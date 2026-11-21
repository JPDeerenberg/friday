import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  encodeSnapshot,
  decodeSnapshot,
  makeShareLink,
  readShareLink,
  extractPayload,
  snapshotRange,
  buildSnapshot,
  lessonsFromEvents,
  absoluteLessons,
  defaultWindowStart,
  scheduleSignature,
  diffLessons,
  newSenderId,
  fromBase64Url,
  toBase64Url,
  crc16,
  FriendLinkError,
  type ScheduleSnapshot,
  type SharedLesson,
} from "./friends-share.ts";
import type { CalendarEvent } from "./types.ts";

const SUBJECTS = [
  "Wiskunde",
  "Nederlands",
  "Engels",
  "Frans",
  "Biologie",
  "Geschiedenis",
  "Gymnastiek",
  "Mentoruur",
];

function snapshot(over: Partial<ScheduleSnapshot> = {}): ScheduleSnapshot {
  const lessons: SharedLesson[] = [];
  for (let day = 0; day < 14; day++) {
    if (day % 7 > 4) continue; // weekdays only
    for (let h = 0; h < 8; h++) {
      const start = 8 * 60 + 30 + h * 50;
      lessons.push({
        day,
        start: Math.floor(start / 5) * 5,
        end: Math.floor(start / 5) * 5 + 50,
        subject: SUBJECTS[(day + h) % SUBJECTS.length],
      });
    }
  }
  return {
    id: "a1b2c3d4",
    name: "Anna",
    createdAt: 29_800_000,
    windowStart: "2026-11-09",
    days: 14,
    lessons,
    ...over,
  };
}

function event(over: Partial<CalendarEvent> & { Id: number }): CalendarEvent {
  return {
    Start: new Date(2026, 10, 9, 8, 30).toISOString(),
    Einde: new Date(2026, 10, 9, 9, 20).toISOString(),
    LesuurVan: 1,
    LesuurTotMet: 1,
    DuurtHeleDag: false,
    Omschrijving: "wisk",
    Lokatie: "B214",
    Status: 0,
    Type: 7,
    Vakken: [{ Id: 1, Naam: "Wiskunde" }],
    Docenten: [{ Id: 1, Naam: "J. Jansen (JAN)" }],
    Lokalen: [{ Naam: "B214" }],
    ...over,
  } as CalendarEvent;
}

describe("encode / decode", () => {
  it("round-trips a snapshot exactly", async () => {
    const s = snapshot();
    assert.deepEqual(await decodeSnapshot(await encodeSnapshot(s)), s);
  });
  it("keeps a full two-week schedule small enough for a QR code", async () => {
    const payload = await encodeSnapshot(snapshot());
    assert.ok(payload.length < 800, `payload is ${payload.length} characters`);
  });
  it("round-trips an empty schedule and unicode names", async () => {
    const s = snapshot({ lessons: [], name: "Zoë 🎒" });
    assert.deepEqual(await decodeSnapshot(await encodeSnapshot(s)), s);
  });
  it("still works without CompressionStream (raw format)", async () => {
    const g = globalThis as { CompressionStream?: unknown };
    const saved = g.CompressionStream;
    g.CompressionStream = undefined;
    try {
      const s = snapshot({ lessons: snapshot().lessons.slice(0, 10) });
      assert.deepEqual(await decodeSnapshot(await encodeSnapshot(s)), s);
    } finally {
      g.CompressionStream = saved;
    }
  });
  it("cleans names and limits them to 24 characters", async () => {
    const s = snapshot({
      name: "  Een   heel erg lange naam die niet past in het veld  ",
    });
    const back = await decodeSnapshot(await encodeSnapshot(s));
    assert.ok(back.name.length <= 24);
    assert.ok(!/\s{2}/.test(back.name));
  });
  it("rejects a snapshot that is too big to share", async () => {
    const lessons: SharedLesson[] = Array.from({ length: 30 }, (_, i) => ({
      day: 0,
      start: 480 + i * 5,
      end: 485 + i * 5,
      subject: "x",
    }));
    await assert.rejects(
      encodeSnapshot(snapshot({ lessons })),
      FriendLinkError,
    );
    await assert.rejects(
      encodeSnapshot(snapshot({ id: "nope" })),
      FriendLinkError,
    );
  });
});

