// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

import {
  admitTemplateInWorkspace,
  defaultWorkContentTemplate,
  validatePackPlan,
  workContentDraft,
  workContentMissing,
} from "../dist/build/packages/core/src/index.js";
import { deriveStableId } from "../dist/build/packages/protocol/src/index.js";
import { cli, instant, workspaceFixture } from "./helpers/workspace-fixture.mjs";

const contentDetailFields = {
  Story: { behavior: "Fixture behavior", discretion: "No additional discretion" },
  Subtask: { assignedRequirements: "R01@1", deliverables: "Fixture deliverable", dependencies: "Recorded source inputs", verificationOwner: "Independent fixture verifier" },
  Pack: { batchContract: "Ordered, source-pinned execution plan; dispatch remains external." },
};

const sourceResults = {
  748: "指定隔离候选的实现和局部验证已交付。隔离候选标准构建通过，纪要 CLI 聚焦用例 7 项通过。有效和截断数组均无写入且返回 --decisions-file 指引。带方括号标签的显式列表依序读回两条，单条文件逐字读回 D1，含引号和中英文逗号的文件逐条读回。",
  749: "独立公开 CLI 通过 11 项实测并复用 15 项输入等价原始回执。含 [1][2 3] 在内的七项无正文数组在写前报 CLI_ARGUMENT_MALFORMED 并提示 --decisions-file，设备流头、序号和源字节不变，目标查无。合法显式逗号列表和带正文的标签列表按原文及顺序读回，JSON 文件保持原文、顺序和数量，单条文件只产生 D1 “已核验 1,392 个文件”。",
  750: "交付的公开 doctor 四例中，健康原生观测返回 DOCTOR_READY 且 nextStep 为空。缺失、过期和配置哈希不匹配均返回 DOCTOR_HOOKS_MISMATCH，分别给出与真实原因相符的可执行下一步，顶层和 hooks-present 分项一致。标准构建通过，29 项 doctor 测试、6 项依赖策略及 2 项受影响 CI 审计回归均通过。",
  751: "公开 doctor 在实时原生观测下返回 DOCTOR_READY。缺失、超过五分钟、配置摘要不匹配三例的 ok=false、DOCTOR_HOOKS_MISMATCH、分项原因及可执行下一步逐项相符。信任文件哈希一致，写探针在隔离流内验证。",
  752: "STORY-668 的正确 ID 和外部键查询返回同一 work ID。以 --id 误传外部键明确提示 --external-key，真正不存在的外部键返回 unavailable（退出 1）。冻结候选与集成源码补丁相同。",
  753: "公开 work-show 用实际 ID 和完整外部键均读回同一 STORY-668 r11，库头一致。外部键误传 --id 退出 1 并提示 --external-key。目标经 work-list 确认不存在的键退出 1 且给出明确的不可用原因，全部只读。",
};

function fixtureContent(kind, workId, { complete = false, acceptanceVersion = 1, parentWorkId, result } = {}) {
  const requirement = { workId, requirementId: "R01", version: 1 };
  const acceptances = [
    { id: "AC01", version: acceptanceVersion, requirement, scenario: "Read the pinned source", expected: "The same source row and result references are returned", method: "Normal create, show and list APIs" },
    ...(parentWorkId === undefined ? [] : [{ id: "AC-STORY-CONTRIBUTION", version: 1, requirement: { workId: parentWorkId, requirementId: "R01", version: 1 }, scenario: "Carry the assigned Story requirement", expected: "The assigned Story criterion remains owned by that Story", method: "Resolve the inherited requirement through the original parent link" }]),
  ];
  const content = {
    schemaVersion: "tcrn.work-content.v1",
    kind,
    variant: "standard",
    goal: `Preserve ${kind} fixture meaning`,
    sources: [{ id: "fixture-request", kind: "user-request", locator: `fixture:${workId}`, version: "1", extraction: "complete", text: "Synthetic isolated PACK test fixture" }],
    scope: `Isolated fixture for ${workId}`,
    constraints: [],
    requirements: [{ id: "R01", version: 1, text: `Verify ${kind} fixture behavior`, sourceIds: ["fixture-request"], shared: false, disposition: "required" }],
    allocations: [],
    acceptance: acceptances,
    evidence: complete ? acceptances.map(acceptance => ({ acceptanceId: acceptance.id, acceptanceVersion: acceptance.version, requirement: acceptance.requirement, codeVersion: "fixture", locator: `fixture:evidence:${workId}:${acceptance.id}`, actual: "Fixture assertion passed", outcome: "satisfied", kind: "machine" })) : [],
    body: "Synthetic data only; no production records are changed.",
    details: contentDetailFields[kind],
    ...(complete ? { completion: { result: result ?? `Fixture result for ${workId}`, codeVersion: "fixture" } } : {}),
  };
  return content;
}

