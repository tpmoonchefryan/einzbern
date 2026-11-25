// SPDX-License-Identifier: Apache-2.0

import { constants, createReadStream } from "node:fs";
import { access, lstat, readFile, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { release } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import { canonicalJson, canonicalSha256 } from "../../protocol/src/index.js";
import { writeFileAtomic } from "./atomic-file.js";
import { compileGlob, gateBaseCommit, gateGitHistory, gateSourcePaths } from "./gates-plan.js";
import type { PlannedGate } from "./gates-plan.js";

const proofSchema = "einzbern.gate-proof.v1";
const digestShape = /^[a-f0-9]{64}$/u;
export const gateRunIdShape = /^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$/u;
const gateLogShape = /^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}\/[0-9]+-[A-Za-z0-9._-]+\.log$/u;
const runtimeVariables = ["PATH", "PATHEXT", "NODE_OPTIONS", "LANG", "LC_ALL", "TZ"] as const;

export interface GateProof {
  readonly schemaVersion: typeof proofSchema;
  readonly inputDigest: string;
  readonly ok: boolean;
  readonly outputFile: string;
  readonly outputSha256: string;
  readonly outputBytes: number;
  readonly artifactsDigest: string | null;
  readonly command?: readonly string[];
}

export interface GateReuseContext {
  readonly gate: PlannedGate;
  // The argv after any supported gate-run adapter has selected its actual invocation.
  readonly command?: readonly string[];
  readonly directory: string;
  readonly cwd: string;
  readonly base: string | null;
  readonly release: boolean;
  readonly projectId?: string | undefined;
  readonly environment: NodeJS.ProcessEnv;
}

export interface GateReuseInspection {
  readonly inputDigest: string | null;
  readonly reason: string;
  readonly proof?: GateProof;
}

export async function gateFileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function inside(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return !isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(".." + sep);
}

async function fileState(root: string, name: string): Promise<readonly [string, string | null, number | null]> {
  const candidate = resolve(root, name);
  if (!inside(root, candidate) || candidate === root) throw new Error("invalid gate input path");
  let attribute;
  try {
    attribute = await lstat(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return [name, null, null];
  }
  const actual = await realpath(candidate);
  if (!attribute.isFile() || actual !== candidate) throw new Error("gate input must be a regular file under its root");
  return [name, await gateFileSha256(actual), attribute.mode & 0o111];
}

async function toolIdentity(command: string, cwd: string, environment: NodeJS.ProcessEnv): Promise<readonly [string, string]> {
  const direct = isAbsolute(command) || command.includes("/") || command.includes("\\");
  const paths = direct ? [resolve(cwd, command)] : (environment.PATH ?? "").split(delimiter).map(root => resolve(cwd, root, command));
  const extensions = process.platform === "win32" && !/\.[A-Za-z0-9]+$/u.test(command)
    ? (environment.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const path of paths) {
    for (const extension of extensions) {
      const candidate = path + extension;
      try {
        await access(candidate, constants.X_OK);
        if (!(await stat(candidate)).isFile()) continue;
        return [command, await gateFileSha256(await realpath(candidate))];
      } catch (error) {
        if (!["ENOENT", "ENOTDIR", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      }
    }
  }
  throw new Error("gate executable could not be identified");
}

export function gateReuseDirectory(context: GateReuseContext): string {
  const { gate, projectId } = context;
  return join(context.directory, "proofs", canonicalSha256({ projectId: projectId ?? null, gate: gate.name, root: gate.root }));
}

export async function gateInputDigest(context: GateReuseContext): Promise<string | null> {
  const { gate, cwd, environment } = context;
  if (!gate.reuse) return null;
  const declaration = gate.reuse;
  const command = context.command ?? gate.command;
  const inventory = gateSourcePaths(cwd);
  const base = context.base === null ? null : gateBaseCommit(cwd, context.base);
  const history = declaration.gitHistory ? gateGitHistory(cwd) : undefined;
  if (!inventory || (context.base !== null && base === null) || history === null) return null;
  const globs = declaration.source.map(compileGlob);
  const source = inventory.filter(path => globs.some(glob => glob.test(path)));
  if (source.length === 0) return null;
  try {
    const files = [];
    for (const path of [...new Set([...source, ...(declaration.files ?? [])])].sort()) files.push(await fileState(cwd, path));
    const tools = [];
    for (const tool of [...new Set([command[0]!, ...(declaration.tools ?? [])])]) tools.push(await toolIdentity(tool, cwd, environment));
    const env = [...new Set([...runtimeVariables, ...(declaration.environment ?? [])])].sort().map(name => [name, environment[name] ?? null]);
    return canonicalSha256({
      schemaVersion: proofSchema, command, declaration, base,
      cwd: declaration.portable ? null : cwd, ...(history === undefined ? {} : { history }), files, tools, env,
      platform: process.platform, arch: process.arch, osRelease: release(), runtime: process.versions,
    });
  } catch {
    return null;
  }
}

export async function gateArtifactsDigest(context: GateReuseContext): Promise<string | null> {
  try {
    const states = [];
    for (const path of context.gate.reuse?.outputs ?? []) {
      const state = await fileState(context.cwd, path);
      if (state[1] === null) return null;
      states.push(state);
    }
    return canonicalSha256(states);
  } catch {
    return null;
  }
}

function proofPath(context: GateReuseContext, inputDigest: string): string {
  return join(gateReuseDirectory(context), inputDigest + ".json");
}

export async function inspectGateReuse(context: GateReuseContext): Promise<GateReuseInspection> {
  if (!context.gate.reuse) return { inputDigest: null, reason: "undeclared-inputs" };
  const inputDigest = await gateInputDigest(context);
  if (context.release) return { inputDigest, reason: "release" };
  if (inputDigest === null) return { inputDigest, reason: "input-unavailable" };
  try {
    const existing = JSON.parse(await readFile(proofPath(context, inputDigest), "utf8")) as GateProof;
    if (existing.schemaVersion !== proofSchema || existing.inputDigest !== inputDigest ||
      !gateLogShape.test(existing.outputFile) || !digestShape.test(existing.outputSha256) ||
      !Number.isSafeInteger(existing.outputBytes) || existing.outputBytes < 0 ||
      (existing.command !== undefined && (!Array.isArray(existing.command) || existing.command.length === 0 || existing.command.some((part) => typeof part !== "string" || part.length === 0))) ||
      (existing.command !== undefined && canonicalJson(existing.command) !== canonicalJson(context.command ?? context.gate.command))) {
      return { inputDigest, reason: "invalid-receipt" };
    }
    if (existing.ok !== true) return { inputDigest, reason: "last-run-did-not-pass" };
    if (existing.artifactsDigest === null || existing.artifactsDigest !== await gateArtifactsDigest(context)) {
      return { inputDigest, reason: "output-artifact-missing-or-changed" };
    }
    const file = join(context.directory, existing.outputFile);
    const info = await lstat(file);
    if (!info.isFile() || info.size !== existing.outputBytes || await gateFileSha256(file) !== existing.outputSha256) {
      return { inputDigest, reason: "raw-evidence-missing-or-changed" };
    }
    return { inputDigest, reason: "matching-evidence", proof: existing };
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    return { inputDigest, reason: missing ? "no-matching-evidence" : "unreadable-evidence" };
  }
}

export async function writeGateProof(context: GateReuseContext, outcome: Omit<GateProof, "schemaVersion">): Promise<void> {
  await writeFileAtomic(proofPath(context, outcome.inputDigest), canonicalJson({ schemaVersion: proofSchema, ...outcome }));
}
