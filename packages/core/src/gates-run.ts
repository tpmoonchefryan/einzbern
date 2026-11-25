import { acquireMemoryChild, memoryGateCommand } from "../../../scripts/lib/memory-budget.mjs";
import { RUNTIME_CAPACITY } from "../../../scripts/lib/runtime-capacity.mjs";
// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-485 R3 (MIN-235 D8; TCRN-CROSS-SUB-344): running a plan's gates. Checks with a
// current successful reuse receipt are carried into the run; every other due check runs as its own
// process in its root, with no shell. A red gate does not stop the ones after it, and the run reports
// every red at the end. Gate output goes to a file, and the run is
// recorded in this device's cache of the library, at cache/<library>/gate-runs/<runId>.json
// (einzbern.gate-run.v1), with its exact target work ids, path/id matches, declaration digest and
// tree digest. The done check (gates-done.ts) accepts a run only for the same tree and declarations
// and, since TCRN-CROSS-STORY-525 (TCRN-CROSS-SUB-448), one whose target work ids include the Story.
// A gate that outlives its timeout is stopped with its whole process group, and whatever a gate left
// running in its group is stopped when it ends.
//
// TCRN-CROSS-STORY-530 (MIN-256; TCRN-CROSS-SUB-450), TCRN-CROSS-STORY-534 (MIN-257 D6;
// TCRN-CROSS-SUB-469): a run made for Stories whose commits are known by key (the plan's subjectKeys:
// the external keys of the Stories and their Subtasks) takes its tree digest over the files those
// commits touched (storyCommitPaths in gates-plan.ts), each read as it is now, changed or not, and
// leaves HEAD out (einzbern.gate-tree.v3): each such root records the files as `paths` and, in
// `files`, each one's content digest. A commit or a file another process makes elsewhere in the
// project leaves such a run standing; a change to the content of one of the Story's files does not,
// committed or not. When those commits touched no file under any root (Q1), the run is taken as one
// made without keys, so its digest is never a constant. A non-release run made without keys, and every release run even with Story keys,
// records each root's HEAD and the digest of every changed and untracked file, as before. The
// done check reads the recorded files again and compares their digests.
//
// TCRN-CROSS-STORY-537 (MIN-257 D6; TCRN-CROSS-SUB-487): a gate can see what the same run has already
// resolved. Each gate process gets EINZBERN_GATE_RUN_PRIOR, the canonical JSON of the run id and,
// in order, the earlier checks' name, root, real directory, actual command, result, output state and
// output path. Reused checks name the producing run with sourceRunId. The first gate gets an empty
// list. The variable overrides any caller value and is not itself part of the run record. The push
// gate reads it to leave out verify:p1 when the same run already passed each of P1's legs.

import { spawnCommand as spawn } from "../../../skill/mana-orchestrate/scripts/process-launch.mjs";
import type { ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, readlink, realpath } from "node:fs/promises";
import { join } from "node:path";

import { assertStrictInstant, canonicalJson, canonicalSha256, compareCanonicalText, parseStrictInstant } from "../../protocol/src/index.js";
import { writeFileAtomic } from "./atomic-file.js";
import { cachePath } from "./device-home.js";
import { GatesPlanError, changedFiles, gateRootBinding, gitHead, resolveGateRoot, storyCommitPaths } from "./gates-plan.js";
import type { GateRepositoryScope, GateRootBinding, GatesPlan, PlannedGate } from "./gates-plan.js";
import type { NamedGate } from "./gates-config.js";
import { withFileLock } from "./file-lock.js";
import { gateArtifactsDigest, gateFileSha256, gateInputDigest, gateReuseDirectory, gateRunIdShape, inspectGateReuse, writeGateProof } from "./gate-reuse.js";
import type { GateReuseContext, GateReuseInspection } from "./gate-reuse.js";

