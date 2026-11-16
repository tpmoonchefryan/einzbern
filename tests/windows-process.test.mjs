// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawnCommand, spawnCommandSync } from "../skill/mana-orchestrate/scripts/process-launch.mjs";
import { probeKiroHost } from "../dist/build/packages/core/src/kiro-host.js";
import { withExclusiveOutputSession, safeWriteOutput } from "../scripts/lib/safe-io.mjs";
import { readProcessTable, detectOwnedFromTable } from "../scripts/spawn-guard.mjs";
import { buildRegistrationLine, parseRegistrationLine } from "../dist/build/packages/core/src/background-resource.js";
import { hostHookCommand, hookLauncherPath } from "../dist/build/packages/core/src/host-hooks.js";

const windows = { skip: process.platform !== "win32" };

test("Windows capture overflow preserves its error and ignored output cannot block completion", windows, async () => {
  const overflow = spawnCommandSync(process.execPath, ["-e", "process.stdout.write('x'.repeat(1000000))"], { maxBuffer: 1024, timeout: 15_000 });
  assert.equal(overflow.error?.code, "ENOBUFS");
  const ignored = spawnCommand(process.execPath, ["-e", "process.stdout.write('x'.repeat(1000000));process.stderr.write('y'.repeat(1000000))"], { stdio: "ignore" });
  const code = await new Promise((resolve, reject) => {
    ignored.once("error", reject);
    ignored.once("close", resolve);
  });
  assert.equal(code, 0);
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "einzbern process 中文 "));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function collect(child, input = "") {
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", bytes => stdout.push(bytes));
  child.stderr.on("data", bytes => stderr.push(bytes));
  child.stdin.end(input);
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() }));
  });
}
async function waitForFile(path) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try { return await readFile(path, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

test("Windows batch launch preserves literal arguments and stdin through a PATH shim", windows, async t => {
  const root = await fixture(t);
  await writeFile(join(root, "argv.cjs"), "console.log(JSON.stringify(process.argv.slice(2))); process.stdin.pipe(process.stdout);");
  await writeFile(join(root, "probe.cmd"), `@"${process.execPath}" "%~dp0argv.cjs" %*\r\n`);
  await writeFile(join(root, "probe"), "#!/bin/sh\nexit 99\n");
  const args = ["", "中文 and spaces", "a&b|c<d>e", "(value)", "100%PATH%", "!value!", 'a"b', "tail\\", "^caret", "comma,semi;star*question?"];
  const env = { ...process.env, PATH: `${root};${process.env.PATH}` };
  const result = await collect(spawnCommand("probe", args, { env }), "input\n");
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.split("\n")[0]), args);
  assert.ok(result.stdout.endsWith("input\n"));
  const sync = spawnCommandSync("probe.cmd", args, { env, input: "input\n", encoding: "utf8", timeout: 10_000 });
  assert.equal(sync.status, 0, sync.stderr);
  assert.deepEqual(JSON.parse(sync.stdout.split("\n")[0]), args);
});

test("Windows hook commands support metacharacters and cross-volume device bindings", windows, async t => {
  const root = await fixture(t);
  const home = join(root, "home");
  const device = join(root, "device-%PATH%-$-`-中文");
  await mkdir(home);
  await mkdir(join(device, "engine"), { recursive: true });
  await writeFile(join(device, "engine/hook.mjs"), "export function launch(args,env){return JSON.stringify({args,home:env.EINZBERN_HOME})}");
  const command = hostHookCommand(hookLauncherPath(device), "UserPromptSubmit", home);
  const env = { ...process.env, USERPROFILE: home };
  delete env.EINZBERN_HOME;
  const run = spawnCommandSync(join(process.env.SystemRoot, "System32/cmd.exe"), ["/d", "/v:off", "/s", "/c", `"${command}"`], { env, encoding: "utf8", windowsVerbatimArguments: true, timeout: 15_000 });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { args: ["user-prompt-submit"], home: device });
  const remote = hostHookCommand(hookLauncherPath("D:\\device"), "UserPromptSubmit", "C:\\home");
  assert.ok(remote.includes(`Buffer.from('${Buffer.from("D:/device").toString("base64")}'`));
});

