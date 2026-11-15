// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, unlink } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FRAMEWORK_VERSION } from "./framework-version.js";
import { observeCacheReason, observeEventRead, observeMetadataBytes } from "./recall-observation.js";
import { ATTESTOR_MESSAGE_BYTES, ATTESTOR_SCHEMA, attestorDigest, attestorEndpoint, attestorMac, validateAttestorEndpoint, validAttestorMac } from "./source-attestor-protocol.js";
import type { AttestorDescriptor, AttestorRequest } from "./source-attestor-protocol.js";

interface BeginResult {
  readonly valid: boolean;
  readonly reason?: string;
  readonly token: string;
  readonly fingerprint: string;
  readonly generation: number;
  readonly incarnations: readonly number[];
  readonly reads: readonly { path: string; bytes: number }[];
  readonly resources: unknown;
}
export interface SourceAttestation {
  readonly initial: BeginResult;
  readonly epoch: string;
  finish(): Promise<boolean>;
  close(): void;
}
interface Connection {
  send(body: Record<string, unknown>): Promise<BeginResult>;
  close(): void;
}
// Executable companions must remain real adjacent files in a release; unlike a
// read-only bundled resource they cannot be an in-memory/data URL.
const RUNTIME_FILES = { host: "source-attestor-host.mjs", native: "native/linux-source-lease.node" };
async function connect(descriptor: AttestorDescriptor): Promise<Connection> {
  await validateAttestorEndpoint(descriptor.endpoint);
  const socket = createConnection(descriptor.endpoint);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("ipc-connect-timeout")); }, 1500);
    socket.once("connect", () => { clearTimeout(timer); resolve(); });
    socket.once("error", error => { clearTimeout(timer); reject(error); });
  });
  return connection(socket, descriptor);
}
function connection(socket: Socket, descriptor: AttestorDescriptor): Connection {
  let input = Buffer.alloc(0), number = 0;
  let waiting: { nonce: string; resolve(value: BeginResult): void; reject(error: Error): void; timer: NodeJS.Timeout } | undefined;
  let failed = false;
  const fail = (error: Error): void => {
    failed = true;
    if (waiting !== undefined) { clearTimeout(waiting.timer); waiting.reject(error); waiting = undefined; }
    socket.destroy();
  };
  socket.on("error", fail);
  socket.on("close", () => { fail(new Error("ipc-disconnected")); });
  socket.on("data", chunk => {
    input = Buffer.concat([input, chunk]);
    if (input.length > ATTESTOR_MESSAGE_BYTES) { fail(new Error("ipc-response-capacity")); return; }
    const end = input.indexOf(10);
    if (end < 0) return;
    try {
      if (end !== input.length - 1 || waiting === undefined) throw new Error("ipc-replay");
      const envelope = JSON.parse(input.subarray(0, end).toString("utf8")); input = Buffer.alloc(0);
      const body = envelope.body;
      if (!validAttestorMac(descriptor.secret, body, envelope.mac) || body.epoch !== descriptor.epoch || body.number !== number || body.nonce !== waiting.nonce) throw new Error(envelope.error ?? "ipc-authentication");
      const current = waiting; waiting = undefined; clearTimeout(current.timer); current.resolve(body.result as BeginResult);
    } catch (error) { fail(error instanceof Error ? error : new Error("ipc-response")); }
  });
  return {
    send: async value => {
      if (failed || socket.destroyed || waiting !== undefined) throw new Error("ipc-unavailable");
      const nonce = randomBytes(32).toString("hex");
      const body = { ...value, epoch: descriptor.epoch, number: ++number, nonce };
      const text = JSON.stringify({ body, mac: attestorMac(descriptor.secret, body) }) + "\n";
      if (Buffer.byteLength(text) > ATTESTOR_MESSAGE_BYTES) throw new Error("ipc-request-capacity");
      return new Promise<BeginResult>((resolve, reject) => {
        const timer = setTimeout(() => { fail(new Error("ipc-response-timeout")); }, 1500);
        waiting = { nonce, resolve, reject, timer };
        socket.write(text);
      });
    },
    close: () => socket.destroy(),
  };
}
async function readDescriptor(path: string, identity: string): Promise<AttestorDescriptor | null> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 4096) return null;
    const descriptor = JSON.parse(await handle.readFile("utf8")) as AttestorDescriptor;
    return descriptor.schema === ATTESTOR_SCHEMA && descriptor.identity === identity && typeof descriptor.endpoint === "string"
      && descriptor.endpoint === attestorEndpoint(path, descriptor.epoch) && /^[a-f0-9]{64}$/u.test(descriptor.secret)
      && Number.isSafeInteger(descriptor.pid) && descriptor.pid > 0 ? descriptor : null;
  } catch { return null; }
  finally { await handle?.close(); }
}
async function configuration(root: string, home: string): Promise<{ host: string; module: string; identity: string; descriptor: string } | null> {
  // Explicit scope for an optional capability pilot, not a weaker read mode.
  // No environment selection can bypass the ordinary full verification path.
  if (process.env.EINZBERN_SOURCE_ATTESTOR_ROOT !== root) return null;
  if (process.platform !== "linux" || process.versions.node.split(".")[0] !== "24") {
    observeCacheReason("source-attestor-platform-unavailable-full-sha256");
    return null;
  }
  const host = fileURLToPath(new URL(RUNTIME_FILES.host, import.meta.url));
  const module = resolve(process.env.EINZBERN_SOURCE_LEASE_MODULE ?? fileURLToPath(new URL(RUNTIME_FILES.native, import.meta.url)));
  try {
    const identity = attestorDigest({ schema: ATTESTOR_SCHEMA, engine: FRAMEWORK_VERSION, runtime: process.version, executable: await realpath(process.execPath),
      platform: process.platform, architecture: process.arch, host: attestorDigest(await readFile(host)), native: attestorDigest(await readFile(module)) });
    const directory = join(home, "source-attestor", attestorDigest([root, identity]).slice(0, 32));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const path of [join(home, "source-attestor"), directory]) {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || await realpath(path) !== path) throw new Error("private-runtime-boundary");
    }
    return { host, module, identity, descriptor: join(directory, "endpoint.json") };
  } catch {
    observeCacheReason("source-attestor-capability-unavailable-full-sha256");
    return null;
  }
}
async function start(config: NonNullable<Awaited<ReturnType<typeof configuration>>>, root: string): Promise<void> {
  const log = await open(join(dirname(config.descriptor), "service.log"), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const capacity = Number(process.env.EINZBERN_SOURCE_ATTESTOR_FDS ?? "4096");
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 8192) throw new Error("fd-capacity");
    const child = spawn(process.execPath, ["--max-old-space-size=128", config.host], { detached: true, stdio: ["pipe", "pipe", log.fd] });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("attestor-start-timeout")); }, 1500);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error("attestor-start-failed")); });
      child.stdout!.once("data", value => {
        clearTimeout(timer);
        try { if (JSON.parse(value.toString()).ready !== true) throw new Error("attestor-not-ready"); resolve(); }
        catch (error) { reject(error); }
      });
      child.stdin!.end(JSON.stringify({ root, descriptor: config.descriptor, identity: config.identity, module: config.module, capacity }));
    });
    child.stdout!.destroy(); child.unref();
  } finally { await log.close(); }
}
export async function beginSourceAttestation(request: AttestorRequest, home: string): Promise<SourceAttestation | null> {
  const config = await configuration(request.root, home);
  if (config === null) return null;
  let channel: Connection | undefined;
  let descriptor: AttestorDescriptor | null = null;
  try {
    try { await lstat(config.descriptor); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; await start(config, request.root); }
    descriptor = await readDescriptor(config.descriptor, config.identity);
    if (descriptor === null) throw new Error("descriptor-unavailable");
    channel = await connect(descriptor);
    const initial = await channel.send({ op: "begin", request });
    for (const read of initial.reads ?? []) {
      const file = request.files.find(file => file.path === read.path);
      if (file !== undefined && Number.isSafeInteger(read.bytes) && read.bytes >= 0) {
        if (file.metadata) observeMetadataBytes(read.bytes);
        else observeEventRead(read.bytes, file.streamId ?? null, file.scope ?? "live");
      }
    }
    if (!initial.valid || initial.fingerprint !== attestorDigest(request) || typeof initial.token !== "string" || !Array.isArray(initial.incarnations)
      || initial.incarnations.length !== request.files.length || !Array.isArray(initial.reads)) throw new Error(initial.reason ?? "begin-binding");
    observeCacheReason(`source-attestor-begin:${descriptor.epoch}:${initial.reads.length === 0 ? "live-reuse" : "leased-sha256"}`);
    const connected = channel;
    return { initial, epoch: descriptor.epoch,
      finish: async () => {
        try {
          const result = await connected.send({ op: "finish", token: initial.token, fingerprint: initial.fingerprint });
          const valid = result.valid === true && result.token === initial.token && result.fingerprint === initial.fingerprint
            && result.generation === initial.generation && attestorDigest(result.incarnations) === attestorDigest(initial.incarnations);
          observeCacheReason(valid ? "source-attestor-finish-valid" : "source-attestor-finish-invalid-full-sha256");
          return valid;
        } catch { observeCacheReason("source-attestor-disconnected-full-sha256"); return false; }
        finally { connected.close(); }
      }, close: () => connected.close() };
  } catch (error) {
    channel?.close();
    observeCacheReason(`source-attestor-miss-full-sha256:${error instanceof Error ? error.message : "unknown"}`);
    // A confirmed dead process cannot hold leases. Retire only its exact
    // descriptor; THIS request still falls back, without an ambiguous retry.
    if (descriptor !== null) {
      try { process.kill(descriptor.pid, 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH" && await readFile(config.descriptor, "utf8").catch(() => "") === JSON.stringify(descriptor)) {
          // The epoch-specific socket belongs to this confirmed dead service.
          // Never remove a replacement service's endpoint or retry this read.
          await validateAttestorEndpoint(descriptor.endpoint);
          await unlink(descriptor.endpoint);
          if (await readFile(config.descriptor, "utf8").catch(() => "") === JSON.stringify(descriptor)) await unlink(config.descriptor);
        }
      }
    }
    return null;
  }
}
export async function controlSourceAttestor(root: string, home: string, op: "status" | "stop"): Promise<unknown> {
  const config = await configuration(root, home);
  if (config === null) return { available: false };
  const descriptor = await readDescriptor(config.descriptor, config.identity);
  if (descriptor === null) return { available: false };
  const channel = await connect(descriptor);
  try { const result = await channel.send({ op }); return { pid: descriptor.pid, epoch: descriptor.epoch, result }; }
  finally { channel.close(); }
}
