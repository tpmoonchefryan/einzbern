// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import { cp, mkdir, readdir, realpath, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function copyDependencyTree(source, target) {
  if (process.platform !== "win32") return cp(source, target, { recursive: true });
  // A pnpm installation has a real node_modules root. Keep that boundary for
  // source walks while sharing installed package directories through junctions.
  await mkdir(target);
  for (const name of await readdir(source)) {
    const entry = join(source, name);
    if ((await stat(entry)).isDirectory()) await symlink(await realpath(entry), join(target, name), "junction");
    else await cp(entry, join(target, name));
  }
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
