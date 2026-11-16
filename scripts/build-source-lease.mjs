#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// Explicit, optional local build. No node-gyp, download, install hook or service.
// Resolve headers from THIS executable's installation; never use /usr/include
// as a substitute for another Node installation's headers.
export async function buildSourceLease(source, output) {
  if (process.platform !== "linux" || process.versions.node.split(".")[0] !== "24") throw new Error("SOURCE_LEASE_PLATFORM_UNSUPPORTED");
  const executable = await realpath(process.execPath);
  const include = resolve(dirname(executable), "../include/node");
  if (!(await stat(join(include, "node_api.h"))).isFile()) throw new Error("SOURCE_LEASE_HEADERS_UNAVAILABLE");
  const destination = resolve(output);
  await mkdir(dirname(destination), { recursive: true });
  const temporary = destination + ".partial-" + process.pid;
  const argv = ["-std=c11", "-O2", "-fPIC", "-shared", "-Wall", "-Wextra", "-Werror", "-DNAPI_VERSION=8", "-I", include, resolve(source), "-o", temporary];
  try {
    const result = spawnSync(process.env.CC || "cc", argv, { encoding: "utf8" });
    process.stdout.write(result.stdout ?? ""); process.stderr.write(result.stderr ?? "");
    if (result.status !== 0) throw new Error("SOURCE_LEASE_BUILD_FAILED");
    await rename(temporary, destination);
    return { reasonCode: "SOURCE_LEASE_BUILT", node: process.version, napi: 8, platform: process.platform, architecture: process.arch,
      sourceSha256: createHash("sha256").update(await readFile(source)).digest("hex"),
      binarySha256: createHash("sha256").update(await readFile(destination)).digest("hex") };
  } finally { await rm(temporary, { force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const script = dirname(fileURLToPath(import.meta.url));
    const source = process.argv[2] ?? join(script, "../native/linux-source-lease.c");
    const output = process.argv[3];
    if (output === undefined) throw new Error("usage: node scripts/build-source-lease.mjs <source.c> <explicit-private-output.node>");
    console.log(JSON.stringify(await buildSourceLease(source, output)));
  } catch (error) { console.error(String(error.message)); process.exitCode = 1; }
}
