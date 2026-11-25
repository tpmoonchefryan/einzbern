// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-INIT-109: Devin as a host. These are fixture checks of the candidate: the hook
// document, the hook runtime, the launcher's yield, the subagent profiles and their wiring into
// setup, doctor and policy resolution. They do not show that a Devin session ran a hook.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { writeNodeExecutable } from "./helpers/executable-fixture.mjs";
import { DEVIN_READ_MATCHER, HOST_HOOK_HOSTS, applyHostHooks, isEinzbernHookCommand } from "../dist/build/packages/core/src/host-hooks.js";
import { hookHost, hookProtocolOutput } from "../dist/build/packages/core/src/hook-recall.js";
import {
  applyDevinProfiles,
  devinConfigRoot,
  devinHookCount,
  devinHooksFile,
  devinProfileName,
  devinProfileOwnership,
  devinSelectionStatus,
  inspectDevinProfile,
  planDevinHooks,
  planDevinProfiles,
  probeDevinHost,
  renderDevinProfile,
} from "../dist/build/packages/core/src/devin-host.js";
import { validateHostCapabilities } from "../dist/build/packages/core/src/host-capabilities.js";
import { applyEngineModelPolicySet } from "../dist/build/packages/core/src/engine-model-policy.js";
import { SetupRecorder, applyHooks, planHooks } from "../dist/build/packages/core/src/setup-fresh.js";
import { runDoctor } from "../dist/build/packages/core/src/doctor.js";
import { runCli } from "../dist/build/packages/cli/src/index.js";
import { runHookEvent } from "../scripts/einzbern-hook.mjs";
import * as launcher from "../scripts/einzbern-hook-launcher.mjs";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const SAVED_ENV = ["EINZBERN_HOST", "EINZBERN_HOME", "DEVIN_PROJECT_DIR", "CLAUDE_PROJECT_DIR", "XDG_CONFIG_HOME", "HOME", "USERPROFILE"];
const BOUND = "process.env.EINZBERN_HOST='devin'";
const authorization = { decidedIn: `minutes:${"a".repeat(24)}#D1`, libraryId: `library:${"b".repeat(24)}`, target: "models.engine-policy" };

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "einzbern-devin-")));
  const saved = Object.fromEntries(SAVED_ENV.map((name) => [name, process.env[name]]));
  const exitCode = process.exitCode;
  for (const name of ["EINZBERN_HOST", "DEVIN_PROJECT_DIR", "CLAUDE_PROJECT_DIR", "XDG_CONFIG_HOME"]) delete process.env[name];
  t.after(async () => {
    for (const name of SAVED_ENV) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    process.exitCode = exitCode;
    await rm(root, { recursive: true, force: true });
  });
  const f = { root, home: join(root, "home"), deviceHome: join(root, "device"), project: join(root, "project") };
  for (const directory of [f.home, f.deviceHome, f.project]) await mkdir(directory, { recursive: true });
  f.config = devinConfigRoot({ home: f.home, env: {} });
  f.configFile = join(f.config, "config.json");
  return f;
}

