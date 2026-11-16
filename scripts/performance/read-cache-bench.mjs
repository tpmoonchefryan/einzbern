// SPDX-License-Identifier: Apache-2.0
// Usage: node scripts/performance/read-cache-bench.mjs spec.json new-private-output.jsonl
// Build serially first. Run with existing derived caches, or remove only an
// explicitly owned disposable cache before a separately labelled cold build.
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { open, readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [specPath, outputPath] = process.argv.slice(2);
const spec = JSON.parse(await readFile(specPath, "utf8"));
const count = spec.samples ?? 20;
if (!Number.isSafeInteger(count) || count < 1 || !["cold-build", "existing-derived-cache"].includes(spec.cacheState)) throw new Error("Declare samples and cacheState");
const entries = spec.entries ?? ["cli", "hook"];
if (spec.cacheState === "cold-build" && (count !== 1 || entries.length !== 1)) throw new Error("A cold build is one entry/sample after resetting an explicitly owned disposable cache");
const script = resolve(dirname(fileURLToPath(import.meta.url)), "read-cache-sample.mjs");
const git = args => {
  const result = spawnSync("git", args, { cwd: spec.repository, encoding: "utf8" });
  if (result.status !== 0) throw new Error("Cannot record repository identity");
  return result.stdout.trim();
};
async function compiledFiles(path, prefix = "") {
  const files = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) files.push(...await compiledFiles(resolve(path, entry.name), `${name}/`));
    else if (entry.isFile() && entry.name.endsWith(".js")) files.push({ path: name, sha256: createHash("sha256").update(await readFile(resolve(path, entry.name))).digest("hex") });
  }
  return files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}
const compiled = await compiledFiles(resolve(spec.repository, "dist/build"));
const identity = { commit: git(["rev-parse", "HEAD"]), sourceDiffSha256: createHash("sha256").update(git(["diff", "HEAD", "--", "packages", "scripts"])).digest("hex"),
  compiledSha256: createHash("sha256").update(JSON.stringify(compiled)).digest("hex"),
  cliSha256: createHash("sha256").update(await readFile(resolve(spec.repository, "scripts/einzbern.mjs"))).digest("hex"),
  hookSha256: createHash("sha256").update(await readFile(resolve(spec.repository, "scripts/einzbern-hook.mjs"))).digest("hex") };
const output = await open(resolve(outputPath), "wx", 0o600);
try {
  for (const entry of entries) {
    for (let sample = 0; sample < count; sample += 1) {
      const argv = [script, resolve(specPath), entry];
      const started = performance.now();
      const child = spawn(process.execPath, argv, { cwd: spec.repository, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
      const code = await new Promise((done, reject) => { child.once("error", reject); child.once("close", done); });
      const wallMs = performance.now() - started;
      const measured = JSON.parse(stdout);
      await output.write(`${JSON.stringify({ ...measured, ...identity, sample, argv: [process.execPath, ...argv], newProcess: true,
        cacheState: spec.cacheState, wallMs, processExitCode: code, stderrBytes: Buffer.byteLength(stderr), stderrSha256: createHash("sha256").update(stderr).digest("hex") })}\n`);
      await output.sync();
      if (code !== 0) throw new Error(`Entry failed; retained sample ${entry}:${sample}`);
    }
  }
} finally { await output.close(); }
