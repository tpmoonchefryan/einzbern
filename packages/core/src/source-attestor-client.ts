// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants, writeSync } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, unlink } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FRAMEWORK_VERSION } from "./framework-version.js";
import { observeCacheReason, observeEventRead, observeMetadataBytes } from "./recall-observation.js";
import { ATTESTOR_MESSAGE_BYTES, ATTESTOR_SCHEMA, CREST_PROOF_SCHEMA, attestorDigest, attestorEndpoint, attestorMac, attestorMountContext, validateAttestorDirectory, validateAttestorEndpoint, validAttestorMac } from "./source-attestor-protocol.js";
import type { AttestorDescriptor, AttestorRequest, CrestAttestorRequest } from "./source-attestor-protocol.js";

interface BeginResult {
  readonly valid: boolean;
  readonly reason?: string;
  readonly token: string;
  readonly fingerprint: string;
  readonly generation: number;
  readonly incarnations: readonly number[];
  readonly reads: readonly { path: string; bytes: number }[];
  readonly resources: unknown;
  readonly sourceSet?: string;
  readonly context?: string;
  readonly warm?: boolean;
  readonly pending?: boolean;
  readonly progress?: number;
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
interface BoundDescriptor { readonly value: AttestorDescriptor; readonly file: string }
async function readDescriptor(path: string, identity: string): Promise<BoundDescriptor | null> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat({ bigint: true });
    if (!info.isFile() || info.nlink !== 1n || info.uid !== BigInt(process.getuid!()) || (info.mode & 0o077n) !== 0n || info.size > 4096n) return null;
    const descriptor = JSON.parse(await handle.readFile("utf8")) as AttestorDescriptor;
    return descriptor.schema === ATTESTOR_SCHEMA && descriptor.identity === identity && typeof descriptor.endpoint === "string"
      && descriptor.endpoint === attestorEndpoint(path, descriptor.epoch) && /^[a-f0-9]{64}$/u.test(descriptor.secret)
      && Number.isSafeInteger(descriptor.pid) && descriptor.pid > 0
      ? { value: descriptor, file: [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":") } : null;
  } catch { return null; }
  finally { await handle?.close(); }
}
async function configuration(root: string, home: string, crestRoots?: readonly string[]): Promise<{ host: string; module: string; identity: string; descriptor: string; crestRoots?: readonly string[] } | null> {
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
    const identity = attestorDigest({ schema: ATTESTOR_SCHEMA, ...(crestRoots === undefined ? {} : { domain: CREST_PROOF_SCHEMA, roots: crestRoots }), engine: FRAMEWORK_VERSION, runtime: process.version, executable: await realpath(process.execPath),
      platform: process.platform, architecture: process.arch, host: attestorDigest(await readFile(host)), native: attestorDigest(await readFile(module)) });
    const directory = join(home, "source-attestor", attestorDigest([root, identity]).slice(0, 32));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const path of [join(home, "source-attestor"), directory]) {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || await realpath(path) !== path) throw new Error("private-runtime-boundary");
    }
    return { host, module, identity, descriptor: join(directory, "endpoint.json"), ...(crestRoots === undefined ? {} : { crestRoots }) };
  } catch {
    observeCacheReason("source-attestor-capability-unavailable-full-sha256");
    return null;
  }
}
async function start(config: NonNullable<Awaited<ReturnType<typeof configuration>>>, root: string): Promise<void> {
  const log = await open(join(dirname(config.descriptor), "service.log"), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  // Under the test controller the companion stays in its already-owned group.
  // Private pipes keep every inherited output FD behind the unchanged policy.
  const controlled = process.env.TCRN_TEST_CONTROLLER_PROCESS_GROUP !== undefined;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const capacity = Number(process.env.EINZBERN_SOURCE_ATTESTOR_FDS ?? "4096");
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 8192) throw new Error("fd-capacity");
    child = spawn(process.execPath, ["--max-old-space-size=128", config.host], { detached: !controlled, stdio: ["pipe", "pipe", controlled ? "pipe" : log.fd] });
    const launched = child;
    if (controlled) {
      launched.stderr!.on("data", value => { writeSync(log.fd, value); });
      launched.once("close", () => { void log.close().catch(() => undefined); });
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { launched.kill("SIGTERM"); reject(new Error("attestor-start-timeout")); }, 1500);
      launched.once("error", error => { clearTimeout(timer); reject(error); });
      launched.once("exit", () => { clearTimeout(timer); reject(new Error("attestor-start-failed")); });
      launched.stdout!.once("data", value => {
        clearTimeout(timer);
        try { if (JSON.parse(value.toString()).ready !== true) throw new Error("attestor-not-ready"); resolve(); }
        catch (error) { reject(error); }
      });
      launched.stdin!.end(JSON.stringify({ root, descriptor: config.descriptor, identity: config.identity, module: config.module, capacity, crestRoots: config.crestRoots }));
    });
    child.stdout!.destroy();
    if (controlled) (child.stderr as Socket).unref();
    child.unref();
  } catch (error) {
    child?.kill("SIGTERM");
    throw error;
  } finally { if (!controlled || child === undefined) await log.close(); }
}