import { GATE_RUN_SCHEMA_VERSION, compareGateRuns, isGateRunRecord } from "./gate-run-record.js";
export { GATE_RUN_SCHEMA_VERSION } from "./gate-run-record.js";
export const GATE_TREE_SCHEMA_VERSION = "einzbern.gate-tree.v3" as const;
export const GATE_RUNS_DIRECTORY = "gate-runs" as const;
export const GATE_RUN_DEFAULT_TIMEOUT_MS = 1_800_000 as const;
export const GATE_RUN_DEFAULT_OUTPUT_BYTES = 1_048_576 as const;
/** TCRN-CROSS-STORY-537: the variable through which a gate reads the gates of its run that ended before it. */
export const GATE_RUN_PRIOR_VARIABLE = "EINZBERN_GATE_RUN_PRIOR" as const;

export const GATES_RUN_REASON_CODES = Object.freeze(["GATES_RUN_INPUT_INVALID"] as const);

export type GatesRunReasonCode = typeof GATES_RUN_REASON_CODES[number];

export class GatesRunError extends Error {
  readonly reasonCode: GatesRunReasonCode;
  readonly details: Readonly<Record<string, string>> | undefined;

  constructor(reasonCode: GatesRunReasonCode, message: string, details?: Readonly<Record<string, string>>) {
    super(message);
    this.name = "GatesRunError";
    this.reasonCode = reasonCode;
    this.details = details;
  }
}

function fail(message: string, details?: Readonly<Record<string, string>>): never {
  throw new GatesRunError("GATES_RUN_INPUT_INVALID", message, details);
}

/** TCRN-CROSS-STORY-534: one of the Story's files under a root, as a run read it. */
export interface GateFileDigest {
  // Relative to the root, with forward slashes.
  readonly path: string;
  // sha256:<hex> of a file's content, link:<target> for a symbolic link, directory, other, or deleted.
  readonly digest: string;
}

/** A root's state over every change under it, as a run made without a Story's keys records it. */
export interface GateRootChanges {
  readonly root: string;
  // False when the root is outside Git: its changes cannot be told apart, so any state of it matches.
  readonly git: boolean;
  readonly head: string | null;
  // The digest of every changed and untracked file under the root, path and content; null without Git.
  readonly changes: string | null;
  readonly paths?: never;
  readonly files?: never;
}

/**
 * TCRN-CROSS-STORY-534: a root's state over the files the Story's commits touched, each read as it is
 * now; HEAD and the other changes under the root are not part of it.
 */
export interface GateRootPaths {
  readonly root: string;
  readonly git: true;
  // The files, relative to the root with forward slashes, sorted.
  readonly paths: readonly string[];
  // Each of `paths`, in the same order, with its content digest.
  readonly files: readonly GateFileDigest[];
  readonly head?: never;
  readonly changes?: never;
}

/** One root's state as a run records it. */
export type GateRootTree = GateRootChanges | GateRootPaths;

/**
 * TCRN-CROSS-STORY-530, 534: what a tree digest is limited to. `keys` names the Stories and Subtasks
 * whose commits give the files of each root that has a commit (storyCommitPaths); when they give no
 * file under any root (Q1), or `keys` is empty, every root counts every change. `paths` gives the
 * files per root as a run recorded them, for their content to be read again; a root it does not name
 * counts every change.
 */
export interface GateTreeScope extends GateRepositoryScope {
  readonly keys?: readonly string[];
  readonly paths?: Readonly<Record<string, readonly string[]>>;
  readonly rootBindings?: Readonly<Record<string, GateRootBinding>>;
}

export interface GateTreeState {
  readonly treeDigest: string;
  readonly trees: readonly GateRootTree[];
}

export interface GateRunResult {
  readonly name: string;
  readonly root: string;
  readonly required: boolean;
  // Path and exact work-id coverage are kept separate so the done check can prove what matched.
  readonly matched: readonly string[];
  readonly matchedWorkIds: readonly string[];
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  // The gate's output, relative to the gate-runs directory.
  readonly outputFile: string;
  readonly outputBytes: number;
  readonly truncated: boolean;
  // Absent only on historical records written before per-gate timing was recorded.
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly durationMs?: number;
  readonly verification?: {
    readonly mode: "executed" | "reused";
    readonly reason: string;
    readonly inputDigest: string | null;
    readonly outputSha256?: string;
    readonly command?: readonly string[];
  };
}

