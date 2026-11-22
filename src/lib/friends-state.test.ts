import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  adoptSnapshot,
  emptyState,
  importFriend,
  removeFriend,
  setEnabled,
  renameFriend,
  setMyName,
  markShared,
  changeNotice,
  describeNotice,
  freshness,
  ageText,
  friendsAsPeople,
  friendLabel,
  sanitizeState,
  MAX_FRIENDS,
} from "./friends-state.ts";
import type { ScheduleSnapshot, SharedLesson } from "./friends-share.ts";

const ME = "00000001";
const lesson = (
  day: number,
  start: number,
  subject = "Wiskunde",
): SharedLesson => ({ day, start, end: start + 50, subject });
function snap(
  id: string,
  over: Partial<ScheduleSnapshot> = {},
): ScheduleSnapshot {
  return {
    id,
    name: "Anna",
    createdAt: 1000,
    windowStart: "2026-11-09",
    days: 14,
    lessons: [lesson(0, 510)],
    ...over,
  };
}

describe("importFriend", () => {
  it("adds a new friend, enabled and without nickname", () => {
    const { state, status } = importFriend(emptyState(ME), snap("aaaaaaaa"), 5);
    assert.equal(status, "added");
    assert.equal(state.friends.length, 1);
    assert.deepEqual(
      [
        state.friends[0].enabled,
        state.friends[0].nickname,
        state.friends[0].importedAt,
      ],
      [true, "", 5],
    );
  });
  it("replaces an older version with a newer one and keeps the nickname and the toggle", () => {
    let s = importFriend(
      emptyState(ME),
      snap("aaaaaaaa", { createdAt: 1000 }),
    ).state;
    s = renameFriend(s, "aaaaaaaa", "Annie");
    s = setEnabled(s, "aaaaaaaa", false);
    const r = importFriend(
      s,
      snap("aaaaaaaa", { createdAt: 2000, lessons: [lesson(1, 600)] }),
      9,
    );
    assert.equal(r.status, "updated");
    assert.equal(r.state.friends.length, 1);
    assert.deepEqual(r.state.friends[0].snapshot.lessons, [lesson(1, 600)]);
    assert.equal(r.state.friends[0].nickname, "Annie");
    assert.equal(r.state.friends[0].enabled, false);
  });
  it("ignores an older or identical version", () => {
    const s = importFriend(
      emptyState(ME),
      snap("aaaaaaaa", { createdAt: 2000 }),
    ).state;
    assert.equal(
      importFriend(s, snap("aaaaaaaa", { createdAt: 1000 })).status,
      "older",
    );
    assert.equal(
      importFriend(s, snap("aaaaaaaa", { createdAt: 2000 })).status,
      "older",
    );
  });
  it("refuses your own link and a full list", () => {
    assert.equal(importFriend(emptyState(ME), snap(ME)).status, "self");
    let s = emptyState(ME);
    for (let i = 0; i < MAX_FRIENDS; i++)
      s = importFriend(s, snap(`${String(i).padStart(8, "a")}`)).state;
    assert.equal(s.friends.length, MAX_FRIENDS);
    assert.equal(importFriend(s, snap("bbbbbbbb")).status, "full");
  });
  it("does not mutate the previous state", () => {
    const before = emptyState(ME);
    importFriend(before, snap("aaaaaaaa"));
    assert.equal(before.friends.length, 0);
  });
});

describe("adoptSnapshot", () => {
  it("adopts a new id for the same person without duplicating or losing settings", () => {
    let s = importFriend(emptyState(ME), snap("aaaaaaaa")).state;
    s = renameFriend(s, "aaaaaaaa", "Annie");
    s = setEnabled(s, "aaaaaaaa", false);
    s = adoptSnapshot(
      s,
      "aaaaaaaa",
      snap("bbbbbbbb", { createdAt: 2000, lessons: [lesson(1, 600)] }),
      9,
    );
    assert.equal(s.friends.length, 1);
    assert.equal(s.friends[0].id, "bbbbbbbb");
    assert.deepEqual(
      [s.friends[0].nickname, s.friends[0].enabled, s.friends[0].importedAt],
      ["Annie", false, 9],
    );
    assert.deepEqual(s.friends[0].snapshot.lessons, [lesson(1, 600)]);
  });
  it("refuses an id that is already another friend or your own", () => {
    let s = importFriend(emptyState(ME), snap("aaaaaaaa")).state;
    s = importFriend(s, snap("bbbbbbbb", { name: "Ben" })).state;
    assert.equal(
      adoptSnapshot(s, "aaaaaaaa", snap("bbbbbbbb")).friends.length,
      2,
    );
    assert.equal(adoptSnapshot(s, "aaaaaaaa", snap(ME)).friends.length, 2);
  });
});

