// SPDX-License-Identifier: Apache-2.0
import { hostCount, hostObject, hostText } from "./host-capabilities.js";

function strings(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) throw new Error(name + " must be a list");
  for (const entry of value) hostText(entry, name);
  return value as string[];
}

function writeSet(value: unknown): string[] {
  const paths = strings(value, "write set");
  for (const path of paths) {
    if (path.includes("\\") || path.split("/").some(part => !part || part === "." || part === "..")) throw new Error("use canonical repository-qualified write paths");
  }
  return paths;
}

const conflicts = (a: string[], b: string[]) => a.some(x => b.some(y => x === y || x.startsWith(y + "/") || y.startsWith(x + "/")));

/** Select a maximum set of compatible authorized packages, preserving queue order for ties. */
export function planImplementationBatch(value: unknown): { selected: string[]; waiting: Record<string, string>; nextAction?: "reconcile-authorized-initiatives" } {
  const input = hostObject(value, "batch plan", ["freeSlots", "availableCandidates", "occupiedWrites", "packages"]);
  const free = input.freeSlots;
  hostCount(free, "observed available slots");
  const available = new Set(strings(input.availableCandidates, "available candidate references"));
  const occupied = writeSet(input.occupiedWrites);
  if (!Array.isArray(input.packages)) throw new Error("packages must be a list");
  const wait: Record<string, string> = Object.create(null);
  const eligible: { id: string; writes: string[] }[] = [];
  const ids = new Set<string>();
  for (const raw of input.packages) {
    const p = hostObject(raw, "package", ["id", "authorized", "requires", "writes"]);
    hostText(p.id, "package id");
    if (ids.has(p.id) || typeof p.authorized !== "boolean") throw new Error("packages require unique ids and explicit authorization state");
    ids.add(p.id);
    const writes = writeSet(p.writes);
    const missing = strings(p.requires, "required candidate references").filter(ref => !available.has(ref));
    if (!p.authorized) wait[p.id] = "authorization";
    else if (missing.length) wait[p.id] = "missing input: " + missing.join(", ");
    else if (conflicts(writes, occupied)) wait[p.id] = "active write conflict";
    else eligible.push({ id: p.id, writes });
  }
  let best: typeof eligible = [];
  const selected: typeof eligible = [];
  function choose(start: number): void {
    if (selected.length > best.length) best = [...selected];
    for (let i = start; i < eligible.length; i++) {
      if (best.length === free || selected.length + eligible.length - i <= best.length) return;
      const current = eligible[i]!;
      if (selected.some(other => conflicts(current.writes, other.writes))) continue;
      selected.push(current);
      choose(i + 1);
      selected.pop();
    }
  }
  choose(0);
  const chosen = new Set(best.map(p => p.id));
  for (const p of eligible) {
    if (!chosen.has(p.id)) wait[p.id] = best.some(other => conflicts(p.writes, other.writes)) ? "selected write conflict" : "capacity";
  }
  if (!chosen.size) return { selected: [], waiting: wait, nextAction: "reconcile-authorized-initiatives" };
  return { selected: [...chosen], waiting: wait };
}