const tier = (order, category, model, effort = "default") => ({ order, category, runner: "devin", model, effort, note: "" });
function policy(tiers) {
  return {
    categories: ["flagship", "main", "economy"].map((id, index) => ({ id, name: id, description: "", order: index + 1 })),
    tiers,
    escalation: { enabled: true, threshold: 2, ceiling: "main" },
  };
}
const savePolicy = (deviceHome, tiers) => applyEngineModelPolicySet({ home: deviceHome, host: "devin", policy: policy(tiers), occurredAt: "2026-11-21T00:00:00Z", actor: "agent:fixture", authorization });
const commandsOf = (document, event) => (document.hooks?.[event] ?? []).flatMap((group) => group.hooks.map((hook) => hook.command));
async function hookLog(deviceHome) {
  const text = await readFile(join(deviceHome, "log", "hook.ndjson"), "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("INIT109-1: the configuration root stays inside the given home and its directory is the selection evidence", async (t) => {
  const f = await fixture(t);
  assert.equal(devinConfigRoot({ home: f.home, env: {}, platform: "linux" }), join(f.home, ".config", "devin"));
  assert.equal(devinConfigRoot({ home: f.home, env: { XDG_CONFIG_HOME: join(f.home, "xdg") }, platform: "linux" }), join(f.home, "xdg", "devin"));
  // Another user's configuration, a relative value and the home itself never redirect the plan.
  for (const value of [join(f.root, "elsewhere"), "relative", f.home]) {
    assert.equal(devinConfigRoot({ home: f.home, env: { XDG_CONFIG_HOME: value }, platform: "linux" }), join(f.home, ".config", "devin"));
  }
  assert.equal(devinConfigRoot({ home: f.home, env: { APPDATA: join(f.home, "Roaming") }, platform: "win32" }), join(f.home, "Roaming", "devin"));
  assert.equal(devinConfigRoot({ home: f.home, env: {}, platform: "win32" }), join(f.home, "AppData", "Roaming", "devin"));
  assert.equal(devinConfigRoot({ home: f.home, devinConfigHome: join(f.root, "explicit") }), join(f.root, "explicit"));
  assert.equal(devinHooksFile({ home: f.home, env: {} }), f.configFile);

  assert.equal(devinSelectionStatus({ home: f.home, env: {} }), "not-selected");
  assert.equal(await planDevinHooks({ home: f.home, env: {}, deviceHome: f.deviceHome }), null);
  assert.equal(await planDevinProfiles({ home: f.home, env: {}, tiers: [tier(10, "main", "m")] }), null);
  await mkdir(dirname(f.config), { recursive: true });
  await writeFile(f.config, "not a directory");
  assert.equal(devinSelectionStatus({ home: f.home, env: {} }), "unknown");
  await rm(f.config);
  await mkdir(f.config);
  assert.equal(devinSelectionStatus({ home: f.home, env: {} }), "selected");
  assert.ok(HOST_HOOK_HOSTS.includes("devin"));
});

test("INIT109-2: the probe reads a version and a Desktop bundle and claims no selection", async (t) => {
  const f = await fixture(t);
  const bin = join(f.root, "bin");
  await mkdir(bin);
  const fake = await writeNodeExecutable(join(bin, "devin"), "console.log('devin 3000.14.30833 (a165b2eb0a68)');");
  const bundle = join(f.root, "Devin.app");
  await mkdir(join(bundle, "Contents"), { recursive: true });
  const plist = (name) => `<plist><dict><key>CFBundleName</key><string>${name}</string><key>CFBundleShortVersionString</key><string>3.14.30833</string></dict></plist>`;
  await writeFile(join(bundle, "Contents", "Info.plist"), plist("Devin"));
  const seen = probeDevinHost({ home: f.home, executable: fake, desktopBundlePath: bundle, now: "2026-11-21T00:00:00Z" });
  assert.deepEqual(seen.cli, { status: "available", executable: fake, version: "3000.14.30833", versionEvidence: "devin --version" });
  assert.deepEqual(seen.desktop, { status: "available", bundlePath: bundle, version: "3.14.30833" });
  assert.equal(seen.selected, "unknown");
  assert.equal(seen.subagentFirstWork.status, "unknown");

  await writeFile(join(bundle, "Contents", "Info.plist"), plist("Another"));
  const other = probeDevinHost({ home: f.home, executable: join(bin, "absent-devin"), desktopBundlePath: bundle });
  assert.equal(other.cli.status, "not-detected");
  assert.deepEqual(other.desktop, { status: "unknown", bundlePath: bundle, version: null });
});

