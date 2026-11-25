// EINZBERN-STORY-007: managed output roots belong to one device and one library each.
import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { initializeLibrary, readRegistry, registerLibrary, setAgentsProjectRoots, unregisterLibraryEntry } from "../dist/build/packages/core/src/index.js";
import { renderAgentsSections } from "../dist/build/packages/core/src/agents-sections.js";

let second = 0;
const at = () => new Date(Date.UTC(2026, 10, 25, 5, 0, ++second)).toISOString().replace(".000Z", "Z");

test("each library writes only to its selected root; unregister tombstones that selection", async (context) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-project-roots-")));
  const deviceHome = join(base, "device");
  const roots = Object.fromEntries(["a1", "a2", "b1", "b2"].map(name => [name, join(base, name)]));
  const libraries = { a: join(base, "libraries", "a"), b: join(base, "libraries", "b") };
  await Promise.all([...Object.values(roots), ...Object.values(libraries).map(path => join(path, ".."))].map(path => mkdir(path, { recursive: true })));
  const priorDeviceHome = process.env.EINZBERN_HOME;
  process.env.EINZBERN_HOME = deviceHome;
  context.after(async () => {
    if (priorDeviceHome === undefined) delete process.env.EINZBERN_HOME;
    else process.env.EINZBERN_HOME = priorDeviceHome;
    await rm(base, { recursive: true, force: true });
  });

  await initializeLibrary({ root: libraries.a, createdAt: at() });
  await initializeLibrary({ root: libraries.b, createdAt: at() });
  for (const root of [roots.a1, roots.a2]) await registerLibrary({ projectPath: root, libraryPath: libraries.a, registeredAt: at(), cloudHosted: false, gitRemote: null }, deviceHome);
  for (const root of [roots.b1, roots.b2]) await registerLibrary({ projectPath: root, libraryPath: libraries.b, registeredAt: at(), cloudHosted: false, gitRemote: null }, deviceHome);
  const registry = await readRegistry(deviceHome);
  const libraryA = registry.entries.find(entry => entry.projectPath === roots.a1).libraryId;
  const libraryB = registry.entries.find(entry => entry.projectPath === roots.b1).libraryId;
  await setAgentsProjectRoots([{ libraryId: libraryA, projectPath: roots.a1 }, { libraryId: libraryB, projectPath: roots.b1 }], deviceHome);

  for (const [libraryPath, selectedRoot] of [[libraries.a, roots.a1], [libraries.b, roots.b1]]) {
    const result = await renderAgentsSections(libraryPath, { projectRoot: selectedRoot, navigation: null, occurredAt: at() });
    assert.equal(result.projectRoot, selectedRoot);
  }
  for (const [libraryPath, otherRoot] of [[libraries.a, roots.a2], [libraries.b, roots.b2]]) {
    await assert.rejects(renderAgentsSections(libraryPath, { projectRoot: otherRoot, navigation: null, occurredAt: at() }), error => error.reasonCode === "MANAGED_SECTION_OUTPUT_UNREGISTERED");
    await assert.rejects(readFile(join(otherRoot, "AGENTS.md")), { code: "ENOENT" });
  }
  await assert.rejects(setAgentsProjectRoots([{ libraryId: libraryA, projectPath: roots.b1 }], deviceHome), error => error.reasonCode === "LIBRARY_REGISTRY_MISMATCH");

  await unregisterLibraryEntry(roots.a1, at(), deviceHome);
  const afterUnregister = await readRegistry(deviceHome);
  assert.equal(afterUnregister.agentsProjectRoots?.[libraryA], null, "the removed selected root leaves an explicit invalidation tombstone");
  assert.equal(afterUnregister.agentsProjectRoots?.[libraryB], roots.b1, "another library's root stays selected");
  await assert.rejects(renderAgentsSections(libraries.a, { projectRoot: roots.a2, navigation: null, occurredAt: at() }), error => error.reasonCode === "MANAGED_SECTION_OUTPUT_UNREGISTERED");

  await setAgentsProjectRoots([{ libraryId: libraryA, projectPath: roots.a2 }], deviceHome);
  assert.equal((await renderAgentsSections(libraries.a, { projectRoot: roots.a2, navigation: null, occurredAt: at() })).projectRoot, roots.a2);
  await assert.rejects(renderAgentsSections(libraries.a, { projectRoot: roots.b1, navigation: null, occurredAt: at() }), error => error.reasonCode === "MANAGED_SECTION_OUTPUT_UNREGISTERED");
});
