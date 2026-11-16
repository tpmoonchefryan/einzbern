// SPDX-License-Identifier: Apache-2.0
import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { renameSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { beginSourceAttestation, controlSourceAttestor } from "../dist/build/packages/core/src/source-attestor-client.js";
import { ATTESTOR_SCHEMA, attestorDigest, attestorMac, validateAttestorEndpoint } from "../dist/build/packages/core/src/source-attestor-protocol.js";
import { initializeLibrary, createProject, appendEvents, createWorkDelta, setWorkspaceSetting, readAllStreams, materializeWorkspaceFromGenesis, declareChainIdentity, consolidateLibraries, registerLibrary,
  createKnowledgeUnit, initializeKnowledgeStore, recordMinutes, cachePath } from "../dist/build/packages/core/src/index.js";
import { withRecallObservation } from "../dist/build/packages/core/src/recall-observation.js";
import { withWorkspaceWriteLock } from "../dist/build/packages/core/src/workspace.js";
import { canonicalSha256 } from "../dist/build/packages/protocol/src/index.js";

const repo = fileURLToPath(new URL("../", import.meta.url));
const addon = resolve(repo, "dist/native/linux-source-lease.node");
const at = "2026-11-13T00:00:00Z";
const journal = process.env.EINZBERN_ATTESTOR_COMMAND_JOURNAL;
const enabled = process.platform === "linux" && await fs.stat(addon).then(() => true, () => false);
function log(value) { if (journal) return fs.appendFile(journal, JSON.stringify(value) + "\n"); }
async function run(argv, options = {}) {
  const started = performance.now();
  const r = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", env: process.env, timeout: 15000, maxBuffer: 32 * 1024 * 1024, ...options });
  const environment = options.env ?? process.env;
  const keys = ["PATH", "TMPDIR", "NODE_OPTIONS", "EINZBERN_HOME", "EINZBERN_TEST_DEVICE_ROOT", "EINZBERN_SOURCE_ATTESTOR_ROOT", "EINZBERN_SOURCE_LEASE_MODULE", "EINZBERN_SOURCE_ATTESTOR_FDS", "EINZBERN_ATTESTOR_READ_JOURNAL", "TCRN_OFFLINE_PROOF", "TCRN_TEST_CONTROLLER_PROCESS_GROUP", "TCRN_TEST_CONTROLLER_REAPER_PID", "TCRN_TEST_CONTROLLER_CHILD_REGISTRY"];
  await log({ argv, cwd: options.cwd ?? process.cwd(), envBoundary: Object.fromEntries(keys.filter(key => environment[key] !== undefined).map(key => [key, environment[key]])), pid: r.pid, childStarted: r.pid > 0, exitCode: r.status, signal: r.signal, timedOut: r.error?.code === "ETIMEDOUT", timeoutMs: options.timeout ?? 15000, stdout: r.stdout, stderr: r.stderr, elapsedMs: performance.now() - started });
  return r;
}
async function setup(t) {
  const base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "attestor-")));
  const root = join(base, "source"), home = join(base, "device");
  await fs.mkdir(root); await fs.mkdir(home, { mode: 0o700 });
  const original = { ...process.env };
  process.env.EINZBERN_SOURCE_ATTESTOR_ROOT = root;
  process.env.EINZBERN_SOURCE_LEASE_MODULE = addon;
  process.env.EINZBERN_HOME = home;
  delete process.env.EINZBERN_SOURCE_ATTESTOR_FDS;
  const actor = join(base, "actor");
  const build = await run(["cc", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", resolve(repo, "tests/fixtures/source-lease-actor.c"), "-o", actor]);
  assert.equal(build.status, 0, build.stderr);
  t.after(async () => {
    process.env.EINZBERN_SOURCE_LEASE_MODULE = addon;
    process.env.EINZBERN_SOURCE_ATTESTOR_ROOT = root;
    await controlSourceAttestor(root, home, "stop").catch(() => undefined);
    // Read back cleanup before deleting the owned fixture.
    for (const descriptor of await descriptors(home)) {
      try { process.kill(descriptor.pid, "SIGCONT"); process.kill(descriptor.pid, "SIGTERM"); } catch {}
    }
    await delay(50);
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    await fs.rm(base, { recursive: true, force: true });
  });
  return { base, root, home, actor };
}
async function descriptors(home) {
  const directory = join(home, "source-attestor");
  const result = [];
  for (const name of await fs.readdir(directory).catch(() => [])) {
    try { result.push(JSON.parse(await fs.readFile(join(directory, name, "endpoint.json"), "utf8"))); } catch {}
  }
  return result;
}
async function rawConnection(descriptor) {
  await validateAttestorEndpoint(descriptor.endpoint);
  return createConnection(descriptor.endpoint);
}
async function raw(f, n = 3) {
  const files = [];
  for (let i = 0; i < n; i++) {
    const path = join(f.root, `segment-${i}.ndjson`), bytes = Buffer.from(`owned original segment ${i}\n`);
    await fs.writeFile(path, bytes);
    files.push({ path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), metadata: false });
  }
  return { schema: ATTESTOR_SCHEMA, root: f.root, binding: "a".repeat(64), directories: [f.root], files };
}
async function readClient(request, home) {
  const source = `import {beginSourceAttestation} from ${JSON.stringify(new URL("../dist/build/packages/core/src/source-attestor-client.js", import.meta.url).href)};
    const proof=await beginSourceAttestation(JSON.parse(process.argv[1]),process.argv[2]);
    console.log(JSON.stringify({pid:process.pid,initial:proof?.initial??null,epoch:proof?.epoch,valid:await proof?.finish()??false}));`;
  const r = await run([process.execPath, "--input-type=module", "-e", source, JSON.stringify(request), home]);
  assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout);
}
async function materialize(f, extra = {}) {
  const source = `import {materializeLibrary,materializeWorkspaceFromGenesis} from ${JSON.stringify(new URL("../dist/build/packages/core/src/index.js", import.meta.url).href)};
    import {withRecallObservation} from ${JSON.stringify(new URL("../dist/build/packages/core/src/recall-observation.js", import.meta.url).href)};
    import {canonicalSha256} from ${JSON.stringify(new URL("../dist/build/packages/protocol/src/index.js", import.meta.url).href)};
    const r=await withRecallObservation(()=>materializeLibrary(process.argv[1]));console.log(JSON.stringify({pid:process.pid,head:r.value.headEventHash,digest:canonicalSha256(r.value),observation:r.observation}));`;
  const r = await run([process.execPath, "--input-type=module", "-e", source, f.root], { env: { ...process.env, ...extra } });
  return { ...r, value: r.status === 0 ? JSON.parse(r.stdout) : null };
}
async function holder(f, mode, path) {
  const argv = [f.actor, mode, path];
  const child = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = ""; child.stdout.on("data", b => stdout += b); child.stderr.on("data", b => stderr += b);
  const done = new Promise(resolve => child.on("exit", async code => { await log({ argv, cwd: process.cwd(), pid: child.pid, exitCode: code, stdout, stderr }); resolve(code); }));
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const ready = JSON.parse((await lines.next()).value);
  assert.equal(ready.ready, true);
  return { child, ready, done, stop: async () => { child.stdin.end("stop\n"); assert.equal(await done, 0, stderr); } };
}

