// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireHeavySlot } from "../scripts/lib/heavy-runs.mjs";
import { checkMemorySample, memoryTestArguments, parseMemoryPolicy, processTable, resolveMemoryDirectory, sampleMemory } from "../scripts/lib/memory-budget.mjs";

const memoryModule = new URL("../scripts/lib/memory-budget.mjs", import.meta.url).href;

async function privateWindowsDirectory(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "memory-windows-native-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const encodedPath = Buffer.from(directory, "utf8").toString("base64");
  // The ambient temp directory can grant other local sandbox users write access.
  execFileSync(join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", `
$ErrorActionPreference = 'Stop';
$env:PSModulePath = Join-Path $PSHOME 'Modules';
$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'));
$owner = [Security.Principal.WindowsIdentity]::GetCurrent().User;
$acl = [Security.AccessControl.DirectorySecurity]::new();
$acl.SetOwner($owner);
$acl.SetAccessRuleProtection($true, $false);
foreach ($sid in @($owner, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'), [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) {
  $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow');
  $acl.AddAccessRule($rule);
}
Set-Acl -LiteralPath $path -AclObject $acl;
`], { timeout: 15_000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  return directory;
}

// Execute Windows branches on every CI platform with explicit synthetic OS observations.
function windowsFixture(source) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import { tmpdir } from 'node:os';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join, toNamespacedPath } from 'node:path';
const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'memory-windows-fixture-')));
const originalPlatform = process.platform;
Object.defineProperty(process, 'platform', { value: 'win32' });
process.env.SystemRoot = directory;
let answer;
let failure = false;
const calls = [];
cp.execFileSync = (executable, args, options) => {
  calls.push({ executable, args, options });
  assert.equal(options.windowsHide, true);
  if (executable.endsWith('filesystem.exe')) {
    assert.equal(options.timeout, 15000);
    assert.equal(args.length, 2);
    assert.ok(['acl-write', 'acl-private'].includes(args[0]));
    if (failure || answer !== true) throw new Error('Synthetic ACL observation denied');
    return Buffer.alloc(0);
  }
  assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
  if (args[3].includes('CreateDirectoryW') || args[3].includes('Add-Type -TypeDefinition $source -OutputAssembly')) {
    assert.equal(options.timeout, 60000);
    return 'true';
  }
  assert.equal(options.timeout, 5000);
  if (failure) throw new Error('Synthetic Windows query failure');
  return JSON.stringify(answer);
};
process.availableMemory = () => 12 * 1024 ** 3;
process.constrainedMemory = () => 16 * 1024 ** 3;
os.totalmem = () => 16 * 1024 ** 3;
syncBuiltinESMExports();
const m = await import(${JSON.stringify(memoryModule)});
try { ${source} }
finally {
  Object.defineProperty(process, 'platform', { value: originalPlatform });
  rmSync(directory, { recursive: true, force: true });
}
`], { encoding: "utf8", timeout: 15_000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr + result.stdout);
}

test("Windows sampling uses both physical and virtual headroom with unknown PSI", () => {
  windowsFixture(`
answer = { TotalVisibleMemorySize: 8 * 1024 ** 2, FreePhysicalMemory: 6 * 1024 ** 2, TotalVirtualMemorySize: 10 * 1024 ** 2, FreeVirtualMemory: 2 * 1024 ** 2 };
const sample = m.sampleMemory();
assert.equal(sample.limitBytes, 8 * 1024 ** 3);
assert.equal(sample.availableBytes, 2 * 1024 ** 3);
assert.equal(sample.stallPercent, null);
assert.equal(sample.pressureSource, 'windows-memory-status');
assert.ok(sample.cpuParallelism >= 1);
const policy = m.parseMemoryPolicy(JSON.stringify({ enabled: true, reserveMiB: 0 }));
m.checkMemorySample(sample, policy);
assert.throws(() => m.checkMemorySample({ ...sample, stallPercent: 0 }, policy), { reasonCode: 'MEMORY_SAMPLE_INVALID_OR_STALE' });
assert.throws(() => m.checkMemorySample({ ...sample, availableBytes: 1 }, policy), { reasonCode: 'MEMORY_PRESSURE_HIGH' });
`);
});

test("Windows sampling refuses missing, malformed, overflowing and failed observations", () => {
  windowsFixture(`
const valid = { TotalVisibleMemorySize: 8192, FreePhysicalMemory: 4096, TotalVirtualMemorySize: 16384, FreeVirtualMemory: 8192 };
for (const invalid of [null, {}, { ...valid, FreePhysicalMemory: null }, { ...valid, FreeVirtualMemory: '8192' }, { ...valid, FreeVirtualMemory: -1 }, { ...valid, FreeVirtualMemory: 32768 }, { ...valid, TotalVirtualMemorySize: Number.MAX_SAFE_INTEGER }]) {
  answer = invalid;
  assert.throws(() => m.sampleMemory(), { reasonCode: 'MEMORY_SAMPLE_UNAVAILABLE' });
}
failure = true;
assert.throws(() => m.sampleMemory(), { reasonCode: 'MEMORY_SAMPLE_UNAVAILABLE' });
`);
});

test("Windows process observation excludes its helper and retains unknown identities", () => {
  windowsFixture(`
answer = { observerPid: 99, rows: [
  { pid: 99, ppid: 42, rss: 10, started: '2026-11-16T00:00:00.1234567Z' },
  { pid: 42, ppid: 1, rss: 1024, started: '2026-11-16T00:00:00.1234567Z' },
  { pid: 43, ppid: 42, rss: null, started: null }
] };
assert.deepEqual(m.processTable(), answer.rows.slice(1));
answer.rows[1].rss = -1;
assert.equal(m.processTable(), null);
answer = { observerPid: 99, rows: [] };
failure = true;
assert.equal(m.processTable(), null);
`);
});

test("Windows suites bound the default fan-out and preserve explicit Node worker counts", () => {
  windowsFixture(`
const args = ['--test', 'one.test.mjs'];
for (const [capacity, workers] of [[1, 1], [4, 3], [32, 4]]) {
  os.availableParallelism = () => capacity;
  syncBuiltinESMExports();
  assert.deepEqual(m.suiteTestArguments(args, {}), ['--test-concurrency=' + workers, ...args]);
}
for (const explicit of [['--test-concurrency=7'], ['--test-concurrency', '2']]) {
  const requested = [...explicit, ...args];
  assert.equal(m.suiteTestArguments(requested, {}), requested);
}
`);
});

test("Windows resource domains require a successful private ACL observation", () => {
  windowsFixture(`
answer = true;
assert.equal(m.resolveMemoryDirectory(undefined, directory), directory);
assert.deepEqual(calls.at(-1).args, ['acl-write', toNamespacedPath(directory)]);
for (const invalid of [false, null, 'true', {}]) {
  answer = invalid;
  assert.throws(() => m.resolveMemoryDirectory(undefined, directory), { reasonCode: 'MEMORY_DOMAIN_INVALID' });
}
failure = true;
assert.throws(() => m.resolveMemoryDirectory(undefined, directory), { reasonCode: 'MEMORY_DOMAIN_INVALID' });
`);
});

test("an unobservable owned process retains its reservation through reparenting", () => {
  windowsFixture(`
const { mkdirSync, writeFileSync } = await import('node:fs');
answer = true;
mkdirSync(join(directory, 'locks'));
const policy = { enabled: true, reserveMiB: 0, budgetMiB: 1024, fixedMiB: 128, workerMiB: 256, maxWorkers: 1 };
writeFileSync(join(directory, 'machine-settings.json'), JSON.stringify({ schemaVersion: 'tcrn.machine-settings.v1', values: { 'execution.memoryPolicy': JSON.stringify(policy) } }));
const owner = { pid: process.pid, ppid: process.ppid, rss: 1024, started: '2026-11-16T00:00:00.1234567Z' };
const child = { pid: process.pid + 1000000, ppid: owner.pid, rss: 1024, started: '2026-11-16T00:00:01.1234567Z' };
let table = [owner];
const sample = () => ({ sampledAt: Date.now(), limitBytes: 16 * 1024 ** 3, availableBytes: 12 * 1024 ** 3, stallPercent: null, pressureSource: 'windows-memory-status' });
const lease = await m.acquireMemoryBudget({ deviceHome: directory, directory: join(directory, 'locks'), command: 'fixture', env: {}, sample, processes: () => table });
table = [owner, child];
lease.refresh();
table = [owner, { ...child, started: null, rss: null }];
assert.throws(() => lease.refresh(), { reasonCode: 'MEMORY_LEASE_OWNER_UNKNOWN' });
assert.throws(() => lease.release(), { reasonCode: 'MEMORY_RELEASE_UNCONFIRMED' });
table = [owner, { ...child, ppid: 0, started: null }];
assert.throws(() => lease.release(), { reasonCode: 'MEMORY_RELEASE_UNCONFIRMED' });
table = [owner];
lease.release();
`);
});

test("native Windows heavy entry admits, limits real Node workers and releases its reservation", { skip: process.platform !== "win32" }, async t => {
  const directory = await privateWindowsDirectory(t);
  const policy = { enabled: true, reserveMiB: 0, budgetMiB: 384, fixedMiB: 128, workerMiB: 256, maxWorkers: 1, maxUsedPercent: 100 };
  await writeFile(join(directory, "machine-settings.json"), JSON.stringify({ schemaVersion: "tcrn.machine-settings.v1", values: { "execution.memoryPolicy": JSON.stringify(policy) } }));
  const sample = sampleMemory();
  checkMemorySample(sample, parseMemoryPolicy(JSON.stringify(policy)));
  assert.equal(sample.pressureSource, "windows-memory-status");
  const owner = processTable().find(row => row.pid === process.pid);
  assert.ok(owner.rss > 0);
  assert.ok(Number.isFinite(Date.parse(owner.started)));
  const env = { ...process.env, EINZBERN_HOME: directory };
  delete env.EINZBERN_MEMORY_LEASE;
  delete env.EINZBERN_HEAVY_SLOT;
  delete env.EINZBERN_HEAVY_LOCK_DIR;
  const slot = await acquireHeavySlot({ command: "windows-native-test", env });
  assert.equal(slot.memory.workers, 1);
  const marker = join(directory, "active-worker");
  const tests = [];
  for (let index = 0; index < 2; index++) {
    const path = join(directory, `worker-${index}.test.mjs`);
    await writeFile(path, `
import test from 'node:test';
import assert from 'node:assert/strict';
import { open, unlink } from 'node:fs/promises';
test('one worker', async () => {
  assert.ok(process.execArgv.some(arg => arg.includes('memory-worker-check.mjs')), 'the worker was admitted by the caller');
  const file = await open(${JSON.stringify(marker)}, 'wx');
  try { await new Promise(resolve => setTimeout(resolve, 100)); }
  finally {
    await file.close();
    await unlink(${JSON.stringify(marker)});
  }
});
`);
    tests.push(path);
  }
  try {
    const args = memoryTestArguments(["--test", ...tests], env);
    assert.ok(args.includes("--test-concurrency=1"));
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: 15_000 });
      let output = "";
      child.stdout.on("data", data => { output += data; });
      child.stderr.on("data", data => { output += data; });
      child.once("error", reject);
      child.once("close", code => resolve({ code, output }));
    });
    assert.equal(result.code, 0, result.output);
  } finally { slot.release(); }
  const { runPortalTestFiles } = await import("../scripts/portal-tests.mjs");
  assert.equal(await runPortalTestFiles(tests, env, { stdio: "pipe" }), 0);
  const state = JSON.parse(await readFile(join(directory, "locks", "memory-budget.json"), "utf8"));
  assert.equal(state.leases.length, 0);
  assert.equal((await readdir(join(directory, "locks", "memory-receipts"))).length, 2);
});

test("native Windows domain rejects an unrelated writable ACL", { skip: process.platform !== "win32" }, async t => {
  const directory = await privateWindowsDirectory(t);
  assert.equal(resolveMemoryDirectory(undefined, directory), directory);
  const encodedPath = Buffer.from(directory, "utf8").toString("base64");
  execFileSync(join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", `
$ErrorActionPreference = 'Stop';
$env:PSModulePath = Join-Path $PSHOME 'Modules';
$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'));
$acl = [IO.Directory]::GetAccessControl($path, [Security.AccessControl.AccessControlSections]::Access);
$everyone = [Security.Principal.SecurityIdentifier]::new('S-1-1-0');
$rule = [Security.AccessControl.FileSystemAccessRule]::new($everyone, 'Write', 'Allow');
$acl.AddAccessRule($rule);
[IO.Directory]::SetAccessControl($path, $acl);
`], { timeout: 15_000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  assert.throws(() => resolveMemoryDirectory(undefined, directory), { reasonCode: "MEMORY_DOMAIN_INVALID" });
});