export interface GateRun {
  readonly schemaVersion: typeof GATE_RUN_SCHEMA_VERSION;
  readonly runId: string;
  readonly libraryId: string;
  readonly projectId?: string;
  readonly at: string;
  readonly release: boolean;
  readonly evidenceOnly?: true;
  readonly base: string | null;
  readonly baseByRoot?: Readonly<Record<string, string>>;
  // The Stories the run was planned to cover; an unbound run cannot satisfy a Story's done check.
  readonly workIds: readonly string[];
  readonly treeDigest: string;
  readonly declarationsDigest: string;
  readonly trees: readonly GateRootTree[];
  readonly gates: readonly GateRunResult[];
  // Every gate that did not pass, required or not, in plan order.
  readonly reds: readonly string[];
}

/** TCRN-CROSS-STORY-537: a gate of the run that ended before the gate that reads it. */
export interface GatePriorResult {
  readonly name: string;
  // The root as the gate declares it, relative to the project.
  readonly root: string;
  // The real, absolute directory the gate ran in.
  readonly directory: string;
  readonly command: readonly string[];
  readonly ok: boolean;
  readonly truncated: boolean;
  // The absolute path of the gate's output file (the run record keeps it relative).
  readonly outputFile: string;
  // Present when outputFile belongs to a successful check reused from an earlier run.
  readonly sourceRunId?: string;
}

/** TCRN-CROSS-STORY-537: what EINZBERN_GATE_RUN_PRIOR holds for one gate of a run. */
export interface GateRunPrior {
  readonly runId: string;
  // In the order they ran; empty for the first gate.
  readonly gates: readonly GatePriorResult[];
}

/** This device's directory of gate runs for a library. */
export function gateRunsDirectory(libraryId: string, deviceHome?: string): string {
  return join(deviceHome === undefined ? cachePath(libraryId) : cachePath(libraryId, deviceHome), GATE_RUNS_DIRECTORY);
}

async function contentDigest(path: string): Promise<string> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return "deleted";
    throw error;
  }
  if (metadata.isSymbolicLink()) return `link:${await readlink(path)}`;
  if (metadata.isDirectory()) return "directory";
  if (!metadata.isFile()) return "other";
  return `sha256:${createHash("sha256").update(await readFile(path)).digest("hex")}`;
}

// A root's state over every change under it: the commit HEAD names and the digest of the path and
// content of every file changed against HEAD or untracked. Outside Git neither is recorded, so every
// state of the root looks the same.
async function changesTree(root: string, directory: string): Promise<GateRootChanges> {
  let files: readonly string[];
  try {
    files = changedFiles(directory);
  } catch (error) {
    if (error instanceof GatesPlanError && error.reasonCode === "GATES_GIT_UNAVAILABLE") return { root, git: false, head: null, changes: null };
    throw error;
  }
  const entries: string[] = [];
  for (const file of files) entries.push(`${file}\u0000${await contentDigest(join(directory, ...file.split("/")))}`);
  return { root, git: true, head: gitHead(directory), changes: createHash("sha256").update(entries.join("\u0000"), "utf8").digest("hex") };
}

// TCRN-CROSS-STORY-534: a root's state over the Story's files, each read where it is now, whether Git
// sees it changed or not.
async function pathsTree(root: string, directory: string, paths: readonly string[]): Promise<GateRootPaths> {
  const files: GateFileDigest[] = [];
  for (const path of paths) files.push({ path, digest: await contentDigest(join(directory, ...path.split("/"))) });
  return { root, git: true, paths: [...paths], files };
}

/**
 * The state of the project a run is made on. For a run made for Stories (`scope.keys`), each root
 * with a commit records the files their commits touched there, with each one's content as it is now
 * (GateRootPaths), and a root without a commit records its HEAD and every change (GateRootChanges);
 * when the commits touched no file under any root (TCRN-CROSS-STORY-534 Q1) every root records its
 * HEAD and every change, as for a run made without keys. With `scope.paths`, the roots it names read
 * the files a run recorded again, and the others every change.
 */
