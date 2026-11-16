// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import { cp, realpath, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function copyDependencyTree(source, target) {
  if (process.platform === "win32") await symlink(await realpath(source), target, "junction");
  else await cp(source, target, { recursive: true });
}

export async function fileSymlinksAvailable(directory) {
  if (process.platform !== "win32") return true;
  const file = join(directory, `symlink-probe-${randomUUID()}`);
  const alias = `${file}.link`;
  await writeFile(file, "");
  try {
    await symlink(file, alias, "file");
    return true;
  } catch (error) {
    if (error.code === "EPERM" || error.code === "EACCES") return false;
    throw error;
  } finally {
    await unlink(alias).catch(error => { if (error.code !== "ENOENT") throw error; });
    await unlink(file);
  }
}
