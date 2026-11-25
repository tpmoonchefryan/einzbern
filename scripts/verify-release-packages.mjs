#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

const engineRepo = "tpmoonchefryan/einzbern";
const manaRepo = "tpmoonchefryan/mana-orchestrate";
const versionPattern = /^\d+\.\d+\.\d+$/u;
const gitSha = /^[0-9a-f]{40}$/u;
const limits = { timeout: 120_000, maxBuffer: 32 * 1024 * 1024 };
const workKey = "RELEASE-GATE-ETHER";
const workTitle = "Violet lighthouse archive continuity";
const seedKey = "RELEASE-GATE-SEED";
const writebackKey = "RELEASE-GATE-WRITEBACK";
const seedText = "Keep the violet lighthouse in the existing Ether.";
const writebackText = "Verified the violet lighthouse after upgrading.";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const github = (path) => JSON.parse(execFileSync("gh", ["api", path], limits));

function release(repo, tag) {
  const info = github(`repos/${repo}/releases/tags/${tag}`);
  assert.equal(info.tag_name, tag);
  assert.equal(info.draft, false);
  const ref = github(`repos/${repo}/git/ref/tags/${tag}`).object;
  assert.match(ref.sha, gitSha);
  const target = ref.type === "tag" ? github(`repos/${repo}/git/tags/${ref.sha}`).object : ref;
  assert.equal(target.type, "commit");
  assert.match(target.sha, gitSha);
  return { info, refSha: ref.sha, tagCommit: target.sha };
}

async function downloadPackages(root, version, artifacts) {
  const tag = `v${version}`;
  const name = `einzbern-${version}.tar.gz`;
  const checksumName = `${name}.sha256`;
  const engine = release(engineRepo, tag);
  const mana = release(manaRepo, tag);
  const archive = join(root, name);
  execFileSync("gh", ["release", "download", tag, "--repo", engineRepo, "--pattern", name, "--pattern", checksumName, "--dir", root], limits);
  const checksum = await readFile(join(root, checksumName));
  const [expected, checkedName] = checksum.toString("utf8").trim().split(/\s+/u);
  assert.match(expected, /^[0-9a-f]{64}$/u, checksumName);
  assert.equal(checkedName, name, `Unexpected archive name in ${checksumName}`);
  const engineDigest = sha256(await readFile(archive));
  assert.equal(engineDigest, expected, `Published SHA-256 mismatch for ${name}`);
  for (const [file, digest] of [[name, engineDigest], [checksumName, sha256(checksum)]]) {
    const asset = engine.info.assets.find((entry) => entry.name === file);
    assert.ok(asset, `Missing published asset: ${file}`);
    if (asset.digest) assert.equal(asset.digest, `sha256:${digest}`, file);
    artifacts.push({ repository: engineRepo, tag, tagCommit: engine.tagCommit, artifact: file, sha256: digest });
  }

  const manaApiPath = `repos/${manaRepo}/tarball/${tag}`;
  assert.equal(mana.info.tarball_url, `https://api.github.com/${manaApiPath}`);
  const manaBytes = execFileSync("gh", ["api", manaApiPath], limits);
  const manaArchive = join(root, `mana-orchestrate-${version}.tar.gz`);
  const manaRoot = join(root, `mana-orchestrate-${version}`);
  await writeFile(manaArchive, manaBytes, { flag: "wx" });
  const entries = execFileSync("tar", ["-tzf", manaArchive], { ...limits, encoding: "utf8" }).trimEnd().split("\n");
  const prefix = `${manaRepo.replace("/", "-")}-${mana.refSha.slice(0, 7)}/`;
  assert.ok(entries.length > 1 && entries.every((entry) => entry.startsWith(prefix)), `Unexpected GitHub tarball root for ${tag}`);
  await mkdir(manaRoot);
  execFileSync("tar", ["-xzf", manaArchive, "-C", manaRoot, "--strip-components=1"], limits);
  const source = await readJson(join(manaRoot, ".github", "engine-source.json"));
  assert.equal(source.schemaVersion, "einzbern.helper-source.v1");
  assert.equal(source.repository, engineRepo);
  assert.equal(source.renderVersion, version);
  assert.match(source.commit, gitSha);
  assert.equal((await readJson(join(manaRoot, "package.json"))).version, version);
  artifacts.push({
    repository: manaRepo, tag, tagCommit: mana.tagCommit, generatorCommit: source.commit,
    artifact: mana.info.tarball_url, sha256: sha256(manaBytes),
  });
  return { version, archive, skill: join(manaRoot, "skill", "mana-orchestrate") };
}

