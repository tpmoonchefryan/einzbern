// SPDX-License-Identifier: Apache-2.0
// Independent syscall-facing read journal for isolated attestor tests. This
// records real read calls, rather than trusting the product's counters.
import fs from "node:fs";
import promises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const output = process.env.EINZBERN_ATTESTOR_READ_JOURNAL;
const root = process.env.EINZBERN_SOURCE_ATTESTOR_ROOT || process.env.SOURCE_READ_ROOT;
if (output && root) {
  const append = fs.appendFileSync;
  const named = value => {
    if (typeof value !== "number") return String(value);
    try { return fs.readlinkSync(`/proc/self/fd/${value}`); } catch { return ""; }
  };
  const record = (path, bytes, operation) => {
    const source = named(path);
    if (source.startsWith(root + "/") && source.endsWith(".ndjson")) append(output, JSON.stringify({ pid: process.pid, operation, path: source, bytes }) + "\n");
  };
  const readSync = fs.readSync;
  fs.readSync = function(fd, ...args) { const n = readSync.call(this, fd, ...args); record(fd, n, "readSync"); return n; };
  const readFile = promises.readFile;
  promises.readFile = async function(path, ...args) { const value = await readFile.call(this, path, ...args); record(path, Buffer.byteLength(value), "readFile"); return value; };
  const open = promises.open;
  promises.open = async function(path, ...args) {
    const handle = await open.call(this, path, ...args);
    const read = handle.read, readFile = handle.readFile;
    handle.read = async function(...args) { const r = await read.call(this, ...args); record(path, r.bytesRead, "handle.read"); return r; };
    handle.readFile = async function(...args) { const r = await readFile.call(this, ...args); record(path, Buffer.byteLength(r), "handle.readFile"); return r; };
    return handle;
  };
  syncBuiltinESMExports();
}