test("INIT109-3: Devin's hooks are written into its own configuration, bound to devin, without touching the rest", async (t) => {
  const f = await fixture(t);
  await mkdir(f.config, { recursive: true });
  await writeFile(f.configFile, `${JSON.stringify({ version: 1, permissions: { allow: ["Exec(git)"] } })}\n`);
  const at = "2026-11-21T00:00:00Z";
  const backupRoot = join(f.deviceHome, "backups");

  const first = await planDevinHooks({ home: f.home, env: {}, deviceHome: f.deviceHome, navigation: "written" });
  assert.equal(first.files.length, 1);
  assert.equal(first.files[0].path, f.configFile);
  assert.equal(first.files[0].changed, true);
  await applyHostHooks(first, { at, backupRoot });
  const written = JSON.parse(await readFile(f.configFile, "utf8"));
  assert.equal(written.version, 1);
  assert.deepEqual(written.permissions, { allow: ["Exec(git)"] });
  assert.deepEqual(Object.keys(written.hooks).sort(), ["PreToolUse", "UserPromptSubmit"]);
  assert.equal(written.hooks.PreToolUse[0].matcher, DEVIN_READ_MATCHER);
  assert.equal(written.hooks.UserPromptSubmit[0].matcher, undefined);
  for (const event of ["UserPromptSubmit", "PreToolUse"]) {
    const [command] = commandsOf(written, event);
    assert.ok(isEinzbernHookCommand(command), command);
    assert.ok(command.includes(BOUND), "Devin's own commands name their host");
    assert.ok(!command.includes(f.root), "no device path is embedded");
  }
  assert.equal(devinHookCount(await readFile(f.configFile, "utf8")), 1);
  assert.equal((await planDevinHooks({ home: f.home, env: {}, deviceHome: f.deviceHome, navigation: "written" })).files[0].changed, false, "rendering again changes nothing");

  // Declined navigation adds the pointer hook; a user's own group in the same event stays.
  written.hooks.PreToolUse.push({ matcher: "exec", hooks: [{ type: "command", command: "./check.sh" }] });
  await writeFile(f.configFile, `${JSON.stringify(written, null, 2)}\n`);
  const declined = await planDevinHooks({ home: f.home, env: {}, deviceHome: f.deviceHome, navigation: "declined" });
  const declinedDocument = JSON.parse(declined.files[0].after);
  assert.ok(commandsOf(declinedDocument, "SessionStart")[0].includes(BOUND));
  assert.deepEqual(declinedDocument.hooks.PreToolUse.at(-1), { matcher: "exec", hooks: [{ type: "command", command: "./check.sh" }] });
  assert.equal(declinedDocument.hooks.SubagentStart, undefined, "Devin has no subagent-start event");

  // A relocated device directory replaces the commands and keeps one copy of each.
  const moved = await planDevinHooks({ home: f.home, env: {}, deviceHome: join(f.root, "device-moved"), navigation: "written" });
  const movedDocument = JSON.parse(moved.files[0].after);
  assert.equal(commandsOf(movedDocument, "UserPromptSubmit").length, 1);
  assert.equal(movedDocument.hooks.PreToolUse.filter((group) => group.matcher === DEVIN_READ_MATCHER).length, 1);
  assert.notEqual(commandsOf(movedDocument, "UserPromptSubmit")[0], commandsOf(written, "UserPromptSubmit")[0]);

  // An edited managed group is a conflict; the file keeps its bytes.
  const edited = structuredClone(written);
  edited.hooks.PreToolUse[0].matcher = "^(read|exec)$";
  const editedText = `${JSON.stringify(edited, null, 2)}\n`;
  await writeFile(f.configFile, editedText);
  await assert.rejects(planDevinHooks({ home: f.home, env: {}, deviceHome: f.deviceHome, navigation: "written" }), { reasonCode: "HOST_HOOKS_FILE_UNSUPPORTED" });
  await assert.rejects(planDevinHooks({ home: f.home, env: {}, deviceHome: f.deviceHome, install: false }), { reasonCode: "HOST_HOOKS_FILE_UNSUPPORTED" });
  assert.equal(await readFile(f.configFile, "utf8"), editedText);

  // Uninstall takes out only what is ours.
  await writeFile(f.configFile, `${JSON.stringify(written, null, 2)}\n`);
  const removal = await planDevinHooks({ home: f.home, env: {}, deviceHome: f.deviceHome, install: false });
  await applyHostHooks(removal, { at: "2026-11-21T00:00:05Z", backupRoot });
  const bare = JSON.parse(await readFile(f.configFile, "utf8"));
  assert.equal(devinHookCount(JSON.stringify(bare)), 0);
  assert.deepEqual(bare.hooks, { PreToolUse: [{ matcher: "exec", hooks: [{ type: "command", command: "./check.sh" }] }] });
  assert.deepEqual(bare.permissions, { allow: ["Exec(git)"] });

  // Devin accepts comments in this file; the engine cannot write it back losslessly and refuses.
  const commented = "{\n  // my settings\n  \"version\": 1\n}\n";
  await writeFile(f.configFile, commented);
  await assert.rejects(planDevinHooks({ home: f.home, env: {}, deviceHome: f.deviceHome }), { reasonCode: "HOST_HOOKS_FILE_UNSUPPORTED" });
  assert.equal(await readFile(f.configFile, "utf8"), commented);
});

