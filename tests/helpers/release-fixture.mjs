// SPDX-License-Identifier: Apache-2.0
// Each release test process creates and retires its own repositories and device directory.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after } from "node:test";
import { README_NAMES, renderReadmes } from "../../scripts/render-readme.mjs";
import { FRAMEWORK_VERSION, initializeLibrary, materializeWorkspace } from "../../dist/build/packages/core/src/index.js";
import { compareSemver, parseEngineVersion } from "../../dist/build/packages/core/src/format-version.js";
import { ATELIER_SURFACE, SURFACE_ENVIRONMENT_VARIABLE } from "../../dist/build/packages/cli/src/index.js";
import { registerLibrary } from "../../dist/build/packages/core/src/registry.js";
import { setGate } from "../../dist/build/packages/core/src/gates-config.js";
import { privateHeavyEnvironment } from "./heavy-slots.mjs";

export const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-release-lockstep-")));
export const OLD_VERSION = FRAMEWORK_VERSION;
const HELPER_OLD_VERSION = "1.0.7";
// The version these fixtures prepare is the patch after the built one, derived rather than written:
// a literal stops being newer the day the tree reaches it, and a fixture library the current build
// initialises refuses an older engine (ENGINE_TOO_OLD).
const OLD_PARTS = parseEngineVersion(OLD_VERSION);
export const NEXT_VERSION = `${OLD_PARTS.major}.${OLD_PARTS.minor}.${BigInt(OLD_PARTS.patch) + 1n}`;
assert.ok(OLD_PARTS.prerelease.length === 0 && compareSemver(OLD_VERSION, NEXT_VERSION) < 0, "the prepared version is a stable version after the built one");
export const FIXTURE_SCHEMA_VERSION = "tcrn.fixture-contract.v1";
export const HELPER_READMES = ["README.md", "README.en.md", "README.ja.md", "README.ko.md", "README.fr.md"];
export const RELEASE_NOTES = "Improve configuration consistency and installation diagnostics.";
export const RELEASE_CLI = fileURLToPath(new URL("../../scripts/release.mjs", import.meta.url));
export const REPOSITORY_ROOT = dirname(dirname(RELEASE_CLI));
export const SPECIFICATIONS = Object.freeze([
  "coding-style-v1.md",
  "installed-paths-v2.md", "work-practices-v1.md", "dot-task-recovery-v1.md", "batch-execution-v1.md", "resource-cleanup-v1.md", "unattended-execution-v1.md", "design-consumption-v1.md", "configuration-contract-v1.md", "settings-catalog-v1.md",
  "dispatch-admission-evidence-v1.md", "dot-execution-v1.md", "native-tool-evidence-v1.md", "host-fallback-v1.md", "engine-model-policy-v1.md", "kiro-host-v1.md", "antigravity-host-v1.md", "devin-host-v1.md",
  "shared-submit-v1.md", "config-backup-v1.md", "dot-rules-v1.md", "context-v1.md", "work-content-v1.md", "engine-hook-events-v2.md",
]);
after(() => rm(base, { recursive: true, force: true }));

export function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export async function writeText(root, path, content) {
  const target = join(root, ...path.split("/"));
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, content);
}

async function initRepo(root) {
  await mkdir(root, { recursive: true });
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "core.autocrlf", "false"]);
  git(root, ["config", "user.name", "Release Test"]);
  git(root, ["config", "user.email", "release-test@example.invalid"]);
}

export async function commitAll(root, message) {
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", message]);
}

