import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { createSupervisorTransport } from "../src/sandbox/supervisor-transport.ts";
import type { SandboxHandle } from "../src/sandbox/sandbox.ts";

const execute = promisify(execFile);

test(
  "root upload transfers large secret bytes separately from argv and publishes only root-readable files",
  { skip: process.env.QM_SUPERVISOR_DOCKER_TEST !== "1", timeout: 60_000 },
  async () => {
    const name = `qm-supervisor-upload-${process.pid}-${Date.now()}`;
    const commands: string[] = [];
    const token = "synthetic-supervisor-upload-secret";
    const bytes = Buffer.alloc(4 * 1024 * 1024, token);
    const handle = { id: name, rootDir: "/workspace" } as SandboxHandle;
    try {
      await execute("docker", ["run", "-d", "--rm", "--name", name, "qm-isolation-supervisor:dev", "sleep", "90"]);
      const transport = createSupervisorTransport(
        {
          identity: async () => name,
          async run(_handle, command) {
            commands.push(command);
            try {
              const output = await execute("docker", ["exec", name, "sh", "-c", command], {
                maxBuffer: 8 * 1024 * 1024,
              });
              return { ...output, code: 0, timedOut: false };
            } catch (error) {
              if (!error || typeof error !== "object" || !("stdout" in error) || !("stderr" in error)) throw error;
              return { stdout: String(error.stdout), stderr: String(error.stderr), code: 1, timedOut: false };
            }
          },
          async writeBytes(_handle, path, data) {
            const command = "import sys; open(sys.argv[1],'wb').write(sys.stdin.buffer.read())";
            commands.push(command, path);
            const pending = execute("docker", ["exec", "-i", name, "python3", "-I", "-c", command, path]);
            pending.child.stdin!.end(Buffer.from(data));
            await pending;
          },
        },
        new Set([name]),
      );
      await transport.writeFile(handle, "/dev/shm/qm-supervisor/request.json", bytes);
      assert.equal(
        commands.some((command) => command.includes(token) || command.includes(bytes.toString("base64").slice(0, 80))),
        false,
      );
      const checked = await transport.run(
        handle,
        'python3 -I -c \'import os; p="/dev/shm/qm-supervisor/request.json"; s=os.stat(p); assert s.st_uid==0 and s.st_mode & 0o777==0o600 and s.st_size==4194304; assert not os.listdir("/dev/shm/qm-supervisor/.uploads")\'',
      );
      assert.equal(checked.code, 0, checked.stderr);
      const denied = await transport.run(
        handle,
        "setpriv --reuid 61001 --regid 61001 --clear-groups cat /dev/shm/qm-supervisor/request.json",
      );
      assert.notEqual(denied.code, 0);
      await transport.run(handle, "ln -s /tmp /dev/shm/qm-supervisor/escape");
      await assert.rejects(
        transport.writeFile(handle, "/dev/shm/qm-supervisor/escape/secret", bytes),
        /staging directory/,
      );
    } finally {
      await execute("docker", ["rm", "-f", name]).catch(() => undefined);
    }
  },
);
