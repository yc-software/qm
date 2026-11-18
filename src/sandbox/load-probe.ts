import { shq } from "../util/shell.ts";

export const IO_SATURATED_FULL60 = 50;

export interface LoadSample {
  sampledAt: number;
  ioFull60: number | null;
  load1: number;
  memUsedMb: number;
  memTotalMb: number;
  diskUsedGb: number;
  diskTotalGb: number;
}

const MARKER = "__QM_LOAD__";

const PROBE = [
  `io=$(awk '/^full/{split($3,a,"=");print a[2];exit}' /proc/pressure/io 2>/dev/null)`,
  `ld=$(cut -d' ' -f1 /proc/loadavg 2>/dev/null)`,
  `lim=$(cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null | head -n1)`,
  `cur=$(cat /sys/fs/cgroup/memory.current /sys/fs/cgroup/memory/memory.usage_in_bytes 2>/dev/null | head -n1)`,
  `ina=$(awk '/^(total_)?inactive_file /{print $2;exit}' /sys/fs/cgroup/memory.stat /sys/fs/cgroup/memory/memory.stat 2>/dev/null)`,
  `mem=$(awk -v l="$lim" -v c="$cur" -v i="\${ina:-0}" '/^MemTotal:/{t=$2}/^MemAvailable:/{a=$2}END{if(!t)exit;u=(t-a)*1024;t*=1024;if(l~/^[0-9]+$/&&l<t&&c~/^[0-9]+$/){t=l;u=c-i}print int(u/1048576), int(t/1048576)}' /proc/meminfo 2>/dev/null)`,
  `dsk=$(df -Pk . 2>/dev/null | awk 'NR==2{print $3, $2}')`,
  `printf '\\n${MARKER} %s %s %s %s %s %s\\n' "\${io:--}" "\${ld:--}" "\${mem:-- -}" "\${dsk:-- -}" "\${__qm_t0:--}" "\${__qm_t1:--}"`,
].join("\n");

const UPTIME = (name: string): string => `{ read ${name} __qm_idle < /proc/uptime; } 2>/dev/null || ${name}=-`;

export const withLoadProbe = (command: string): string =>
  `${UPTIME("__qm_t0")}\n(eval ${shq(command)})\n__qm_rc=$?\n${UPTIME("__qm_t1")}\n(set +eu\n${PROBE}\n) 2>/dev/null\n(exit $__qm_rc)`;

const num = (raw: string | undefined): number | null => {
  if (raw === undefined || raw === "-") return null;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
};

const tenth = (value: number): number => Math.round(value * 10) / 10;

export function takeLoadSample(
  stdout: string,
  now: number,
): { stdout: string; sample?: LoadSample; commandMs?: number } {
  const at = stdout.lastIndexOf(`\n${MARKER} `);
  if (at < 0) return { stdout };
  const end = stdout.indexOf("\n", at + 1);
  const line = stdout.slice(at + MARKER.length + 2, end < 0 ? undefined : end);
  const rest = stdout.slice(0, at) + (end < 0 ? "" : stdout.slice(end + 1));
  const fields = line.split(" ");
  const [io, load1, memUsed, memTotal, diskUsed, diskTotal, startedAt, endedAt] = fields.map(num);
  const timed =
    fields.length === 8 && startedAt != null && endedAt != null && endedAt >= startedAt
      ? { commandMs: Math.round((endedAt - startedAt) * 1000) }
      : {};
  if (fields.length !== 8 || load1 == null || memUsed == null || !memTotal || diskUsed == null || !diskTotal)
    return { stdout: rest, ...timed };
  return {
    stdout: rest,
    ...timed,
    sample: {
      sampledAt: now,
      ioFull60: io ?? null,
      load1,
      memUsedMb: memUsed,
      memTotalMb: memTotal,
      diskUsedGb: tenth(diskUsed / 2 ** 20),
      diskTotalGb: tenth(diskTotal / 2 ** 20),
    },
  };
}