export async function createRepos(name) {
  const root = join(base, name);
  const engineRoot = join(root, "einzbern");
  const helperRoot = join(root, "mana-orchestrate");
  await initRepo(engineRoot);
  await initRepo(helperRoot);

  await writeText(engineRoot, "package.json", `${JSON.stringify({ name: "einzbern", version: OLD_VERSION, private: true, type: "module", packageManager: JSON.parse(await readFile(join(REPOSITORY_ROOT, "package.json"), "utf8")).packageManager }, null, 2)}\n`);
  for (const packageName of ["cli", "core", "protocol"]) {
    await writeText(engineRoot, `packages/${packageName}/package.json`, `${JSON.stringify({ name: `@einzbern/${packageName}`, version: OLD_VERSION, private: true }, null, 2)}\n`);
  }
  await writeText(engineRoot, "packages/protocol/schema-fixture.json", `${JSON.stringify({ schemaVersion: FIXTURE_SCHEMA_VERSION, record: { id: "stable" } }, null, 2)}\n`);
  // Each fixture needs its own copy. Native synchronous directory copies avoid a
  // promise round trip per entry while this test process is preparing it serially.
  cpSync(join(REPOSITORY_ROOT, "dist/build"), join(engineRoot, "dist/build"), { recursive: true });
  cpSync(join(REPOSITORY_ROOT, "packages/core"), join(engineRoot, "packages/core"), { recursive: true });
  for (const directory of ["scripts", "portal", "skill"]) {
    cpSync(join(REPOSITORY_ROOT, directory), join(engineRoot, directory), { recursive: true });
  }
  for (const path of ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.txt", "native/linux-source-lease.c", "packages/core/src/names.ts", "docs/codex-native-controller.md", "docs/antigravity-swarm-controller.md", "docs/design/memory-admission.md", "docs/design/continuous-source-attestor.md", ...SPECIFICATIONS.map(name => `specs/${name}`)]) {
    await writeText(engineRoot, path, await readFile(join(REPOSITORY_ROOT, path), "utf8"));
  }
  await writeText(engineRoot, "packages/core/src/framework-version.ts", await readFile(join(REPOSITORY_ROOT, "packages/core/src/framework-version.ts"), "utf8"));
  await writeText(engineRoot, "scripts/einzbern.mjs", await readFile(join(REPOSITORY_ROOT, "scripts/einzbern.mjs"), "utf8"));
  await writeText(engineRoot, ".gitignore", "/dist/\n/node_modules/\n");
  await writeText(engineRoot, "CHANGELOG.md", `# Changelog\n\n## Unreleased\n\n${RELEASE_NOTES}\n\n## ${OLD_VERSION}\n\nEarlier release.\n`);
  for (const name of README_NAMES) {
    await writeText(engineRoot, `docs/readme/einzbern/${name}`, `# Einzbern\n\n![release](https://img.shields.io/badge/release-{{version}}-blue)\n`);
  }
  await renderReadmes({ root: engineRoot, version: OLD_VERSION });
  await commitAll(engineRoot, "initial engine");

  await writeText(helperRoot, "package.json", `${JSON.stringify({ name: "mana-orchestrate", version: HELPER_OLD_VERSION, private: true }, null, 2)}\n`);
  await writeText(helperRoot, ".gitignore", "/node_modules/\n");
  await writeText(helperRoot, `skill/mana-orchestrate/SKILL.md`, `# Mana Orchestrate\n\nNavigation for Einzbern ${OLD_VERSION}: generated for this version.\n`);
  for (const name of HELPER_READMES) {
    await writeText(helperRoot, name, `# Mana Orchestrate\n\n![release](https://img.shields.io/badge/release-${HELPER_OLD_VERSION}-blue)\n`);
  }
  await commitAll(helperRoot, "initial helper");
  return { engineRoot: await realpath(engineRoot), helperRoot: await realpath(helperRoot), projectRoot: await realpath(root) };
}

// TCRN-CROSS-SUB-502 (STORY-538 GWT5): the gates-run a release step starts takes its heavy-run slot in a
// directory of this case's own, outside the case's project root, never the slot of a run around the test.
export async function makeEnvironment(name) {
  const home = join(base, name, "home");
  const einZbernHome = join(home, ".einzbern");
  await mkdir(einZbernHome, { recursive: true });
  return privateHeavyEnvironment(join(base, "heavy-locks", name), { ...process.env, HOME: home, EINZBERN_HOME: einZbernHome });
}

export async function makeWorkspace(name, repos, environment, { declarations = "required", red = false, helperRequired = true } = {}) {
  const workspace = join(base, name, "release-workspace");
  await initializeLibrary({ root: workspace, createdAt: "2026-09-27T00:00:00Z" });
  await registerLibrary({ projectPath: repos.projectRoot, libraryPath: workspace, registeredAt: "2026-09-27T00:00:01Z" }, environment.EINZBERN_HOME);
  if (declarations !== "empty") {
    for (const [index, [name, root]] of [["engine:fixture", repos.engineRoot], ["helper:fixture", repos.helperRoot]].entries()) {
      await setGate(workspace, {
        occurredAt: `2026-09-27T00:00:0${index + 2}Z`, name,
        gate: { command: [process.execPath, "-e", `process.exit(process.cwd() === ${JSON.stringify(root)} ? ${red && index === 0 ? 3 : 0} : 19)`], root: basename(root), covers: ["**"], required: declarations === "required" && (index === 0 || helperRequired), enabled: declarations !== "disabled", releaseOnly: true },
      });
    }
  }
  return workspace;
}

export function pinnedBuildArguments(engineRoot) {
  return ["pnpm@11.3.0", "--dir", engineRoot, "--recursive", "--filter", "einzbern{.}", "--fail-if-no-match", "--reporter=ndjson", "run", "--stream", "build"];
}

