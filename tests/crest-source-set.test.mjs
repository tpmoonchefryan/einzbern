// SPDX-License-Identifier: Apache-2.0
import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { beginCrestAttestation, beginSourceAttestation, controlSourceAttestor } from "../dist/build/packages/core/src/source-attestor-client.js";
import { ATTESTOR_SCHEMA, CREST_PROOF_SCHEMA, attestorMountContext } from "../dist/build/packages/core/src/source-attestor-protocol.js";
import { completeFixtureState } from "./fixtures/crest-set-client.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));
const addon = resolve(repo, "dist/native/linux-source-lease.node");
const enabled = process.platform === "linux" && await fs.stat(addon).then(() => true, () => false);
const client = resolve(repo, "tests/fixtures/crest-set-client.mjs");
const journal = process.env.EINZBERN_ATTESTOR_COMMAND_JOURNAL;
async function record(row) { if (journal) await fs.appendFile(journal, JSON.stringify(row) + "\n"); }

async function fixture(t, count = 8, shortHome = false) {
  const base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "crest-set-")));
  const root = join(base, "source"), crest = join(root, "crest"), home = shortHome ? await fs.mkdtemp("/tmp/crest-ipc-") : join(base, "device"), cache = join(base, "fixture-result.json");
  await fs.mkdir(crest, { recursive: true }); await fs.mkdir(home, { recursive: true, mode: 0o700 });
  for (let i = 0; i < count; i++) await fs.writeFile(join(crest, `member-${i}.json`), `{"owned":${i},"payload":"complete fixture bytes"}\n`);
  const original = { ...process.env };
  Object.assign(process.env, { EINZBERN_SOURCE_ATTESTOR_ROOT: root, EINZBERN_SOURCE_LEASE_MODULE: addon, EINZBERN_HOME: home });
  const request = { schema: CREST_PROOF_SCHEMA, domain: "crest", root, roots: [crest], binding: "b".repeat(64) };
  t.after(async () => {
    Object.assign(process.env, { EINZBERN_SOURCE_ATTESTOR_ROOT: root, EINZBERN_SOURCE_LEASE_MODULE: addon });
    const descriptors = [];
    for (const name of await fs.readdir(join(home, "source-attestor")).catch(() => [])) {
      try { descriptors.push(JSON.parse(await fs.readFile(join(home, "source-attestor", name, "endpoint.json"), "utf8"))); } catch {}
    }
    await controlSourceAttestor(root, home, "stop", request.roots).catch(() => undefined);
    await controlSourceAttestor(root, home, "stop").catch(() => undefined);
    for (const descriptor of descriptors) {
      for (let i = 0; i < 100; i++) {
        try { process.kill(descriptor.pid, 0); }
        catch (error) { if (error.code === "ESRCH") break; throw error; }
        if (i === 0) { try { process.kill(descriptor.pid, "SIGCONT"); process.kill(descriptor.pid, "SIGTERM"); } catch {} }
        await delay(10);
      }
      assert.throws(() => process.kill(descriptor.pid, 0), { code: "ESRCH" }, "owned helper is gone before fixture retirement");
    }
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    await fs.rm(base, { recursive: true, force: true });
    if (shortHome) await fs.rm(home, { recursive: true, force: true });
  });
  return { base, root, crest, home, cache, request };
}

async function readClient(f, label, request = f.request, prefix = []) {
  const argv = [...prefix, process.execPath, client, JSON.stringify(request), f.home, f.cache];
  const started = Date.now();
  const r = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", timeout: 15000, maxBuffer: 8 * 1024 * 1024, env: process.env });
  await record({ label, argv, cwd: process.cwd(), pid: r.pid, started, ended: Date.now(), childStarted: r.pid > 0,
    exitCode: r.status, signal: r.signal, timedOut: r.error?.code === "ETIMEDOUT", stdout: r.stdout, stderr: r.stderr, root: f.root });
  assert.equal(r.status, 0, r.stderr);
  const result = JSON.parse(r.stdout);
  assert.equal(result.state.digest, completeFixtureState(request.roots).digest, `${label}: delivered state equals complete reader`);
  return result;
}

async function resourceSnapshot(f, crest) {
  const status = await controlSourceAttestor(f.root, f.home, "status", crest ? f.request.roots : undefined);
  const fds = [];
  for (const fd of await fs.readdir(`/proc/${status.pid}/fd`)) {
    const target = await fs.readlink(`/proc/${status.pid}/fd/${fd}`).catch(() => null);
    const info = target === "anon_inode:inotify" ? await fs.readFile(`/proc/${status.pid}/fdinfo/${fd}`, "utf8") : null;
    fds.push({ fd: Number(fd), target, info });
  }
  const snapshot = { label: crest ? "crest-helper-resources" : "akasha-helper-resources", ...status, fds,
    processStatus: await fs.readFile(`/proc/${status.pid}/status`, "utf8"), limits: await fs.readFile(`/proc/${status.pid}/limits`, "utf8") };
  await record(snapshot);
  return snapshot;
}

