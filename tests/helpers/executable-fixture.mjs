// SPDX-License-Identifier: Apache-2.0
import { writeFile } from "node:fs/promises";
import { basename } from "node:path";

/** Exercise the platform's real executable entry point with the same fixture program. */
export async function writeNodeExecutable(path, source) {
  if (process.platform !== "win32") {
    await writeFile(path, source.startsWith("#!") ? source : `#!${process.execPath}\n${source}\n`, { mode: 0o700 });
    return path;
  }
  await writeFile(`${path}.mjs`, source.replace(/^#![^\n]*\n/u, ""));
  await writeFile(`${path}.cmd`, `@"${process.execPath}" "%~dp0${basename(path)}.mjs" %*\r\n`);
  return `${path}.cmd`;
}