export async function gateTreeState(projectRoot: string, roots: readonly string[], scope: GateTreeScope = {}): Promise<GateTreeState> {
  const project = await realpath(projectRoot);
  const keys = [...new Set(scope.keys ?? [])];
  const directories: (readonly [string, string])[] = [];
  for (const root of [...new Set(roots)].sort(compareCanonicalText)) {
    directories.push([root, await resolveGateRoot(project, root, gateRootBinding(scope.rootBindings, root), scope)]);
  }
  const limited = new Map<string, readonly string[]>();
  if (scope.paths !== undefined) {
    for (const [root] of directories) {
      const recorded = Object.hasOwn(scope.paths, root) ? scope.paths[root] : undefined;
      if (recorded !== undefined) limited.set(root, recorded);
    }
  } else if (keys.length > 0) {
    for (const [root, directory] of directories) if (gitHead(directory) !== null) limited.set(root, storyCommitPaths(directory, keys));
    // Q1: without a file of the Stories' anywhere the digest would be a constant that no change moves.
    if ([...limited.values()].every((paths) => paths.length === 0)) limited.clear();
  }
  const trees: GateRootTree[] = [];
  for (const [root, directory] of directories) {
    const paths = limited.get(root);
    trees.push(paths === undefined ? await changesTree(root, directory) : await pathsTree(root, directory, paths));
  }
  return { treeDigest: canonicalSha256({ schemaVersion: GATE_TREE_SCHEMA_VERSION, trees }), trees };
}

function terminate(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // The process group is already gone.
  }
}

interface GateProcess {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly output: Buffer;
  readonly truncated: boolean;
}

function runGateProcess(command: readonly string[], cwd: string, timeoutMs: number, outputBytes: number, env: NodeJS.ProcessEnv, outputFd?: number): Promise<GateProcess> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    const append = (chunk: Buffer): void => {
      const room = outputBytes - bytes;
      if (chunk.length > room) truncated = true;
      if (room <= 0) return;
      const kept = chunk.subarray(0, room);
      chunks.push(kept);
      bytes += kept.length;
    };
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let child: ChildProcess | undefined;
    const finish = (exitCode: number | null, signal: string | null, failure: string | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      // Whatever the gate left running in its process group ends with it.
      if (child !== undefined) terminate(child, "SIGTERM");
      if (failure !== null) append(Buffer.from(`einzbern: the gate could not run: ${failure}\n`, "utf8"));
      resolve({ exitCode, signal, timedOut, output: Buffer.concat(chunks), truncated });
    };
    const [executable, ...args] = command;
    try {
      child = spawn(executable ?? "", args, {
        cwd,
        detached: process.platform !== "win32",
        env,
        shell: false,
        stdio: ["ignore", outputFd ?? "pipe", outputFd ?? "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      const failure = error as NodeJS.ErrnoException;
      finish(null, null, failure.code ?? String(failure.message ?? error));
      return;
    }
    const started = child;
    started.stdout?.on("data", append);
    started.stderr?.on("data", append);
    started.once("error", (error: NodeJS.ErrnoException) => finish(null, null, error.code ?? error.message));
    started.once("close", (exitCode: number | null, signal: NodeJS.Signals | null) => finish(exitCode, signal, null));
    started.once("spawn", () => {
      timer = setTimeout(() => {
        timedOut = true;
        terminate(started, "SIGTERM");
        killTimer = setTimeout(() => {
          if (!settled) terminate(started, "SIGKILL");
        }, 1_000);
        killTimer.unref();
      }, timeoutMs);
    });
  });
}

// The UTC second as a file-name prefix that sorts: 20260926T100000Z.
function utcStamp(at: string): string {
  return new Date(Number(parseStrictInstant(at) / 1_000_000n)).toISOString().replace(/\.\d{3}Z$/u, "Z").replace(/[-:]/gu, "");
}