test("INIT109-4: a Devin hook run is recorded as devin and its read tool keeps the 32 KiB, 200-line window", async (t) => {
  const f = await fixture(t);
  assert.equal(hookHost({ DEVIN_PROJECT_DIR: "/p", CLAUDE_PROJECT_DIR: "/p" }), "devin", "Devin also sets the Claude Code variable for the registration it imports");
  assert.equal(hookHost({ EINZBERN_HOST: "devin" }), "devin");
  assert.equal(hookHost({ EINZBERN_HOST: "claude-code", DEVIN_PROJECT_DIR: "/p" }), "claude-code", "a declared host still wins");
  assert.equal(hookHost({ CLAUDE_PROJECT_DIR: "/p" }), "claude-code");
  assert.equal(hookHost({ DEVIN_PROJECT_DIR: "" }), "codex");
  assert.deepEqual(JSON.parse(hookProtocolOutput("devin", "UserPromptSubmit", ["one", "two"])), { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "one\ntwo" } });

  const big = join(f.project, "big.txt");
  const image = join(f.project, "big.png");
  const small = join(f.project, "small.txt");
  const body = Array.from({ length: 2000 }, (_, index) => `line ${String(index).padStart(5, "0")} of the large file`).join("\n");
  await writeFile(big, body);
  await writeFile(image, body);
  await writeFile(small, "short\n");
  process.env.EINZBERN_HOME = f.deviceHome;
  process.env.EINZBERN_HOST = "devin";
  const read = (tool_input, tool_name = "read") => runHookEvent({ event: "pre-tool-use", payload: { hook_event_name: "PreToolUse", tool_name, tool_input, session_id: "s" }, cwd: f.project });

  for (const input of [{ file_path: big }, { file_path: big, limit: 201 }, { file_path: "big.txt", offset: 10 }]) {
    const answer = JSON.parse(await read(input));
    assert.equal(answer.decision, "block");
    assert.match(answer.reason, /at most 200 lines/u);
  }
  assert.equal(await read({ file_path: big, offset: 1, limit: 200 }), null);
  assert.equal(await read({ file_path: small }), null);
  assert.equal(await read({ file_path: image }), null, "an image is not a text window");
  assert.equal(await read({ command: `cat ${big}` }, "exec"), null, "shell commands are never interpreted");
  assert.equal(await read({ file_path: big }, "Read"), null, "only Devin's own tool name is guarded under devin");
  assert.equal(await read({ file_path: join(f.project, "absent.txt") }), null);
  const pointer = JSON.parse(await runHookEvent({ event: "session-start", payload: { source: "startup" }, cwd: f.project }));
  assert.match(pointer.hookSpecificOutput.additionalContext, /Mana Orchestrate/u);

  const rows = await hookLog(f.deviceHome);
  assert.ok(rows.length >= 9);
  assert.ok(rows.every((row) => row.host === "devin" && row.event === "pre-tool-use"));
  assert.equal(rows.filter((row) => row.reasonCode === "HOOK_READ_GUARD_DENIED").length, 3);

  // Claude Code keeps its own contract: its Read is guarded with its own answer, `read` is not its tool.
  process.env.EINZBERN_HOST = "claude-code";
  assert.equal(await read({ file_path: big }), null);
  assert.equal(JSON.parse(await read({ file_path: big }, "Read")).hookSpecificOutput.permissionDecision, "deny");
});

