// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";

import { isGateRunRecord } from "../dist/build/packages/core/src/gate-run-record.js";
import { parseGateRunPrior } from "../scripts/lib/push-gate-p1-coverage.mjs";

const runId = "20261125T132153Z-0123456789ab";
const sourceRunId = "20261125T132154Z-abcdef012345";

function legacyRun() {
  return {
    schemaVersion: "einzbern.gate-run.v1",
    runId,
    libraryId: "workspace:" + "8".repeat(24),
    at: "2026-11-25T13:21:53.000Z",
    release: false,
    base: null,
    workIds: [],
    treeDigest: "0".repeat(64),
    declarationsDigest: "1".repeat(64),
    trees: [{ root: ".", git: false, head: null, changes: null }],
    gates: [{
      name: "legacy",
      root: ".",
      required: true,
      matched: [],
      matchedWorkIds: [],
      ok: true,
      exitCode: 0,
      signal: null,
      timedOut: false,
      outputFile: runId + "/1-legacy.log",
      outputBytes: 0,
      truncated: false,
    }],
    reds: [],
  };
}

test("legacy gate runs remain readable and reused prior output stays bound to its source run", () => {
  const legacy = legacyRun();
  assert.equal(isGateRunRecord(legacy), true);

  const current = structuredClone(legacy);
  current.evidenceOnly = true;
  current.gates[0].verification = {
    mode: "executed",
    reason: "matching-inputs",
    inputDigest: "2".repeat(64),
    outputSha256: "3".repeat(64),
    command: ["node", "check.mjs"],
  };
  assert.equal(isGateRunRecord(current), true);
  current.evidenceOnly = false;
  assert.equal(isGateRunRecord(current), false);

  const prior = {
    runId,
    gates: [{
      name: "tests",
      root: ".",
      directory: "/repo",
      command: ["node", "--test"],
      ok: true,
      truncated: false,
      outputFile: "/cache/gate-runs/" + sourceRunId + "/1-tests.log",
      sourceRunId,
    }],
  };
  assert.equal(parseGateRunPrior(JSON.stringify(prior)).ok, true);
  prior.gates[0].outputFile = "/cache/gate-runs/" + runId + "/1-tests.log";
  assert.equal(parseGateRunPrior(JSON.stringify(prior)).ok, false);
});