test("attestor: distinct clients share real same-fd SHA; restart, binding and source damage", { skip: !enabled }, async t => {
  const f = await setup(t), request = await raw(f);
  const first = await readClient(request, f.home), second = await readClient(request, f.home);
  assert.notEqual(first.pid, second.pid); assert.equal(first.valid, true); assert.equal(second.valid, true);
  assert.equal(first.initial.reads.length, 3); assert.deepEqual(second.initial.reads, []);
  assert.equal(second.epoch, first.epoch); assert.deepEqual(second.initial.incarnations, first.initial.incarnations);
  const initialDescriptor = (await descriptors(f.home))[0];
  const descriptorPath = join(dirname(initialDescriptor.endpoint), "endpoint.json");
  assert.equal((await fs.lstat(initialDescriptor.endpoint)).isSocket(), true);
  assert.equal((await fs.lstat(initialDescriptor.endpoint)).mode & 0o077, 0);
  for (const endpoint of ["\0einzbern-source-legacy", "relative.sock", "127.0.0.1:9", join(f.home, "absent")]) {
    await fs.writeFile(descriptorPath, JSON.stringify({ ...initialDescriptor, endpoint }));
    assert.equal((await readClient(request, f.home)).valid, false, endpoint);
  }
  await fs.writeFile(descriptorPath, JSON.stringify(initialDescriptor));
  await fs.chmod(initialDescriptor.endpoint, 0o666);
  assert.equal((await readClient(request, f.home)).valid, false, "shared socket cannot attest");
  await fs.chmod(initialDescriptor.endpoint, 0o600);
  await fs.chmod(dirname(initialDescriptor.endpoint), 0o755);
  assert.equal((await readClient(request, f.home)).valid, false, "shared directory cannot attest");
  await fs.chmod(dirname(initialDescriptor.endpoint), 0o700);
  await fs.rename(initialDescriptor.endpoint, initialDescriptor.endpoint + ".held");
  await fs.symlink(initialDescriptor.endpoint + ".held", initialDescriptor.endpoint);
  assert.equal((await readClient(request, f.home)).valid, false, "symlink socket cannot attest");
  await fs.unlink(initialDescriptor.endpoint);
  await fs.rename(initialDescriptor.endpoint + ".held", initialDescriptor.endpoint);
  assert.equal((await readClient(request, f.home)).valid, true);
  const proof = await beginSourceAttestation(request, f.home);
  const descriptor = (await descriptors(f.home))[0]; process.kill(descriptor.pid, "SIGKILL"); await delay(30);
  assert.equal(await proof.finish(), false);
  assert.equal((await readClient(request, f.home)).valid, false, "dead descriptor request falls back");
  const restarted = await readClient(request, f.home);
  assert.equal(restarted.valid, true); assert.notEqual(restarted.epoch, first.epoch); assert.equal(restarted.initial.reads.length, 3);
  const foreign = await readClient({ ...request, root: f.base }, f.home); assert.equal(foreign.valid, false);
  const badDigest = structuredClone(request); badDigest.files[0].sha256 = "0".repeat(64);
  assert.equal((await readClient(badDigest, f.home)).valid, false);
});