test("Windows job joins detached descendants after normal exit and cancellation", windows, async t => {
  const root = await fixture(t);
  const descendant = join(root, "descendant.cjs");
  await writeFile(descendant, "require('fs').writeFileSync(process.argv[2],String(process.pid)); setInterval(()=>{},1000);");
  for (const cancel of [false, true]) {
    const pidFile = join(root, `${cancel}.pid`);
    const script = `const {spawn}=require('child_process'); const c=spawn(process.execPath,${JSON.stringify([descendant, pidFile])},{detached:true,stdio:'ignore'}); c.unref(); ${cancel ? "setInterval(()=>{},1000)" : "setTimeout(()=>{},500)"}`;
    const child = spawnCommand(process.execPath, ["-e", script]);
    const result = collect(child);
    const pid = Number(await waitForFile(pidFile));
    if (cancel) child.kill("SIGTERM");
    const ended = await result;
    assert.equal(ended.code, cancel ? null : 0, ended.stderr);
    assert.equal(ended.signal, cancel ? "SIGTERM" : null);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  }
});

test("Windows job kills descendants when its controlling Node process is forcibly terminated", windows, async t => {
  const root = await fixture(t);
  const pidFile = join(root, "child.pid");
  const module = new URL("../skill/mana-orchestrate/scripts/process-launch.mjs", import.meta.url).href;
  const script = `import {spawnCommand} from ${JSON.stringify(module)}; const c=spawnCommand(process.execPath,['-e',${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`)}]);c.on('error',()=>{});c.stdout.resume();c.stderr.resume();`;
  const owner = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: "ignore", windowsHide: true });
  t.after(() => owner.kill());
  const pid = Number(await waitForFile(pidFile));
  owner.kill("SIGKILL");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { process.kill(pid, 0); } catch (error) { assert.equal(error.code, "ESRCH"); return; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail("Job descendant survived its owner");
});

test("Windows spawn guard reads live job membership and clears only a joined job", windows, async () => {
  const child = spawnCommand(process.execPath, ["-e", "setInterval(()=>{},1000)"]);
  const result = collect(child);
  await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  const at = "2026-11-16T00:00:00Z";
  const registration = { pgid: child.pid, pattern: "setInterval", purpose: "windows-fixture", spawnedAt: at, windowsJobName: child.jobName };
  const registry = buildRegistrationLine(registration);
  assert.deepEqual(parseRegistrationLine(registry), registration);
  try {
    const live = detectOwnedFromTable(registry, readProcessTable(registry), at, registration.purpose);
    assert.equal(live.status, "residue-present");
    assert.ok(live.residue.some(row => row.pid === child.pid));
  } finally {
    child.kill();
    await result;
  }
  assert.equal(detectOwnedFromTable(registry, readProcessTable(registry), at, registration.purpose).status, "clean");
});

test("Windows Kiro discovery requires executable and product evidence", windows, async t => {
  const root = await fixture(t);
  const installation = join(root, "Programs", "Kiro");
  await mkdir(join(installation, "resources", "app"), { recursive: true });
  await writeFile(join(installation, "Kiro.exe"), "fixture");
  await writeFile(join(installation, "resources", "app", "product.json"), JSON.stringify({ applicationName: "kiro", win32AppUserModelId: "Kiro" }));
  await writeFile(join(installation, "resources", "app", "package.json"), JSON.stringify({ version: "1.4.178" }));
  const input = { home: root, executable: process.execPath, env: { ...process.env, LOCALAPPDATA: root, ProgramFiles: root, "ProgramFiles(x86)": root } };
  const identity = probeKiroHost(input);
  assert.equal(identity.ide.status, "available");
  assert.equal(identity.ide.version, "1.4.178");
  assert.equal(identity.ide.bundlePath, installation);
  assert.equal(identity.selected, "unknown");
  await rm(join(installation, "Kiro.exe"));
  assert.notEqual(probeKiroHost(input).ide.status, "available");
});

test("Windows output session recovers after its kernel job has ended", windows, async t => {
  const root = await fixture(t);
  await mkdir(join(root, ".git"));
  const module = new URL("../scripts/lib/safe-io.mjs", import.meta.url).href;
  const script = `import {withExclusiveOutputSession} from ${JSON.stringify(module)}; await withExclusiveOutputSession(${JSON.stringify(root)},()=>process.exit(17));`;
  const ended = await collect(spawnCommand(process.execPath, ["--input-type=module", "-e", script]));
  assert.equal(ended.code, 17, ended.stderr);
  const owner = JSON.parse(await readFile(join(root, ".git", "einzbern-output.lock", "owner.json"), "utf8"));
  assert.match(owner.jobName, /^Local\\Einzbern-/u);
  await withExclusiveOutputSession(root, () => safeWriteOutput(root, "dist/recovered.txt", "recovered\n"));
  assert.equal(await readFile(join(root, "dist", "recovered.txt"), "utf8"), "recovered\n");
});
