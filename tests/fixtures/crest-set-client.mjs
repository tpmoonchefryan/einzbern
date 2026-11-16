// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import fs from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beginCrestAttestation } from "../../dist/build/packages/core/src/source-attestor-client.js";
import { attestorMountContext } from "../../dist/build/packages/core/src/source-attestor-protocol.js";
import { withRecallObservation } from "../../dist/build/packages/core/src/recall-observation.js";

// A plain complete byte reader for the protocol fixture, not a Crest parser or
// a production projection issuer. Real list/Recall semantics are tested apart.
export function completeFixtureState(roots) {
  const entries = [];
  let bytes = 0;
  function visit(root, path) {
    const info = fs.lstatSync(path);
    if (info.isDirectory()) {
      const names = fs.readdirSync(path).sort();
      entries.push([root, relative(root, path), "directory", names]);
      for (const name of names) visit(root, join(path, name));
    } else if (info.isFile()) {
      const data = fs.readFileSync(path); bytes += data.length;
      entries.push([root, relative(root, path), "file", createHash("sha256").update(data).digest("hex")]);
    } else entries.push([root, relative(root, path), "unsupported"]);
  }
  for (const root of roots) {
    try { visit(root, root); }
    catch (error) { if (error.code !== "ENOENT") throw error; entries.push([root, "absent"]); }
  }
  return { digest: createHash("sha256").update(JSON.stringify(entries)).digest("hex"), bytes, entries: entries.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const started = Date.now();
  const request = JSON.parse(process.argv[2]), home = process.argv[3], cache = process.argv[4];
  const observed = await withRecallObservation(() => beginCrestAttestation(request, home));
  const proof = observed.value;
  let state, full = false;
  if (proof?.initial.warm) {
    try { state = JSON.parse(fs.readFileSync(cache, "utf8")); } catch { /* Exercise a full reader on a missing fixture receipt. */ }
  }
  if (state === undefined) { state = completeFixtureState(request.roots); full = true; }
  const valid = await proof?.finish() ?? false;
  if (!valid) { state = completeFixtureState(request.roots); full = true; }
  else fs.writeFileSync(cache, JSON.stringify(state));
  console.log(JSON.stringify({ pid: process.pid, started, ended: Date.now(), valid, full, state, context: attestorMountContext(),
    epoch: proof?.epoch, binding: proof?.binding, initial: proof?.initial ?? null, attestorReasons: observed.observation.cacheReasons }));
}