async function stoppedDescriptor(f) {
  const descriptor = (await descriptors(f.home))[0];
  assert.ok(descriptor);
  await controlSourceAttestor(f.root, f.home, "stop");
  let dead = false;
  for (let n = 0; n < 150; n++) {
    try { process.kill(descriptor.pid, 0); }
    catch (error) { if (error.code === "ESRCH") { dead = true; break; } throw error; }
    await delay(10);
  }
  assert.equal(dead, true, "the service has actually exited");
  await assert.rejects(fs.lstat(descriptor.endpoint), { code: "ENOENT" });
  const path = join(dirname(descriptor.endpoint), "endpoint.json");
  await fs.writeFile(path, JSON.stringify(descriptor), { flag: "wx", mode: 0o600 });
  return { descriptor, path };
}

test("attestor: exact dead descriptor with absent socket falls back completely, retires, then fresh clients restart", { skip: !enabled }, async t => {
  const f = await setup(t);
  await initializeLibrary({ root: f.root, createdAt: at });
  await createProject(f.root, { externalKey: "DEAD-ENDPOINT", name: "Dead endpoint", occurredAt: at });
  const first = await materialize(f);
  assert.equal(first.status, 0, first.stderr);
  const { descriptor, path } = await stoppedDescriptor(f);
  const fallback = await materialize(f);
  assert.equal(fallback.status, 0, fallback.stderr);
  assert.ok(fallback.value.observation.logicalEventBytes > 0, "this client still performs full SHA");
  assert.equal(fallback.value.digest, first.value.digest);
  assert.equal(fallback.value.digest, canonicalSha256(await materializeWorkspaceFromGenesis(f.root)), "complete public history is retained");
  await assert.rejects(fs.lstat(path), { code: "ENOENT" });
  const restarted = await materialize(f);
  assert.equal(restarted.status, 0, restarted.stderr);
  assert.notEqual((await descriptors(f.home))[0].epoch, descriptor.epoch);
  assert.ok(restarted.value.observation.logicalEventBytes > 0, "a new epoch does its own initial SHA");
  const warm = await materialize(f);
  assert.equal(warm.status, 0, warm.stderr);
  assert.equal(warm.value.observation.logicalEventBytes, 0);
  assert.equal(warm.value.digest, first.value.digest);
});