function workRef(record) {
  return { id: record.id, externalKey: record.externalKey, kind: record.kind, revision: record.revision, parentId: record.parentId };
}

function criterion(owner, requirementOwner = owner) {
  const acceptance = owner.content.acceptance[0];
  return {
    acceptanceOwner: workRef(owner),
    acceptanceId: acceptance.id,
    acceptanceVersion: acceptance.version,
    requirementOwner: workRef(requirementOwner),
    requirementId: acceptance.requirement.requirementId,
    requirementVersion: acceptance.requirement.version,
  };
}

const implementationFiles = [
  { repository: "Einzbern", path: "packages/cli/src/index.ts", access: "modify" },
  { repository: "Einzbern", path: "tests/minutes-cli.test.mjs", access: "modify" },
  { repository: "Einzbern", path: "tests/doctor.test.mjs", access: "modify" },
  { repository: "Einzbern", path: "packages/core/src/doctor.ts", access: "conditional", condition: "Read the current contract; modify only if the CLI slice requires it." },
  { repository: "Einzbern", path: "packages/core/src/codex-native-health.ts", access: "conditional", condition: "Read the current contract; modify only if the CLI slice requires it." },
  { repository: "Einzbern", path: "tests/p3-cli-read-surface.test.mjs", access: "modify" },
  { repository: "Code", path: ".tcrn-artifacts/initiatives/2026-11-17-em-post-501/", access: "modify" },
];

const verificationFiles = [
  { repository: "Einzbern", path: "packages/cli/src/index.ts", access: "read" },
  { repository: "Einzbern", path: "tests/minutes-cli.test.mjs", access: "read" },
  { repository: "Einzbern", path: "tests/doctor.test.mjs", access: "read" },
  { repository: "Einzbern", path: "tests/p3-cli-read-surface.test.mjs", access: "read" },
  { repository: "Code", path: ".tcrn-artifacts/initiatives/2026-11-17-em-post-501/", access: "modify" },
];

const linuxEvidenceFiles = [
  { repository: "Einzbern", path: "packages/core/src/device-home.ts", access: "read" },
  { repository: "Einzbern", path: "packages/core/src/storage-location.ts", access: "read" },
  { repository: "Code", path: ".tcrn-artifacts/operations/20261108-ubuntu-gdrive-sync/", access: "read" },
  { repository: "Code", path: "E&M Review Thread_5_0_0.md", access: "read" },
  { repository: "Linux runtime", path: "cache/codex-peer-hooks (six .conflict samples, source files, bisync logs and authoritative directory)", access: "read", resolution: "Resolve from the current Linux runtime configuration at execution time; do not guess missing paths." },
  { repository: "Code", path: ".tcrn-artifacts/initiatives/2026-11-17-em-post-501/", access: "modify" },
];

