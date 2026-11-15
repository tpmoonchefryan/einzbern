// SPDX-License-Identifier: Apache-2.0
import { createHash, randomBytes } from "node:crypto";
import { readSync } from "node:fs";
import { chmod, readFile, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer, type Socket } from "node:net";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { ATTESTOR_MESSAGE_BYTES, ATTESTOR_SCHEMA, attestorDigest, attestorEndpoint, attestorMac, validateAttestorDirectory, validateAttestorEndpoint, validAttestorMac } from "./source-attestor-protocol.js";
import type { AttestorDescriptor, AttestorFile, AttestorRequest } from "./source-attestor-protocol.js";

interface Lease { readonly id: number; readonly fd: number; readonly incarnation: number }
interface Bridge {
  init(capacity: number): { capacity: number };
  acquire(path: string): Lease;
  check(ids: readonly number[]): boolean;
  release(id: number): void;
  status(): { generation: number; held: number; live: number; capacity: number };
  watch(directories: readonly { path: string; names: readonly string[] | null }[]): object;
  guardCheck(guard: object): boolean;
  guardClose(guard: object): void;
}
export interface AttestorLaunch {
  readonly root: string;
  readonly descriptor: string;
  readonly identity: string;
  readonly module: string;
  readonly capacity?: number;
}
interface Held { readonly declaration: AttestorFile; readonly lease: Lease }
interface Transaction {
  readonly request: AttestorRequest;
  readonly fingerprint: string;
  readonly token: string;
  readonly guard: object;
  readonly ids: readonly number[];
  readonly incarnations: readonly number[];
  readonly generation: number;
  readonly started: number;
}