test("attestor: absent socket never retires untrusted, live, unknown or replaced descriptors", { skip: !enabled }, async t => {
  const f = await setup(t), request = await raw(f);
  assert.equal((await readClient(request, f.home)).valid, true);
  const { descriptor, path } = await stoppedDescriptor(f);
  const bytes = JSON.stringify(descriptor);
  for (const value of [
    "malformed", { ...descriptor, schema: "other" }, { ...descriptor, identity: "0".repeat(64) },
    { ...descriptor, epoch: "0".repeat(64) }, { ...descriptor, endpoint: join(f.home, "absent") },
    { ...descriptor, secret: "invalid" }, { ...descriptor, pid: 0 }, { ...descriptor, pid: process.pid },
  ]) {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    await fs.writeFile(path, text);
    assert.equal((await readClient(request, f.home)).valid, false);
    assert.equal(await fs.readFile(path, "utf8"), text);
  }
  await fs.writeFile(path, bytes);
  for (const boundary of ["descriptor-mode", "descriptor-hardlink", "descriptor-symlink", "parent-mode", "socket-file", "socket-symlink"]) {
    if (boundary === "descriptor-mode") await fs.chmod(path, 0o666);
    if (boundary === "descriptor-hardlink") await fs.link(path, path + ".held");
    if (boundary === "descriptor-symlink") { await fs.rename(path, path + ".held"); await fs.symlink(path + ".held", path); }
    if (boundary === "parent-mode") await fs.chmod(dirname(path), 0o755);
    if (boundary === "socket-file") await fs.writeFile(descriptor.endpoint, "replacement", { mode: 0o600 });
    if (boundary === "socket-symlink") await fs.symlink(path, descriptor.endpoint);
    assert.equal((await readClient(request, f.home)).valid, false, boundary);
    assert.equal(await fs.readFile(path, "utf8"), bytes, boundary);
    if (boundary === "descriptor-mode") await fs.chmod(path, 0o600);
    if (boundary === "descriptor-hardlink") await fs.unlink(path + ".held");
    if (boundary === "descriptor-symlink") { await fs.unlink(path); await fs.rename(path + ".held", path); }
    if (boundary === "parent-mode") await fs.chmod(dirname(path), 0o700);
    if (boundary.startsWith("socket-")) await fs.unlink(descriptor.endpoint);
  }
  const originalKill = process.kill;
  for (const mutation of ["EPERM", "EIO", "replace"]) {
    process.kill = function (pid, signal) {
      if (pid !== descriptor.pid || signal !== 0) return originalKill.call(this, pid, signal);
      try { originalKill.call(this, pid, signal); }
      catch (error) {
        assert.equal(error.code, "ESRCH");
        if (mutation === "replace") { writeFileSync(path + ".new", bytes, { mode: 0o600 }); renameSync(path + ".new", path); }
        else error.code = mutation;
        throw error;
      }
    };
    try { assert.equal(await beginSourceAttestation(request, f.home), null, mutation); }
    finally { process.kill = originalKill; }
    assert.equal(await fs.readFile(path, "utf8"), bytes, mutation);
  }
});

for (const mode of ["hold", "hold-map", "hold-fork-map"]) test(`attestor: existing ${mode} denies initial lease, including fd-closed mmap`, { skip: !enabled }, async t => {
  const f = await setup(t), request = await raw(f), h = await holder(f, mode, request.files[0].path);
  try { assert.equal((await readClient(request, f.home)).valid, false); }
  finally { await h.stop(); }
  assert.equal((await readClient(request, f.home)).valid, true);
});

for (const mode of ["write", "map", "nonblock"]) test(`attestor: ${mode} break invalidates natively while Node is busy and promptly releases writer`, { skip: !enabled }, async t => {
  const f = await setup(t), request = await raw(f), proof = await beginSourceAttestation(request, f.home);
  assert.ok(proof);
  const r = await run([f.actor, mode, request.files[1].path]); assert.equal(r.status, 0, r.stderr);
  const writer = JSON.parse(r.stdout);
  if (mode !== "nonblock") { assert.equal(writer.opened, true); assert.ok(writer.elapsedMs < 1000, r.stdout); }
  assert.equal(await proof.finish(), false);
  if (mode !== "nonblock") assert.equal((await readClient(request, f.home)).valid, false);
});

for (const operation of ["rename", "symlink", "hardlink", "parent", "metadata"]) test(`attestor: ${operation} and restored names invalidate current transaction`, { skip: !enabled }, async t => {
  const f = await setup(t), request = await raw(f), proof = await beginSourceAttestation(request, f.home);
  assert.ok(proof); const path = request.files[0].path;
  if (operation === "rename") { await fs.rename(path, path + ".old"); await fs.rename(path + ".old", path); }
  if (operation === "symlink") { await fs.rename(path, path + ".old"); await fs.symlink(path + ".old", path); }
  if (operation === "hardlink") await fs.link(path, path + ".alias");
  if (operation === "parent") { await fs.rename(f.root, f.root + ".old"); await fs.rename(f.root + ".old", f.root); }
  if (operation === "metadata") { await fs.writeFile(join(f.root, "manifest.json"), "changed"); await fs.unlink(join(f.root, "manifest.json")); }
  assert.equal(await proof.finish(), false);
});

test("attestor: concurrent one-shot finish, forged IPC, replay, timeout and fd exhaustion", { skip: !enabled }, async t => {
  const f = await setup(t), request = await raw(f);
  const a = await beginSourceAttestation(request, f.home), b = await beginSourceAttestation(request, f.home);
  assert.ok(a && b); assert.deepEqual(await Promise.all([a.finish(), b.finish()]), [true, true]);
  assert.equal(await a.finish(), false);
  const d = (await descriptors(f.home))[0];
  const forged = await rawConnection(d);
  const fake = await new Promise(resolve => { forged.once("connect", () => forged.write(JSON.stringify({ body: { epoch: d.epoch, number: 1, nonce: "b".repeat(64), op: "begin", request }, mac: "0".repeat(64) }) + "\n")); forged.once("data", bytes => { forged.destroy(); resolve(bytes.toString()); }); });
  assert.match(fake, /ipc-authentication/u);
  const socket = await rawConnection(d);
  const body = { op: "finish", epoch: d.epoch, number: 1, nonce: "a".repeat(64), token: a.initial.token, fingerprint: attestorDigest(request) };
  const response = await new Promise(resolve => { socket.once("connect", () => socket.write(JSON.stringify({ body, mac: attestorMac(d.secret, body) }) + "\n")); socket.once("data", b => { socket.destroy(); resolve(b.toString()); }); });
  assert.match(response, /ipc-order/u);
  const c = await beginSourceAttestation(request, f.home); assert.ok(c); await delay(5100); assert.equal(await c.finish(), false);
  await controlSourceAttestor(f.root, f.home, "stop"); await delay(40);
  process.env.EINZBERN_SOURCE_ATTESTOR_FDS = "2";
  assert.equal((await readClient(request, f.home)).valid, false);
  const status = await controlSourceAttestor(f.root, f.home, "status"); assert.equal(status.result.resources.capacity, 2);
});

