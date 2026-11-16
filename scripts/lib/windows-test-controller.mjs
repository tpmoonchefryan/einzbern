// SPDX-License-Identifier: Apache-2.0
import { spawnCommand } from "../../skill/mana-orchestrate/scripts/process-launch.mjs";
import { acquireMemoryChild, memoryTestArguments } from "./memory-budget.mjs";
import { PROGRESS_SCHEMA_VERSION, summarizeProgress } from "./incremental-output.mjs";
import { collectTestDiagnostics, prepareTestDiagnostics, snapshotTestController } from "./test-run-diagnostics.mjs";
import { createPrivateWindowsDirectory } from "./windows-system.mjs";
import { randomUUID } from "node:crypto";
import { closeSync, openSync, writeFileSync, writeSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** A job is joined before close, so test output and descendants have one lifetime. */
export async function runWindowsTestController(args, { cwd, env, timeoutMs, onFailure, tests }) {
  env = { ...env };
  delete env.NODE_TEST_CONTEXT;
  const lease = await acquireMemoryChild("node:test-controller", env);
  let directory;
  let diagnosticDirectory;
  const stdout = [];
  const stderr = [];
  const descriptors = [];
  let timedOut = false;
  let timer;
  let child;
  let outputError;
  const cancel = () => child?.kill("SIGTERM");
  try {
    directory = join(env.TMPDIR ?? tmpdir(), `tcrn-test-controller-${randomUUID()}`);
    if (!createPrivateWindowsDirectory(directory)) throw new Error("Controller output directory already exists");
    let diagnostics;
    let progressPath;
    if (tests) {
      diagnosticDirectory = join(env.TMPDIR ?? tmpdir(), `tcrn-test-progress-${randomUUID()}`);
      if (!createPrivateWindowsDirectory(diagnosticDirectory)) throw new Error("Controller diagnostic directory already exists");
      diagnostics = prepareTestDiagnostics(diagnosticDirectory, tests, cwd, pathToFileURL(join(cwd, "scripts/test-file-progress-reporter.mjs")).href);
      progressPath = join(diagnosticDirectory, "progress.ndjson");
      Object.assign(env, diagnostics.environment, {
        TCRN_TEST_CONTROLLER_OUTER_PID: String(process.pid),
        EINZBERN_TEST_DIAGNOSTIC_ROOT: "1",
      });
    }
    const stdoutFd = openSync(join(directory, "stdout"), "wx", 0o600);
    descriptors.push(stdoutFd);
    const stderrFd = openSync(join(directory, "stderr"), "wx", 0o600);
    descriptors.push(stderrFd);
    const started = Date.now();
    child = spawnCommand(process.execPath, memoryTestArguments(diagnostics?.arguments ?? ["--test-reporter=tap", ...args], env), {
      cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    const capture = (descriptor, chunks, bytes) => {
      try { writeSync(descriptor, bytes); chunks.push(bytes); }
      catch (error) { outputError = error; cancel(); }
    };
    child.stdout.on("data", bytes => capture(stdoutFd, stdout, bytes));
    child.stderr.on("data", bytes => capture(stderrFd, stderr, bytes));
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    timer = setTimeout(() => { timedOut = true; cancel(); }, timeoutMs);
    const result = await new Promise((resolveResult, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolveResult({ code, signal }));
    });
    const raw = { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
    const ok = !outputError && !timedOut && result.code === 0 && !result.signal && !raw.stderr.trim();
    const lastProgress = { schemaVersion: PROGRESS_SCHEMA_VERSION, type: "completed", ok, ...result, writerQuiescent: true, ...(lease ? { memoryAdmission: { workers: lease.workers, reservedBytes: lease.bytes } } : {}) };
    const progress = { ...summarizeProgress([lastProgress]), lastProgress, cleanupErrors: [], timedOut };
    if (diagnostics) {
      writeFileSync(progressPath, `${JSON.stringify(lastProgress)}\n`, { flag: "wx", mode: 0o600 });
      const snapshot = {
        trigger: timedOut ? "deadline" : "process-exit", triggerElapsedMs: Date.now() - started,
        timeoutMs, terminalProgressStatus: "completed",
        controllerAtTrigger: snapshotTestController([lastProgress], 0, {}),
      };
      progress.diagnostics = collectTestDiagnostics(diagnostics, snapshot, progressPath, true);
    }
    if (!ok) {
      const reasonCode = outputError ? "TEST_CONTROLLER_OUTPUT_FAILED" : timedOut ? "TEST_CONTROLLER_TIMEOUT" : result.code !== 0 || result.signal ? "COMMAND_FAILED" : "COMMAND_UNEXPECTED_STDERR";
      const details = { raw, progress, primaryError: result };
      if (onFailure) onFailure(reasonCode, reasonCode, details);
      throw Object.assign(new Error(reasonCode), { reasonCode, details });
    }
    return { progress };
  } finally {
    clearTimeout(timer);
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
    try {
      for (const descriptor of descriptors) closeSync(descriptor);
      if (diagnosticDirectory) await rm(diagnosticDirectory, { recursive: true });
      // The CI descriptor observer retains these files after this process has
      // closed them, then removes this exact directory on Windows.
      if (directory && !env.EINZBERN_CI_EVIDENCE_DIR) await rm(directory, { recursive: true });
    } finally { lease?.release(); }
  }
}