test("PACK ordinary work APIs preserve ordered source assignments and reverse Story lookup", async context => {
  const fixture = await workspaceFixture(context, { externalKey: "PACK-PLAN-FIXTURE" });
  const workspaceArgs = ["--workspace", fixture.workspace];
  const common = [...workspaceArgs, "--project-id", fixture.projectId];
  const libraryIdentity = await cli(["status", ...workspaceArgs]);
  context.diagnostic(`isolated-fixture=${JSON.stringify({ workspace: fixture.workspace, workspaceId: libraryIdentity.workspaceId, projectId: fixture.projectId, externalKey: "PACK-PLAN-FIXTURE" })}`);
  let tick = 10;
  const at = () => instant(tick++);
  const receipts = new Map();
  for (const kind of ["Story", "Subtask", "Pack"]) {
    const state = await admitTemplateInWorkspace(fixture.workspace, { template: defaultWorkContentTemplate(kind), ownerId: "owner:fixture", occurredAt: at() });
    receipts.set(kind, state.templates.find(entry => entry.template.id === `minimum-${kind.toLowerCase()}`).receipt);
  }

  async function create(kind, externalKey, parentId, { status = "planned", content, blockedBy = [] } = {}) {
    const id = deriveStableId("work", externalKey);
    const args = ["work-create", ...common, "--at", at(), "--external-key", externalKey, "--kind", kind, "--title", externalKey, "--status", status];
    if (parentId !== null) args.push("--parent-id", parentId);
    if (blockedBy.length) args.push("--blocked-by", blockedBy.join(","));
    if (content !== undefined) args.push("--content", JSON.stringify(content), "--template-receipt", JSON.stringify(receipts.get(kind)));
    const result = await cli(args);
    assert.equal(result.record.id, id);
    return { ...result.record, content };
  }

  async function advanceToSourceRevision(record, sourceRevision, sourceLabel) {
    while (record.revision < sourceRevision) {
      const result = await cli([
        "work-annotate", ...workspaceArgs, "--at", at(), "--id", record.id,
        "--summary", `Isolated source snapshot ${sourceLabel} revision ${record.revision + 1}`,
      ]);
      record = { ...record, ...result.record };
    }
    assert.equal(record.revision, sourceRevision, `${sourceLabel} fixture revision matches its readback`);
    return record;
  }

  const initiative = await advanceToSourceRevision(
    await create("Initiative", "TCRN-CROSS-INIT-108", null),
    3,
    "INIT-108",
  );
  const epic216 = await create("Epic", "TCRN-CROSS-EPIC-216", initiative.id);
  const epic223 = await create("Epic", "TCRN-CROSS-EPIC-223", initiative.id);

  const stories = {};
  for (const [number, epic] of [[689, epic216], [690, epic216], [691, epic216], [705, epic223], [706, epic223]]) {
    const key = `TCRN-CROSS-STORY-${number}`;
    const id = deriveStableId("work", key);
    const content = fixtureContent("Story", id, { acceptanceVersion: number === 689 ? 2 : 1 });
    const status = number === 705 ? "active" : "planned";
    stories[number] = await create("Story", key, epic.id, { status, content, blockedBy: number === 706 ? [stories[705]?.id].filter(Boolean) : [] });
  }

  const subtasks = {};
  const subtaskRows = [
    [748, 689], [749, 689], [750, 690], [751, 690], [752, 691], [753, 691], [782, 706],
  ];
  for (const [number, storyNumber] of subtaskRows) {
    const key = `TCRN-CROSS-SUB-${number}`;
    const id = deriveStableId("work", key);
    const content = fixtureContent("Subtask", id);
    subtasks[number] = await create("Subtask", key, stories[storyNumber].id, { status: "planned", content });
  }

  async function annotateContent(record, content) {
    const result = await cli(["work-annotate", ...workspaceArgs, "--at", at(), "--id", record.id, "--content", JSON.stringify(content)]);
    return { ...record, ...result.record, content };
  }
  for (const [storyNumber, implementationNumber, verificationNumber] of [[689, 748, 749], [690, 750, 751], [691, 752, 753]]) {
    const story = stories[storyNumber];
    const allocations = [
      { workId: story.id, requirementId: "R01", version: 1, childId: subtasks[implementationNumber].id, responsibility: "implementation" },
      { workId: story.id, requirementId: "R01", version: 1, childId: subtasks[verificationNumber].id, responsibility: "verification" },
    ];
    stories[storyNumber] = await annotateContent(story, { ...story.content, allocations });
    const sourceRevision = { 689: 16, 690: 9, 691: 8 }[storyNumber];
    stories[storyNumber] = await advanceToSourceRevision(stories[storyNumber], sourceRevision, `STORY-${storyNumber}`);
  }
  stories[705] = await advanceToSourceRevision(stories[705], 5, "STORY-705");
  for (const number of [748, 749, 750, 751, 752, 753]) {
    const subtask = subtasks[number];
    subtasks[number] = await annotateContent(subtask, fixtureContent("Subtask", subtask.id, { complete: true, parentWorkId: subtask.parentId, result: sourceResults[number] }));
    for (const status of ["ready", "active", "done"]) {
      const result = await cli(["work-transition", ...workspaceArgs, "--at", at(), "--id", subtasks[number].id, "--status", status, "--project", fixture.projectId]);
      subtasks[number] = { ...subtasks[number], ...result.record };
    }
    const sourceRevision = { 748: 5, 749: 10, 750: 7, 751: 6, 752: 5, 753: 6 }[number];
    subtasks[number] = await advanceToSourceRevision(subtasks[number], sourceRevision, `SUB-${number}`);
  }

  const rowOneSources = [stories[689], subtasks[748], stories[690], subtasks[750], stories[691], subtasks[752]];
  const rowThreeSources = [stories[689], subtasks[749], stories[690], subtasks[751], stories[691], subtasks[753]];
  const blocker = {
    kind: "blocked-by",
    work: workRef(stories[706]),
    blocker: workRef(stories[705]),
    requiredStatus: "done",
  };
  assert.equal(initiative.revision, 3, "INIT-108 reference uses its live source revision");
  assert.deepEqual(
    Object.fromEntries([689, 690, 691, 705, 706].map(number => [number, stories[number].revision])),
    { 689: 16, 690: 9, 691: 8, 705: 5, 706: 1 },
  );
  assert.deepEqual(
    Object.fromEntries([748, 749, 750, 751, 752, 753, 782].map(number => [number, subtasks[number].revision])),
    { 748: 5, 749: 10, 750: 7, 751: 6, 752: 5, 753: 6, 782: 1 },
  );
  const plan = {
    schemaVersion: "tcrn.pack-plan.v1",
    initiative: workRef(initiative),
    maxConcurrency: 2,
    assignments: [
      {
        id: "row-01-cli-implementation",
        order: 1,
        role: "implementation",
        status: "done",
        parallelGroup: "wave-01-independent",
        sourceWorks: rowOneSources.map(workRef),
        criteria: rowOneSources.map(source => criterion(source)),
        files: implementationFiles,
        prerequisites: [],
        resultSources: [748, 750, 752].map(number => ({ source: workRef(subtasks[number]), locator: "completion.result" })),
        verification: null,
      },
      {
        id: "row-02-linux-read-only-evidence",
        order: 2,
        role: "evidence",
        status: "planned",
        parallelGroup: "wave-01-independent",
        sourceWorks: [stories[706], subtasks[782]].map(workRef),
        criteria: [criterion(stories[706]), criterion(subtasks[782])],
        files: linuxEvidenceFiles,
        prerequisites: [blocker],
        resultSources: [],
        verification: null,
      },
      {
        id: "row-03-independent-verification",
        order: 3,
        role: "verification",
        status: "done",
        parallelGroup: null,
        sourceWorks: rowThreeSources.map(workRef),
        criteria: rowThreeSources.map(source => criterion(source)),
        files: verificationFiles,
        prerequisites: [{ kind: "assignment-result", assignmentId: "row-01-cli-implementation" }],
        resultSources: [749, 751, 753].map(number => ({ source: workRef(subtasks[number]), locator: "completion.result" })),
        verification: {
          trigger: "after-results-recorded",
          afterAssignmentIds: ["row-01-cli-implementation"],
          verifiers: [749, 751, 753].map(number => workRef(subtasks[number])),
        },
      },
    ],
  };

  const packKey = "TCRN-CROSS-PACK-INIT108-WAVE02";
  const packId = deriveStableId("work", packKey);
  const content = {
    ...fixtureContent("Pack", packId),
    packPlan: plan,
  };
  const receipt = receipts.get("Pack");
  const created = await cli(["work-create", ...common, "--at", at(), "--external-key", packKey, "--kind", "Pack", "--title", "INIT-108 candidate execution pack", "--content", JSON.stringify(content), "--template-receipt", JSON.stringify(receipt)]);
  const packIdActual = created.record.id;
  assert.equal(created.record.kind, "Pack");
  assert.equal(created.record.externalKey, packKey);
  assert.equal(created.record.revision, 1);
  assert.equal(created.record.status, "planned");
  assert.equal(created.record.parentId, null);

  const shown = await cli(["work-show", ...workspaceArgs, "--id", packIdActual]);
  assert.deepEqual(shown.content.packPlan, plan);
  assert.equal(shown.record.revision, 1, "PACK version is the ordinary WorkRecord revision");
  assert.equal(shown.record.status, "planned", "PACK state is the ordinary WorkRecord status");
  assert.equal(shown.record.externalKey, packKey, "PACK number is the ordinary external key");
  const byNumber = await cli(["work-show", ...workspaceArgs, "--external-key", packKey]);
  assert.equal(byNumber.record.id, packIdActual);

  const reverse = await cli(["work-list", ...common, "--kind", "Pack", "--search", stories[690].id, "--full", "true"]);
  assert.equal(reverse.total, 1);
  assert.equal(reverse.records[0].id, packIdActual);
  const foundRow = reverse.records[0].content.packPlan.assignments.find(row => row.sourceWorks.some(source => source.id === stories[690].id));
  assert.equal(foundRow.id, "row-01-cli-implementation");
  assert.equal(foundRow.resultSources.find(result => result.source.id === subtasks[750].id).locator, "completion.result");
  const byAssignment = await cli(["work-list", ...common, "--kind", "Pack", "--search", "row-01-cli-implementation", "--full", "true"]);
  assert.equal(byAssignment.records[0].content.packPlan.assignments[0].id, "row-01-cli-implementation");

  const rowOne = shown.content.packPlan.assignments[0];
  assert.deepEqual(rowOne.sourceWorks.map(source => source.kind), ["Story", "Subtask", "Story", "Subtask", "Story", "Subtask"]);
  assert.deepEqual(rowOne.sourceWorks.filter(source => source.kind === "Subtask").map(source => source.externalKey), ["TCRN-CROSS-SUB-748", "TCRN-CROSS-SUB-750", "TCRN-CROSS-SUB-752"]);
  assert.equal(rowOne.criteria.find(ref => ref.acceptanceOwner.id === stories[690].id).acceptanceId, "AC01");
  assert.equal(rowOne.criteria.find(ref => ref.acceptanceOwner.id === stories[690].id).requirementOwner.id, stories[690].id);
  assert.deepEqual(shown.content.packPlan.assignments.map(row => row.order), [1, 2, 3]);
  assert.equal(rowOne.parallelGroup, "wave-01-independent");
  assert.equal(shown.content.packPlan.assignments[1].parallelGroup, rowOne.parallelGroup);
  assert.equal(shown.content.packPlan.maxConcurrency, 2);
  assert.equal(shown.content.packPlan.assignments[1].files.find(file => file.repository === "Linux runtime").access, "read");
  assert.match(shown.content.packPlan.assignments[1].files.find(file => file.repository === "Linux runtime").resolution, /current Linux runtime configuration/u);
  assert.deepEqual(shown.content.packPlan.assignments[2].verification.verifiers.map(source => source.id), [subtasks[749].id, subtasks[751].id, subtasks[753].id]);
  assert.deepEqual(shown.content.packPlan.assignments[2].verification.afterAssignmentIds, ["row-01-cli-implementation"]);
  assert.deepEqual(shown.content.packPlan.assignments[1].prerequisites[0].blocker, workRef(stories[705]));

  const originalStory = await cli(["work-show", ...workspaceArgs, "--id", stories[690].id]);
  const originalSubtask = await cli(["work-show", ...workspaceArgs, "--id", subtasks[750].id]);
  assert.equal(originalSubtask.content.completion.result, sourceResults[750]);
  assert.equal(foundRow.resultSources.find(result => result.source.id === originalSubtask.record.id).source.revision, originalSubtask.record.revision);
  const originalEpic = await cli(["work-show", ...workspaceArgs, "--id", epic216.id]);
  assert.equal(originalStory.record.parentId, originalEpic.record.id);
  assert.equal(originalEpic.record.parentId, initiative.id);
  assert.equal(originalSubtask.record.parentId, originalStory.record.id);
  const blockedStory = await cli(["work-show", ...workspaceArgs, "--id", stories[706].id]);
  assert.deepEqual(blockedStory.relations.forward.blockedBy, [stories[705].id]);
  const activeBlocker = await cli(["work-show", ...workspaceArgs, "--id", stories[705].id]);
  assert.equal(activeBlocker.record.status, "active");
  assert.equal(blockedStory.record.status, "planned", "the source prerequisite is represented without changing either source status");

  const stalePlan = structuredClone(plan);
  stalePlan.assignments[0].sourceWorks[0].revision += 1;
  const invalidContent = { ...content, packPlan: stalePlan };
  await assert.rejects(() => cli(["work-create", ...common, "--at", at(), "--external-key", "TCRN-CROSS-PACK-STALE-REF", "--kind", "Pack", "--title", "Stale reference", "--content", JSON.stringify(invalidContent), "--template-receipt", JSON.stringify(receipt)]), error => error.reasonCode === "WORKSPACE_INPUT_INVALID");
  const afterRefusal = await cli(["work-list", ...common, "--kind", "Pack"]);
  assert.equal(afterRefusal.total, 1, "stale source snapshots are rejected before an event is appended");
});

