// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { readBoundRegularFile, safeWriteOutput, withExclusiveOutputSession } from "../scripts/lib/safe-io.mjs";
import { isInside, walkFiles } from "../scripts/lib/files.mjs";
import { configureStorageLocation } from "../dist/build/packages/core/src/storage-configure.js";
import { readSnapshotManifestFile } from "../dist/build/packages/core/src/workspace-snapshot.js";
import { memoryPackageTask } from "../dist/build/scripts/lib/memory-budget.mjs";
import { hasPrivateWindowsPermissions } from "../scripts/lib/windows-system.mjs";
import { storePath, loadPath } from "../dist/build/packages/core/src/stored-path.js";
import { validateSettingValue } from "../dist/build/packages/core/src/settings.js";
import { FileStoreBackend } from "../dist/build/packages/core/src/store-backend.js";

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "einzbern windows 中文 ")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("portable record names preserve logical IDs, bytes and existing POSIX records", async t => {
  const root = await fixture(t);
  await mkdir(join(root, "records"));
  const profile = {
    reasonCodes: { pathInvalid: "PATH_INVALID", linkUnsafe: "LINK_UNSAFE", specialFile: "SPECIAL_FILE", limitExceeded: "LIMIT_EXCEEDED", sourceChanged: "SOURCE_CHANGED", alreadyExists: "ALREADY_EXISTS" },
    limits: { markerBytes: 1024, metadataBytes: 1024, bodyBytes: 1024, viewBytes: 1024, recordBytes: 1024 },
  };
  const backend = new FileStoreBackend(root, profile);
  const id = `artifact:${"a".repeat(24)}`;
  const portable = `${id.replace(":", "%3A")}.json`;
  await writeFile(join(root, "records", portable), "original");
  assert.deepEqual(await backend.listArtifactRecords(), [`${id}.json`]);
  assert.equal((await backend.readArtifactRecord(id)).toString(), "original");
  await backend.writeArtifactRecord(id, "updated");
  assert.equal(await readFile(join(root, "records", portable), "utf8"), "updated");
  const next = `artifact:${"b".repeat(24)}`;
  await backend.writeArtifactRecord(next, "new");
  const nextName = process.platform === "win32" ? next.replace(":", "%3A") : next;
  assert.equal(await readFile(join(root, "records", `${nextName}.json`), "utf8"), "new");
  if (process.platform === "win32") await assert.rejects(backend.writeArtifactRecord("other:stream", "invalid"), { reasonCode: "PATH_INVALID" });
  if (process.platform !== "win32") {
    await writeFile(join(root, "records", `${id}.json`), "ambiguous");
    await assert.rejects(backend.listArtifactRecords(), { reasonCode: "PATH_INVALID" });
    await assert.rejects(backend.readArtifactRecord(id), { reasonCode: "STORE_RECORD_AMBIGUOUS" });
  }
});

test("Windows stored paths round-trip across volumes and UNC shares", { skip: process.platform !== "win32" }, () => {
  for (const [base, target, stored] of [
    ["C:\\device", "D:\\runtime\\cache", "D:/runtime/cache"],
    ["C:\\device", "C:\\runtime\\cache", "../runtime/cache"],
    ["C:\\device", "\\\\server\\share\\runtime", "//server/share/runtime"],
  ]) {
    assert.equal(storePath(base, target), stored);
    assert.equal(loadPath(base, stored), target);
  }
});

test("Windows path boundaries reject other volumes and accept normalized article bindings", { skip: process.platform !== "win32" }, () => {
  assert.equal(isInside("C:\\device", "D:\\runtime"), false);
  assert.equal(isInside("C:\\device", "\\\\server\\share\\runtime"), false);
  assert.equal(isInside("C:\\device", "C:\\device\\cache"), true);
  assert.equal(validateSettingValue("knowledge.articlesPath", "D:\\knowledge"), "D:\\knowledge");
});

test("the built resource adapter resolves its source executor on the native platform", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  assert.deepEqual(memoryPackageTask(["pnpm", "build"], root), { entry: "scripts/task.mjs", args: ["build"] });
});

test("Windows suite controller reports success, failures and a joined timeout", { skip: process.platform !== "win32" }, async t => {
  const root = await fixture(t);
  const { runWindowsTestController } = await import("../scripts/lib/windows-test-controller.mjs");
  const file = join(root, "example.test.mjs");
  const options = { cwd: root, env: { ...process.env }, timeoutMs: 30_000 };
  await writeFile(file, "import test from 'node:test'; test('pass',()=>{});\n");
  const success = await runWindowsTestController(["--test", file], options);
  assert.equal(success.progress.lastProgress.writerQuiescent, true);
  await writeFile(file, "import test from 'node:test'; test('fail',()=>{throw new Error('fixture failure')});\n");
  await assert.rejects(runWindowsTestController(["--test", file], options), { reasonCode: "COMMAND_FAILED" });
  await writeFile(file, "setInterval(()=>{},1000);\n");
  await assert.rejects(runWindowsTestController(["--test", file], { ...options, timeoutMs: 3000 }), error => {
    assert.equal(error.reasonCode, "TEST_CONTROLLER_TIMEOUT");
    assert.equal(error.details.progress.lastProgress.writerQuiescent, true);
    return true;
  });
});

