// SPDX-License-Identifier: Apache-2.0
// The pinned INC-155 coverage program expects a POSIX no-follow file walker.
// Supply the engine's NTFS walker only to that program in its disposable archive.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { toPosixPath, walkFiles as walkNativeFiles } from "./files.mjs";

export { toPosixPath };
export const repositoryRoot = process.cwd();
const coverageEntry = realpathSync.native(join(repositoryRoot, "scripts", "coverage-conservation.mjs"));

export async function walkFiles() {
  const files = await walkNativeFiles(repositoryRoot);
  const isTest = path => (path.startsWith("tests/") || path.startsWith("portal/tests/")) && path.endsWith(".test.mjs");
  const actual = files.map(file => toPosixPath(relative(repositoryRoot, file))).filter(isTest);
  const listing = execFileSync("git", ["ls-tree", "-r", "--name-only", "-z", "HEAD", "--", "tests", "portal/tests"], { cwd: repositoryRoot, encoding: "utf8", windowsHide: true });
  const expected = new Set(listing.split("\0").filter(isTest));
  if (!expected.size || actual.length !== expected.size || actual.some(path => !expected.has(path))) {
    throw new Error("EVIDENCE_HISTORY_TEST_ROSTER_MISMATCH");
  }
  return files;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./lib/files.mjs" && context.parentURL?.startsWith("file:") && realpathSync.native(fileURLToPath(context.parentURL)) === coverageEntry) {
      return { url: import.meta.url, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
