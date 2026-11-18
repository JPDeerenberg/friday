/**
 * Persisted missions state plus the one function the rest of the app calls:
 * `recordQuestEvent("homework_done")` etc. Safe to call from anywhere, any number
 * of times — the rules (targets, caps, once-per-day) live in quests.ts.
 */
import { writable, get } from "svelte/store";
import {
  applyQuestEvent, emptyQuestState, rollState, sanitizeQuestState, type QuestDef, type QuestEvent, type QuestState,
} from "./quests.ts";

const KEY = "friday_quests_v1";

function load(): QuestState {
  const now = new Date();
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(KEY) : null;
    return rollState(sanitizeQuestState(raw ? JSON.parse(raw) : null, now), now);
  } catch {
    return emptyQuestState(now);
  }
}

export const quests = writable<QuestState>(load());

quests.subscribe((state) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // storage full or blocked: the in-memory state still works
  }
});

/** The mission(s) just completed, for the small "Missie voltooid" toast. */
export const questToast = writable<{ id: number; defs: QuestDef[]; awarded: number } | null>(null);
let toastId = 0;

export function recordQuestEvent(event: QuestEvent, amount = 1): void {
  const result = applyQuestEvent(get(quests), event, new Date(), amount);
  quests.set(result.state);
  if (result.completed.length > 0) {
    questToast.set({ id: ++toastId, defs: result.completed, awarded: result.awarded });
  }
}
