// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync } from "node:fs";
import { lstat, readFile, statfs } from "node:fs/promises";
import { join, relative } from "node:path";

export interface LocalIdentityContext {
  readonly boot: string;
  readonly mount: string;
  readonly device: string;
}

export interface LocalFileIdentity {
  readonly boot: string;
  readonly mount: string;
  readonly device: number;
  readonly fileId: string;
  readonly birth: string;
  readonly change: string;
  readonly length: string;
  readonly mode: string;
}

/** Object observations, never proof of unchanged bytes: a writable mapping can
 * change content without changing even multigrain ctime. Consumers must hash
 * current content before reusing a previously verified projection. Keep the
 * existing capability boundary; unknown filesystems use the ordinary reader. */
export async function localIdentityContext(root: string): Promise<LocalIdentityContext | null> {
  if (process.platform !== "linux") return null;
  try {
    const [filesystem, info, boot, mounts, kernel] = await Promise.all([
      statfs(root, { bigint: true }), lstat(root, { bigint: true }),
      readFile("/proc/sys/kernel/random/boot_id", "utf8"), readFile("/proc/self/mountinfo", "utf8"),
      readFile("/proc/sys/kernel/osrelease", "utf8"),
    ]);
    const version = /^(\d+)\.(\d+)\./u.exec(kernel);
    if (version === null || !(Number(version[1]) > 6 || Number(version[1]) === 6 && Number(version[2]) >= 13)) return null;
    const filesystemName = new Map([[0xef53n, "ext4"], [0x1021994n, "tmpfs"]]).get(filesystem.type);
    if (filesystemName === undefined || !/^[a-f0-9-]{36}\n?$/u.test(boot)) return null;
    const mount = mounts.split("\n").filter(line => {
      const path = line.split(" ")[4]?.replace(/\\([0-7]{3})/gu, (_match, octal: string) => String.fromCharCode(parseInt(octal, 8)));
      return path !== undefined && (path === "/" || root === path || root.startsWith(`${path}/`));
    }).sort((left, right) => right.split(" ")[4]!.length - left.split(" ")[4]!.length)[0];
    if (mount === undefined || !mount.includes(` - ${filesystemName} `)) return null;
    return { boot: boot.trim(), mount: createHash("sha256").update(mount).digest("hex"), device: info.dev.toString() };
  } catch {
    return null;
  }
}

export function localFileIdentity(info: BigIntStats, context: LocalIdentityContext, directory = false): LocalFileIdentity | null {
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1n)
    || info.dev.toString() !== context.device || info.ino <= 0n || info.birthtimeNs <= 0n || info.ctimeNs <= 0n) return null;
  return { boot: context.boot, mount: context.mount, device: Number(info.dev), fileId: info.ino.toString(),
    birth: info.birthtimeNs.toString(), change: info.ctimeNs.toString(), length: info.size.toString(), mode: info.mode.toString() };
}

const CONTENT_DIGEST_BUFFER = Buffer.allocUnsafe(1024 * 1024);

/** Hash a held descriptor from offset zero without moving its read position.
 * This covers repeated writes through an already writable mmap as well as
 * ordinary writes, truncation and replacement. */
export function fileContentDigest(fd: number): { readonly sha256: string; readonly bytes: number } {
  const hash = createHash("sha256");
  const buffer = CONTENT_DIGEST_BUFFER;
  let bytes = 0;
  for (;;) {
    const count = readSync(fd, buffer, 0, buffer.length, bytes);
    if (count === 0) break;
    hash.update(buffer.subarray(0, count));
    bytes += count;
  }
  return { sha256: hash.digest("hex"), bytes };
}

function sameIdentity(left: LocalFileIdentity | null, right: LocalFileIdentity | null): boolean {
  return left !== null && right !== null && left.boot === right.boot && left.mount === right.mount
    && left.device === right.device && left.fileId === right.fileId && left.birth === right.birth
    && left.change === right.change && left.length === right.length && left.mode === right.mode;
}

/** Each source file contributes its actual content, including old records.
 * Metadata is only an object/race check and never substitutes for the digest. */
export async function localTreeIdentity(root: string): Promise<string | null> {
  const context = await localIdentityContext(root);
  if (context === null) return null;
  const observed = context;
  const entries: [string, LocalFileIdentity, string | null][] = [];
  function visit(path: string): void {
    const info = lstatSync(path, { bigint: true });
    const identity = localFileIdentity(info, observed, info.isDirectory());
    if (identity === null) throw new Error("unprovable source identity");
    if (info.isDirectory()) {
      entries.push([relative(root, path), identity, null]);
      for (const name of readdirSync(path)) visit(join(path, name));
      return;
    }
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const held = fstatSync(fd, { bigint: true });
      if (!sameIdentity(localFileIdentity(held, observed), identity)) throw new Error("source replaced");
      const content = fileContentDigest(fd);
      if (content.bytes !== Number(held.size) || !sameIdentity(localFileIdentity(lstatSync(path, { bigint: true }), observed), identity)) throw new Error("source changed");
      entries.push([relative(root, path), identity, content.sha256]);
    } finally { closeSync(fd); }
  }
  try {
    if (!lstatSync(root).isDirectory()) return null;
    visit(root);
    entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    const hash = createHash("sha256");
    for (const [rel, id, sha] of entries) {
      hash.update(rel);
      hash.update(`\0${id.boot}:${id.mount}:${id.device}:${id.fileId}:${id.birth}:${id.change}:${id.length}:${id.mode}:${sha ?? ""}\n`);
    }
    return hash.digest("hex");
  } catch {
    return null;
  }
}