test("INIT109-5: under Devin the imported Claude Code registration yields to Devin's own and never takes the Codex path", async (t) => {
  const f = await fixture(t);
  await mkdir(f.config, { recursive: true });
  assert.equal(launcher.devinRegistrationInstalled({}, f.home, "user-prompt-submit"), false);
  const plan = await planDevinHooks({ home: f.home, env: {}, deviceHome: f.deviceHome, navigation: "written" });
  await applyHostHooks(plan, { at: "2026-11-21T00:00:00Z", backupRoot: join(f.deviceHome, "backups") });
  assert.equal(launcher.devinRegistrationInstalled({}, f.home, "user-prompt-submit"), true);
  assert.equal(launcher.devinRegistrationInstalled({}, f.home, "pre-tool-use"), true);
  assert.equal(launcher.devinRegistrationInstalled({}, f.home, "subagent-start"), false, "a hook for another event cannot claim this event");
  const installed = await readFile(f.configFile, "utf8");
  const document = JSON.parse(installed);
  await writeFile(f.configFile, JSON.stringify({ hooks: { PreToolUse: document.hooks.PreToolUse } }));
  assert.equal(launcher.devinRegistrationInstalled({}, f.home, "user-prompt-submit"), false, "PreToolUse alone leaves imported prompt recall available");
  assert.equal(launcher.devinRegistrationInstalled({}, f.home, "pre-tool-use"), true);
  await writeFile(f.configFile, JSON.stringify({ hooks: { UserPromptSubmit: document.hooks.PreToolUse } }));
  assert.equal(launcher.devinRegistrationInstalled({}, f.home, "user-prompt-submit"), false, "the event group must agree with the launcher's event argument");
  await writeFile(f.configFile, installed);

  const run = (event, env) => spawnSync(process.execPath, [join(repositoryRoot, "scripts", "einzbern-hook-launcher.mjs"), event], {
    cwd: f.project,
    input: JSON.stringify({ session_id: "devin-session", cwd: f.project, hook_event_name: "UserPromptSubmit", prompt: "hello", tool_name: "read", tool_input: { file_path: "x" } }),
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: f.home, USERPROFILE: f.home, EINZBERN_HOME: f.deviceHome, ...env },
  });
  const imported = { DEVIN_PROJECT_DIR: f.project, CLAUDE_PROJECT_DIR: f.project };
  for (const event of ["user-prompt-submit", "pre-tool-use", "subagent-start"]) {
    const yielded = run(event, imported);
    assert.equal(yielded.status, 0, yielded.stderr);
    assert.equal(yielded.stdout, "");
    assert.equal(yielded.stderr, "");
  }
  assert.deepEqual((await hookLog(f.deviceHome)).map((row) => [row.event, row.reasonCode, row.host]), [["user-prompt-submit", "HOOK_DEVIN_IMPORT_YIELDED", "devin"]]);

  // A comment added later makes the file JSON with comments; the registration is still found.
  await writeFile(f.configFile, `// edited by the user\n${installed}`);
  assert.equal(launcher.devinRegistrationInstalled({}, f.home, "user-prompt-submit"), true);
  // Only the unbound Claude Code command: nothing of Devin's own is installed.
  const unbound = installed.replaceAll(BOUND, "");
  await writeFile(f.configFile, unbound);
  assert.equal(launcher.devinRegistrationInstalled({}, f.home, "user-prompt-submit"), false);

  // Without Devin's own registration the imported run goes on. Even when the host withholds the
  // Claude Code variable it is not taken for Codex: no Codex coordination state appears.
  const alone = run("user-prompt-submit", { DEVIN_PROJECT_DIR: f.project });
  assert.equal(alone.status, 0, alone.stderr);
  assert.equal(alone.stdout, "");
  for (const directory of ["codex-query-guards", "codex-peer-roles", "codex-peer-handoffs"]) assert.equal(existsSync(join(f.deviceHome, directory)), false, directory);
});

