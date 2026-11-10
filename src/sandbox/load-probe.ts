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
  `mem=$(awk '/^MemTotal:/{t=$2}/^MemAvailable:/{a=$2}END{if(t)print int((t-a)/1024), int(t/1024)}' /proc/meminfo 2>/dev/null)`,
  `dsk=$(df -Pk . 2>/dev/null | awk 'NR==2{print $3, $2}')`,
  `printf '\\n${MARKER} %s %s %s %s\\n' "\${io:--}" "\${ld:--}" "\${mem:-- -}" "\${dsk:-- -}"`,
].join("\n");

export const withLoadProbe = (command: string): string =>
  `(\n${command}\n)\n__qm_rc=$?\n(set +eu\n${PROBE}\n) 2>/dev/null\n(exit $__qm_rc)`;

const num = (raw: string | undefined): number | null => {
  if (raw === undefined || raw === "-") return null;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
};

const tenth = (value: number): number => Math.round(value * 10) / 10;

export function takeLoadSample(stdout: string, now: number): { stdout: string; sample?: LoadSample } {
  const at = stdout.lastIndexOf(`\n${MARKER} `);
  if (at < 0) return { stdout };
  const fields = stdout
    .slice(at + MARKER.length + 2)
    .trim()
    .split(/\s+/);
  const [io, load1, memUsed, memTotal, diskUsed, diskTotal] = fields.map(num);
  const rest = stdout.slice(0, at);
  if (fields.length !== 6 || load1 == null || memUsed == null || !memTotal || diskUsed == null || !diskTotal)
    return { stdout: rest };
  return {
    stdout: rest,
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