test("descriptor-bound reads reject hardlinks and path replacement on native filesystems", async t => {
  const root = await fixture(t);
  const source = join(root, "source.json");
  await writeFile(source, '{"value":1}\n');
  assert.equal((await readBoundRegularFile(source)).content.toString(), '{"value":1}\n');
  assert.equal(await readSnapshotManifestFile(source), '{"value":1}\n');
  const alias = join(root, "alias.json");
  await link(source, alias);
  await assert.rejects(readBoundRegularFile(source), { reasonCode: "INPUT_INVALID" });
  await assert.rejects(readSnapshotManifestFile(source), { reasonCode: "SNAPSHOT_PATH_INVALID" });
  await rm(alias);
  await assert.rejects(readBoundRegularFile(source, {
    afterOpen: async () => {
      await rename(source, join(root, "original.json"));
      await writeFile(source, '{"value":2}\n');
    },
  }), { reasonCode: "INPUT_PATH_CHANGED" });
});

test("Windows output sessions serialize writers and release after an operation fails", { skip: process.platform !== "win32" }, async t => {
  const root = await fixture(t);
  await mkdir(join(root, ".git"));
  const module = new URL("../scripts/lib/safe-io.mjs", import.meta.url).href;
  await withExclusiveOutputSession(root, async () => {
    assert.equal(hasPrivateWindowsPermissions(join(root, ".git", "einzbern-output.lock")), true);
    await withExclusiveOutputSession(root, () => safeWriteOutput(root, "dist/result.json", "first\n"));
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
import { withExclusiveOutputSession } from ${JSON.stringify(module)};
try { await withExclusiveOutputSession(${JSON.stringify(root)}, () => {}); process.exitCode = 1; }
catch (error) { process.stdout.write(error.reasonCode); }
`], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, "OUTPUT_SESSION_RECOVERY_REQUIRED");
  });
  await assert.rejects(withExclusiveOutputSession(root, async () => { throw new Error("fixture failure"); }), /fixture failure/u);
  await withExclusiveOutputSession(root, () => safeWriteOutput(root, "dist/result.json", "second\n"));
  assert.equal(await readFile(join(root, "dist/result.json"), "utf8"), "second\n");
});

test("Windows output sessions retain an interrupted owner's claim", { skip: process.platform !== "win32" }, async t => {
  const root = await fixture(t);
  await mkdir(join(root, ".git"));
  const module = new URL("../scripts/lib/safe-io.mjs", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
import { withExclusiveOutputSession } from ${JSON.stringify(module)};
await withExclusiveOutputSession(${JSON.stringify(root)}, () => process.exit(0));
`], {
    encoding: "utf8", windowsHide: true, timeout: 20_000,
    env: { ...process.env, HOME: root, USERPROFILE: root },
  });
  assert.equal(child.status, 0, child.stderr);
  const ownerPath = join(root, ".git", "einzbern-output.lock", "owner.json");
  const before = await readFile(ownerPath);
  await assert.rejects(withExclusiveOutputSession(root, () => {}), { reasonCode: "OUTPUT_SESSION_RECOVERY_REQUIRED" });
  assert.deepEqual(await readFile(ownerPath), before);
});

test("Windows junctions are rejected by source walks and output mutation", { skip: process.platform !== "win32" }, async t => {
  const root = await fixture(t);
  const source = join(root, "project");
  const target = join(root, "target");
  await mkdir(source);
  await mkdir(join(source, ".git"));
  await mkdir(target);
  await writeFile(join(target, "keep.txt"), "keep\n");
  await symlink(target, join(source, "linked"), "junction");
  await assert.rejects(walkFiles(source), { reasonCode: "SOURCE_SPECIAL_FILE" });
  await symlink(target, join(source, "dist"), "junction");
  await withExclusiveOutputSession(source, async () => {
    await assert.rejects(safeWriteOutput(source, "dist/keep.txt", "changed\n"), { reasonCode: "OUTPUT_DIRECTORY_SYMLINK" });
  });
  assert.equal(await readFile(join(target, "keep.txt"), "utf8"), "keep\n");
});

test("Windows runtime relocation uses junctions and rejects a nested destination before mutation", { skip: process.platform !== "win32" }, async t => {
  const root = await fixture(t);
  const home = join(root, "device");
  const library = join(root, "library");
  const runtime = join(root, "runtime");
  await mkdir(home);
  await mkdir(library);
  for (const area of ["cache", "locks", "backups"]) await mkdir(join(home, area));
  await writeFile(join(home, "cache", "payload.txt"), "payload\n");
  const at = "2026-11-16T00:00:00Z";
  const decision = "minutes:000000000000000000000001#D1";
  await assert.rejects(configureStorageLocation(home, library, join(home, "nested"), at, decision, true), /STORAGE_LOCATION_INVALID/u);
  const result = await configureStorageLocation(home, library, runtime, at, decision, true);
  assert.equal(result.reasonCode, "STORAGE_LOCATION_CONFIGURED");
  for (const area of ["cache", "locks", "backups"]) assert.equal(await realpath(join(home, area)), join(runtime, area));
  assert.equal(await readFile(join(home, "cache", "payload.txt"), "utf8"), "payload\n");
  assert.equal((await configureStorageLocation(home, library, runtime, at, decision, true)).reasonCode, "STORAGE_LOCATION_CONFIGURED");
});