test("INIT109-6: one profile per tier row, owned by its marker, updated with the policy and never over a user's edit", async (t) => {
  const f = await fixture(t);
  await mkdir(f.config, { recursive: true });
  const agents = join(f.config, "agents");
  const tiers = [tier(10, "main", "model-main"), tier(20, "economy", "model-eco", "high"), tier(30, "flagship", "", "")];
  const apply = async (rows, at) => {
    const plan = await planDevinProfiles({ home: f.home, env: {}, tiers: rows });
    await applyDevinProfiles(plan, { at, deviceHome: f.deviceHome });
    return plan;
  };

  const created = await apply(tiers, "2026-11-21T00:00:00Z");
  assert.deepEqual(created.files.map((file) => [file.name, file.action]), [["einzbern-economy-20", "create"], ["einzbern-main-10", "create"]], "a row without a model gets no profile");
  assert.equal(devinProfileName(tiers[0]), "einzbern-main-10");
  const main = await readFile(join(agents, "einzbern-main-10.md"), "utf8");
  assert.equal(main, renderDevinProfile(tiers[0]));
  assert.match(main, /^---\nname: "einzbern-main-10"\ndescription: "[^"\n]+"\nmodel: "model-main"\n---\n<!-- einzbern:managed-profile v1 sha256=[a-f0-9]{64} -->\n/u);
  assert.ok(!/\n(?:effort|allowed-tools|tools|max-nesting):/u.test(main), "only keys Devin documents, and no nesting");
  assert.ok(main.includes("~/.agents/skills/mana-orchestrate/SKILL.md"));
  assert.ok(!main.includes(f.root));
  assert.match(await readFile(join(agents, "einzbern-economy-20.md"), "utf8"), /requests effort high; a Devin profile cannot set it/u);
  assert.equal(devinProfileOwnership(main), "owned");
  const again = await planDevinProfiles({ home: f.home, env: {}, tiers });
  assert.equal(again.changed, false);
  assert.ok(again.files.every((file) => file.action === "current"));

  // A policy change updates the owned file and keeps the replaced bytes.
  const economyBefore = await readFile(join(agents, "einzbern-economy-20.md"), "utf8");
  const changed = await apply([tiers[0], tier(20, "economy", "model-eco-2", "high")], "2026-11-21T00:00:10Z");
  assert.deepEqual(changed.files.map((file) => file.action), ["update", "current"]);
  assert.equal(await readFile(join(f.deviceHome, "backups", "20261121T000010Z", "host-profiles", "devin", "einzbern-economy-20.md"), "utf8"), economyBefore);

  // A user's edit and a user's own file are theirs.
  const editedMain = `${main}- my extra rule\n`;
  await writeFile(join(agents, "einzbern-main-10.md"), editedMain);
  await writeFile(join(agents, "einzbern-custom.md"), "---\nname: einzbern-custom\n---\nmine\n");
  assert.equal(devinProfileOwnership(editedMain), "modified");
  assert.equal(devinProfileOwnership("---\nname: x\n---\n"), "foreign");
  const conflicted = await planDevinProfiles({ home: f.home, env: {}, tiers: [tier(10, "main", "model-main-2"), tier(20, "economy", "model-eco-2", "high")] });
  assert.deepEqual(conflicted.conflicts, [join(agents, "einzbern-main-10.md")]);
  await assert.rejects(applyDevinProfiles(conflicted, { at: "2026-11-21T00:00:20Z", deviceHome: f.deviceHome }), { reasonCode: "DEVIN_PROFILE_USER_EDITED" });
  assert.equal(await readFile(join(agents, "einzbern-main-10.md"), "utf8"), editedMain);

  assert.deepEqual(await inspectDevinProfile({ home: f.home, env: {}, tier: tier(20, "economy", "model-eco-2", "high") }), { name: "einzbern-economy-20", status: "current" });
  assert.equal((await inspectDevinProfile({ home: f.home, env: {}, tier: tier(20, "economy", "model-eco-3", "high") })).status, "stale");
  assert.equal((await inspectDevinProfile({ home: f.home, env: {}, tier: tier(10, "main", "model-main") })).status, "modified");
  assert.equal((await inspectDevinProfile({ home: f.home, env: {}, tier: tier(40, "economy", "m") })).status, "missing");
  assert.equal((await inspectDevinProfile({ home: join(f.root, "other-home"), env: {}, tier: tiers[0] })).status, "not-selected");

  // With no devin policy the owned copy goes; the edited and the foreign file stay.
  const removed = await apply(null, "2026-11-21T00:00:30Z");
  assert.deepEqual(removed.files.map((file) => [file.name, file.action]), [["einzbern-economy-20", "remove"]]);
  assert.deepEqual((await readdir(agents)).sort(), ["einzbern-custom.md", "einzbern-main-10.md"]);
});

