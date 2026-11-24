import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  dayKey,
  weekKey,
  questSeason,
  dailyQuests,
  weeklyQuests,
  emptyQuestState,
  rollState,
  applyQuestEvent,
  weekStreak,
  todaysRows,
  weekRows,
  sanitizeQuestState,
  homeworkKey,
  DAILY_XP_CAP,
  WEEKLY_XP_CAP,
  type QuestState,
} from "./quests.ts";

const MON = new Date(2026, 10, 9, 10); // Monday 9 Nov 2026
const at = (offsetDays: number, h = 10) =>
  new Date(2026, 10, 9 + offsetDays, h);

/** The first day in a window where the homework mission is on the board. */
function dayWithHomework(): Date {
  for (let i = 0; i < 120; i++) {
    if (dailyQuests(dayKey(at(i))).some((q) => q.id === "d-homework"))
      return at(i);
  }
  throw new Error("homework mission never rotates in");
}

describe("keys", () => {
  it("uses ISO weeks that start on Monday", () => {
    assert.equal(weekKey(new Date(2026, 10, 9)), "2026-W46");
    assert.equal(weekKey(new Date(2026, 10, 15)), "2026-W46");
    assert.equal(weekKey(new Date(2026, 10, 16)), "2026-W47");
    assert.equal(weekKey(new Date(2026, 0, 1)), "2026-W01");
    assert.equal(weekKey(new Date(2027, 0, 1)), "2026-W53");
  });
  it("formats days and school years", () => {
    assert.equal(dayKey(new Date(2026, 0, 5)), "2026-01-05");
    assert.equal(questSeason(new Date(2026, 7, 1)), "2026-2027");
    assert.equal(questSeason(new Date(2026, 6, 31)), "2025-2026");
  });
});

describe("which missions are active", () => {
  it("always has the check-in plus three different others, the same all day for everyone", () => {
    for (let i = 0; i < 40; i++) {
      const q = dailyQuests(dayKey(at(i)));
      assert.equal(q.length, 4);
      assert.equal(q[0].id, "d-open");
      assert.equal(new Set(q.slice(1).map((x) => x.id)).size, 3);
      assert.deepEqual(q, dailyQuests(dayKey(at(i))));
    }
  });
  it("varies over the days", () => {
    const sets = new Set(
      Array.from({ length: 30 }, (_, i) =>
        dailyQuests(dayKey(at(i)))
          .map((q) => q.id)
          .join(),
      ),
    );
    assert.ok(sets.size > 6);
  });
  it("has homework plus two different rotating missions each week", () => {
    const w = weeklyQuests("2026-W46");
    assert.equal(w[0].id, "w-homework");
    assert.equal(w.length, 3);
    assert.equal(new Set(w.slice(1).map((x) => x.id)).size, 2);
    assert.equal(
      w.slice(1).some((q) => q.id === "w-homework"),
      false,
    );
  });
});

describe("completing missions", () => {
  it("completes the check-in on the first app_open and awards its points once", () => {
    const r1 = applyQuestEvent(emptyQuestState(MON), "app_open", MON);
    assert.deepEqual(
      r1.completed.map((q) => q.id),
      ["d-open"],
    );
    assert.equal(r1.awarded, 3);
    assert.equal(r1.state.xp, 3);
    const r2 = applyQuestEvent(r1.state, "app_open", MON);
    assert.deepEqual(r2.completed, []);
    assert.equal(r2.state.xp, 3);
  });
  it("counts progress towards a target before completing", () => {
    const now = dayWithHomework();
    let r = applyQuestEvent(emptyQuestState(now), "homework_done", now);
    assert.equal(
      r.completed.some((q) => q.id === "d-homework"),
      false,
    );
    assert.equal(r.state.dailyProgress["d-homework"], 1);
    r = applyQuestEvent(r.state, "homework_done", now);
    assert.equal(
      r.completed.some((q) => q.id === "d-homework"),
      true,
    );
    assert.equal(r.state.dailyDone.includes("d-homework"), true);
  });
  it("never counts the same lesson twice, even across days", () => {
    const now = dayWithHomework();
    const first = applyQuestEvent(
      emptyQuestState(now),
      "homework_done",
      now,
      1,
      homeworkKey(4242),
    );
    assert.equal(first.state.dailyProgress["d-homework"], 1);
    const duplicate = applyQuestEvent(
      first.state,
      "homework_done",
      now,
      1,
      homeworkKey(4242),
    );
    assert.equal(duplicate.state.dailyProgress["d-homework"], 1);
    assert.deepEqual(duplicate.completed, []);
    const other = applyQuestEvent(
      duplicate.state,
      "homework_done",
      now,
      1,
      homeworkKey(9999),
    );
    assert.equal(other.state.dailyProgress["d-homework"], 2);
  });
  it("remembers dedupe keys even when no mission is active", () => {
    const r = applyQuestEvent(
      emptyQuestState(MON),
      "blackjack_played",
      MON,
      1,
      "blackjack:hand-1",
    );
    assert.equal(r.state.seen["blackjack:hand-1"], dayKey(MON));
    const again = applyQuestEvent(
      r.state,
      "blackjack_played",
      MON,
      1,
      "blackjack:hand-1",
    );
    assert.equal(again.completed.length, 0);
  });
  it("ignores events that no active mission cares about", () => {
    const r = applyQuestEvent(emptyQuestState(MON), "translated", MON);
    const rotations = weeklyQuests(weekKey(MON)).slice(1);
    assert.equal(
      r.completed.length,
      rotations.some((q) => q.event === "translated") ? 1 : 0,
    );
  });
  it("never awards more than the daily or weekly cap", () => {
    let s = emptyQuestState(MON);
    let total = 0;
    for (const ev of [
      "app_open",
      "agenda_checked",
      "homework_done",
      "simulator_used",
      "pack_opened",
    ] as const) {
      for (let i = 0; i < 3; i++) {
        const r = applyQuestEvent(s, ev, MON);
        s = r.state;
        total += r.awarded;
      }
    }
    assert.ok(s.dayXp <= DAILY_XP_CAP);
    assert.ok(total <= DAILY_XP_CAP + WEEKLY_XP_CAP);
    assert.equal(s.xp, total);
  });
  it("caps a full week and a full day at the same limits for everyone", () => {
    let s = emptyQuestState(at(0));
    for (let d = 0; d < 7; d++) {
      const now = at(d);
      for (const ev of [
        "app_open",
        "agenda_checked",
        "homework_done",
        "simulator_used",
        "pack_opened",
        "friend_shared",
        "friend_added",
        "wrapped_viewed",
        "translated",
      ] as const) {
        for (let i = 0; i < 10; i++) s = applyQuestEvent(s, ev, now).state;
      }
    }
    assert.ok(s.xp <= 7 * DAILY_XP_CAP + WEEKLY_XP_CAP, `xp ${s.xp}`);
    assert.ok(s.weekXp <= WEEKLY_XP_CAP);
  });
});

