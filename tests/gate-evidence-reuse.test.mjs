// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { checkGateDeclaration } from "../dist/build/packages/core/src/gates-config.js";
import { planGates } from "../dist/build/packages/core/src/gates-plan.js";
import {
  gateRunEvidenceCurrent, gateRunsDirectory, gateVerificationPlan, latestGateRun, readGateEvidence, runGates,
} from "../dist/build/packages/core/src/gates-run.js";
import { parseGateRunPrior } from "../scripts/lib/push-gate-p1-coverage.mjs";

const workId = "work:" + "1".repeat(24);
const alternateWork = "work:" + "2".repeat(24);
const projectId = "project:" + "7".repeat(24);
const libraryId = "workspace:" + "8".repeat(24);

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "einzbern-verification-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = join(root, "project");
  await mkdir(projectRoot);
  const git = (...args) => execFileSync("git", [
    "-C", projectRoot, "-c", "user.name=Gate Test", "-c", "user.email=gate-test-at-example.invalid",
    "-c", "commit.gpgsign=false", ...args,
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q");
  await writeFile(join(projectRoot, "artifact"), "fixed release artifact\n");
  await writeFile(join(projectRoot, "registry"), "unregistered\n");
  await writeFile(join(projectRoot, ".gitignore"), "generated\n");
  git("add", ".");
  git("commit", "-qm", "frozen candidate");
  const base = git("rev-parse", "HEAD");
  const invocations = join(root, "invocations");
  let tick = 0;
  const scope = { libraryId, projectId, deviceHome: join(root, "device") };
  const gate = (name, input, statement = "") => ({
    ...checkGateDeclaration({
      command: [process.execPath, "-e",
        "require('node:fs').appendFileSync(" + JSON.stringify(invocations) + ",process.argv[1]+'\\n');" +
        "console.log(require('node:fs').readFileSync(process.argv[2],'utf8'));" + statement, name, input],
      root: ".", covers: ["**"], required: true, enabled: true, releaseOnly: false,
      reuse: { source: [input], portable: true },
    }, name), name,
  });
  const plan = async (gates, mode = {}) => ({
    ...await planGates({ ...scope, projectRoot, gates, base, workIds: [workId] }), ...mode,
  });
  const run = (planned) => runGates(planned, { ...scope, outputBytes: 1_024, at: new Date(Date.UTC(2026, 10, 22, 0, 0, ++tick)).toISOString() });
  return { root, projectRoot, git, base, invocations, scope, gate, plan, run };
}

const modes = (run) => Object.fromEntries(run.gates.map(gate => [gate.name, gate.verification.mode]));

test("same working bytes across commit, subsequent independent plan executes only changed and new checks", async (t) => {
  const f = await setup(t);
  const artifact = f.gate("artifact", "artifact", "process.stderr.write('X'.repeat(2048));");
  const doctor = f.gate("doctor", "registry");
  const plan = await f.plan([artifact, doctor], { evidenceOnly: true });
  const { run: cold } = await f.run(plan);
  assert.deepEqual(modes(cold), { artifact: "executed", doctor: "executed" });
  assert.deepEqual(cold.reds, []);
  const rawLog = join(gateRunsDirectory(libraryId, f.scope.deviceHome), cold.gates[0].outputFile);
  const rawOutput = await readFile(rawLog, "utf8");
  assert.equal(rawOutput.replaceAll("X", ""), "fixed release artifact\n\n");
  assert.equal(rawOutput.length - "fixed release artifact\n\n".length, 2_048);
  assert.equal(cold.gates[0].truncated, false);
  assert.equal(await latestGateRun(f.scope), null);
  assert.equal((await readGateEvidence(gateRunsDirectory(libraryId, f.scope.deviceHome), cold.runId, libraryId, workId)).runId, cold.runId);
  assert.equal(await readGateEvidence(gateRunsDirectory(libraryId, f.scope.deviceHome), cold.runId, libraryId, alternateWork), null);

  f.git("commit", "--allow-empty", "-qm", "tree-equivalent merge");
  const { run: reuse } = await f.run(await f.plan([artifact, doctor]));
  assert.deepEqual(modes(reuse), { artifact: "reused", doctor: "reused" });
  assert.equal(reuse.gates[0].outputFile, cold.gates[0].outputFile);
  const bound = { ...f.scope, rootBindings: plan.rootBindings };
  assert.equal(await gateRunEvidenceCurrent(reuse, reuse.gates[1], doctor, f.projectRoot, bound), true);

  await writeFile(join(f.projectRoot, "registry"), "registered\n");
  assert.equal(await gateRunEvidenceCurrent(reuse, reuse.gates[1], doctor, f.projectRoot, bound), false);
  const lookup = f.gate("lookup", "registry");
  const acceptance = await f.plan([artifact, doctor, lookup], { evidenceOnly: true });
  assert.deepEqual((await gateVerificationPlan(acceptance, f.scope)).map(check => [check.name, check.action]),
    [["artifact", "reuse"], ["doctor", "run"], ["lookup", "run"]]);
  const { run: supplement } = await f.run(acceptance);
  assert.deepEqual(modes(supplement), { artifact: "reused", doctor: "executed", lookup: "executed" });
  assert.equal(await readFile(f.invocations, "utf8"), "artifact\ndoctor\ndoctor\nlookup\n");
});

test("parallel callers share one execution, raw evidence loss reopens the gate and red stays due", async (t) => {
  const f = await setup(t);
  const definition = f.gate("artifact", "artifact");
  const plan = await f.plan([definition]);
  const [left, right] = await Promise.all([f.run(plan), f.run(plan)]);
  assert.deepEqual([left.run, right.run].map(run => run.gates[0].verification.mode).sort(), ["executed", "reused"]);
  assert.equal(await readFile(f.invocations, "utf8"), "artifact\n");
  const raw = join(gateRunsDirectory(libraryId, f.scope.deviceHome), left.run.gates[0].outputFile);
  await writeFile(raw, "changed evidence\n");
  assert.equal((await gateVerificationPlan(plan, f.scope))[0].reason, "raw-evidence-missing-or-changed");
  const { run } = await f.run(plan);
  assert.equal(run.gates[0].verification.mode, "executed");

  const red = await f.plan([f.gate("red", "artifact", "process.exit(1);")]);
  assert.deepEqual((await f.run(red)).run.reds, ["red"]);
  assert.equal((await gateVerificationPlan(red, f.scope))[0].reason, "last-run-did-not-pass");
});

test("release runs execute even when equivalent successful evidence already exists", async (t) => {
  const f = await setup(t);
  const definition = f.gate("artifact", "artifact");
  const { run: ordinary } = await f.run(await f.plan([definition]));
  assert.equal(ordinary.gates[0].verification.mode, "executed");

  const { run: release } = await f.run(await f.plan([definition], { release: true }));
  assert.equal(release.release, true);
  assert.equal(release.gates[0].verification.mode, "executed");
  assert.equal((await readFile(f.invocations, "utf8")).trim().split("\n").length, 2);
});

test("supplement checks receive earlier reused evidence with the original log and its run ID", async (t) => {
  const f = await setup(t);
  const artifact = f.gate("artifact", "artifact");
  const { run: first } = await f.run(await f.plan([artifact]));
  const { reuse: _reuse, ...aggregate } = f.gate(
    "summary",
    "registry",
    "console.log(process.env.EINZBERN_GATE_RUN_PRIOR);",
  );
  const { run: review } = await f.run(await f.plan([artifact, aggregate]));
  assert.equal(review.gates[0].verification.mode, "reused");
  const directory = gateRunsDirectory(libraryId, f.scope.deviceHome);
  const output = await readFile(join(directory, review.gates[1].outputFile), "utf8");
  const prior = JSON.parse(output.trimEnd().split("\n").at(-1));
  assert.equal(prior.runId, review.runId);
  assert.equal(prior.gates[0].sourceRunId, first.runId);
  const parsed = parseGateRunPrior(JSON.stringify(prior));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.gates[0].directory, f.projectRoot);
  assert.equal(parsed.gates[0].outputFile, join(directory, first.gates[0].outputFile));
  assert.match(await readFile(parsed.gates[0].outputFile, "utf8"), /fixed release artifact/);
  delete prior.gates[0].sourceRunId;
  assert.equal(parseGateRunPrior(JSON.stringify(prior)).ok, false);
});