test("INIT109-7: setup, repair, doctor and uninstall handle Devin only where its configuration directory exists", async (t) => {
  const f = await fixture(t);
  const at = "2026-11-21T00:01:00Z";
  const devinPaths = (recorder) => recorder.writes.filter((entry) => entry.path.startsWith(f.config)).map((entry) => entry.path.slice(f.config.length + 1)).sort();
  const doctorHost = async () => (await runDoctor({ projectRoot: f.project, home: f.home, deviceHome: f.deviceHome, platform: process.platform, env: { PATH: join(f.root, "empty-bin") } }))
    .find((entry) => entry.check === "hooks-present").detail.hosts.find((host) => host.host === "devin");

  // Not selected: nothing is planned or created, and doctor says so without a cause.
  const absent = new SetupRecorder(f.deviceHome, at);
  await planHooks(absent, f.home, f.deviceHome, "written", true, undefined, false, f.project);
  assert.deepEqual(devinPaths(absent), []);
  await applyHooks(new SetupRecorder(f.deviceHome, at), { home: f.home, projectRoot: f.project, deviceHome: f.deviceHome, at, navigation: "written" });
  assert.equal(existsSync(f.config), false);
  const notSelected = await doctorHost();
  assert.equal(notSelected.applicability, "not-selected");
  assert.equal(notSelected.hooks, 0);
  assert.deepEqual(notSelected.causes, []);

  await mkdir(f.config, { recursive: true });
  await writeFile(f.configFile, "{\"version\":1}\n");
  await savePolicy(f.deviceHome, [tier(10, "main", "model-main"), tier(20, "economy", "model-eco")]);
  const missing = await doctorHost();
  assert.equal(missing.applicability, "selected");
  assert.deepEqual(missing.causes, ["HOOK_MISSING", "DEVIN_PROFILE_NOT_AS_EXPECTED"]);

  const planned = new SetupRecorder(f.deviceHome, at);
  await planHooks(planned, f.home, f.deviceHome, "written", true, undefined, false, f.project);
  assert.deepEqual(planned.blockers, []);
  assert.deepEqual(devinPaths(planned), [join("agents", "einzbern-economy-20.md"), join("agents", "einzbern-main-10.md"), "config.json"]);
  await applyHooks(new SetupRecorder(f.deviceHome, at), { home: f.home, projectRoot: f.project, deviceHome: f.deviceHome, at, navigation: "written" });
  const config = JSON.parse(await readFile(f.configFile, "utf8"));
  assert.equal(config.version, 1);
  assert.ok(commandsOf(config, "UserPromptSubmit")[0].includes(BOUND));
  const claude = JSON.parse(await readFile(join(f.home, ".claude", "settings.json"), "utf8"));
  assert.ok(!commandsOf(claude, "UserPromptSubmit")[0].includes("EINZBERN_HOST"), "the Claude Code registration is written as before");
  assert.equal(launcher.devinRegistrationInstalled({}, f.home), true);

  const repaired = new SetupRecorder(f.deviceHome, "2026-11-21T00:02:00Z");
  await planHooks(repaired, f.home, f.deviceHome, "written", true, undefined, false, f.project);
  assert.deepEqual(devinPaths(repaired), [], "a second run has nothing to write");
  const healthy = await doctorHost();
  assert.equal(healthy.hooks, 1);
  assert.deepEqual(healthy.causes, []);
  assert.deepEqual(healthy.profiles, [{ name: "einzbern-economy-20", state: "current" }, { name: "einzbern-main-10", state: "current" }]);

  // A profile the user edited blocks the plan and is reported by doctor; it is not overwritten.
  const profile = join(f.config, "agents", "einzbern-main-10.md");
  const edited = `${await readFile(profile, "utf8")}- mine\n`;
  await writeFile(profile, edited);
  await savePolicy(f.deviceHome, [tier(10, "main", "model-main-2"), tier(20, "economy", "model-eco")]);
  const blocked = new SetupRecorder(f.deviceHome, "2026-11-21T00:03:00Z");
  await planHooks(blocked, f.home, f.deviceHome, "written", true, undefined, false, f.project);
  assert.deepEqual(blocked.blockers.map((entry) => [entry.reasonCode, entry.path]), [["DEVIN_PROFILE_USER_EDITED", profile]]);
  assert.deepEqual((await doctorHost()).causes, ["DEVIN_PROFILE_NOT_AS_EXPECTED"]);
  assert.equal(await readFile(profile, "utf8"), edited);

  // Uninstall: our hooks and unmodified profiles go; the edited profile and the other keys stay.
  await applyHooks(new SetupRecorder(f.deviceHome, "2026-11-21T00:04:00Z"), { home: f.home, projectRoot: f.project, deviceHome: f.deviceHome, at: "2026-11-21T00:04:00Z", navigation: null, install: false });
  assert.deepEqual(JSON.parse(await readFile(f.configFile, "utf8")), { version: 1, hooks: {} });
  assert.deepEqual(await readdir(join(f.config, "agents")), ["einzbern-main-10.md"]);
});