describe("rolling over", () => {
  it("resets the day's progress tomorrow but keeps the points", () => {
    const r = applyQuestEvent(emptyQuestState(MON), "app_open", MON);
    const tomorrow = rollState(r.state, at(1));
    assert.deepEqual(tomorrow.dailyDone, []);
    assert.equal(tomorrow.dayXp, 0);
    assert.equal(tomorrow.xp, 3);
  });
  it("starts a new season in August and keeps the dedupe log", () => {
    const june = new Date(2027, 5, 15, 10);
    const s = applyQuestEvent(
      emptyQuestState(june),
      "app_open",
      june,
      1,
      "keep-me",
    ).state;
    assert.equal(s.xp, 3);
    const august = rollState(s, new Date(2027, 7, 20, 10));
    assert.equal(august.season, "2027-2028");
    assert.equal(august.xp, 0);
    assert.deepEqual(august.activeWeeks, []);
    assert.equal(august.seen["keep-me"], dayKey(june));
  });
});

describe("week streak", () => {
  const withWeeks = (weeks: string[]): QuestState => ({
    ...emptyQuestState(MON),
    activeWeeks: weeks,
  });
  it("counts consecutive active weeks", () => {
    assert.equal(
      weekStreak(withWeeks(["2026-W44", "2026-W45", "2026-W46"]), MON),
      3,
    );
  });
  it("survives a quiet current week (counts back from last week)", () => {
    assert.equal(weekStreak(withWeeks(["2026-W44", "2026-W45"]), MON), 2);
  });
  it("starts again silently after a gap", () => {
    assert.equal(weekStreak(withWeeks(["2026-W40", "2026-W41"]), MON), 0);
    assert.equal(
      weekStreak(withWeeks(["2026-W41", "2026-W45", "2026-W46"]), MON),
      2,
    );
  });
  it("is recorded when a daily mission is completed", () => {
    const s = applyQuestEvent(emptyQuestState(MON), "app_open", MON).state;
    assert.deepEqual(s.activeWeeks, ["2026-W46"]);
    assert.equal(weekStreak(s, MON), 1);
  });
});

describe("display rows and storage", () => {
  it("shows progress for today's and this week's missions", () => {
    const s = applyQuestEvent(emptyQuestState(MON), "app_open", MON).state;
    const rows = todaysRows(s, MON);
    assert.equal(rows.length, 4);
    assert.deepEqual(
      [rows[0].def.id, rows[0].done, rows[0].progress],
      ["d-open", true, 1],
    );
    assert.equal(rows[1].done, false);
    assert.equal(weekRows(s, MON).length, 3);
  });
  it("rolls the display over to today without changing stored points", () => {
    const s = applyQuestEvent(emptyQuestState(MON), "app_open", MON).state;
    assert.equal(todaysRows(s, at(1))[0].done, false);
  });
  it("reads stored state defensively", () => {
    assert.deepEqual(sanitizeQuestState(null, MON), emptyQuestState(MON));
    const s = sanitizeQuestState(
      {
        xp: -5,
        dailyProgress: { a: 2, b: "x" },
        dailyDone: ["a", 5],
        activeWeeks: "no",
        seen: { ok: "2026-11-09", bad: "yesterday" },
        cardXpCredited: 12,
      },
      MON,
    );
    assert.equal(s.xp, 0);
    assert.deepEqual(s.dailyProgress, { a: 2 });
    assert.deepEqual(s.dailyDone, ["a"]);
    assert.deepEqual(s.activeWeeks, []);
    assert.deepEqual(s.seen, { ok: "2026-11-09" });
    assert.equal(s.cardXpCredited, 12);
  });
});