interface GateExecutionScope extends GateRepositoryScope {
  readonly libraryId: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly rootBindings?: GatesPlan["rootBindings"];
}

async function reuseContext(plan: GatesPlan, gate: PlannedGate, scope: GateExecutionScope): Promise<GateReuseContext> {
  const cwd = await resolveGateRoot(plan.projectRoot, gate.root, gateRootBinding(plan.rootBindings, gate.root), scope);
  return {
    gate,
    cwd,
    directory: gateRunsDirectory(scope.libraryId, scope.deviceHome),
    base: plan.baseByRoot?.[gate.root] ?? plan.base,
    release: plan.release,
    ...(scope.projectId === undefined ? {} : { projectId: scope.projectId }),
    environment: scope.env ?? process.env,
  };
}

/** Show which checks have current successful evidence without executing them. */
export async function gateVerificationPlan(plan: GatesPlan, scope: GateExecutionScope): Promise<readonly {
  readonly name: string;
  readonly action: "reuse" | "run";
  readonly reason: string;
  readonly source?: string;
}[]> {
  const decisions = [];
  for (const gate of plan.gates) {
    const inspection = await inspectGateReuse(await reuseContext(plan, gate, scope));
    decisions.push({
      name: gate.name,
      reason: inspection.reason,
      action: inspection.proof ? "reuse" as const : "run" as const,
      ...(inspection.proof ? { source: inspection.proof.outputFile } : {}),
    });
  }
  return decisions;
}

/** Read a handoff run from either the formal run directory or the isolated evidence-only directory. */
export async function readGateEvidence(directory: string, runId: string, libraryId: string, workId?: string): Promise<GateRun | null> {
  if (!gateRunIdShape.test(runId)) return null;
  for (const where of [directory, join(directory, "evidence-only")]) {
    try {
      const run: unknown = JSON.parse(await readFile(join(where, runId + ".json"), "utf8"));
      if (isGateRunRecord(run) && run.runId === runId && run.libraryId === libraryId && (!workId || run.workIds.includes(workId))) return run;
    } catch {
      // A missing or malformed record does not prove that a check ran.
    }
  }
  return null;
}

/** A successful recorded check is current only while its declared inputs and output remain available. */
export async function gateRunEvidenceCurrent(
  run: GateRun,
  result: GateRunResult,
  declaration: NamedGate,
  projectRoot: string,
  scope: GateExecutionScope,
): Promise<boolean> {
  const verification = result.verification;
  if (verification === undefined) return true;
  if (!declaration.reuse || verification.inputDigest === null || verification.outputSha256 === undefined) return false;

  const cwd = await resolveGateRoot(projectRoot, result.root, gateRootBinding(scope.rootBindings, result.root), scope);
  const environment = scope.env ?? process.env;
  let command: readonly string[];
  try {
    command = memoryGateCommand(declaration.command, cwd, environment);
  } catch {
    return false;
  }
  if (verification.command !== undefined && canonicalJson(command) !== canonicalJson(verification.command)) return false;
  const gate: PlannedGate = {
    name: declaration.name,
    root: result.root,
    command,
    required: declaration.required,
    releaseOnly: declaration.releaseOnly,
    reuse: declaration.reuse,
    reason: "required",
    matched: result.matched,
    matchedWorkIds: result.matchedWorkIds,
  };
  const inspection = await inspectGateReuse({
    gate,
    cwd,
    directory: gateRunsDirectory(run.libraryId, scope.deviceHome),
    base: run.baseByRoot?.[result.root] ?? run.base,
    // Validation only verifies the recorded proof; release runs have already executed every gate.
    release: false,
    ...(run.projectId === undefined ? {} : { projectId: run.projectId }),
    environment,
    command,
  });
  return inspection.proof?.inputDigest === verification.inputDigest &&
    inspection.proof.outputSha256 === verification.outputSha256 && inspection.proof.outputFile === result.outputFile;
}

interface RunGatesAdmission {
  readonly env: NodeJS.ProcessEnv;
  readonly release?: () => void;
}