test("INIT109-8: dispatch records accept devin and policy resolution names the profile to dispatch", async (t) => {
  const f = await fixture(t);
  const capabilities = { hostKind: "devin", invocationKind: "native-tool", selectionControl: "explicit", toolName: "run_subagent", toolAvailable: true, requestedSelectionSupported: "unknown", hostManagedSupported: true };
  assert.equal(validateHostCapabilities(capabilities).hostKind, "devin");
  assert.equal(validateHostCapabilities({ ...capabilities, selectionControl: "host-managed" }).toolName, "run_subagent");
  assert.throws(() => validateHostCapabilities({ ...capabilities, hostKind: "devin-cloud" }), { reasonCode: "HOST_EXECUTION_INVALID" });

  process.env.EINZBERN_HOME = f.deviceHome;
  process.env.HOME = f.home;
  process.env.USERPROFILE = f.home;
  const resolve = async (host, category, rejections) => {
    let text = "";
    await runCli(["execution-policy-resolve", "--host", host, "--category", category, "--rejections", String(rejections)], { write(value) { text += value; } });
    return JSON.parse(text);
  };
  const tiers = [tier(10, "main", "model-main"), tier(20, "economy", "model-eco-strong"), tier(30, "economy", "model-eco")];
  await savePolicy(f.deviceHome, tiers);
  assert.deepEqual((await resolve("devin", "economy", 0)).devinProfile, { name: "einzbern-economy-30", status: "not-selected" });
  await mkdir(f.config, { recursive: true });
  assert.deepEqual((await resolve("devin", "economy", 0)).devinProfile, { name: "einzbern-economy-30", status: "missing" });
  await applyDevinProfiles(await planDevinProfiles({ home: f.home, env: {}, tiers }), { at: "2026-11-21T00:00:00Z", deviceHome: f.deviceHome });
  const first = await resolve("devin", "economy", 0);
  assert.deepEqual(first.devinProfile, { name: "einzbern-economy-30", status: "current" });
  assert.equal(first.record.model, "model-eco");
  // Escalation walks tier rows, so the profile follows the row, not the category.
  assert.deepEqual((await resolve("devin", "economy", 2)).devinProfile, { name: "einzbern-economy-20", status: "current" });
  assert.deepEqual((await resolve("devin", "economy", 4)).devinProfile, { name: "einzbern-main-10", status: "current" });

  await applyEngineModelPolicySet({ home: f.deviceHome, host: "codex", policy: policy(tiers.map((row) => ({ ...row, runner: "codex" }))), occurredAt: "2026-11-21T00:00:00Z", actor: "agent:fixture", authorization });
  assert.equal(Object.hasOwn(await resolve("codex", "economy", 0), "devinProfile"), false);
});