async function retireDeadDescriptor(config: { descriptor: string; identity: string }, original: BoundDescriptor): Promise<void> {
  try {
    try { process.kill(original.value.pid, 0); return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return; }
    await validateAttestorDirectory(dirname(config.descriptor));
    const current = await readDescriptor(config.descriptor, config.identity);
    if (attestorDigest(current) !== attestorDigest(original)) return;
    // Only lstat of the exact endpoint may admit absence. A failed parent or
    // socket validation, including a replacement/symlink, never authorizes it.
    const endpoint = original.value.endpoint;
    let absent = false;
    try { await lstat(endpoint); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; absent = true; }
    if (!absent) { await validateAttestorEndpoint(endpoint); await unlink(endpoint); }
    await validateAttestorDirectory(dirname(config.descriptor));
    if (attestorDigest(await readDescriptor(config.descriptor, config.identity)) === attestorDigest(original)) await unlink(config.descriptor);
  } catch { /* Optional recovery cannot replace this request's full SHA fallback. */ }
}
export async function beginSourceAttestation(request: AttestorRequest, home: string): Promise<SourceAttestation | null> {
  const config = await configuration(request.root, home);
  if (config === null) return null;
  let channel: Connection | undefined;
  let descriptor: AttestorDescriptor | null = null;
  let bound: BoundDescriptor | null = null;
  try {
    try { await lstat(config.descriptor); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; await start(config, request.root); }
    bound = await readDescriptor(config.descriptor, config.identity);
    descriptor = bound?.value ?? null;
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
    if (bound !== null) await retireDeadDescriptor(config, bound);
    return null;
  }
}
export interface CrestAttestation extends SourceAttestation { readonly binding: string }

/** A separate endpoint/root collection prevents Akasha's request-set eviction
 * from silently retiring Crest continuity. No native addon loads in the client. */
export async function beginCrestAttestation(value: Omit<CrestAttestorRequest, "context">, home: string, warmOnly = false): Promise<CrestAttestation | null> {
  const config = await configuration(value.root, home, value.roots);
  if (config === null) return null;
  let channel: Connection | undefined;
  let bound: BoundDescriptor | null = null;
  try {
    const request: CrestAttestorRequest = { ...value, context: attestorMountContext() };
    try { await lstat(config.descriptor); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; await start(config, value.root); }
    bound = await readDescriptor(config.descriptor, config.identity);
    if (bound === null) throw new Error("descriptor-unavailable");
    const descriptor = bound.value;
    channel = await connect(descriptor);
    const started = performance.now();
    let initial = await channel.send({ op: "crest-begin", request, warmOnly });
    let progress = 0;
    const token = initial.token;
    while (initial.pending === true) {
      if (!initial.valid || initial.token !== token || initial.fingerprint !== attestorDigest(request)
        || !Number.isSafeInteger(initial.progress) || initial.progress! <= progress || initial.progress! > 8192 || performance.now() - started >= 5000) throw new Error("crest-preparation-progress");
      progress = initial.progress!;
      initial = await channel.send({ op: "crest-next", token, fingerprint: initial.fingerprint, context: request.context, progress });
    }
    for (const read of initial.reads ?? []) if (Number.isSafeInteger(read.bytes) && read.bytes >= 0) observeMetadataBytes(read.bytes);
    if (!initial.valid || initial.fingerprint !== attestorDigest(request) || typeof initial.token !== "string" || initial.token !== token
      || !Array.isArray(initial.incarnations) || !Array.isArray(initial.reads) || initial.context !== request.context
      || typeof initial.sourceSet !== "string" || !/^[a-f0-9]{64}$/u.test(initial.sourceSet)
      || typeof initial.warm !== "boolean" || attestorMountContext() !== request.context) throw new Error(initial.reason ?? "crest-begin-binding");
    const connected = channel;
    const binding = attestorDigest({ schema: CREST_PROOF_SCHEMA, fingerprint: initial.fingerprint, sourceSet: initial.sourceSet, epoch: descriptor.epoch,
      identity: descriptor.identity, generation: initial.generation, incarnations: initial.incarnations });
    observeCacheReason(initial.warm ? "crest-source-set-warm" : "crest-source-set-leased-sha256");
    return { initial, binding, epoch: descriptor.epoch,
      finish: async () => {
        try {
          const result = await connected.send({ op: "finish", token: initial.token, fingerprint: initial.fingerprint, context: attestorMountContext() });
          const valid = result.valid === true && result.token === initial.token && result.fingerprint === initial.fingerprint
            && result.generation === initial.generation && result.sourceSet === initial.sourceSet && result.context === initial.context
            && attestorDigest(result.incarnations) === attestorDigest(initial.incarnations) && attestorMountContext() === request.context;
          observeCacheReason(valid ? "crest-source-set-finish-valid" : "crest-source-set-finish-invalid-full-scan");
          return valid;
        } catch { observeCacheReason("crest-source-set-disconnected-full-scan"); return false; }
        finally { connected.close(); }
      }, close: () => connected.close() };
  } catch (error) {
    channel?.close();
    observeCacheReason(`crest-source-set-miss-full-scan:${error instanceof Error ? error.message : "unknown"}`);
    if (bound !== null) await retireDeadDescriptor(config, bound);
    return null;
  }
}

export async function controlSourceAttestor(root: string, home: string, op: "status" | "stop", crestRoots?: readonly string[]): Promise<unknown> {
  const config = await configuration(root, home, crestRoots);
  if (config === null) return { available: false };
  const bound = await readDescriptor(config.descriptor, config.identity);
  if (bound === null) return { available: false };
  const descriptor = bound.value;
  const channel = await connect(descriptor);
  try { const result = await channel.send({ op }); return { pid: descriptor.pid, epoch: descriptor.epoch, result }; }
  finally { channel.close(); }
}
