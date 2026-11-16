// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, open, readdir, readFile, statfs } from "node:fs/promises";
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

export async function fileHandleContentDigest(handle: FileHandle, buffer = Buffer.allocUnsafe(1024 * 1024)): Promise<{ readonly sha256: string; readonly bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, bytes);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    bytes += bytesRead;
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
  const files: { readonly path: string; readonly identity: LocalFileIdentity }[] = [];
  const directories: { readonly path: string; readonly identity: LocalFileIdentity; readonly names: string[] }[] = [];
  let visited = 0;
  async function visit(path: string): Promise<void> {
    // This capability admits only local filesystems. Batch their metadata just
    // like the small-file hashes below, avoiding one libuv job per Crest file.
    if (++visited % 16 === 0) await new Promise<void>(resolve => setImmediate(resolve));
    const info = lstatSync(path, { bigint: true });
    const identity = localFileIdentity(info, observed, info.isDirectory());
    if (identity === null) throw new Error("unprovable source identity");
    if (info.isDirectory()) {
      entries.push([relative(root, path), identity, null]);
      const names = readdirSync(path);
      directories.push({ path, identity, names: names.sort() });
      for (const name of names) await visit(join(path, name));
      return;
    }
    files.push({ path, identity });
  }
  try {
    if (!(await lstat(root)).isDirectory()) return null;
    await visit(root);
    for (let index = 0; index < files.length; index += 1) {
      const { path, identity } = files[index]!;
      // Crest's small files pay more for FileHandle/libuv round trips than for
      // their full SHA. Close each held fd before yielding a bounded batch;
      // larger files retain asynchronous reads so their size cannot stall a
      // long-lived reader for an entire synchronous full-file hash.
      if (Number(identity.length) <= 256 * 1024) {
        // A FIFO raced into the name must reach the regular-file check without
        // blocking this event loop in openSync.
        const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const held = fstatSync(fd, { bigint: true });
          if (!sameIdentity(localFileIdentity(held, observed), identity)) throw new Error("source replaced");
          const content = fileContentDigest(fd);
          if (content.bytes !== Number(held.size) || !sameIdentity(localFileIdentity(lstatSync(path, { bigint: true }), observed), identity)) throw new Error("source changed");
          entries.push([relative(root, path), identity, content.sha256]);
        } finally { closeSync(fd); }
      } else {
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const held = await handle.stat({ bigint: true });
          if (!sameIdentity(localFileIdentity(held, observed), identity)) throw new Error("source replaced");
          const content = await fileHandleContentDigest(handle);
          if (content.bytes !== Number(held.size) || !sameIdentity(localFileIdentity(await lstat(path, { bigint: true }), observed), identity)) throw new Error("source changed");
          entries.push([relative(root, path), identity, content.sha256]);
        } finally { await handle.close(); }
      }
      if ((index + 1) % 16 === 0) await new Promise<void>(resolve => setImmediate(resolve));
    }
    await Promise.all(directories.map(async ({ path, identity, names }) => {
      const current = localFileIdentity(await lstat(path, { bigint: true }), observed, true);
      const currentNames = (await readdir(path)).sort();
      if (!sameIdentity(current, identity) || names.length !== currentNames.length
        || names.some((name, index) => name !== currentNames[index])) throw new Error("source directory changed");
    }));
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
