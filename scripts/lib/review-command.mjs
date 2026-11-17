// SPDX-License-Identifier: Apache-2.0
// The synchronous review API waits for this collector. The shell has private
// pipes so the POSIX test controller can register and reap its process group.
import { spawn } from "node:child_process";
import { createWriteStream, readFileSync } from "node:fs";
import { pipeline } from "node:stream/promises";

const { command, timeoutMs, stdoutPath, stderrPath } = JSON.parse(readFileSync(0, "utf8"));
const child = spawn("/bin/sh", ["-c", command], {
  detached: true,
  shell: false,
  stdio: ["ignore", "pipe", "pipe"],
});

function killGroup() {
  if (child.pid === undefined) return;
  try { process.kill(-child.pid, "SIGKILL"); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
}

let launchError;
let timedOut = false;
child.once("error", error => { launchError = error.code ?? "START_FAILED"; });
const closed = new Promise(resolve => child.once("close", resolve));
const timer = setTimeout(() => { timedOut = true; killGroup(); }, timeoutMs);
// A completed shell may have left a descendant holding one of its output pipes.
child.once("exit", killGroup);
try {
  const [status] = await Promise.all([
    closed,
    pipeline(child.stdout, createWriteStream(stdoutPath, { flags: "wx", mode: 0o600 })),
    pipeline(child.stderr, createWriteStream(stderrPath, { flags: "wx", mode: 0o600 })),
  ]);
  const errorCode = timedOut ? "ETIMEDOUT" : launchError;
  process.stdout.write(JSON.stringify({ status, error: errorCode ? { code: errorCode } : null }));
} finally {
  clearTimeout(timer);
  killGroup();
}