test("disjoint reusable checks can take available slots concurrently", async (t) => {
  const f = await setup(t);
  const plans = await Promise.all([
    f.plan([f.gate("artifact", "artifact")]),
    f.plan([f.gate("doctor", "registry")]),
  ]);
  const overlap = Promise.withResolvers();
  let active = 0;
  const admit = async () => {
    active += 1;
    if (active === plans.length) overlap.resolve(true);
    return {
      env: {},
      release() { active -= 1; },
    };
  };
  const racing = plans.map((plan, index) => runGates(plan, {
    ...f.scope,
    at: new Date(Date.UTC(2026, 10, 22, 0, 0, index)).toISOString(),
    admit: async () => {
      const lease = await admit();
      await Promise.race([overlap.promise, delay(4000, false, { ref: false })]);
      return lease;
    },
  }));
  const [concurrent, results] = await Promise.all([
    Promise.race([overlap.promise, delay(4000, false, { ref: false })]),
    Promise.all(racing),
  ]);
  assert.equal(concurrent, true);
  assert.equal(active, 0);
  assert.ok(results.every(({ run }) => run.gates[0].verification.mode === "executed"));
});

test("the gate must establish stable inputs and retain its declared outputs", async (t) => {
  const f = await setup(t);
  const generated = f.gate("generate", "artifact", "require('node:fs').writeFileSync('generated','built');");
  const plan = await f.plan([{ ...generated, reuse: { ...generated.reuse, outputs: ["generated"] } }]);
  assert.deepEqual((await f.run(plan)).run.reds, []);
  assert.equal((await gateVerificationPlan(plan, f.scope))[0].action, "reuse");
  await rm(join(f.projectRoot, "generated"));
  assert.equal((await gateVerificationPlan(plan, f.scope))[0].reason, "output-artifact-missing-or-changed");

  const drifting = f.gate("drift", "artifact", "require('node:fs').appendFileSync('artifact','change');");
  const drift = await f.plan([drifting]);
  const ro = (await f.run(drift)).run.gates[0];
  assert.equal(ro.ok, true);
  assert.equal(ro.verification.inputDigest, null);
  assert.equal((await gateVerificationPlan(drift, f.scope))[0].action, "run");
});
