// SPDX-License-Identifier: Apache-2.0
import { cp, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const sourceRoot = resolve(import.meta.dirname, "../..");

// The real task builder always bundles this executable companion. Thin task
// fixtures carry its actual source/import closure and the governing compiler
// project, rather than stubbing the host or skipping dependency verification.
export async function copyTaskRuntimeInputs(root) {
  for (const path of ["tsconfig.json", "packages/core/src/darwin-source-identity.mjs", "packages/core/src/source-attestor-service.ts", "packages/core/src/source-attestor-protocol.ts"]) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await cp(join(sourceRoot, path), join(root, path));
  }
  const { devDependencies } = JSON.parse(await readFile(join(sourceRoot, "package.json"), "utf8"));
  return { devDependencies: { typescript: devDependencies.typescript } };
}