test("Pack plan schema and ordered references reject malformed plans", async () => {
  const [planSchemaText, contentSchemaText, commonSchemaText] = await Promise.all([
    readFile(new URL("../schemas/pack-plan-v1.schema.json", import.meta.url), "utf8"),
    readFile(new URL("../schemas/work-content-v1.schema.json", import.meta.url), "utf8"),
    readFile(new URL("../schemas/protocol-common-v1.schema.json", import.meta.url), "utf8"),
  ]);
  const planSchema = JSON.parse(planSchemaText);
  const contentSchema = JSON.parse(contentSchemaText);
  const commonSchema = JSON.parse(commonSchemaText);
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addSchema(commonSchema);
  ajv.addSchema(planSchema);
  assert.equal(ajv.compile(contentSchema)({ ...workContentDraft("Pack"), packPlan: { schemaVersion: "tcrn.pack-plan.v1", initiative: { id: "work:000000000000000000000000", externalKey: "PACK-INIT", kind: "Initiative", revision: 1, parentId: null }, maxConcurrency: 1, assignments: [{ id: "row-1", order: 1, role: "implementation", status: "planned", parallelGroup: null, sourceWorks: [{ id: "work:000000000000000000000000", externalKey: "PACK-INIT", kind: "Initiative", revision: 1, parentId: null }], criteria: [{ acceptanceOwner: { id: "work:000000000000000000000000", externalKey: "PACK-INIT", kind: "Initiative", revision: 1, parentId: null }, acceptanceId: "AC01", acceptanceVersion: 1, requirementOwner: { id: "work:000000000000000000000000", externalKey: "PACK-INIT", kind: "Initiative", revision: 1, parentId: null }, requirementId: "R01", requirementVersion: 1 }], files: [{ repository: "Einzbern", path: "packages/cli/src/index.ts", access: "read" }], prerequisites: [], resultSources: [], verification: null }] } }), true);

  const draft = workContentDraft("Pack");
  assert.ok(workContentMissing(draft, "write").includes("packPlan"));
  const malformed = { schemaVersion: "tcrn.pack-plan.v1", initiative: { id: "work:000000000000000000000000", externalKey: "PACK-INIT", kind: "Initiative", revision: 1, parentId: null }, maxConcurrency: 1, assignments: [] };
  assert.throws(() => validatePackPlan(malformed), error => error.reasonCode === "PACK_PLAN_INVALID");
});
