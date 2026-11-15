// SPDX-License-Identifier: Apache-2.0
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const ATTESTOR_SCHEMA = "einzbern.continuous-source-lease.v1";
export const ATTESTOR_MESSAGE_BYTES = 8 * 1024 * 1024;
export interface AttestorFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly metadata: boolean;
  readonly streamId?: string;
  readonly scope?: "live" | "archive";
}
export interface AttestorRequest {
  readonly schema: typeof ATTESTOR_SCHEMA;
  readonly root: string;
  readonly binding: string;
  readonly files: readonly AttestorFile[];
  readonly directories: readonly string[];
}
export interface AttestorDescriptor {
  readonly schema: typeof ATTESTOR_SCHEMA;
  readonly endpoint: string;
  readonly secret: string;
  readonly epoch: string;
  readonly pid: number;
  readonly identity: string;
}

export function attestorEndpoint(descriptor: string, epoch: string): string {
  if (!isAbsolute(descriptor) || descriptor.includes("\0") || resolve(descriptor) !== descriptor || !/^[a-f0-9]{64}$/u.test(epoch)) throw new Error("ipc-endpoint-binding");
  const endpoint = join(dirname(descriptor), `s-${epoch.slice(0, 12)}`);
  if (Buffer.byteLength(endpoint) + 1 > 108) throw new Error("ipc-path-capacity");
  return endpoint;
}

export async function validateAttestorDirectory(path: string): Promise<void> {
  if (!isAbsolute(path) || path.includes("\0") || resolve(path) !== path) throw new Error("private-runtime-boundary");
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || await realpath(path) !== path) throw new Error("private-runtime-boundary");
}

export async function validateAttestorEndpoint(endpoint: string): Promise<void> {
  if (!isAbsolute(endpoint) || endpoint.includes("\0") || resolve(endpoint) !== endpoint || Buffer.byteLength(endpoint) + 1 > 108) throw new Error("ipc-endpoint-binding");
  await validateAttestorDirectory(dirname(endpoint));
  const info = await lstat(endpoint);
  if (!info.isSocket() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error("private-ipc-boundary");
}

export function attestorDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function attestorMac(secret: string, value: unknown): string {
  return createHmac("sha256", secret).update(JSON.stringify(value)).digest("hex");
}
export function validAttestorMac(secret: string, value: unknown, mac: unknown): boolean {
  if (typeof mac !== "string" || !/^[a-f0-9]{64}$/u.test(mac)) return false;
  return timingSafeEqual(Buffer.from(mac, "hex"), Buffer.from(attestorMac(secret, value), "hex"));
}
