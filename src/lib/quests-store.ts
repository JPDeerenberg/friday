/**
 * Persisted mission/XP state plus the small API the rest of the app calls:
 * `recordQuestEvent("homework_done", 1, homeworkKey(id))`,
 * `awardXp(card.xp)`, `spendXp(wager)` and `seedCardXpOnce(...)`.
 *
 * All mutations roll the state to today first. Dedupe keys are written even
 * when no mission is active, so repeated actions can never inflate progress.
 */
import { writable, get } from "svelte/store";
import {
  applyQuestEvent,
  dayEventKey,
  dayKey,
  emptyQuestState,
  rollState,
  sanitizeQuestState,
  type QuestDef,
  type QuestEvent,
  type QuestState,
} from "./quests.ts";

const KEY = "friday_quests_v1";

/** Events that should count at most once per calendar day. */
const DAY_EVENTS: ReadonlySet<QuestEvent> = new Set([
  "app_open",
  "agenda_checked",
  "grades_checked",
  "messages_checked",
  "plan_checked",
  "assignments_checked",
]);

function load(): QuestState {
  const now = new Date();
  try {
    const raw =
      typeof localStorage !== "undefined" ? localStorage.getItem(KEY) : null;
    return rollState(
      sanitizeQuestState(raw ? JSON.parse(raw) : null, now),
      now,
    );
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
export const questToast = writable<{
  id: number;
  defs: QuestDef[];
  awarded: number;
} | null>(null);
let toastId = 0;

export function recordQuestEvent(
  event: QuestEvent,
  amount = 1,
  key?: string,
): void {
  const now = new Date();
  const dedupeKey =
    key ?? (DAY_EVENTS.has(event) ? dayEventKey(event, now) : undefined);
  const result = applyQuestEvent(get(quests), event, now, amount, dedupeKey);
  quests.set(result.state);
  if (result.completed.length > 0) {
    questToast.set({
      id: ++toastId,
      defs: result.completed,
      awarded: result.awarded,
    });
  }
}

/** Add XP outside the mission caps: opened cards and Blackjack payouts. */
export function awardXp(amount: number): void {
  const gain = Math.max(0, Math.floor(amount));
  if (gain <= 0) return;
  const now = new Date();
  quests.update((state) => {
    const rolled = rollState(state, now);
    return { ...rolled, xp: rolled.xp + gain };
  });
}

/** Try to spend XP. Returns false when the balance is not enough. */
export function spendXp(amount: number): boolean {
  const stake = Math.max(0, Math.floor(amount));
  if (stake <= 0) return false;
  let ok = false;
  const now = new Date();
  quests.update((state) => {
    const rolled = rollState(state, now);
    if (rolled.xp < stake) return rolled;
    ok = true;
    return { ...rolled, xp: rolled.xp - stake };
  });
  return ok;
}

/**
 * Credit a grade card exactly once. The dedupe key survives collection resets
 * and syncs, so re-opening an old card cannot be used to farm XP.
 */
export function creditCardXpOnce(
  cardId: number | string,
  amount: number,
): void {
  const gain = Math.max(0, Math.floor(amount));
  if (gain <= 0) return;
  const now = new Date();
  const key = `cardxp:${cardId}`;
  quests.update((state) => {
    const rolled = rollState(state, now);
    if (rolled.seen[key]) return rolled;
    return {
      ...rolled,
      xp: rolled.xp + gain,
      cardXpCredited: rolled.cardXpCredited + gain,
      seen: { ...rolled.seen, [key]: dayKey(now) },
    };
  });
}

/**
 * One-time migration: fold XP from cards that were opened before the unified
 * wallet existed into `xp`. A card opened before this runs is already in
 * `cardXpCredited`, so it is not counted twice.
 */
export function seedCardXpOnce(currentSeasonXp: number): void {
  const points = Math.max(0, Math.floor(currentSeasonXp));
  const now = new Date();
  quests.update((state) => {
    const rolled = rollState(state, now);
    if (rolled.cardXpSeeded) return rolled;
    const missing = Math.max(0, points - rolled.cardXpCredited);
    return {
      ...rolled,
      xp: rolled.xp + missing,
      cardXpCredited: Math.max(rolled.cardXpCredited, points),
      cardXpSeeded: true,
    };
  });
}