test("attestor: forced kernel revocation after SIGSTOP never restores old authority", { skip: !enabled, timeout: 65000 }, async t => {
  const f = await setup(t), request = await raw(f), proof = await beginSourceAttestation(request, f.home);
  assert.ok(proof); const d = (await descriptors(f.home))[0];
  process.kill(d.pid, "SIGSTOP");
  const argv = [f.actor, "write", request.files[0].path];
  const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = ""; child.stdout.on("data", b => stdout += b); child.stderr.on("data", b => stderr += b);
  try {
    const code = await new Promise(resolve => child.on("exit", resolve));
    await log({ argv, exitCode: code, stdout, stderr }); assert.equal(code, 0, stderr);
    assert.equal(JSON.parse(stdout).opened, true);
  } finally { process.kill(d.pid, "SIGCONT"); }
  assert.equal(await proof.finish(), false);
  assert.equal((await readClient(request, f.home)).valid, false);
});

test("attestor: optional native absence retains full materialization; 220 real segments skip bytes across fresh processes", { skip: !enabled, timeout: 120000 }, async t => {
  const f = await setup(t);
  await initializeLibrary({ root: f.root, createdAt: at });
  const state = await createProject(f.root, { externalKey: "ATTEST-PROJECT", name: "Calibration", occurredAt: at });
  const projectId = state.projects[0].id;
  await setWorkspaceSetting(f.root, { key: "storage.segmentBytes", value: "4096", occurredAt: at });
  await setWorkspaceSetting(f.root, { key: "storage.snapshotEveryEvents", value: "1", occurredAt: at });
  await appendEvents(f.root, Array.from({ length: 219 }, (_, n) => createWorkDelta({ projectId, externalKey: `ATTEST-${n}`, kind: "Initiative", parentId: null, title: `Calibration ${n}`, body: "Neutral calibration. ".repeat(250), occurredAt: at })), { occurredAt: at });
  const first = await materialize(f), warm = await materialize(f);
  assert.equal(first.status, 0, first.stderr); assert.equal(warm.status, 0, warm.stderr);
  assert.notEqual(first.value.pid, warm.value.pid);
  assert.equal(warm.value.observation.logicalEventBytes, 0); assert.equal(warm.value.observation.replayedEvents, 0);
  assert.ok(warm.value.observation.cacheReasons.includes("source-attestor-finish-valid"));
  assert.equal(warm.value.digest, canonicalSha256(await materializeWorkspaceFromGenesis(f.root)));
  const missing = await materialize(f, { EINZBERN_SOURCE_LEASE_MODULE: join(f.base, "absent.node") });
  assert.equal(missing.status, 0, missing.stderr); assert.ok(missing.value.observation.logicalEventBytes > 0);
  assert.equal(missing.value.digest, warm.value.digest);
  const strong = await withWorkspaceWriteLock(f.root, () => withRecallObservation(() => import("../dist/build/packages/core/src/workspace.js").then(m=>m.materializeLibrary(f.root))));
  assert.ok(strong.observation.logicalEventBytes > 0);
  assert.equal(strong.observation.cacheReasons.some(reason=>reason.startsWith("source-attestor-begin:")), false);
  await appendEvents(f.root, [createWorkDelta({ projectId, externalKey: "ATTEST-TAIL", kind: "Initiative", parentId: null, title: "Tail", body: "Tail calibration. ".repeat(500), occurredAt: at })], { occurredAt: at });
  const tail = await materialize(f); assert.equal(tail.status, 0, tail.stderr);
  assert.equal(tail.value.observation.replayedEvents, 1);
  assert.ok(tail.value.observation.logicalEventBytes < first.value.observation.logicalEventBytes / 10);
  assert.equal(tail.value.digest, canonicalSha256(await materializeWorkspaceFromGenesis(f.root)));
  await controlSourceAttestor(f.root, f.home, "stop"); await delay(40);
  const exhausted = await materialize(f, { EINZBERN_SOURCE_ATTESTOR_FDS: "2" });
  assert.equal(exhausted.status, 0, exhausted.stderr);
  assert.ok(exhausted.value.observation.logicalEventBytes > 0);
  assert.equal(exhausted.value.digest, tail.value.digest);
  const read = await readAllStreams(f.root), stream = read.streams.find(x => x.manifest?.segments.length >= 220);
  assert.ok(stream); assert.ok(stream.manifest.segments.length >= 220);
  const path = join(f.root, "akasha", stream.deviceId, stream.manifest.segments[1].name), bytes = await fs.readFile(path);
  const damaged = Buffer.from(bytes); damaged[20] ^= 1; await fs.writeFile(path, damaged);
  const bad = await materialize(f); assert.notEqual(bad.status, 0); assert.match(bad.stderr, /AKASHA_.*CORRUPT/u);
});

