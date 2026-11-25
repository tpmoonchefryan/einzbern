// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

type Params = Record<string, unknown>;
export type CodexCall = (method: string, params: Params) => Promise<unknown>;
const maximum = 32 * 1024 * 1024;

// The public Codex proxy connects only to the existing local control socket. Its
// stdio carries WebSocket frames, not newline-delimited JSON. No listener or daemon is started.
function clientFrame(opcode: number, bytes: Buffer): Buffer {
  const size = bytes.length < 126 ? 2 : bytes.length < 65536 ? 4 : 10;
  const head = Buffer.alloc(size + 4);
  head[0] = 0x80 | opcode;
  head[1] = 0x80 | (size === 2 ? bytes.length : size === 4 ? 126 : 127);
  if (size === 4) head.writeUInt16BE(bytes.length, 2);
  if (size === 10) head.writeBigUInt64BE(BigInt(bytes.length), 2);
  const mask = randomBytes(4);
  mask.copy(head, size);
  const body = Buffer.from(bytes);
  for (let i = 0; i < body.length; i++) body[i] = body[i]! ^ mask[i % 4]!;
  return Buffer.concat([head, body]);
}

export async function withLocalCodex<T>(operation: (call: CodexCall) => Promise<T>): Promise<T> {
  const proxy = spawn("codex", ["app-server", "proxy"], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
  const key = randomBytes(16).toString("base64");
  const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  let buffer: Buffer = Buffer.alloc(0);
  let fragments: Buffer[] = [];
  let fragmentSize = 0;
  let connected = false;
  let sequence = 0;
  const ready = Promise.withResolvers<void>();
  const pending = new Map<number, ReturnType<typeof Promise.withResolvers<unknown>>>();
  let failure: Error | undefined;
  function stop(error: Error): void {
    failure = error;
    ready.reject(error);
    for (const ticket of pending.values()) ticket.reject(error);
    proxy.kill();
  }
  const write = (value: unknown) => proxy.stdin.write(clientFrame(1, Buffer.from(JSON.stringify(value))));
  const call: CodexCall = async (method, params) => {
    if (failure) throw failure;
    const id = ++sequence;
    const ticket = Promise.withResolvers<unknown>();
    pending.set(id, ticket);
    const timeout = setTimeout(() => stop(new Error("Codex RPC timed out: " + method)), 10000);
    try {
      write({ id, method, params });
      return await ticket.promise;
    } finally { clearTimeout(timeout); pending.delete(id); }
  };
  function consume(): void {
    if (!connected) {
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) {
        if (buffer.length > 8192) throw new Error("Oversized Codex proxy handshake");
        return;
      }
      const headers = buffer.subarray(0, end).toString("ascii").split("\r\n");
      if (!/^HTTP\/1\.1 101\b/u.test(headers[0]!) || !headers.some(h => h.toLowerCase().startsWith("sec-websocket-accept:") && h.slice(h.indexOf(":")+1).trim() === accept)) throw new Error("Codex proxy upgrade refused");
      buffer = buffer.subarray(end + 4);
      connected = true;
      ready.resolve();
    }
    while (buffer.length >= 2) {
      const first = buffer[0]!, second = buffer[1]!;
      const opcode = first & 15, final = (first & 128) !== 0;
      if ((first & 112) || (second & 128)) throw new Error("Unsupported Codex frame flags");
      let length = second & 127, offset = 2;
      if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
      else if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
      if (length > maximum) throw new Error("Oversized Codex frame");
      if (buffer.length < offset + length) return;
      const data = buffer.subarray(offset, offset + length);
      buffer = buffer.subarray(offset + length);
      if (opcode >= 8 && (!final || length > 125)) throw new Error("Invalid Codex control frame");
      if (opcode === 8) throw new Error("Codex proxy closed");
      if (opcode === 9) { proxy.stdin.write(clientFrame(10, data)); continue; }
      if (opcode === 10) continue;
      if (opcode !== (fragments.length ? 0 : 1)) throw new Error("Unexpected Codex message frame");
      fragmentSize += length;
      if (fragmentSize > maximum) throw new Error("Oversized Codex response");
      fragments.push(data);
      if (!final) continue;
      const msg = JSON.parse(Buffer.concat(fragments).toString("utf8"));
      fragments = []; fragmentSize = 0;
      const ticket = pending.get(msg.id);
      if (ticket) {
        if (msg.error) ticket.reject(new Error("Codex RPC: " + String(msg.error.message ?? msg.error.code)));
        else ticket.resolve(msg.result);
      }
    }
  }
  proxy.once("error", stop);
  proxy.stdin.on("error", stop);
  proxy.once("close", () => stop(new Error("Codex proxy exited")));
  proxy.stdout.on("data", (chunk: Buffer) => {
    try { buffer = Buffer.concat([buffer, chunk]); consume(); }
    catch (error) { stop(error instanceof Error ? error : new Error(String(error))); }
  });
  const timer = setTimeout(() => stop(new Error("Codex proxy handshake timed out")), 8000);
  try {
    proxy.stdin.write("GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: " + key + "\r\nSec-WebSocket-Version: 13\r\n\r\n");
    await ready.promise;
    clearTimeout(timer);
    await call("initialize", { clientInfo: { name: "einzbern_batch", version: "1" }, capabilities: { experimentalApi: true } });
    write({ method: "initialized" });
    return await operation(call);
  } finally { clearTimeout(timer); proxy.kill(); }
}