interface RunGatesOptions {
  readonly libraryId: string;
  readonly projectId?: string;
  readonly at: string;
  readonly deviceHome?: string;
  readonly timeoutMs?: number;
  readonly outputBytes?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly admit?: () => Promise<RunGatesAdmission>;
}

/**
 * Run every due gate of a plan and record the run in this device's cache of the library. Reuse is
 * limited to declared, current successful evidence, and release runs always execute. The tree
 * digest is taken before the first gate starts. Each gate's environment is `env` (the process's
 * when not given) with EINZBERN_GATE_RUN_PRIOR set to the checks already resolved in this run.
 */
export async function runGates(plan: GatesPlan, options: RunGatesOptions): Promise<{ readonly run: GateRun; readonly recordPath: string }> {
  assertStrictInstant(options.at);
  const timeoutMs = options.timeoutMs ?? GATE_RUN_DEFAULT_TIMEOUT_MS;
  const outputBytes = options.outputBytes ?? GATE_RUN_DEFAULT_OUTPUT_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > RUNTIME_CAPACITY.timerMilliseconds) fail("a gate timeout must fit the native timer and be at least 100 milliseconds", { timeoutMs: String(timeoutMs) });
  if (!Number.isSafeInteger(outputBytes) || outputBytes < 1_024 || outputBytes > RUNTIME_CAPACITY.bufferBytes) fail("a gate's output budget must fit the runtime buffer and be at least 1024 bytes", { outputBytes: String(outputBytes) });
  const directory = gateRunsDirectory(options.libraryId, options.deviceHome);
  const resolution = {
    libraryId: options.libraryId,
    ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
    ...(options.deviceHome === undefined ? {} : { deviceHome: options.deviceHome }),
    ...(plan.rootBindings === undefined ? {} : { rootBindings: plan.rootBindings }),
  };
  const tree = await gateTreeState(plan.projectRoot, plan.roots, {
    ...resolution,
    ...(plan.release || plan.subjectKeys === undefined ? {} : { keys: plan.subjectKeys }),
  });
  const runId = `${utcStamp(options.at)}-${canonicalSha256({
    projectRoot: plan.projectRoot,
    at: options.at,
    ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
    treeDigest: tree.treeDigest,
    declarationsDigest: plan.declarationsDigest,
    release: plan.release,
    base: plan.base,
    ...(plan.baseByRoot === undefined ? {} : { baseByRoot: plan.baseByRoot }),
    workIds: plan.workIds,
    gates: plan.gates.map((gate) => gate.name),
    nonce: randomUUID(),
  }).slice(0, 12)}`;
  await mkdir(join(directory, runId), { recursive: true });
  const results: GateRunResult[] = [];
  // TCRN-CROSS-STORY-537: the gates that have ended, handed to each gate after them.
  const prior: GatePriorResult[] = [];
  for (const [index, gate] of plan.gates.entries()) {
    const context = await reuseContext(plan, gate, { ...options, rootBindings: plan.rootBindings });
    const execute = () => resolveGateCheck(context, { runId, index, prior, timeoutMs, outputBytes }, options.admit);
    let result: GateRunResult;
    if (gate.reuse !== undefined) {
      const proofDirectory = gateReuseDirectory(context);
      await mkdir(proofDirectory, { recursive: true });
      result = await withFileLock(join(proofDirectory, "run.lock"), execute, { command: "einzbern gates-run" });
    } else {
      result = await execute();
    }
    results.push(result);
    const sourceRunId = result.outputFile.split("/")[0]!;
    prior.push({
      name: gate.name,
      root: gate.root,
      directory: context.cwd,
      command: result.verification?.command ?? gate.command,
      ok: result.ok,
      truncated: result.truncated,
      outputFile: join(directory, result.outputFile),
      ...(sourceRunId === runId ? {} : { sourceRunId }),
    });
  }
  const run: GateRun = {
    schemaVersion: GATE_RUN_SCHEMA_VERSION,
    runId,
    libraryId: options.libraryId,
    ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
    at: options.at,
    release: plan.release,
    ...(plan.evidenceOnly ? { evidenceOnly: true } : {}),
    base: plan.base,
    ...(plan.baseByRoot === undefined ? {} : { baseByRoot: plan.baseByRoot }),
    workIds: plan.workIds,
    treeDigest: tree.treeDigest,
    declarationsDigest: plan.declarationsDigest,
    trees: tree.trees,
    gates: results,
    reds: results.filter((result) => !result.ok).map((result) => result.name),
  };
  const recordDirectory = plan.evidenceOnly ? join(directory, "evidence-only") : directory;
  await mkdir(recordDirectory, { recursive: true });
  const recordPath = join(recordDirectory, `${runId}.json`);
  await writeFileAtomic(recordPath, canonicalJson(run));
  return { run, recordPath };
}

