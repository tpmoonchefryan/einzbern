// SPDX-License-Identifier: Apache-2.0
// The complete offline release, real pack, multi-Story gates and done consumption share one fixture.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync } from "node:fs";
import { cp, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import test from "node:test";
import { checkReleaseGatePlan, finishRelease, generateRelease, validateReleaseCommits } from "../scripts/lib/release-lockstep.mjs";
import { gateTreeState } from "../dist/build/packages/core/src/gates-run.js";
import { validateFrozenDependencyGraph } from "../scripts/lib/dependency-graph.mjs";
import { createDependencyMaterialization, populateDependencyStore } from "../scripts/lib/dependency-materialization.mjs";
import {
  NEXT_VERSION,
  OLD_VERSION,
  RELEASE_NOTES,
  REPOSITORY_ROOT,
  commitAll,
  commitRelease,
  createReleaseFixture,
  git,
  pinnedBuildArguments,
  scopedReleaseProject,
  writeText,
} from "./helpers/release-fixture.mjs";

// Capture Corepack's standard cache resolution before any fixture substitutes HOME.
const SOURCE_COREPACK_HOME = resolve(process.env.COREPACK_HOME ?? join(
  process.env.XDG_CACHE_HOME ?? process.env.LOCALAPPDATA ?? join(homedir(), process.platform === "win32" ? "AppData/Local" : ".cache"),
  "node/corepack",
));
// pnpm resolves this independently of Corepack. Retain the source location before
// the complete release fixture gives the real installer a private HOME and cache.
const SOURCE_PNPM_CACHE = resolve(process.env.pnpm_config_cache_dir || process.env.PNPM_CONFIG_CACHE_DIR || (
  process.env.XDG_CACHE_HOME ? join(process.env.XDG_CACHE_HOME, "pnpm")
    : process.platform === "darwin" ? join(homedir(), "Library/Caches/pnpm")
      : process.platform !== "win32" ? join(homedir(), ".cache/pnpm")
        : process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "pnpm-cache") : join(homedir(), ".pnpm-cache")
));


async function assertCorepackCacheCopy(sourceRoot, targetRoot) {
  const [sourceEntries, targetEntries] = await Promise.all([
    readdir(sourceRoot, { withFileTypes: true }),
    readdir(targetRoot, { withFileTypes: true }),
  ]);
  sourceEntries.sort((left, right) => left.name.localeCompare(right.name));
  targetEntries.sort((left, right) => left.name.localeCompare(right.name));
  assert.deepEqual(targetEntries.map((entry) => entry.name), sourceEntries.map((entry) => entry.name));
  for (const [index, sourceEntry] of sourceEntries.entries()) {
    const source = join(sourceRoot, sourceEntry.name);
    const target = join(targetRoot, sourceEntry.name);
    const targetEntry = targetEntries[index];
    if (sourceEntry.isDirectory()) {
      assert.ok(targetEntry.isDirectory(), target);
      await assertCorepackCacheCopy(source, target);
    } else {
      assert.ok(sourceEntry.isFile() && targetEntry.isFile(), `the cached pnpm runtime must contain regular files: ${source}`);
      const [sourceBytes, targetBytes] = await Promise.all([readFile(source), readFile(target)]);
      assert.deepEqual(targetBytes, sourceBytes, `the private Corepack cache preserves every byte of ${source}`);
    }
  }
}