async function deviceAt(root) {
  const home = join(root, "home"), device = join(root, "device"), project = join(root, "project");
  const workspace = join(root, "Ether"), scratch = join(root, "tmp");
  await Promise.all([home, project, scratch].map((path) => mkdir(path, { recursive: true })));
  const env = {
    PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter),
    HOME: home,
    EINZBERN_HOME: device,
    XDG_CONFIG_HOME: join(home, ".config"),
    TMPDIR: scratch,
    NODE_OPTIONS: `--import=${new URL("./no-network.mjs", import.meta.url).href}`,
  };
  const run = (entry, args) => spawnSync(process.execPath, [entry, ...args], { ...limits, cwd: project, env, encoding: "utf8" });
  const launcher = join(device, "engine", "einzbern.mjs");
  return { home, device, project, workspace, run, cli: (...args) => command(run(launcher, args), args[0]) };
}

function command(result, label) {
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${label}: ${result.stderr || result.stdout || result.signal}`);
  return JSON.parse(result.stdout);
}

function install(device, release, archive = release.archive) {
  return device.run(join(release.skill, "scripts", "install.mjs"), [
    "--version", release.version, "--archive", archive, "--home", device.device,
  ]);
}

const at = () => new Date().toISOString().replace(/\.\d{3}Z$/u, "Z");

function setup(device, mode, ...flags) {
  const args = ["setup", "--mode", mode, "--project", device.project, "--at", at(), ...flags];
  const plan = device.cli(...args);
  assert.equal(plan.reasonCode, "SETUP_PLAN_READY");
  assert.deepEqual(plan.blockers, []);
  const applied = device.cli(...args, "--yes", "true");
  assert.equal(applied.reasonCode, "SETUP_APPLIED");
  assert.ok(applied.selfCheck.checks.length > 0 && applied.selfCheck.checks.every((check) => check.ok), JSON.stringify(applied.selfCheck));
  return { plan, applied };
}

async function assertSkill(device, release) {
  const installed = join(device.home, ".claude", "skills", "mana-orchestrate");
  for (const file of ["SKILL.md", join("scripts", "install.mjs")]) {
    assert.ok((await readFile(join(installed, file))).equals(await readFile(join(release.skill, file))),
      `Installed ${file} differs from the v${release.version} Mana release`);
  }
}

function activeLibrary(device, version, libraryId) {
  const status = device.cli("status", "--workspace", device.workspace);
  assert.equal(status.reasonCode, "WORKSPACE_COMMAND_COMPLETED");
  assert.equal(status.engineVersion, version);
  assert.equal(status.workspaceId, libraryId);
}

function doctor(device) {
  const result = device.cli("doctor", "--project", device.project);
  assert.equal(result.reasonCode, "DOCTOR_READY");
  assert.equal(result.ok, true, JSON.stringify(result.checks));
}

async function fresh(device, release) {
  const installed = command(install(device, release), "install");
  assert.equal(installed.reasonCode, "INSTALL_ENGINE_READY");
  assert.equal(installed.current.version, release.version);
  const { applied } = setup(device, "fresh", "--artifacts", device.workspace, "--cloud", "false",
    "--language", "en", "--navigation", "false");
  assert.equal(applied.library.created, true);
  activeLibrary(device, release.version, applied.library.libraryId);
  await assertSkill(device, release);
  return applied.library.libraryId;
}

async function recordMinutes(device, projectId, key, decision) {
  const decisionsFile = join(device.project, `${key}.json`);
  await writeFile(decisionsFile, JSON.stringify([decision]), { flag: "wx" });
  const result = device.cli("minutes-record", "--workspace", device.workspace, "--project-id", projectId,
    "--title", key, "--summary", decision, "--decisions-file", decisionsFile, "--actor", "agent:release-gate",
    "--external-key", key, "--at", at());
  assert.equal(result.reasonCode, "MINUTES_RECORDED");
  assert.equal(result.localCommitted, true);
  assert.equal(result.verifiedReadback, true);
  readMinutes(device, key, decision);
}

function readMinutes(device, key, decision) {
  const result = device.cli("minutes-show", "--workspace", device.workspace, "--external-key", key);
  assert.equal(result.reasonCode, "WORKSPACE_RECORD_READY");
  assert.equal(result.record.externalKey, key);
  assert.deepEqual(result.record.decisions.map((row) => row.text), [decision]);
}

function checkSwitch({ plan, applied }, from, to, libraryId, reason) {
  for (const { engineSwitch, library } of [plan, applied]) {
    assert.equal(engineSwitch.from, from);
    assert.equal(engineSwitch.to, to);
    assert.equal(library.libraryId, libraryId);
  }
  assert.equal(applied.engineSwitch.reasonCode, reason);
  assert.equal(applied.library.created, false);
}

async function verify(root, from, to, receipt) {
  const freshDevice = await deviceAt(join(root, "fresh"));
  const freshLibraryId = await fresh(freshDevice, to);
  doctor(freshDevice);
  receipt.checks.push(`fresh install and doctor: ${to.version}`);

  const device = await deviceAt(join(root, "upgrade"));
  const libraryId = await fresh(device, from);
  const { projectId } = device.cli("rule-list", "--project", device.project);
  assert.ok(projectId, "Setup did not register a project");
  const work = device.cli("work-create", "--workspace", device.workspace, "--project-id", projectId,
    "--external-key", workKey, "--kind", "Initiative", "--title", workTitle, "--summary", seedText, "--at", at());
  assert.equal(work.record.externalKey, workKey);
  await recordMinutes(device, projectId, seedKey, seedText);

  checkSwitch(setup(device, "update", "--archive", to.archive), from.version, to.version, libraryId, "ENGINE_UPDATED");
  activeLibrary(device, to.version, libraryId);
  await assertSkill(device, to);
  doctor(device);
  readMinutes(device, seedKey, seedText);
  const recall = device.cli("recall", "--workspace", device.workspace, "--project-id", projectId,
    "--view", "agent", "--query", workKey, "--at", at());
  assert.equal(recall.reasonCode, "RECALL_READY");
  assert.equal(recall.workspaceId, libraryId);
  assert.ok(recall.context.some((line) => line.includes(workTitle) && line.includes(workKey)), JSON.stringify(recall.context));
  await recordMinutes(device, projectId, writebackKey, writebackText);
  receipt.checks.push(`upgrade, doctor, seeded recall and verified writeback: ${from.version} -> ${to.version}`);

  checkSwitch(setup(device, "update", "--rollback", "true"), to.version, from.version, libraryId, "ENGINE_ROLLED_BACK");
  activeLibrary(device, from.version, libraryId);
  await assertSkill(device, from);
  readMinutes(device, seedKey, seedText);
  readMinutes(device, writebackKey, writebackText);
  const restored = device.cli("work-show", "--workspace", device.workspace, "--external-key", workKey);
  assert.equal(restored.record.id, work.record.id);
  receipt.checks.push(`rollback with original and new data readable: ${to.version} -> ${from.version}`);

  const mismatch = install(freshDevice, to, from.archive);
  if (mismatch.error) throw mismatch.error;
  assert.equal(mismatch.status, 1, mismatch.stderr);
  const error = JSON.parse(mismatch.stderr);
  assert.equal(error.ok, false);
  assert.equal(error.reasonCode, "INSTALL_VERSION_MISMATCH");
  assert.equal(error.required, to.version);
  assert.equal(error.actual, from.version);
  assert.ok(error.error.includes(from.version) && error.error.includes(to.version), error.error);
  assert.equal((await readJson(join(freshDevice.device, "engine", "current"))).previous, null);
  activeLibrary(freshDevice, to.version, freshLibraryId);
  receipt.checks.push(`version mismatch refused without switching: ${error.reasonCode}`);
}

const [fromVersion, toVersion, output, ...extra] = process.argv.slice(2);
assert.ok(output && !extra.length && versionPattern.test(fromVersion) && versionPattern.test(toVersion) && fromVersion !== toVersion,
  "Usage: node scripts/verify-release-packages.mjs <from-version> <to-version> <new-receipt.json>");
const receipt = { schemaVersion: "einzbern.release-package-verification.v1", fromVersion, toVersion, ok: false, artifacts: [], checks: [] };
const root = await realpath(await mkdtemp(join(tmpdir(), "einzbern-release-packages-")));
try {
  const from = await downloadPackages(root, fromVersion, receipt.artifacts);
  const to = await downloadPackages(root, toVersion, receipt.artifacts);
  await verify(root, from, to, receipt);
  receipt.ok = true;
} finally {
  await rm(root, { recursive: true, force: true });
  await writeFile(resolve(output), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}
for (const check of receipt.checks) console.log(check);
