// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstatSync, readdirSync } from "node:fs";
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

/** Linux 6.13+ ext4/tmpfs multigrain change time and inode birth identity.
 * FS_MGTIME makes the next write after a stat query visibly change ctime even
 * within one coarse clock tick. Older kernels cannot provide that contract.
 * See kernel.org/doc/html/latest/filesystems/multigrain-ts.html.
 * Unlike size/mtime, an unprivileged source writer cannot restore ctime after
 * changing bytes. Boot + mount + device + inode + birth bind the actual object,
 * including inode reuse. Remote/FUSE filesystems without this contract fail
 * closed to the ordinary SHA-256 reader. These observations only authorize
 * reuse when an independent local record binds a previous full verification. */
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

/** Source bytes are never read by this metadata inventory. Every file's change
 * identity is checked: directory times or a stream's last filename alone would
 * miss an in-place change to an older record. */
export async function localTreeIdentity(root: string): Promise<string | null> {
  const context = await localIdentityContext(root);
  if (context === null) return null;
  const observed = context;
  const entries: [string, LocalFileIdentity][] = [];
  function visit(path: string): void {
    const info = lstatSync(path, { bigint: true });
    const identity = localFileIdentity(info, observed, info.isDirectory());
    if (identity === null) throw new Error("unprovable source identity");
    entries.push([relative(root, path), identity]);
    if (info.isDirectory()) for (const name of readdirSync(path)) visit(join(path, name));
  }
  try {
    visit(root);
    entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
  } catch {
    return null;
  }
}