async function materializePinnedCorepack(fixture) {
  const sourceRoot = join(SOURCE_COREPACK_HOME, "v1", "pnpm", "11.3.0");
  const [recordBytes, packageBytes] = await Promise.all([
    readFile(join(sourceRoot, ".corepack")),
    readFile(join(sourceRoot, "package.json")),
  ]).catch((error) => {
    throw new Error(`the complete release fixture requires genuine cached pnpm@11.3.0 at ${sourceRoot}; Corepack network access is disabled`, { cause: error });
  });
  const record = JSON.parse(recordBytes.toString("utf8"));
  const packageJson = JSON.parse(packageBytes.toString("utf8"));
  assert.deepEqual(record.locator, { name: "pnpm", reference: "11.3.0" });
  assert.equal(record.bin.pnpm, "./bin/pnpm.mjs");
  assert.equal(packageJson.name, "pnpm");
  assert.equal(packageJson.version, "11.3.0");
  assert.equal(packageJson.bin.pnpm, "bin/pnpm.mjs");
  const corepackHome = join(fixture.environment.HOME, "release-corepack");
  const targetRoot = join(corepackHome, "v1", "pnpm", "11.3.0");
  await mkdir(dirname(targetRoot), { recursive: true });
  // Copy this version's metadata and entire runtime closure, never the shared cache.
  await cp(sourceRoot, targetRoot, { recursive: true, errorOnExist: true, force: false });
  await assertCorepackCacheCopy(sourceRoot, targetRoot);
  assert.deepEqual(await readFile(join(targetRoot, ".corepack")), recordBytes);
  assert.deepEqual(await readFile(join(targetRoot, "package.json")), packageBytes);
  return corepackHome;
}

async function materializeLockfileVerificationCache(fixture, lockContent) {
  const sourceLockfile = await realpath(join(REPOSITORY_ROOT, "pnpm-lock.yaml"));
  const sourceCache = join(SOURCE_PNPM_CACHE, "lockfile-verified.jsonl");
  const [sourceContent, sourceStat, cacheContent] = await Promise.all([
    readFile(sourceLockfile, "utf8"),
    stat(sourceLockfile, { bigint: true }),
    readFile(sourceCache, "utf8"),
  ]);
  assert.equal(sourceContent, lockContent, "the fixture retains the genuinely verified source lockfile bytes");
  let sourceRecord;
  for (const line of cacheContent.split("\n")) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    const lockfile = record?.lockfile;
    // Match only this source installation's current native path/stat entry.
    // The raw-byte comparison above establishes the same semantic lockfile;
    // pinned pnpm still decides whether its recorded policy permits reuse.
    if (lockfile?.path === sourceLockfile && typeof lockfile.hash === "string"
      && lockfile.size === Number(sourceStat.size) && lockfile.mtimeNs === sourceStat.mtimeNs.toString()
      && lockfile.inode === sourceStat.ino.toString()) sourceRecord = { line, record };
  }
  assert.ok(sourceRecord, `the complete release fixture requires a genuine current lockfile verification record in ${sourceCache}`);
  const cacheDir = join(fixture.environment.HOME, "release-pnpm-cache");
  const cachePath = join(cacheDir, "lockfile-verified.jsonl");
  await mkdir(cacheDir, { recursive: true });
  // Preserve one authentic record verbatim, including its timestamp and original
  // path/stat. Native pnpm hashes the fixture and appends its own path/stat entry.
  const recordBytes = Buffer.from(`${sourceRecord.line}\n`);
  await writeFile(cachePath, recordBytes, { flag: "wx" });
  assert.deepEqual(await readFile(cachePath), recordBytes);
  return { cacheDir, cachePath, recordBytes, record: sourceRecord.record };
}

