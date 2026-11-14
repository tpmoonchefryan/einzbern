// SPDX-License-Identifier: Apache-2.0
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

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
