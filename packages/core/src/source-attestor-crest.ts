// SPDX-License-Identifier: Apache-2.0
import { createHash, randomBytes } from "node:crypto";
import { fstatSync, lstatSync, readdirSync, readSync, statfsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { CREST_PROOF_SCHEMA, attestorDigest, attestorMountContext, attestorMountSnapshot } from "./source-attestor-protocol.js";
import type { CrestAttestorRequest } from "./source-attestor-protocol.js";
import type { SourceLeaseBridge } from "./source-attestor-service.js";

interface CrestBridge extends SourceLeaseBridge {
  acquireCrest(path: string, guard: object): ReturnType<SourceLeaseBridge["acquire"]>;
  guardAdd(guard: object, path: string, names: readonly string[] | null): string;
  guardHold(guard: object, id: number): void;
  guardedCheck(guard: object, ids: readonly number[], generation: number): boolean;
  peer(fd: number): { pid: number; uid: number };
}
interface CompleteSet {
  readonly guard: object;
  readonly ids: readonly number[];
  readonly incarnations: readonly number[];
  readonly generation: number;
  readonly fingerprint: string;
  readonly sourceSet: string;
  readonly context: string;
  readonly directories: number;
  validated: boolean;
}
interface Adoption {
  readonly set: CompleteSet;
  readonly token: string;
  readonly started: number;
  readonly peer: number;
}
interface Preparation {
  readonly client: object;
  readonly request: CrestAttestorRequest;
  readonly iterator: Generator<number, CompleteSet | null>;
  readonly reads: { path: string; bytes: number }[];
  readonly token: string;
  readonly started: number;
  readonly peer: number;
  progress: number;
}

/** One Crest root collection in its own disposable helper. Akasha leases never
 * enter this object. The parser/replay and protected projection remain clients'
 * authority; this object proves only the continuous, complete source byte set. */
export class CrestSourceSet {
  private readonly bridge: CrestBridge;
  private set: CompleteSet | null = null;
  private preparation: Preparation | null = null;
  private readonly transactions = new Map<object, Adoption>();
  private hashes = 0;
  private hashedBytes = 0;

  constructor(bridge: SourceLeaseBridge, private readonly root: string, private readonly roots: readonly string[]) {
    if (![bridge.acquireCrest, bridge.guardAdd, bridge.guardedCheck, bridge.peer].every(api => typeof api === "function")) throw new Error("crest-native-api-unavailable");
    this.bridge = bridge as CrestBridge;
    if (resolve(root) !== root || roots.length === 0 || roots.length > 8192 || new Set(roots).size !== roots.length
      || roots.some(path => resolve(path) !== path || !this.inside(path))) throw new Error("crest-root-binding");
  }

  private inside(path: string): boolean {
    const part = relative(this.root, path);
    return part !== "" && !isAbsolute(part) && part !== ".." && !part.startsWith("../");
  }

  private context(peer: number, expected: string): boolean {
    return attestorMountContext() === expected && attestorMountContext(peer) === expected;
  }

  private clean(set: CompleteSet, peer: number): boolean {
    try {
      return this.context(peer, set.context)
        && this.bridge.guardedCheck(set.guard, set.ids, set.generation)
        && this.context(peer, set.context)
        && this.bridge.guardCheck(set.guard) && this.bridge.status().generation === set.generation;
    } catch { return false; }
  }

  private drop(): void {
    this.preparation?.iterator.return(null);
    this.preparation = null;
    if (this.set !== null) {
      this.bridge.guardClose(this.set.guard);
      for (const id of this.set.ids) this.bridge.release(id);
      this.set = null;
    }
    this.transactions.clear();
  }

  close(client: object): void {
    // A normal one-shot finish removes the transaction first. An interrupted
    // adoption cannot retain authority across the resulting client gap.
    if (this.transactions.has(client) || this.preparation?.client === client) this.drop();
  }

  stop(): void { this.drop(); }

  expire(): void {
    if (this.preparation !== null && performance.now() - this.preparation.started >= 5000) this.drop();
    for (const adoption of this.transactions.values()) if (performance.now() - adoption.started >= 5000) { this.drop(); break; }
  }

  resources(): object {
    return { hashes: this.hashes, hashedBytes: this.hashedBytes, members: this.set?.ids.length ?? 0,
      directories: this.set?.directories ?? 0, validated: this.set?.validated ?? false, preparing: this.preparation !== null, transactions: this.transactions.size };
  }

  begin(client: object, request: CrestAttestorRequest, peer: number, warmOnly = false): unknown {
    const reads: { path: string; bytes: number }[] = [];
    try {
      if (request?.schema !== CREST_PROOF_SCHEMA || request.domain !== "crest" || request.root !== this.root
        || attestorDigest(request.roots) !== attestorDigest(this.roots) || !/^[a-f0-9]{64}$/u.test(request.binding)
        || !/^[a-f0-9]{64}$/u.test(request.context) || !this.context(peer, request.context)) throw new Error("crest-request-binding");
      if (this.transactions.has(client)) throw new Error("crest-adoption-order");
      if (this.preparation !== null) return { valid: false, reads, reason: "crest-preparation-busy", resources: this.resources() };
      const started = performance.now();
      const fingerprint = attestorDigest(request);
      const warm = this.set !== null;
      if (!warm && warmOnly) throw new Error("crest-source-set-cold");
      if (this.set !== null && (!this.set.validated || this.set.fingerprint !== fingerprint || !this.clean(this.set, peer))) {
        this.drop();
        // This request takes the complete reader. A later request may perform
        // a new bootstrap; never clear a dirty guard and reuse its old leases.
        throw new Error("crest-source-set-invalidated");
      }
      const token = randomBytes(32).toString("hex");
      if (this.set === null) {
        this.preparation = { client, request, iterator: this.bootstrap(request, reads), reads, token, started, peer, progress: 0 };
        return this.next(client, { token, fingerprint, context: request.context, progress: 0 });
      }
      return this.adopt(client, this.set, token, started, peer, warm, reads);
    } catch (error) {
      this.drop();
      return { valid: false, reads, reason: error instanceof Error ? error.message : "crest-begin-failed", resources: this.resources() };
    }
  }

  /** Cold collection advances by the reader's existing 16-member quantum.
   * Each authenticated IPC exchange keeps its 1500ms deadline; all steps AND
   * the final parser/adoption still share the original five-second transaction.
   * These are bounded preparation steps, never retries of a failed adoption. */
  next(client: object, message: { token?: string; fingerprint?: string; context?: string; progress?: number }): unknown {
    const prep = this.preparation;
    const reads = prep?.reads ?? [];
    try {
      if (prep === null || prep.client !== client || message.token !== prep.token || message.fingerprint !== attestorDigest(prep.request)
        || message.context !== prep.request.context || message.progress !== prep.progress || performance.now() - prep.started >= 5000) throw new Error("crest-preparation-binding");
      const step = prep.iterator.next();
      if (!step.done) {
        prep.progress = step.value;
        return { valid: true, pending: true, token: prep.token, fingerprint: message.fingerprint, progress: prep.progress, reads: [], resources: this.resources() };
      }
      this.preparation = null;
      if (step.value === null) throw new Error("crest-preparation-cancelled");
      this.set = step.value;
      return this.adopt(client, this.set, prep.token, prep.started, prep.peer, false, reads);
    } catch (error) {
      this.drop();
      return { valid: false, reads, reason: error instanceof Error ? error.message : "crest-preparation-failed", resources: this.resources() };
    }
  }

  private adopt(client: object, set: CompleteSet, token: string, started: number, peer: number, warm: boolean, reads: readonly { path: string; bytes: number }[]): unknown {
    if (!this.clean(set, peer) || performance.now() - started >= 5000) throw new Error("crest-begin-changed");
    this.transactions.set(client, { set, token, started, peer });
    return { valid: true, token, fingerprint: set.fingerprint, generation: set.generation, incarnations: set.incarnations,
      sourceSet: set.sourceSet, context: set.context, warm, reads, resources: this.resources() };
  }

  finish(client: object, message: { token?: string; fingerprint?: string; context?: string }): unknown {
    const adoption = this.transactions.get(client);
    this.transactions.delete(client);
    if (adoption === undefined) throw new Error("crest-transaction-missing");
    const set = adoption.set;
    const valid = this.set === set && message.token === adoption.token && message.fingerprint === set.fingerprint
      && message.context === set.context && performance.now() - adoption.started < 5000 && this.clean(set, adoption.peer);
    if (valid) set.validated = true;
    else this.drop();
    return { valid, token: adoption.token, fingerprint: set.fingerprint, generation: set.generation,
      incarnations: set.incarnations, sourceSet: set.sourceSet, context: set.context, resources: this.resources() };
  }

  private *bootstrap(request: CrestAttestorRequest, reads: { path: string; bytes: number }[]): Generator<number, CompleteSet | null> {
    const snapshot = attestorMountSnapshot();
    if (snapshot.identity !== request.context) throw new Error("crest-bootstrap-mount-context");
    const mounts = snapshot.mountinfo.trimEnd().split("\n").map(line => {
      const fields = line.split(" ");
      const point = fields[4]?.replace(/\\([0-7]{3})/gu, (_match, octal: string) => String.fromCharCode(parseInt(octal, 8)));
      if (!/^\d+$/u.test(fields[0] ?? "") || point === undefined || !isAbsolute(point)) throw new Error("crest-mount-table");
      return { id: fields[0]!, point };
    }).sort((left, right) => right.point.length - left.point.length);
    const expectedMount = (path: string): string => {
      const candidates = mounts.filter(mount => path === mount.point || path.startsWith(mount.point === "/" ? "/" : mount.point + "/"));
      const first = candidates[0];
      if (first === undefined || candidates[1]?.point.length === first.point.length) throw new Error("crest-ambiguous-mount");
      return first.id;
    };
    const guard = this.bridge.watch([]);
    const ids: number[] = [], incarnations: number[] = [];
    const members: unknown[] = [];
    const visited = new Set<string>();
    let directories = 0;
    let complete = false;
    const owner = this;
    const buffer = Buffer.allocUnsafe(64 * 1024);
    try {
      // Guard each existing parent/name BEFORE testing the next component.
      // An absent root remains covered by its existing parent, across clients.
      const rootExists = (root: string): boolean => {
        let parent = "/";
        for (const name of root.slice(1).split("/")) {
          if (this.bridge.guardAdd(guard, parent, [name]) !== expectedMount(parent)) throw new Error("crest-ancestor-mount");
          parent = join(parent, name);
          try {
            const info = lstatSync(parent);
            if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("crest-ancestor-type");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            if (statfsSync(dirname(parent)).type !== 0xef53) throw new Error("crest-absent-filesystem");
            members.push([root, "absent", parent]);
            return false;
          }
        }
        return true;
      };
      const visit = function*(path: string): Generator<number, void> {
        if (visited.has(path)) return;
        visited.add(path);
        const info = lstatSync(path, { bigint: true });
        if (info.isDirectory()) {
          if (owner.bridge.guardAdd(guard, path, null) !== expectedMount(path)) throw new Error("crest-directory-mount");
          if (statfsSync(path).type !== 0xef53) throw new Error("crest-directory-filesystem");
          const names = readdirSync(path).sort();
          directories++;
          members.push([path, "directory", names]);
          if (visited.size % 16 === 0) yield visited.size;
          for (const name of names) yield* visit(join(path, name));
          return;
        }
        if (!info.isFile() || info.nlink !== 1n || info.uid !== BigInt(process.getuid!())) throw new Error("crest-member-type");
        const lease = owner.bridge.acquireCrest(path, guard);
        ids.push(lease.id); incarnations.push(lease.incarnation);
        if (lease.mountId !== expectedMount(path)) throw new Error("crest-member-mount");
        const held = fstatSync(lease.fd, { bigint: true });
        const hash = createHash("sha256");
        let offset = 0;
        for (;;) {
          const count = readSync(lease.fd, buffer, 0, buffer.length, offset);
          if (count === 0) break;
          hash.update(buffer.subarray(0, count)); offset += count;
          if (BigInt(offset) > held.size) throw new Error("crest-member-length");
        }
        owner.hashes++; owner.hashedBytes += offset; reads.push({ path, bytes: offset });
        if (BigInt(offset) !== held.size) throw new Error("crest-initial-sha256");
        members.push([path, "file", lease.mountId, held.dev.toString(), held.ino.toString(), held.size.toString(), hash.digest("hex")]);
        if (visited.size % 16 === 0) yield visited.size;
      };
      for (const root of this.roots) if (rootExists(root)) yield* visit(root);
      const generation = this.bridge.status().generation;
      if (!this.bridge.guardedCheck(guard, ids, generation)) throw new Error("crest-bootstrap-changed");
      complete = true;
      return { guard, ids, incarnations, generation, fingerprint: attestorDigest(request),
        sourceSet: attestorDigest(members), context: request.context, directories, validated: false };
    } finally {
      if (!complete) {
        this.bridge.guardClose(guard);
        for (const id of ids) this.bridge.release(id);
      }
    }
  }
}