describe("editing the list", () => {
  it("removes, toggles, renames and labels friends", () => {
    let s = importFriend(emptyState(ME), snap("aaaaaaaa")).state;
    s = importFriend(s, snap("bbbbbbbb", { name: "Ben" })).state;
    assert.equal(friendLabel(s.friends[0]), "Anna");
    s = renameFriend(s, "aaaaaaaa", "  Annie  ");
    assert.equal(friendLabel(s.friends[0]), "Annie");
    s = renameFriend(s, "aaaaaaaa", "");
    assert.equal(friendLabel(s.friends[0]), "Anna");
    assert.equal(friendsAsPeople(setEnabled(s, "bbbbbbbb", false)).length, 1);
    assert.equal(removeFriend(s, "aaaaaaaa").friends.length, 1);
    assert.equal(setMyName(s, "  Joris  ").myName, "Joris");
  });
  it("turns friends into people with absolute lessons and stable colours", () => {
    const s = importFriend(emptyState(ME), snap("aaaaaaaa")).state;
    const [p] = friendsAsPeople(s);
    assert.equal(p.name, "Anna");
    assert.equal(p.lessons.length, 1);
    assert.equal(new Date(p.lessons[0].start).getHours(), 8);
    assert.equal(friendsAsPeople(s)[0].hue, p.hue);
    assert.equal(p.coversFrom, new Date(2026, 10, 9).getTime());
    assert.equal(p.coversTo, new Date(2026, 10, 23).getTime());
  });
});

describe("change notices (the 'new QR' prompt)", () => {
  const shared = {
    windowStart: "2026-11-09",
    lessons: [lesson(0, 510), lesson(0, 560, "Frans")],
  };
  const base = markShared(emptyState(ME), shared, "sig", 1);
  it("says nothing before the first share", () => {
    assert.equal(changeNotice(emptyState(ME), shared), null);
  });
  it("says nothing when the schedule is unchanged", () => {
    assert.equal(changeNotice(base, shared), null);
  });
  it("notices a cancelled lesson and a new lesson", () => {
    const n = changeNotice(base, {
      windowStart: "2026-11-09",
      lessons: [lesson(0, 510), lesson(1, 600, "Nask")],
    });
    assert.deepEqual(n, {
      kind: "changed",
      added: 1,
      removed: 1,
      changed: true,
    });
    assert.match(
      describeNotice(n!),
      /1 les is vervallen of verplaatst, 1 nieuwe les/,
    );
  });
  it("asks for a new link when a new week has started", () => {
    const n = changeNotice(base, {
      windowStart: "2026-11-16",
      lessons: shared.lessons,
    });
    assert.deepEqual(n, { kind: "new-week" });
    assert.match(describeNotice(n!), /nieuwe week/);
  });
});

describe("freshness and age", () => {
  const s = snap("aaaaaaaa", {
    createdAt: Math.floor(new Date(2026, 10, 9, 12).getTime() / 60000),
  });
  it("is fresh, then old, then expired", () => {
    assert.equal(freshness(s, new Date(2026, 10, 10, 12).getTime()), "fresh");
    assert.equal(freshness(s, new Date(2026, 10, 16, 12).getTime()), "old");
    assert.equal(
      freshness(s, new Date(2026, 10, 23, 0, 1).getTime()),
      "expired",
    );
  });
  it("describes age in Dutch", () => {
    const base = 1_000_000;
    const at = (min: number) => (base + min) * 60000;
    assert.equal(ageText(base, at(1)), "zojuist");
    assert.equal(ageText(base, at(30)), "30 min geleden");
    assert.equal(ageText(base, at(180)), "3 uur geleden");
    assert.equal(ageText(base, at(60 * 24)), "gisteren");
    assert.equal(ageText(base, at(60 * 24 * 4)), "4 dagen geleden");
    assert.equal(ageText(base, at(-10)), "zojuist");
  });
});

describe("sanitizeState", () => {
  it("round-trips a good state", () => {
    let s = importFriend(emptyState(ME), snap("aaaaaaaa")).state;
    s = markShared(
      s,
      { windowStart: "2026-11-09", lessons: [lesson(0, 510)] },
      "sig",
      7,
    );
    assert.deepEqual(sanitizeState(JSON.parse(JSON.stringify(s))), s);
  });
  it("rejects states without a valid id and survives garbage", () => {
    assert.equal(sanitizeState(null), null);
    assert.equal(sanitizeState("x"), null);
    assert.equal(sanitizeState({ myId: "zzz" }), null);
  });
  it("drops broken, duplicate and self-referencing friends but keeps the rest", () => {
    const good = snap("aaaaaaaa");
    const raw = {
      myId: ME,
      friends: [
        { snapshot: good },
        { snapshot: good },
        { snapshot: { ...good, id: ME } },
        {
          snapshot: {
            ...good,
            id: "bbbbbbbb",
            lessons: [{ day: 99, start: 1, end: 2, subject: "x" }],
          },
        },
        { snapshot: { id: "cccccccc" } },
        null,
        "nope",
      ],
    };
    const s = sanitizeState(raw)!;
    assert.deepEqual(
      s.friends.map((f) => f.id),
      ["aaaaaaaa"],
    );
    assert.equal(s.lastShared, null);
    assert.equal(s.myName, "");
  });
});