test("attestor: 334-segment merged history survives cache loss with separate reducer authorities", { skip: !enabled, timeout: 120000 }, async t => {
  const f = await setup(t), sources = [];
  const readsPath = resolve(repo, `dist/attestor-source-reads-${process.pid}.jsonl`);
  await fs.writeFile(readsPath, "");
  process.env.EINZBERN_ATTESTOR_READ_JOURNAL = readsPath;
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ""} --import=${fileURLToPath(new URL("./helpers/source-attestor-observer.mjs", import.meta.url))}`;
  t.after(async () => {
    if (journal) await fs.copyFile(readsPath, join(dirname(journal), `native-source-reads-${process.pid}.jsonl`));
    await fs.rm(readsPath, { force: true });
  });
  for (const [n, role] of ["coordination", "project"].entries()) {
    const root = join(f.base, "library-" + n), initial = await initializeLibrary({ root, createdAt: at });
    const state = await createProject(root, { externalKey: `MERGED-${n}`, name: `Calibration ${n}`, occurredAt: at });
    const projectId = state.projects[0].id;
    await declareChainIdentity(root, { role, coordinationLibraryId: sources[0]?.id ?? initial.metadata.workspaceId, ...(role === "project" ? { primaryProjectId: projectId } : {}) }, { occurredAt: at });
    await setWorkspaceSetting(root, { key: "storage.segmentBytes", value: "4096", occurredAt: at });
    await appendEvents(root, Array.from({ length: 110 }, (_, i) => createWorkDelta({ projectId, externalKey: `MERGED-${n}-${i}`, kind: "Initiative", parentId: null, title: "Calibration", body: "Neutral spectral readings. ".repeat(240), occurredAt: at })), { occurredAt: at });
    const projectPath = join(f.base, "project-" + n); await fs.mkdir(projectPath);
    await registerLibrary({ projectPath, projectId, libraryPath: root, registeredAt: at, gitRemote: null });
    sources.push({ root, projectId, projectPath, id: initial.metadata.workspaceId, role });
  }
  await fs.rmdir(f.root);
  await consolidateLibraries({ primary: sources[0].root, sources: sources.map(s => ({ path: s.root, bindings: [{ projectPath: s.projectPath, projectId: s.projectId, role: s.role }] })) }, f.root, { at, actor: "agent:codex", decidedIn: "minutes:000000000000000000000001#D1", yes: true });
  const first = await materialize(f);
  const firstReads = await fs.readFile(readsPath, "utf8");
  assert.ok(firstReads.trim().split("\n").map(JSON.parse).reduce((n, row) => n + row.bytes, 0) > 0);
  const warm = await materialize(f);
  assert.equal(await fs.readFile(readsPath, "utf8"), firstReads, "neither fresh client nor living helper issues a source content read on warm reuse");
  assert.equal(first.status, 0, first.stderr); assert.equal(warm.status, 0, warm.stderr);
  assert.equal(warm.value.observation.logicalEventBytes, 0);
  assert.ok(warm.value.observation.cacheReasons.includes("materialized-state-hit"));
  await appendEvents(f.root, [createWorkDelta({ projectId: sources[0].projectId, externalKey: "MERGED-TAIL", kind: "Initiative", parentId: null, title: "Tail", body: "Neutral tail. ".repeat(400), occurredAt: at })], { occurredAt: at });
  const tail = await materialize(f); assert.equal(tail.status, 0, tail.stderr);
  assert.equal(tail.value.observation.replayedEvents, 1); assert.ok(tail.value.observation.logicalEventBytes < first.value.observation.logicalEventBytes / 10);
  assert.equal(tail.value.digest, canonicalSha256(await materializeWorkspaceFromGenesis(f.root)));
  const read = await readAllStreams(f.root);
  const count = r => r.streams.reduce((n,s) => n + (s.manifest?.segments.length ?? 0), 0) + (r.consolidation?.sources.reduce((n,s) => n + count(s.read), 0) ?? 0);
  assert.ok(count(read) >= 334); t.diagnostic(JSON.stringify({ segments: count(read), first: first.value.observation, warm: warm.value.observation, tail: tail.value.observation }));
  const { openLibrary, materializeLibrary } = await import("../dist/build/packages/core/src/index.js");
  const libraryId = (await openLibrary(f.root)).manifest.libraryId;
  const replayReceipt = join(f.home, "replay-projections", libraryId.replace(":", "-"), "projection.json");
  const historyReceipt = join(f.home, "derived-projections", libraryId.replace(":", "-"), "materialized-events.json");
  const historyPayload = join(cachePath(libraryId), "materialized-events.bin");
  // A separately authenticated materialized state remains reducer authority.
  await fs.rm(replayReceipt);
  const receiptOnly = await materialize(f);
  assert.equal(receiptOnly.status, 0, receiptOnly.stderr);
  assert.equal(receiptOnly.value.observation.replayedEvents, 0);
  assert.equal(receiptOnly.value.digest, tail.value.digest);
  for (const loss of ["receipt", "payload", "damaged-receipt", "damaged-payload"]) {
    if (loss === "receipt") await fs.rm(historyReceipt);
    if (loss === "payload") await fs.rm(historyPayload);
    if (loss === "damaged-receipt") await fs.writeFile(historyReceipt, "invalid receipt");
    if (loss === "damaged-payload") await fs.writeFile(historyPayload, "invalid payload");
    const recovered = await materialize(f);
    assert.equal(recovered.status, 0, `${loss}: ${recovered.stderr}`);
    assert.equal(recovered.value.digest, tail.value.digest, loss);
    assert.equal(recovered.value.observation.logicalEventBytes, 0, "history loss does not revoke byte authority");
    assert.equal((await materialize(f)).value.observation.replayedEvents, 0, "repaired cache is reusable");
  }
  // Only losing all applicable reducer authorities forces full reducer replay.
  await fs.rm(replayReceipt, { force: true });
  await fs.rm(join(cachePath(libraryId), "materialized.bin"), { force: true });
  const missingProof = await materialize(f); assert.equal(missingProof.status, 0, missingProof.stderr);
  assert.ok(missingProof.value.observation.replayedEvents > 1);
  assert.equal(missingProof.value.observation.logicalEventBytes, 0);
  assert.equal(missingProof.value.digest, tail.value.digest);
  // A returned public state owns its authenticated history, even if caches
  // disappear and a later materialization publishes another head before use.
  const retained = await materializeLibrary(f.root);
  await fs.rm(cachePath(libraryId), { recursive: true, force: true });
  const rebuilt = await materialize(f);
  assert.equal(rebuilt.status, 0, rebuilt.stderr);
  assert.equal(rebuilt.value.digest, tail.value.digest);
  await appendEvents(f.root, [createWorkDelta({ projectId: sources[0].projectId, externalKey: "AFTER-RETURN", kind: "Initiative", parentId: null, title: "Later head", occurredAt: at })], { occurredAt: at });
  const later = await materialize(f);
  assert.equal(later.status, 0, later.stderr);
  assert.notEqual(later.value.head, retained.headEventHash);
  assert.equal(canonicalSha256(retained), tail.value.digest);
  assert.equal(later.value.digest, canonicalSha256(await materializeWorkspaceFromGenesis(f.root)));
});

test("attestor: complete CLI and Hook launcher preserve fixed-head Crest/FTS expiry and projection upgrade", { skip: !enabled, timeout: 120000 }, async t => {
  const f=await setup(t);
  await initializeLibrary({root:f.root,createdAt:at});
  const state=await createProject(f.root,{externalKey:"ATTEST-PROJECT",name:"Calibration",occurredAt:at});
  const projectId=state.projects[0].id;
  await registerLibrary({projectPath:f.base,projectId,libraryPath:f.root,registeredAt:at,gitRemote:null});
  await recordMinutes(f.root,{occurredAt:at,externalKey:"ATTEST-MIN",projectId,title:"Calibration decisions",summary:"Calibration provenance",decisions:["Keep the reference.","Calibrate the alloy sensor."],decidedBy:[],linkedWorkIds:[]});
  await initializeKnowledgeStore(f.root,{disposableAcknowledged:true});
  await createKnowledgeUnit(f.root,{externalKey:"ATTEST-FRESH",scope:"project",projectId,roleScopes:[],category:"testing",kind:"fact",subject:"Alloy calibration",summary:"The sensor measures seven units.",snippet:"Seven units.",tags:["calibration"],sourceReferences:[],sourceDigest:canonicalSha256("attestor.synthetic-source.v1"),linkedEvidenceIds:[],linkedWorkIds:[],linkedDecisionIds:[],linkedGateIds:[],retrievalDisposition:"default",freshnessState:"fresh",lastVerified:at,stalenessPolicy:{maximumAgeDays:1,unknownDisposition:"fail-closed"},exportDisposition:"metadata-only",accountableOwnerId:"owner:calibration",body:"The neutral alloy sensor measures seven units.",lifecycle:"active",occurredAt:at});
  await fs.mkdir(join(f.home,"engine"),{recursive:true});
  await fs.symlink(repo,join(f.home,"engine","4.6.0"),"dir");
  await fs.writeFile(join(f.home,"engine","current"),JSON.stringify({schemaVersion:"einzbern.engine-current.v1",version:"4.6.0",previous:null,switchedAt:at}));
  const query="ATTEST-FRESH ATTEST-MIN#D2", late="2026-11-15T00:00:00Z";
  async function entry(mode,instant,pilot=true){
    const clock=join(f.base,"clock.mjs");
    await fs.writeFile(clock,`const NativeDate=Date;globalThis.Date=class extends NativeDate{constructor(...a){super(...(a.length?a:[${JSON.stringify(instant)}]));}static now(){return NativeDate.parse(${JSON.stringify(instant)});}};`);
    const args=mode==="cli"?[resolve(repo,"scripts/einzbern.mjs"),"recall","--workspace",f.root,"--view","agent","--at",instant,"--query",query,"--allow-trailing","true"]:[resolve(repo,"scripts/einzbern-hook-launcher.mjs"),"user-prompt-submit"];
    const r=await run([process.execPath,"--import",clock,...args],{input:JSON.stringify({cwd:f.base,prompt:query}),cwd:f.base,env:{...process.env,EINZBERN_HOST:"claude-code",EINZBERN_RECALL_OBSERVATION:"1",EINZBERN_SOURCE_ATTESTOR_ROOT:pilot?f.root:""}});
    assert.equal(r.status,0,r.stderr);assert.ok(r.stdout.length>0,r.stderr);assert.doesNotMatch(r.stderr,/HOOK_LAUNCH_FAILED/u);
    return r.stdout;
  }
  const head=(await readAllStreams(f.root)).streams.map(s=>s.manifest?.headEventHash);
  for(const mode of ["cli","hook"]){
    const cold=await entry(mode,at),warm=await entry(mode,at);assert.equal(warm,cold);
    assert.match(warm,/Alloy calibration/u);assert.match(warm,/D2/u);
    const expired=await entry(mode,late);assert.doesNotMatch(expired,/Alloy calibration/u);
    assert.equal(expired,await entry(mode,late,false));
    await fs.rm(cachePath(state.metadata.workspaceId),{recursive:true,force:true});
    assert.equal(expired,await entry(mode,late,false));
    await entry(mode,late);
    const proofs=join(f.home,"derived-projections",state.metadata.workspaceId.replace(":","-"));
    for(const name of await fs.readdir(proofs)){const path=join(proofs,name),record=JSON.parse(await fs.readFile(path,"utf8"));record.binding="old-projection-version";await fs.writeFile(path,JSON.stringify(record));}
    assert.equal(expired,await entry(mode,late));
  }
  assert.deepEqual((await readAllStreams(f.root)).streams.map(s=>s.manifest?.headEventHash),head);
});

test("attestor: native invalidation releases writer while the JS event loop is blocked", { skip: !enabled }, async t => {
  const f = await setup(t), request = await raw(f, 2);
  const code = `import {createRequire} from 'node:module';const b=createRequire(import.meta.url)(process.argv[1]);b.init(16);
    const a=b.acquire(process.argv[2]),c=b.acquire(process.argv[3]);console.log(JSON.stringify({ready:true}));
    const start=performance.now();while(performance.now()-start<2000){};
    console.log(JSON.stringify({valid:b.check([a.id,c.id]),status:b.status()}));b.release(a.id);b.release(c.id);`;
  const argv = [process.execPath, "--input-type=module", "-e", code, addon, ...request.files.map(x=>x.path)];
  const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = ""; child.stdout.on("data",b=>stdout+=b); child.stderr.on("data",b=>stderr+=b);
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  assert.equal(JSON.parse((await lines.next()).value).ready,true);
  const writer=await run([f.actor,"write",request.files[1].path]);
  assert.equal(writer.status,0,writer.stderr); assert.ok(JSON.parse(writer.stdout).elapsedMs<1000);
  const result=JSON.parse((await lines.next()).value); assert.equal(result.valid,false); assert.ok(result.status.generation>1);
  const exitCode=await new Promise(resolve=>child.on("exit",resolve)); assert.equal(exitCode,0,stderr);
  await log({argv,exitCode,stdout,stderr});
});