async function resolveGateCheck(
  context: GateReuseContext,
  settings: { readonly runId: string; readonly index: number; readonly prior: readonly GatePriorResult[]; readonly timeoutMs: number; readonly outputBytes: number },
  admit: RunGatesOptions["admit"],
): Promise<GateRunResult> {
  const { gate, directory, cwd } = context;
  const { runId, index, prior, timeoutMs, outputBytes } = settings;
  const identity = { name: gate.name, root: gate.root, required: gate.required, matched: gate.matched, matchedWorkIds: gate.matchedWorkIds };

  // An admission callback may supply values that affect a check, so inspect early only when it
  // cannot change the execution environment.
  if (admit === undefined) {
    const initial = await inspectGateReuse(context);
    if (initial.proof) {
      return {
        ...identity,
        ok: true,
        exitCode: 0,
        signal: null,
        timedOut: false,
        outputFile: initial.proof.outputFile,
        outputBytes: initial.proof.outputBytes,
        truncated: false,
        verification: {
          mode: "reused",
          reason: initial.reason,
          inputDigest: initial.proof.inputDigest,
          outputSha256: initial.proof.outputSha256,
          command: initial.proof.command ?? gate.command,
        },
      };
    }
  }

  const admitted = await admit?.();
  const fingerprintEnvironment = { ...context.environment, ...admitted?.env };
  const gateEnvironment = { ...fingerprintEnvironment, [GATE_RUN_PRIOR_VARIABLE]: canonicalJson({ runId, gates: prior }) };
  let memory: Awaited<ReturnType<typeof acquireMemoryChild>> | null = null;
  let raw: Awaited<ReturnType<typeof open>> | null = null;
  let decision: GateReuseInspection = { inputDigest: null, reason: "undeclared-inputs" };
  try {
    if (gate.command.includes("--test")) memory = await acquireMemoryChild("gate:node-test", gateEnvironment);
    const command = memoryGateCommand(gate.command, cwd, gateEnvironment);
    const runContext: GateReuseContext = { ...context, environment: fingerprintEnvironment, command };
    decision = await inspectGateReuse(runContext);
    if (decision.proof) {
      return {
        ...identity,
        ok: true,
        exitCode: 0,
        signal: null,
        timedOut: false,
        outputFile: decision.proof.outputFile,
        outputBytes: decision.proof.outputBytes,
        truncated: false,
        verification: {
          mode: "reused",
          reason: decision.reason,
          inputDigest: decision.proof.inputDigest,
          outputSha256: decision.proof.outputSha256,
          command: decision.proof.command ?? command,
        },
      };
    }

    const outputFile = `${runId}/${index + 1}-${gate.name.replace(/[^A-Za-z0-9._-]/gu, "_")}.log`;
    const outputPath = join(directory, ...outputFile.split("/"));
    const startedAt = new Date().toISOString();
    const started = performance.now();
    if (decision.inputDigest !== null) raw = await open(outputPath, "wx", 0o600);
    const outcome = await runGateProcess(command, cwd, timeoutMs, outputBytes, gateEnvironment, raw?.fd);
    if (raw && outcome.output.length > 0) await raw.writeFile(outcome.output);
    const durationMs = Math.max(0, Math.round(performance.now() - started));
    const finishedAt = new Date().toISOString();
    if (!raw) await writeFileAtomic(outputPath, outcome.output);
    const ok = outcome.exitCode === 0 && !outcome.timedOut;
    const actualBytes = raw ? (await lstat(outputPath)).size : outcome.output.length;
    const inputDigest = decision.inputDigest;
    const outputSha256 = inputDigest === null ? undefined : await gateFileSha256(outputPath);
    let recordedInput: string | null = null;
    let reason = decision.reason;
    if (inputDigest !== null && outputSha256 !== undefined) {
      const stable = inputDigest === await gateInputDigest(runContext);
      const artifactsDigest = ok && stable ? await gateArtifactsDigest(runContext) : null;
      await writeGateProof(runContext, {
        inputDigest,
        ok: ok && stable && artifactsDigest !== null,
        outputSha256,
        outputFile,
        outputBytes: actualBytes,
        artifactsDigest,
        command,
      });
      if (!stable) reason = "inputs-changed-during-run";
      else if (ok && artifactsDigest === null) reason = "output-artifact-not-recorded";
      else if (ok) recordedInput = inputDigest;
    }
    return {
      ...identity,
      ok,
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      timedOut: outcome.timedOut,
      outputFile,
      outputBytes: actualBytes,
      truncated: outcome.truncated,
      startedAt,
      finishedAt,
      durationMs,
      ...(gate.reuse === undefined ? {} : {
        verification: {
          mode: "executed" as const,
          reason,
          inputDigest: recordedInput,
          ...(outputSha256 === undefined ? {} : { outputSha256 }),
          command,
        },
      }),
    };
  } finally {
    memory?.release();
    admitted?.release?.();
    await raw?.close();
  }
}