async function materializeReleaseDependencies(fixture) {
  const [packageJson, dependencyPolicy, lockContent, modules] = await Promise.all([
    readFile(join(fixture.engineRoot, "package.json"), "utf8").then(JSON.parse),
    readFile(join(fixture.engineRoot, "scripts/policy/dependency-policy.json"), "utf8").then(JSON.parse),
    readFile(join(fixture.engineRoot, "pnpm-lock.yaml"), "utf8"),
    readFile(join(REPOSITORY_ROOT, "node_modules/.modules.yaml"), "utf8").then(JSON.parse),
  ]);
  assert.equal(modules.packageManager, packageJson.packageManager);
  assert.equal(modules.packageManager, "pnpm@11.3.0");
  const corepackHome = await materializePinnedCorepack(fixture);
  const verificationCache = await materializeLockfileVerificationCache(fixture, lockContent);
  assert.ok(typeof modules.storeDir === "string" && isAbsolute(modules.storeDir));
  const sourceStore = await realpath(modules.storeDir);
  assert.equal(basename(sourceStore), "v11");
  const graph = validateFrozenDependencyGraph({ packageJson, dependencyPolicy, lockContent });
  assert.ok(typeof modules.virtualStoreDir === "string" && modules.virtualStoreDir.length > 0);
  const virtualStore = resolve(REPOSITORY_ROOT, "node_modules", modules.virtualStoreDir);
  const packages = await Promise.all(graph.records.map(async ({ identity, integrity, name }) => ({
    key: `${integrity}\t${identity}`,
    root: await realpath(join(virtualStore, identity.replaceAll("/", "+"), "node_modules", name)),
  })));
  const materializationRoot = join(fixture.projectRoot, "release-dependency-input");
  const inputStore = join(materializationRoot, "store", "v11");
  const privateStore = join(fixture.environment.HOME, "release-pnpm-store");
  await mkdir(inputStore, { recursive: true });
  try {
    // pnpm 11 stores opaque package-index records in SQLite. Retain only the
    // frozen graph's exact integrity/identity keys and their verified CAS files;
    // the source installation and its unrelated store entries remain read-only.
    // Read a static committed index snapshot without opening a shared WAL or
    // taking a writable SQLite connection. Missing cache inputs still fail the
    // real offline install below; no shared installation is used by the build.
    const copied = JSON.parse(execFileSync("python3", ["-I", "-c", String.raw`
import hashlib, json, pathlib, sqlite3, stat, sys
source_store, target_store = map(pathlib.Path, sys.argv[1:3])
packages = json.loads(sys.argv[3])
source = sqlite3.connect((source_store / "index.db").as_uri() + "?mode=ro&immutable=1", uri=True)
target = sqlite3.connect(target_store / "index.db")
copied = set()
try:
    target.execute("CREATE TABLE package_index (key TEXT PRIMARY KEY, data BLOB NOT NULL) WITHOUT ROWID")
    for package in packages:
        key = package["key"]
        row = source.execute("SELECT data FROM package_index WHERE key = ?", (key,)).fetchone()
        assert row is not None, "installed dependency store is missing " + key
        data = row[0]
        # Hash this exact installed package's regular files to locate its CAS
        # inputs. Preserve the opaque index row; pnpm remains its actual decoder.
        package_files = 0
        for installed in sorted(pathlib.Path(package["root"]).rglob("*")):
            assert not installed.is_symlink(), "unexpected installed package symlink: " + str(installed)
            if installed.is_dir():
                continue
            assert installed.is_file(), "unexpected installed package entry: " + str(installed)
            package_files += 1
            content = installed.read_bytes()
            digest = hashlib.sha512(content).hexdigest()
            suffix = "-exec" if stat.S_IMODE(installed.stat().st_mode) & 0o111 else ""
            path = pathlib.Path("files") / digest[:2] / (digest[2:] + suffix)
            if str(path) in copied:
                continue
            input_path = source_store / path
            assert input_path.is_file(), "installed dependency store is missing CAS file " + str(path)
            assert input_path.read_bytes() == content, str(path)
            output = target_store / path
            output.parent.mkdir(parents=True, exist_ok=True)
            with output.open("xb") as stream:
                stream.write(content)
            output.chmod(stat.S_IMODE(input_path.stat().st_mode))
            copied.add(str(path))
        assert package_files > 0, "installed dependency package is empty: " + key
        target.execute("INSERT INTO package_index (key, data) VALUES (?, ?)", (key, data))
    target.commit()
finally:
    target.close()
    source.close()
print(json.dumps({"packages": len(packages), "files": len(copied)}))
    `, sourceStore, inputStore, JSON.stringify(packages)], {
      env: fixture.environment, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    }));
    assert.equal(copied.packages, graph.records.length);
    assert.ok(copied.files > 0);
    await createDependencyMaterialization(fixture.engineRoot, materializationRoot);
    await populateDependencyStore(fixture.engineRoot, materializationRoot, privateStore);
  } finally {
    // The verified private store now owns the input; discard its temporary duplicate.
    await rm(materializationRoot, { recursive: true, force: true });
  }
  fixture.environment = {
    ...fixture.environment,
    COREPACK_HOME: corepackHome,
    COREPACK_ENABLE_NETWORK: "0", COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    // Reuse the genuine record under its recorded verifier policy. A private
    // HOME has no user-level pnpm settings to activate that verifier for us.
    pnpm_config_minimum_release_age: String(verificationCache.record.policy.minimumReleaseAge),
    pnpm_config_store_dir: privateStore,
    pnpm_config_cache_dir: verificationCache.cacheDir,
    pnpm_config_offline: "true", pnpm_config_frozen_lockfile: "true", pnpm_config_ignore_scripts: "true",
    pnpm_config_package_import_method: "copy",
  };
  execFileSync("corepack", ["pnpm@11.3.0", "--dir", fixture.engineRoot, "install", "--offline", "--frozen-lockfile", "--ignore-scripts", "--store-dir", privateStore, "--package-import-method=copy"], {
    env: fixture.environment, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  const installed = JSON.parse(await readFile(join(fixture.engineRoot, "node_modules/.modules.yaml"), "utf8"));
  assert.equal(installed.packageManager, packageJson.packageManager);
  assert.equal(await realpath(installed.storeDir), await realpath(join(privateStore, "v11")));
  assert.notEqual(installed.storeDir, sourceStore);
  assert.equal(await readFile(join(fixture.engineRoot, "pnpm-lock.yaml"), "utf8"), lockContent);
  const cacheBytes = await readFile(verificationCache.cachePath);
  assert.deepEqual(cacheBytes.subarray(0, verificationCache.recordBytes.length), verificationCache.recordBytes);
  const fixtureLockfile = join(fixture.engineRoot, "pnpm-lock.yaml");
  const nativeRecord = cacheBytes.toString("utf8").split("\n").filter(Boolean).map(JSON.parse)
    .findLast((record) => record.lockfile?.path === fixtureLockfile);
  assert.ok(nativeRecord, "native pnpm must recognize the semantic hash and append the fixture's own path/stat");
  const fixtureStat = await stat(fixtureLockfile, { bigint: true });
  assert.deepEqual(nativeRecord.lockfile, {
    hash: verificationCache.record.lockfile.hash, path: fixtureLockfile,
    size: Number(fixtureStat.size), mtimeNs: fixtureStat.mtimeNs.toString(), inode: fixtureStat.ino.toString(),
  });
  assert.deepEqual(nativeRecord.policy, verificationCache.record.policy);
  assert.equal(nativeRecord.verifiedAt, verificationCache.record.verifiedAt, "reuse retains the authentic verification timestamp");
}

test("607-R2: complete generated release readiness, native multi-Story gates, pack and same-run done consumption", async () => {
  const fixture = await createReleaseFixture("complete-native-release");
  // One complete integration input. The receipt/commit refusal cases above remain
  // small fixtures; only this case consumes the real source and renderers end to end.
  const tracked = git(REPOSITORY_ROOT, ["ls-files", "-z"]).split("\0").filter(Boolean);
  for (const path of tracked) {
    const target = join(fixture.engineRoot, path);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(REPOSITORY_ROOT, path), target);
  }
  cpSync(join(REPOSITORY_ROOT, "dist/build"), join(fixture.engineRoot, "dist/build"), { recursive: true });
  git(fixture.engineRoot, ["rm", "-q", "--", "packages/protocol/schema-fixture.json"]);
  await writeText(fixture.engineRoot, "CHANGELOG.md", `# Changelog\n\n## Unreleased\n\n${RELEASE_NOTES}\n\n## ${OLD_VERSION}\n\nEarlier release.\n`);
  await commitAll(fixture.engineRoot, "complete release source input");
  fixture.projectId = await scopedReleaseProject(fixture, "complete-native-release-project");
  const cli = (args) => JSON.parse(execFileSync(process.execPath, [join(fixture.engineRoot, "scripts/einzbern.mjs"), ...args], { env: fixture.environment, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  const common = ["--workspace", fixture.workspace, "--project-id", fixture.projectId, "--at", "2026-10-08T00:00:05Z"];
  const initiative = cli(["work-create", ...common, "--external-key", "RELEASE-INIT", "--kind", "Initiative", "--title", "Release integration"]).record.id;
  const epic = cli(["work-create", ...common, "--external-key", "RELEASE-EPIC", "--kind", "Epic", "--status", "active", "--parent-id", initiative, "--title", "Release integration"]).record.id;
  const workIds = ["RELEASE-STORY-1", "RELEASE-STORY-2"].map((key) => cli(["work-create", ...common, "--external-key", key, "--kind", "Story", "--status", "active", "--parent-id", epic, "--title", key, "--goal", "Release package exists", "--acceptance", "GIVEN complete inputs WHEN gates pass THEN package exists"]).record.id).sort();
  await writeText(fixture.engineRoot, "docs/releases/integration-input.md", "# Story source input\n");
  await commitAll(fixture.engineRoot, "RELEASE-STORY-1 RELEASE-STORY-2: integration source");
  await materializeReleaseDependencies(fixture);
  const calls = [];
  const runner = async (command, args, options) => {
    if (command === "corepack" && args[0] === "pnpm@11.3.0" && args.at(-1) === "build") {
      // Generation has just changed the workspace package versions. Refresh
      // pnpm's native workspace state explicitly through private pipes before
      // its real run command; its implicit install would inherit controller IO.
      const install = ["pnpm@11.3.0", "--dir", fixture.engineRoot, "install", "--offline", "--frozen-lockfile", "--ignore-scripts"];
      calls.push({ command, args: install, phase: "native-offline-readiness" });
      execFileSync(command, install, { ...options, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    }
    calls.push({ command, args });
    return { status: 0, stdout: execFileSync(command, args, { ...options, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), stderr: "" };
  };
  const options = { ...fixture, workIds, version: NEXT_VERSION, env: fixture.environment, runner };
  const generated = await generateRelease({ ...options, at: "2026-10-08T01:00:00Z" });
  assert.equal(generated.reasonCode, "RELEASE_GENERATED");
  const receipt = JSON.parse(await readFile(fixture.receiptPath, "utf8"));
  assert.deepEqual(receipt.gates.workIds, workIds);
  assert.deepEqual(receipt.generated.build, { reasonCode: "BUILD_VERIFIED", builtVersion: NEXT_VERSION });
  assert.ok(receipt.generated.helperDocs.skillInstallTreeDigest);
  commitRelease(fixture, receipt);
  const wrongSet = await validateReleaseCommits({ ...options, workIds: [workIds[0]] });
  assert.ok(wrongSet.violations.some((entry) => entry.code === "RELEASE_RECEIPT_MISMATCH" && entry.field === "gates.workIds"));
  const originalReceipt = await readFile(fixture.receiptPath);
  const legacyReceipt = structuredClone(receipt);
  delete legacyReceipt.gates.workIds;
  await writeFile(fixture.receiptPath, JSON.stringify(legacyReceipt));
  const lateBinding = await validateReleaseCommits(options);
  assert.ok(lateBinding.violations.some((entry) => entry.field === "gates.workIds"), "old receipts cannot acquire a new Story binding");
  await writeFile(fixture.receiptPath, originalReceipt);
  await writeText(fixture.engineRoot, `dist/release/einzbern-${OLD_VERSION}.tar.gz`, "previous formal package\n");
  await writeText(fixture.engineRoot, `dist/release/einzbern-${OLD_VERSION}.tar.gz.sha256`, "previous digest\n");
  const finished = await finishRelease({ ...options, at: "2026-10-08T02:00:00Z" });
  assert.deepEqual(finished.staleReleaseArtifacts.map((move) => move.to), [`dist/stale-release/${OLD_VERSION}/einzbern-${OLD_VERSION}.tar.gz`, `dist/stale-release/${OLD_VERSION}/einzbern-${OLD_VERSION}.tar.gz.sha256`]);
  assert.deepEqual((await readdir(join(fixture.engineRoot, "dist/release"))).sort(), [`einzbern-${NEXT_VERSION}.tar.gz`, `einzbern-${NEXT_VERSION}.tar.gz.sha256`]);
  assert.equal(finished.gates.ok, true);
  assert.deepEqual(finished.gates.selected, ["engine:fixture", "helper:fixture"]);
  assert.equal(finished.check, "RELEASE_VERSION_CHECKED");
  assert.equal(await readFile(finished.assets.checksum, "utf8"), `${finished.assets.sha256}  einzbern-${NEXT_VERSION}.tar.gz\n`);
  assert.ok(calls.some((call) => call.args[0]?.endsWith("pack-release.mjs")));

  assert.equal(finished.readiness.reasonCode, "RELEASE_READINESS_READY");
  assert.ok(finished.readiness.checks.every((check) => check.status === "verified"));
  assert.equal(finished.reasonCode, "RELEASE_FINISHED");
  assert.ok((await readFile(finished.assets.archive)).length > 0);
  const saved = JSON.parse(await readFile(finished.gates.recordPath, "utf8"));
  assert.deepEqual(saved.workIds, workIds);
  assert.equal(saved.gates.length, 2);
  assert.ok(saved.gates.every((gate) => gate.ok && gate.matchedWorkIds.length === 2));
  const bound = await checkReleaseGatePlan({ ...options });
  assert.equal(saved.treeDigest, (await gateTreeState(fixture.projectRoot, bound.plan.roots)).treeDigest);
  const countBefore = (await readdir(dirname(finished.gates.recordPath))).filter((name) => name.endsWith(".json")).length;
  for (const id of workIds) {
    const done = cli(["work-transition", "--workspace", fixture.workspace, "--at", "2026-10-08T03:00:00Z", "--id", id, "--status", "done", "--project", fixture.projectRoot]);
    assert.equal(done.doneGates.runId, saved.runId);
  }
  assert.equal((await readdir(dirname(finished.gates.recordPath))).filter((name) => name.endsWith(".json")).length, countBefore, "done consumes the same saved run without another gate execution");
  const builds = calls.filter((call) => call.command === "corepack" && call.phase !== "native-offline-readiness");
  assert.equal(builds.length, 1, "one real pinned build");
  assert.deepEqual(builds[0].args, pinnedBuildArguments(fixture.engineRoot));
  const installs = calls.filter((call) => call.phase === "native-offline-readiness");
  assert.equal(installs.length, 1, "one explicit native offline preparation after version generation");
  assert.deepEqual(installs[0].args, ["pnpm@11.3.0", "--dir", fixture.engineRoot, "install", "--offline", "--frozen-lockfile", "--ignore-scripts"]);
  assert.equal(calls.filter((call) => call.args[0]?.endsWith("pack-release.mjs")).length, 1);
  const buildIndex = calls.indexOf(builds[0]);
  const renderIndex = calls.findIndex((call) => call.args[0]?.endsWith("render-helper-docs.mjs"));
  const packIndex = calls.findIndex((call) => call.args[0]?.endsWith("pack-release.mjs"));
  assert.ok(calls.indexOf(installs[0]) < buildIndex && buildIndex >= 0 && renderIndex > buildIndex && packIndex > renderIndex);
});