test("Crest set: 1110 members, three fresh warm clients, gap changes, and restart", { skip: !enabled, timeout: 60000 }, async t => {
  const f = await fixture(t, 1110);
  const cold = await readClient(f, "1110-cold");
  assert.equal(cold.valid, true); assert.equal(cold.full, true); assert.equal(cold.initial.reads.length, 1110);
  const clients = [];
  for (let i = 0; i < 3; i++) {
    const warm = await readClient(f, `1110-warm-${i}`);
    assert.equal(warm.valid, true); assert.equal(warm.full, false); assert.equal(warm.initial.warm, true);
    assert.deepEqual(warm.initial.reads, []); assert.equal(warm.epoch, cold.epoch); clients.push(warm.pid);
  }
  assert.equal(new Set(clients).size, 3);
  // An independent Akasha set must not evict the 1110 Crest leases.
  const path = join(f.root, "segment.ndjson"), text = "independent Akasha fixture\n";
  await fs.writeFile(path, text);
  const akasha = await beginSourceAttestation({ schema: ATTESTOR_SCHEMA, root: f.root, binding: "a".repeat(64), directories: [],
    files: [{ path, bytes: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex"), metadata: false }] }, f.home);
  assert.ok(akasha); assert.equal(await akasha.finish(), true);
  assert.equal((await readClient(f, "1110-after-akasha")).full, false);
  const crestResources = await resourceSnapshot(f, true), akashaResources = await resourceSnapshot(f, false);
  assert.notEqual(crestResources.pid, akashaResources.pid); assert.equal(crestResources.result.resources.held, 1110);
  await fs.writeFile(join(f.crest, "unexpected.partial"), "gap addition\n");
  const added = await readClient(f, "1110-gap-add");
  assert.equal(added.full, true); assert.notEqual(added.state.digest, cold.state.digest);
  assert.equal((await readClient(f, "1110-rebuild")).initial.reads.length, 1111);
  assert.equal((await readClient(f, "1110-rebuilt-warm")).full, false);
  await controlSourceAttestor(f.root, f.home, "stop", f.request.roots); await delay(50);
  const restart = await readClient(f, "1110-helper-restart");
  assert.equal(restart.full, true); assert.notEqual(restart.epoch, cold.epoch); assert.equal(restart.initial.reads.length, 1111);
});

test("Crest set: a same-size content change in a >256 KiB member invalidates the warm proof", { skip: !enabled, timeout: 60000 }, async t => {
  const f = await fixture(t, 1), member = join(f.crest, "member-0.json");
  const originalBytes = Buffer.alloc(300 * 1024, 0x41);
  await fs.writeFile(member, originalBytes);
  const cold = await readClient(f, "large-member-cold");
  assert.equal(cold.full, true); assert.equal(cold.valid, true);
  assert.equal(cold.state.bytes, originalBytes.length);
  const warm = await readClient(f, "large-member-warm");
  assert.equal(warm.full, false); assert.equal(warm.valid, true);
  const changedBytes = Buffer.from(originalBytes);
  changedBytes[changedBytes.length - 1] = 0x42;
  await fs.writeFile(member, changedBytes);
  const changed = await readClient(f, "large-member-content-change");
  assert.equal(changed.full, true); assert.equal(changed.valid, false);
  assert.notEqual(changed.state.digest, warm.state.digest);
  const rebuilt = await readClient(f, "large-member-rebuild");
  assert.equal(rebuilt.full, true); assert.equal(rebuilt.valid, true);
  const rewarm = await readClient(f, "large-member-rewarm");
  assert.equal(rewarm.full, false); assert.equal(rewarm.valid, true);
  await record({ label: "large-member-content-evidence", path: "crest/member-0.json", bytes: originalBytes.length,
    beforeSha256: createHash("sha256").update(originalBytes).digest("hex"), afterSha256: createHash("sha256").update(changedBytes).digest("hex"),
    initialResultDigest: warm.state.digest, changedResultDigest: changed.state.digest,
    cold: { full: cold.full, valid: cold.valid, reads: cold.initial.reads.length },
    warm: { full: warm.full, valid: warm.valid, reads: warm.initial.reads.length },
    invalidated: { full: changed.full, valid: changed.valid, reads: changed.initial?.reads.length ?? 0,
      reason: changed.attestorReasons },
    rebuilt: { full: rebuilt.full, valid: rebuilt.valid, reads: rebuilt.initial.reads.length },
    rewarm: { full: rewarm.full, valid: rewarm.valid, reads: rewarm.initial.reads.length } });
});

for (const change of ["delete", "rename", "parent", "hardlink", "metadata", "content", "mmap", "ignored", "overflow"]) {
  test(`Crest set: client gap ${change} invalidates the whole set and uses the complete reader`, { skip: !enabled, timeout: 60000 }, async t => {
    const f = await fixture(t);
    await readClient(f, `${change}-cold`); assert.equal((await readClient(f, `${change}-warm`)).full, false);
    const member = join(f.crest, "member-0.json");
    if (change === "delete") await fs.unlink(member);
    if (change === "rename") await fs.rename(member, member + ".renamed");
    if (change === "parent") { await fs.rename(f.crest, f.crest + ".old"); await fs.mkdir(f.crest); await fs.writeFile(join(f.crest, "replacement"), "replacement parent"); }
    if (change === "hardlink") { await fs.link(member, join(f.base, "external-link")); await fs.unlink(join(f.base, "external-link")); }
    if (change === "metadata") { await fs.chmod(member, 0o640); await fs.chmod(member, 0o600); }
    if (change === "content") await fs.writeFile(member, "new source content\n");
    if (change === "mmap") {
      const actor = join(f.base, "actor");
      const build = spawnSync("cc", ["-O2", "-Wall", "-Wextra", "-Werror", resolve(repo, "tests/fixtures/source-lease-actor.c"), "-o", actor], { encoding: "utf8" });
      assert.equal(build.status, 0, build.stderr);
      const r = spawnSync(actor, ["map", member], { encoding: "utf8", timeout: 2000 });
      assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout).opened, true);
      await record({ label: "mmap-writer", pid: r.pid, stdout: r.stdout, stderr: r.stderr, exitCode: r.status });
    }
    if (change === "ignored") { await fs.rm(f.crest, { recursive: true }); await fs.mkdir(f.crest); }
    if (change === "overflow") {
      const count = Number(await fs.readFile("/proc/sys/fs/inotify/max_queued_events", "utf8")) + 128;
      assert.ok(count < 65536, "the observed queue permits a bounded owned overflow fixture");
      for (let i = 0; i < count; i++) { const path = join(f.crest, `temporary-${i}`); writeFileSync(path, "queue"); unlinkSync(path); }
    }
    const changed = await readClient(f, `${change}-fallback`);
    assert.equal(changed.full, true); assert.equal(changed.valid, false);
    const rebuilt = await readClient(f, `${change}-new-proof`); assert.equal(rebuilt.full, true); assert.equal(rebuilt.valid, true);
    assert.equal((await readClient(f, `${change}-new-warm`)).full, false);
  });
}

test("Crest set: absent root creation, binding, disconnect, and native capability failures", { skip: !enabled }, async t => {
  const f = await fixture(t);
  await fs.rm(f.crest, { recursive: true });
  assert.equal((await readClient(f, "absent-cold")).valid, true);
  assert.equal((await readClient(f, "absent-warm")).full, false);
  await fs.mkdir(f.crest); await fs.writeFile(join(f.crest, "created"), "new root");
  assert.equal((await readClient(f, "absent-created")).valid, false);
  await readClient(f, "absent-rebuild");
  assert.equal((await readClient(f, "wrong-binding", { ...f.request, binding: "c".repeat(64) })).valid, false);
  await readClient(f, "binding-rebuild");
  const interrupted = await beginCrestAttestation(f.request, f.home); assert.ok(interrupted); interrupted.close(); await delay(30);
  assert.equal((await readClient(f, "disconnect-rebuild")).full, true);
  process.env.EINZBERN_SOURCE_LEASE_MODULE = join(f.base, "missing.node");
  assert.equal((await readClient(f, "missing-native")).valid, false);
  process.env.EINZBERN_SOURCE_LEASE_MODULE = addon;
  const partial = await readClient(f, "partial-roots", { ...f.request, roots: [join(f.crest, "absent")] });
  assert.equal(partial.full, true); // A separate collection cannot authorize the original root.
  const wrongDomain = await readClient(f, "wrong-domain", { ...f.request, domain: "akasha" });
  assert.equal(wrongDomain.valid, false);
  assert.equal((await readClient(f, "old-schema", { ...f.request, schema: "old-crest-api" })).valid, false);
  await controlSourceAttestor(f.root, f.home, "stop", f.request.roots); await delay(30);
  await fs.writeFile(join(f.crest, "capacity-member-1"), "second member");
  await fs.writeFile(join(f.crest, "capacity-member-2"), "third member");
  process.env.EINZBERN_SOURCE_ATTESTOR_FDS = "2";
  const insufficient = await readClient(f, "capacity-two"); assert.equal(insufficient.valid, false); assert.equal(insufficient.full, true);
  await controlSourceAttestor(f.root, f.home, "stop", f.request.roots); await delay(30);
  delete process.env.EINZBERN_SOURCE_ATTESTOR_FDS;
  const oldAddon = join(f.base, "old-addon.cjs");
  await fs.writeFile(oldAddon, `const b=require(${JSON.stringify(addon)});for(const k of ['init','acquire','check','release','status','watch','guardCheck','guardClose'])exports[k]=b[k];`);
  process.env.EINZBERN_SOURCE_LEASE_MODULE = oldAddon;
  const unsupported = await readClient(f, "old-native-api"); assert.equal(unsupported.valid, false); assert.equal(unsupported.full, true);
});

test("Crest set: forced kernel revocation cannot restore a stopped helper's old authority", { skip: !enabled, timeout: 90000 }, async t => {
  const f = await fixture(t);
  await readClient(f, "revoke-cold");
  const status = await controlSourceAttestor(f.root, f.home, "status", f.request.roots);
  const actor = join(f.base, "actor"), member = join(f.crest, "member-0.json");
  const built = spawnSync("cc", ["-O2", "-Wall", "-Wextra", "-Werror", resolve(repo, "tests/fixtures/source-lease-actor.c"), "-o", actor], { encoding: "utf8" });
  assert.equal(built.status, 0, built.stderr);
  process.kill(status.pid, "SIGSTOP");
  let writer;
  try { writer = spawnSync(actor, ["write", member], { encoding: "utf8", timeout: 70000 }); }
  finally { process.kill(status.pid, "SIGCONT"); }
  await record({ label: "crest-forced-revoke-writer", pid: writer.pid, exitCode: writer.status, stdout: writer.stdout, stderr: writer.stderr, timedOut: writer.error?.code === "ETIMEDOUT" });
  assert.equal(writer.status, 0, writer.stderr);
  await delay(20);
  const fallback = await readClient(f, "forced-revoke-fallback"); assert.equal(fallback.valid, false); assert.equal(fallback.full, true);
  const rebuilt = await readClient(f, "forced-revoke-rebuild"); assert.equal(rebuilt.full, true); assert.equal(rebuilt.valid, true);
});

test("Crest set: same socket/root in another mount namespace and a bind overmount cannot adopt helper bytes", { skip: !enabled }, async t => {
  const capability = spawnSync("bwrap", ["--ro-bind", "/", "/", "--", "true"], { encoding: "utf8" });
  if (capability.status !== 0) { t.skip(`private mount namespace unavailable at this execution position: ${capability.stderr.trim()}`); return; }
  const f = await fixture(t, 8, true);
  const cold = await readClient(f, "namespace-cold");
  const warm = await readClient(f, "namespace-warm"); assert.equal(warm.full, false);
  const alternative = join(f.base, "alternative"); await fs.mkdir(alternative);
  await fs.writeFile(join(alternative, "foreign.json"), "another namespace's current named source\n");
  const nested = ["bwrap", "--die-with-parent", "--ro-bind", "/", "/", "--bind", f.base, f.base, "--proc", "/proc", "--dev-bind", "/dev", "/dev", "--"];
  const foreign = await readClient(f, "different-namespace", f.request, nested);
  assert.notEqual(foreign.context, cold.context); assert.equal(foreign.valid, false); assert.equal(foreign.full, true);
  await readClient(f, "namespace-rebuild");
  const overmount = [...nested.slice(0, -1), "--ro-bind", alternative, f.crest, "--"];
  // This client sees a different genesis corpus at the identical root string.
  const argv = [...overmount, process.execPath, client, JSON.stringify(f.request), f.home, f.cache];
  const r = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", timeout: 15000 });
  assert.equal(r.status, 0, r.stderr); const mounted = JSON.parse(r.stdout);
  await record({ label: "bind-overmount", argv, pid: r.pid, stdout: r.stdout, stderr: r.stderr, exitCode: r.status, helperContext: cold.context, clientContext: attestorMountContext() });
  assert.equal(mounted.valid, false); assert.equal(mounted.full, true); assert.notEqual(mounted.context, cold.context);
  assert.notEqual(mounted.state.digest, cold.state.digest);
  assert.equal(mounted.state.bytes, Buffer.byteLength("another namespace's current named source\n"));
});