describe("hostile or damaged input", () => {
  it("rejects garbage, empty and truncated payloads with a readable error", async () => {
    for (const bad of ["", "!!!", "AAAA", "x".repeat(40), "AQID"]) {
      await assert.rejects(
        decodeSnapshot(bad),
        (e: unknown) => e instanceof FriendLinkError && e.message.length > 5,
        bad,
      );
    }
    const good = await encodeSnapshot(snapshot());
    await assert.rejects(
      decodeSnapshot(good.slice(0, good.length - 12)),
      FriendLinkError,
    );
  });
  it("catches a changed character through the checksum", async () => {
    const good = await encodeSnapshot(
      snapshot({ lessons: snapshot().lessons.slice(0, 6) }),
    );
    const mid = Math.floor(good.length / 2);
    const swapped =
      good.slice(0, mid) +
      (good[mid] === "A" ? "B" : "A") +
      good.slice(mid + 1);
    await assert.rejects(decodeSnapshot(swapped), FriendLinkError);
  });
  it("rejects an unknown format version", async () => {
    const raw = fromBase64Url(await encodeSnapshot(snapshot({ lessons: [] })));
    raw[0] = 9;
    await assert.rejects(decodeSnapshot(toBase64Url(raw)), /nieuwere versie/);
  });
  it("rejects a valid-looking body with impossible values", async () => {
    const g = globalThis as { CompressionStream?: unknown };
    const saved = g.CompressionStream;
    g.CompressionStream = undefined; // raw format so the body can be edited
    try {
      const raw = fromBase64Url(
        await encodeSnapshot(snapshot({ lessons: [] })),
      );
      const body = raw.slice(1, -2);
      let i = 4;
      while (body[i] & 0x80) i++;
      i++;
      while (body[i] & 0x80) i++;
      i++;
      const tampered = body.slice();
      tampered[i] = 200; // 200 days
      const crc = crc16(tampered);
      const out = new Uint8Array(1 + tampered.length + 2);
      out[0] = 1;
      out.set(tampered, 1);
      out[out.length - 2] = crc >> 8;
      out[out.length - 1] = crc & 0xff;
      await assert.rejects(decodeSnapshot(toBase64Url(out)), FriendLinkError);
    } finally {
      g.CompressionStream = saved;
    }
  });
});