// TCRN-CROSS-SUB-357 rev4 (INIT-053 R41 B1): generate and finish. The fixture helper carries a kept
// LICENSE, two tracked extra files (the C5 script and a retired reference) and, when asked, an
// ignored extra file; render and build are stand-ins, gate reads and runs are the real CLI.
export const CREATE_SKILL_ARCHIVE = "skill/mana-orchestrate/scripts/create-skill-archive.mjs";
export const RETIRED_REFERENCE = "skill/mana-orchestrate/references/retired-guide.md";
export const IGNORED_EXTRA = "ignored-extra.txt";

export async function createReleaseFixture(name, { red = false, ignoredExtra = false } = {}) {
  const repos = await createRepos(name);
  await writeText(repos.helperRoot, "LICENSE", "Apache-2.0 fixture\n");
  await writeText(repos.helperRoot, CREATE_SKILL_ARCHIVE, "// fixture copy of the helper archive script\n");
  await writeText(repos.helperRoot, RETIRED_REFERENCE, "# Retired guide\n");
  if (ignoredExtra) await writeText(repos.helperRoot, ".gitignore", `/node_modules/\n/${IGNORED_EXTRA}\n`);
  await commitAll(repos.helperRoot, "helper extras");
  if (ignoredExtra) await writeText(repos.helperRoot, IGNORED_EXTRA, "ignored, untracked\n");
  const environment = await makeEnvironment(name);
  const workspace = await makeWorkspace(name, repos, environment, { red });
  return { ...repos, environment, workspace, receiptPath: join(repos.projectRoot, "release-receipt.json") };
}

export function commitRelease(fixture, receipt) {
  git(fixture.engineRoot, ["add", "-A"]);
  git(fixture.engineRoot, ["commit", "-q", "-m", "release engine"]);
  if (receipt.helper.removeFiles.length > 0) git(fixture.helperRoot, ["rm", "-q", "--", ...receipt.helper.removeFiles]);
  git(fixture.helperRoot, ["add", "-A"]);
  git(fixture.helperRoot, ["commit", "-q", "-m", "release helper"]);
}

// SUB-544: configuration scope is independent of the registered filesystem root. These
// fixtures use native project creation, scoped declarations and the actual built CLI.
export async function scopedReleaseProject(fixture, key, { required = true, helperRequired = true, enabled = true, rootOverride, covers = ["**"], red = false } = {}) {
  if (!fixture.coordinationReady) {
    const cli = join(fixture.engineRoot, "scripts/einzbern.mjs");
    const libraryId = (await materializeWorkspace(fixture.workspace)).metadata.workspaceId;
    // Only these scoped fixtures need a coordination chain. Legacy default-library fixtures
    // keep their undeclared identity and registration, exercising the compatibility path.
    execFileSync(process.execPath, [cli, "chain-declare", "--workspace", fixture.workspace, "--role", "coordination", "--coordination-library-id", libraryId, "--at", "2026-10-08T00:00:00Z"], { env: { ...fixture.environment, [SURFACE_ENVIRONMENT_VARIABLE]: ATELIER_SURFACE }, stdio: ["ignore", "pipe", "pipe"] });
    // A coordination directory has one unscoped registration; A and B are configuration
    // identities inside that chain, never competing registrations for the same directory.
    execFileSync(process.execPath, [cli, "library-register", "--project", fixture.projectRoot, "--library", fixture.workspace, "--at", "2026-10-08T00:00:00Z"], { env: fixture.environment, stdio: ["ignore", "pipe", "pipe"] });
    fixture.coordinationReady = true;
  }
  const created = JSON.parse(execFileSync(process.execPath, [join(fixture.engineRoot, "scripts/einzbern.mjs"), "project-create", "--workspace", fixture.workspace, "--external-key", key, "--name", key, "--at", "2026-10-08T00:00:01Z"], { env: fixture.environment, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  const projectId = created.record.id;
  for (const [index, [name, root]] of [["engine:fixture", fixture.engineRoot], ["helper:fixture", fixture.helperRoot]].entries()) {
    await setGate(fixture.workspace, {
      occurredAt: `2026-10-08T00:00:0${index + 2}Z`, configurationProjectId: projectId, name,
      gate: { command: [process.execPath, "-e", `process.exit(process.cwd() === ${JSON.stringify(root)} ? ${red ? 7 : 0} : 19)`], root: rootOverride ?? basename(root), covers, required: required && (index === 0 || helperRequired), enabled, releaseOnly: true },
    });
  }
  return projectId;
}