/**
 * The latest run this device recorded for the library, by its instant, optionally only among
 * runs made on one tree under one set of declarations; null when there is none. A record that
 * does not read as a run is skipped. `workIds` keeps only runs made for exactly those target work
 * ids; `includesWorkIds` (TCRN-CROSS-STORY-525) only runs whose targets include each of them.
 * `accept` (TCRN-CROSS-STORY-530), given, is asked of the remaining runs from the latest back, and
 * the first it accepts is the answer: the done check reads the files each run recorded again
 * (TCRN-CROSS-STORY-534). A record with a root that names its paths without their content digests
 * (einzbern.gate-tree.v2) is skipped, as is any other that does not read as a run.
 */
export async function latestGateRun(input: {
  readonly libraryId: string;
  readonly projectId?: string;
  readonly deviceHome?: string;
  readonly treeDigest?: string;
  readonly declarationsDigest?: string;
  readonly workIds?: readonly string[];
  readonly includesWorkIds?: readonly string[];
  readonly accept?: (run: GateRun) => Promise<boolean>;
}): Promise<GateRun | null> {
  const directory = gateRunsDirectory(input.libraryId, input.deviceHome);
  let names: readonly string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw error;
  }
  const candidates: GateRun[] = [];
  for (const name of names.filter((entry) => entry.endsWith(".json")).sort(compareCanonicalText)) {
    let run: unknown;
    try {
      run = JSON.parse(await readFile(join(directory, name), "utf8"));
    } catch {
      continue;
    }
    if (!isGateRunRecord(run) || run.evidenceOnly || run.libraryId !== input.libraryId || run.projectId !== input.projectId) continue;
    if (input.treeDigest !== undefined && run.treeDigest !== input.treeDigest) continue;
    if (input.declarationsDigest !== undefined && run.declarationsDigest !== input.declarationsDigest) continue;
    if (input.workIds !== undefined) {
      const expected = [...new Set(input.workIds)].sort(compareCanonicalText);
      if (run.workIds.length !== expected.length || run.workIds.some((workId, index) => workId !== expected[index])) continue;
    }
    if (input.includesWorkIds !== undefined && !input.includesWorkIds.every((workId) => run.workIds.includes(workId))) continue;
    candidates.push(run);
  }
  candidates.sort(compareGateRuns);
  for (const candidate of candidates) {
    if (input.accept === undefined || await input.accept(candidate)) return candidate;
  }
  return null;
}