describe("links", () => {
  it("builds a link after the # and reads it back", async () => {
    const s = snapshot();
    const link = await makeShareLink(s);
    assert.match(link, /^https:\/\/fridayapp\.nl\/#friend=[A-Za-z0-9_-]+$/);
    assert.deepEqual(await readShareLink(link), s);
    assert.ok(
      (await makeShareLink(s, "https://example.test")).startsWith(
        "https://example.test/#friend=",
      ),
    );
  });
  it("finds the payload in a pasted message, a bare payload or a fragment", async () => {
    const s = snapshot({ lessons: snapshot().lessons.slice(0, 5) });
    const link = await makeShareLink(s);
    const payload = link.split("#friend=")[1];
    assert.equal(
      extractPayload(`Hoi! Mijn rooster: ${link} groetjes`),
      payload,
    );
    assert.equal(extractPayload(`#friend=${payload}`), payload);
    assert.equal(extractPayload(payload), payload);
    assert.equal(extractPayload("hallo wereld"), null);
    assert.equal(extractPayload(""), null);
    assert.deepEqual(await readShareLink(`  ${link}\n`), s);
    await assert.rejects(readShareLink("hallo wereld"), /geen Friday-link/);
  });
});

describe("building from the agenda", () => {
  const WS = "2026-11-09"; // Monday
  it("keeps timetabled lessons, drops cancelled ones, and rounds to 5 minutes", () => {
    const events = [
      event({
        Id: 1,
        Start: new Date(2026, 10, 9, 8, 32).toISOString(),
        Einde: new Date(2026, 10, 9, 9, 18).toISOString(),
      }),
      event({
        Id: 2,
        Status: 5,
        Start: new Date(2026, 10, 9, 9, 20).toISOString(),
        Einde: new Date(2026, 10, 9, 10, 10).toISOString(),
      }),
      event({ Id: 3, LesuurVan: null as never }),
      event({ Id: 4, DuurtHeleDag: true }),
      event({
        Id: 5,
        Start: new Date(2026, 10, 10, 10, 30).toISOString(),
        Einde: new Date(2026, 10, 10, 11, 20).toISOString(),
        Vakken: [{ Id: 2, Naam: "Nederlands" }],
      }),
    ];
    assert.deepEqual(lessonsFromEvents(events, WS, 14), [
      { day: 0, start: 8 * 60 + 30, end: 9 * 60 + 20, subject: "Wiskunde" },
      { day: 1, start: 10 * 60 + 30, end: 11 * 60 + 20, subject: "Nederlands" },
    ]);
  });
  it("ignores lessons outside the window", () => {
    const before = event({
      Id: 1,
      Start: new Date(2026, 10, 8, 10, 0).toISOString(),
      Einde: new Date(2026, 10, 8, 10, 50).toISOString(),
    });
    const after = event({
      Id: 2,
      Start: new Date(2026, 10, 23, 10, 0).toISOString(),
      Einde: new Date(2026, 10, 23, 10, 50).toISOString(),
    });
    assert.deepEqual(lessonsFromEvents([before, after], WS, 14), []);
  });
  it("shortens long subject names and never shares the room or the teacher", async () => {
    const e = event({
      Id: 1,
      Vakken: [{ Id: 1, Naam: "Lichamelijke opvoeding en sport" }],
    });
    const snap = buildSnapshot({
      id: "a1b2c3d4",
      name: "Anna",
      events: [e],
      windowStart: WS,
    });
    assert.ok(snap.lessons[0].subject.length <= 14);
    const payload = await encodeSnapshot(snap);
    const text = new TextDecoder("latin1").decode(fromBase64Url(payload));
    assert.ok(!text.includes("B214") && !text.includes("Jansen"));
  });
  it("converts back to absolute local times", () => {
    const snap = buildSnapshot({
      id: "a1b2c3d4",
      name: "Anna",
      windowStart: WS,
      events: [event({ Id: 1 })],
    });
    const [l] = absoluteLessons(snap);
    assert.equal(new Date(l.start).getHours(), 8);
    assert.equal(new Date(l.start).getMinutes(), 30);
    assert.equal(new Date(l.start).getDate(), 9);
    assert.equal(new Date(l.end).getHours(), 9);
    assert.equal(l.subject, "Wiskunde");
  });
});

describe("window start", () => {
  it("is this week's Monday on weekdays and the coming Monday at the weekend", () => {
    const d = (day: number) => new Date(2026, 10, day, 12); // 9 Nov 2026 is a Monday
    assert.equal(defaultWindowStart(d(9)), "2026-11-09");
    assert.equal(defaultWindowStart(d(11)), "2026-11-09");
    assert.equal(defaultWindowStart(d(13)), "2026-11-09");
    assert.equal(defaultWindowStart(d(14)), "2026-11-16");
    assert.equal(defaultWindowStart(d(15)), "2026-11-16");
  });
});

describe("change detection", () => {
  const a: SharedLesson[] = [
    { day: 0, start: 510, end: 560, subject: "Wiskunde" },
    { day: 0, start: 560, end: 610, subject: "Frans" },
  ];
  it("has a signature that only depends on the lessons", () => {
    assert.equal(scheduleSignature(a), scheduleSignature([...a].reverse()));
    assert.notEqual(scheduleSignature(a), scheduleSignature(a.slice(0, 1)));
    assert.notEqual(
      scheduleSignature(a),
      scheduleSignature([{ ...a[0], start: 515 }, a[1]]),
    );
  });
  it("counts added and removed lessons", () => {
    assert.deepEqual(diffLessons(a, a), {
      added: 0,
      removed: 0,
      changed: false,
    });
    assert.deepEqual(diffLessons(a, a.slice(0, 1)), {
      added: 0,
      removed: 1,
      changed: true,
    });
    assert.deepEqual(diffLessons(a, [a[0], { ...a[1], subject: "Duits" }]), {
      added: 1,
      removed: 1,
      changed: true,
    });
  });
});

describe("misc", () => {
  it("makes 8-character hex ids", () => {
    for (let i = 0; i < 20; i++) assert.match(newSenderId(), /^[0-9a-f]{8}$/);
  });
  it("computes the local range a snapshot covers", () => {
    assert.deepEqual(snapshotRange({ windowStart: "2026-11-09", days: 14 }), {
      from: new Date(2026, 10, 9).getTime(),
      to: new Date(2026, 10, 23).getTime(),
    });
  });
});