function inside(root: string, path: string): boolean {
  const part = relative(root, path);
  return part === "" || (!isAbsolute(part) && part !== ".." && !part.startsWith("../"));
}
function validateRequest(value: AttestorRequest, launch: AttestorLaunch): void {
  if (value?.schema !== ATTESTOR_SCHEMA || value.root !== launch.root || !/^[a-f0-9]{64}$/u.test(value.binding)
    || !Array.isArray(value.files) || value.files.length === 0 || value.files.length > 8192
    || !Array.isArray(value.directories) || value.directories.length > 8192) throw new Error("request-binding");
  const names = new Set<string>();
  for (const file of value.files) {
    if (typeof file.path !== "string" || resolve(file.path) !== file.path || !inside(launch.root, file.path)
      || names.has(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 0
      || typeof file.metadata !== "boolean" || !/^[a-f0-9]{64}$/u.test(file.sha256)) throw new Error("file-binding");
    names.add(file.path);
  }
  for (const directory of value.directories) if (typeof directory !== "string" || resolve(directory) !== directory || !inside(launch.root, directory)) throw new Error("directory-binding");
}

/** One bounded, disposable process, no source writes and no authority on disk. */
export async function runSourceAttestor(launch: AttestorLaunch): Promise<void> {
  const require = createRequire(import.meta.url);
  const bridge = require(launch.module) as Bridge;
  bridge.init(launch.capacity ?? 4096);
  const epoch = randomBytes(32).toString("hex");
  const descriptor: AttestorDescriptor = { schema: ATTESTOR_SCHEMA, endpoint: attestorEndpoint(launch.descriptor, epoch),
    secret: randomBytes(32).toString("hex"), epoch, pid: process.pid, identity: launch.identity };
  const held = new Map<string, Held>();
  const sockets = new Set<Socket>();
  const transactions = new Map<Socket, Transaction>();
  let hashes = 0, hashedBytes = 0, stopping = false, ownsDescriptor = false;
  let lastActivity = performance.now();
  const release = (entry: Held): void => { bridge.release(entry.lease.id); held.delete(entry.declaration.path); };
  const clearTransaction = (socket: Socket): void => {
    const tx = transactions.get(socket);
    if (tx !== undefined) bridge.guardClose(tx.guard);
    transactions.delete(socket);
  };
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    for (const socket of sockets) { clearTransaction(socket); socket.destroy(); }
    for (const entry of held.values()) release(entry);
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (ownsDescriptor) {
      const current = await readFile(launch.descriptor, "utf8").catch(() => "");
      if (current === JSON.stringify(descriptor)) await unlink(launch.descriptor).catch(() => undefined);
    }
  };
  const resources = (): unknown => ({ ...bridge.status(), hashes, hashedBytes, transactions: transactions.size, ...process.memoryUsage() });
  function begin(socket: Socket, request: AttestorRequest): unknown {
    validateRequest(request, launch);
    clearTransaction(socket);
    const wanted = new Set(request.files.map(file => file.path));
    for (const entry of held.values()) {
      if (!wanted.has(entry.declaration.path) || !bridge.check([entry.lease.id])) release(entry);
    }
    if (request.files.length > bridge.status().capacity) throw new Error("fd-capacity");
    const directories = new Map<string, Set<string> | null>(request.directories.map(path => [path, null]));
    // Guard all current parent membership, including the root's named ancestry.
    for (const file of request.files) {
      let child = file.path;
      for (;;) {
        const directory = dirname(child);
        if (directory === child) break;
        if (!directories.has(directory)) directories.set(directory, new Set());
        directories.get(directory)?.add(basename(child));
        child = directory;
      }
    }
    const guard = bridge.watch([...directories].map(([path, names]) => ({ path, names: names === null ? null : [...names] })));
    const newEntries: Held[] = [];
    const reads: { path: string; bytes: number }[] = [];
    const ids: number[] = [], incarnations: number[] = [];
    try {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      for (const declaration of request.files) {
        let entry = held.get(declaration.path);
        if (entry !== undefined && attestorDigest(entry.declaration) !== attestorDigest(declaration)) { release(entry); entry = undefined; }
        if (entry === undefined) {
          const lease = bridge.acquire(declaration.path);
          entry = { declaration, lease }; newEntries.push(entry); held.set(declaration.path, entry);
          // The SHA-256 is read from exactly the fd that successfully acquired
          // the native lease. Neither a pathname read nor an expected digest
          // supplied by a client can manufacture an initial content proof.
          const hash = createHash("sha256"); let offset = 0;
          for (;;) {
            const n = readSync(lease.fd, buffer, 0, buffer.length, offset);
            if (n === 0) break;
            hash.update(buffer.subarray(0, n)); offset += n;
            if (offset > declaration.bytes) throw new Error("declared-length");
          }
          hashes++; hashedBytes += offset; reads.push({ path: declaration.path, bytes: offset });
          if (offset !== declaration.bytes || hash.digest("hex") !== declaration.sha256 || !bridge.check([lease.id])) throw new Error("leased-sha256");
        }
        ids.push(entry.lease.id); incarnations.push(entry.lease.incarnation);
      }
      if (!bridge.guardCheck(guard) || !bridge.check(ids) || !bridge.guardCheck(guard)) throw new Error("begin-source-changed");
      const tx: Transaction = { request, fingerprint: attestorDigest(request), token: randomBytes(32).toString("hex"), guard, ids, incarnations,
        generation: bridge.status().generation, started: performance.now() };
      transactions.set(socket, tx);
      return { valid: true, token: tx.token, fingerprint: tx.fingerprint, generation: tx.generation, incarnations, reads, resources: resources() };
    } catch (error) {
      bridge.guardClose(guard);
      for (const entry of newEntries) if (held.get(entry.declaration.path) === entry) release(entry);
      return { valid: false, reads, reason: error instanceof Error ? error.message : "begin-failed", resources: resources() };
    }
  }
  function finish(socket: Socket, message: { token?: string; fingerprint?: string }): unknown {
    const tx = transactions.get(socket);
    if (tx === undefined) throw new Error("transaction-missing");
    try {
      // All metadata files are leased as well as hashed. The directory guard
      // brackets native fd/current-name checks; dirty/overflow is permanent.
      // The final clean guard and generation sample are the finish boundary.
      const valid = message.token === tx.token && message.fingerprint === tx.fingerprint && performance.now() - tx.started < 5000
        && bridge.guardCheck(tx.guard) && bridge.check(tx.ids) && bridge.guardCheck(tx.guard) && bridge.status().generation === tx.generation;
      return { valid, token: tx.token, fingerprint: tx.fingerprint, generation: tx.generation, incarnations: tx.incarnations, resources: resources() };
    } finally { clearTransaction(socket); }
  }
  const server = createServer(socket => {
    sockets.add(socket); lastActivity = performance.now();
    socket.setTimeout(5000, () => socket.destroy());
    let input = Buffer.alloc(0), requestNumber = 0;
    socket.on("data", chunk => {
      input = Buffer.concat([input, chunk]);
      if (input.length > ATTESTOR_MESSAGE_BYTES) { socket.destroy(); return; }
      let end: number;
      while ((end = input.indexOf(10)) >= 0) {
        const line = input.subarray(0, end); input = input.subarray(end + 1);
        lastActivity = performance.now();
        try {
          const envelope = JSON.parse(line.toString("utf8")); const body = envelope.body;
          if (!validAttestorMac(descriptor.secret, body, envelope.mac) || body.epoch !== descriptor.epoch || body.number !== ++requestNumber
            || typeof body.nonce !== "string" || !/^[a-f0-9]{64}$/u.test(body.nonce)) throw new Error("ipc-authentication");
          let result: unknown;
          if (body.op === "begin" && requestNumber === 1) result = begin(socket, body.request);
          else if (body.op === "finish" && requestNumber === 2) result = finish(socket, body);
          else if (body.op === "status" && requestNumber === 1) result = { valid: false, resources: resources() };
          else if (body.op === "stop" && requestNumber === 1) result = { valid: false, stopping: true };
          else throw new Error("ipc-order");
          const response = { epoch: descriptor.epoch, number: body.number, nonce: body.nonce, result };
          socket.write(JSON.stringify({ body: response, mac: attestorMac(descriptor.secret, response) }) + "\n");
          if (body.op === "stop") socket.end(() => { void stop(); });
        } catch (error) {
          clearTransaction(socket);
          const reason = error instanceof Error ? error.message : "attestor-failed";
          socket.write(JSON.stringify({ error: reason }) + "\n");
          socket.end();
        }
      }
    });
    socket.on("error", () => undefined);
    socket.on("close", () => { clearTransaction(socket); sockets.delete(socket); lastActivity = performance.now(); });
  });
  server.maxConnections = 16;
  const timer = setInterval(() => {
    for (const [socket, tx] of transactions) if (performance.now() - tx.started >= 5000) { clearTransaction(socket); socket.destroy(); }
    // Resource failure never evicts source bytes into a fabricated proof.
    if ((sockets.size === 0 && performance.now() - lastActivity >= 60_000) || process.memoryUsage().rss > 256 * 1024 * 1024) void stop();
  }, 250);
  process.once("SIGTERM", () => { void stop(); }); process.once("SIGINT", () => { void stop(); });
  try {
    await validateAttestorDirectory(dirname(launch.descriptor));
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(descriptor.endpoint, resolve); });
    await chmod(descriptor.endpoint, 0o600);
    await validateAttestorEndpoint(descriptor.endpoint);
    await writeFile(launch.descriptor, JSON.stringify(descriptor), { flag: "wx", mode: 0o600 }); ownsDescriptor = true;
    process.stdout.write(JSON.stringify({ ready: true, pid: process.pid }) + "\n");
  } catch (error) { await stop(); throw error; }
}
