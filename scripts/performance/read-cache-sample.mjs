// SPDX-License-Identifier: Apache-2.0
// One complete production entry in a fresh process; retain no returned prose.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const [specPath, entry] = process.argv.slice(2);
const spec = JSON.parse(await readFile(specPath, "utf8"));
if (!["cli", "hook"].includes(entry) || typeof spec.at !== "string" || typeof spec.query !== "string") throw new Error("Invalid read-cache sample");
const repository = resolve(spec.repository);
const library = resolve(spec.library);
delete process.env.EINZBERN_RECALL_OBSERVATION;
delete process.env.USER_PROMPT;
process.env.EINZBERN_HOST = spec.host ?? "claude-code";
// Hook has no public --at. Pin only its wall clock; parent wall time and Node's
// performance/CPU clocks remain real. Record the pinned instant in every sample.
if (entry === "hook") {
  const NativeDate = Date;
  globalThis.Date = class extends NativeDate {
    constructor(...args) { super(...(args.length === 0 ? [spec.at] : args)); }
    static now() { return NativeDate.parse(spec.at); }
  };
}
const { withRecallObservation } = await import(pathToFileURL(`${repository}/dist/build/packages/core/src/recall-observation.js`));
const write = process.stdout.write.bind(process.stdout);
const hash = createHash("sha256");
let bytes = 0, observation, effectiveArgv, error;
process.stdout.write = (chunk, encoding, callback) => {
  const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === "string" ? encoding : undefined);
  hash.update(value); bytes += value.length;
  if (typeof encoding === "function") encoding(); else callback?.();
  return true;
};
try {
  await withRecallObservation(async () => {
    if (entry === "cli") {
      const script = `${repository}/scripts/einzbern.mjs`;
      effectiveArgv = [process.execPath, script, "recall", "--workspace", library, "--view", "agent", "--at", spec.at, "--query", spec.query, "--allow-trailing", "true", ...(spec.cliArguments ?? [])];
      process.argv = effectiveArgv;
      await import(pathToFileURL(script));
    } else {
      effectiveArgv = [process.execPath, `${repository}/scripts/einzbern-hook.mjs`, "user-prompt-submit"];
      const { runHookEvent } = await import(pathToFileURL(effectiveArgv[1]));
      const output = await runHookEvent({ event: "user-prompt-submit", libraryPath: library,
        cwd: resolve(spec.cwd), payload: { prompt: spec.query, cwd: resolve(spec.cwd) } });
      if (output !== null) process.stdout.write(output);
    }
  }, value => { observation = value; });
} catch (caught) {
  error = { name: caught.name, reasonCode: caught.reasonCode ?? null };
  process.exitCode = 1;
} finally { process.stdout.write = write; }
write(`${JSON.stringify({ schemaVersion: "einzbern.read-cache-sample.v1", pid: process.pid, entry, effectiveArgv,
  library, cwd: spec.cwd, at: spec.at, query: spec.query, host: process.env.EINZBERN_HOST,
  outputSha256: hash.digest("hex"), outputBytes: bytes, observation, error: error ?? null, exitCode: process.exitCode ?? 0 })}\n`);
