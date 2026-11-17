// SPDX-License-Identifier: Apache-2.0
import { isAbsolute, relative, resolve, sep } from "node:path";

/** Use relative device paths when both locations have a common filesystem root. */
export function storePath(base: string, path: string): string {
  const stored = relative(resolve(base), resolve(path));
  // Windows cannot express a relative path between volumes or UNC shares.
  // loadPath already accepts absolute device-local values for this case.
  if (isAbsolute(stored)) return resolve(path).split(sep).join("/");
  return stored.split(sep).join("/") || ".";
}

/** Absolute legacy values remain readable; the next supported write makes them portable. */
export function loadPath(base: string, path: string): string {
  if (!path || /[\0\r\n]/u.test(path)) throw new Error("PORTABLE_PATH_INVALID");
  return resolve(base, path);
}
