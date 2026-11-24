import { stableHash } from "./sync-codec.ts";
import type { SyncEntry } from "./sync-types.ts";

export function entryNewer(a: SyncEntry, b: SyncEntry | undefined): boolean {
  if (!b) return true;
  if (a.rev !== b.rev) return a.rev > b.rev;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt;
  return a.device > b.device;
}

export function mergeEntries(
  local: SyncEntry[],
  remote: SyncEntry[],
): { merged: SyncEntry[]; fromRemote: SyncEntry[]; conflicts: number } {
  const map = new Map<string, SyncEntry>();
  for (const entry of local) map.set(entry.key, entry);
  let conflicts = 0;
  const fromRemote: SyncEntry[] = [];
  for (const entry of remote) {
    const current = map.get(entry.key);
    if (!current) {
      map.set(entry.key, entry);
      fromRemote.push(entry);
      continue;
    }
    if (entryNewer(entry, current)) {
      map.set(entry.key, entry);
      fromRemote.push(entry);
      if (current.rev > 0 && entry.rev > 0) conflicts += 1;
    }
  }
  return { merged: [...map.values()], fromRemote, conflicts };
}

export function comparableEntry(entry: SyncEntry): string {
  // `device` is only a tie-breaker for genuinely different writes; the local
  // collector re-stamps unchanged remote entries with its own device id.
  return stableHash({
    key: entry.key,
    category: entry.category,
    rev: entry.rev,
    updatedAt: entry.updatedAt,
    deleted: entry.deleted ?? false,
    value: entry.value,
  });
}

export function entriesEqual(a: SyncEntry[], b: SyncEntry[]): boolean {
  if (a.length !== b.length) return false;
  const remote = new Map(b.map((entry) => [entry.key, comparableEntry(entry)]));
  return a.every((entry) => remote.get(entry.key) === comparableEntry(entry));
}
