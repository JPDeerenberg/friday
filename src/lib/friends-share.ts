/**
 * Sharing a schedule with friends without any server.
 *
 * The schedule travels *inside* the link/QR code: a small binary snapshot (lesson
 * times and subject names for this and next week), compressed and base64url
 * encoded, placed after the `#` of a URL. The part after `#` is never sent to a
 * web server, so nothing is hosted anywhere; when the schedule changes the sender
 * simply shares a new link/QR.
 *
 * Deliberately shared: day, start/end time and subject of each lesson, plus a
 * display name. Not shared: grades, teachers, rooms, homework, messages.
 *
 * Link contents are untrusted input: decoding validates sizes, a checksum and
 * every field, and fails with a readable Dutch message instead of throwing garbage
 * into the app.
 */
import type { CalendarEvent } from "./types.ts";
import { isTimetabledLesson } from "./next-lesson.ts";

export const SHARE_BASE = "https://fridayapp.nl/";

export interface SharedLesson {
  /** Days after `windowStart` (0-based). */
  day: number;
  /** Minutes after local midnight. */
  start: number;
  end: number;
  subject: string;
  /** v2 detail fields. Older links simply omit them. */
  teacher?: string;
  room?: string;
  homework?: string;
  test?: string;
  note?: string;
}

export interface ScheduleSnapshot {
  /** Stable random id of the sender, so a newer link replaces the older one. */
  id: string;
  name: string;
  /** Unix minutes when the snapshot was made. */
  createdAt: number;
  /** Monday the window starts on, "YYYY-MM-DD". */
  windowStart: string;
  /** Length of the window in days (7 or 14). */
  days: number;
  lessons: SharedLesson[];
}

export class FriendLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FriendLinkError";
  }
}

const MAX_NAME_CHARS = 24;
const MAX_SUBJECT_CHARS = 24;
const MAX_TEACHER_CHARS = 32;
const MAX_ROOM_CHARS = 20;
const MAX_HOMEWORK_CHARS = 240;
const MAX_TEST_CHARS = 32;
const MAX_NOTE_CHARS = 120;
const MAX_DAYS = 14;
const MAX_LESSONS_PER_DAY = 24;
const MAX_SUBJECTS = 40;
const TIME_BASE_MIN = 5 * 60; // 05:00
const UNIT = 5; // minutes per time unit

const FORMAT_RAW = 1;
const FORMAT_DEFLATE = 2;
const FORMAT_JSON = 3;
const FORMAT_JSON_DEFLATE = 4;

// ---------------------------------------------------------------- bytes

function varintBytes(n: number): number[] {
  const out: number[] = [];
  let v = Math.max(0, Math.floor(n));
  while (v >= 0x80) {
    out.push((v % 0x80) | 0x80);
    v = Math.floor(v / 0x80);
  }
  out.push(v);
  return out;
}

class Reader {
  private i = 0;
  private readonly b: Uint8Array;
  constructor(b: Uint8Array) {
    this.b = b;
  }
  byte(): number {
    if (this.i >= this.b.length)
      throw new FriendLinkError(
        "De link is niet compleet. Kopieer hem opnieuw.",
      );
    return this.b[this.i++];
  }
  varint(): number {
    let result = 0;
    let mul = 1;
    for (let n = 0; n < 6; n++) {
      const x = this.byte();
      result += (x & 0x7f) * mul;
      if ((x & 0x80) === 0) return result;
      mul *= 0x80;
    }
    throw new FriendLinkError("De link is beschadigd.");
  }
  bytes(len: number): Uint8Array {
    if (this.i + len > this.b.length)
      throw new FriendLinkError(
        "De link is niet compleet. Kopieer hem opnieuw.",
      );
    const out = this.b.slice(this.i, this.i + len);
    this.i += len;
    return out;
  }
  string(max: number): string {
    const len = this.byte();
    if (len > max * 4) throw new FriendLinkError("De link is beschadigd.");
    return new TextDecoder("utf-8", { fatal: false }).decode(this.bytes(len));
  }
  get done() {
    return this.i >= this.b.length;
  }
}

/** CRC-16/CCITT-FALSE: catches a link that was cut off or mangled on the way. */
export function crc16(bytes: Uint8Array): number {
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let k = 0; k < 8; k++)
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

export function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array {
  const clean = text.replace(/-/g, "+").replace(/_/g, "/");
  const padded = clean + "=".repeat((4 - (clean.length % 4)) % 4);
  let bin: string;
  try {
    bin = atob(padded);
  } catch {
    throw new FriendLinkError("Dit is geen geldige Friday-link.");
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pipe(
  bytes: Uint8Array,
  stream: {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
  },
): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  // A damaged stream rejects these as well as the reads below; the read loop reports it.
  writer.write(bytes).catch(() => {});
  writer.close().catch(() => {});
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
    if (total > 64 * 1024) throw new FriendLinkError("De link is te groot.");
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === "undefined") return null;
  return pipe(bytes, new CompressionStream("deflate-raw") as never);
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new FriendLinkError(
      "Deze browser kan de link niet uitpakken. Werk je app of browser bij.",
    );
  }
  try {
    return await pipe(bytes, new DecompressionStream("deflate-raw") as never);
  } catch (e) {
    if (e instanceof FriendLinkError) throw e;
    throw new FriendLinkError("De link is beschadigd.");
  }
}

// ---------------------------------------------------------------- dates

const pad = (n: number) => String(n).padStart(2, "0");

/** Local "YYYY-MM-DD" of a Date. */
export function localDay(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseDay(day: string): { y: number; m: number; d: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) throw new FriendLinkError("De link is beschadigd.");
  return { y: +match[1], m: +match[2], d: +match[3] };
}

/** Local midnight of `windowStart` plus `dayOffset` days. */
function localMidnight(windowStart: string, dayOffset: number): Date {
  const { y, m, d } = parseDay(windowStart);
  return new Date(y, m - 1, d + dayOffset, 0, 0, 0, 0);
}

/** The Monday the shared window starts on: this week's Monday, or next Monday at the weekend. */
export function defaultWindowStart(now: Date = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dow = d.getDay(); // 0 = Sunday
  const back = dow === 0 ? -1 : dow === 6 ? -2 : dow - 1; // weekend -> upcoming Monday
  d.setDate(d.getDate() - back);
  return localDay(d);
}

function daysSinceEpoch(day: string): number {
  const { y, m, d } = parseDay(day);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}

function dayFromEpochDays(n: number): string {
  const d = new Date(n * 86400000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// ---------------------------------------------------------------- build

export function cleanName(name: string): string {
  return Array.from(name.replace(/\s+/g, " ").trim())
    .slice(0, MAX_NAME_CHARS)
    .join("");
}

function cleanSubject(name: string): string {
  return Array.from(name.replace(/\s+/g, " ").trim())
    .slice(0, MAX_SUBJECT_CHARS)
    .join("");
}

function plainText(value: string | undefined | null): string {
  return (value ?? "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(p|div|li|tr)>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function cleanText(value: string | undefined | null, max: number): string {
  return Array.from(plainText(value)).slice(0, max).join("").trim();
}

const testLabel = (infoType: number | undefined): string => {
  switch (infoType) {
    case 2:
      return "Proefwerk";
    case 3:
      return "Tentamen";
    case 4:
      return "SO";
    case 5:
      return "Mondeling";
    default:
      return "";
  }
};

/** A random 8-character id for the sender. */
export function newSenderId(): string {
  const bytes = new Uint8Array(4);
  if (typeof crypto !== "undefined" && crypto.getRandomValues)
    crypto.getRandomValues(bytes);
  else for (let i = 0; i < 4; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Turns calendar events into the lessons that are shared (cancelled lessons are left out: they are free time). */
export function lessonsFromEvents(
  events: ReadonlyArray<CalendarEvent>,
  windowStart: string,
  days: number,
): SharedLesson[] {
  const origin = localMidnight(windowStart, 0).getTime();
  const out: SharedLesson[] = [];
  for (const e of events) {
    if (!isTimetabledLesson(e)) continue;
    const start = new Date(e.Start);
    const end = new Date(e.Einde);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) continue;
    const day = Math.round(
      (new Date(
        start.getFullYear(),
        start.getMonth(),
        start.getDate(),
      ).getTime() -
        origin) /
        86400000,
    );
    if (day < 0 || day >= days) continue;
    const startMin =
      Math.floor((start.getHours() * 60 + start.getMinutes()) / UNIT) * UNIT;
    const endMin =
      Math.ceil((end.getHours() * 60 + end.getMinutes()) / UNIT) * UNIT;
    if (startMin < TIME_BASE_MIN || endMin <= startMin) continue;
    if (
      (endMin - startMin) / UNIT > 255 ||
      (startMin - TIME_BASE_MIN) / UNIT > 255
    )
      continue;
    const subject =
      cleanSubject(e.Vakken?.[0]?.Naam || e.Omschrijving || "Les") || "Les";
    const teacher = cleanText(
      (e.Docenten ?? []).map((d) => d.Naam).join(", "),
      MAX_TEACHER_CHARS,
    );
    const room = cleanText(
      e.Lokalen?.[0]?.Naam || e.Lokatie || "",
      MAX_ROOM_CHARS,
    );
    const homework =
      e.InfoType === 1 && !e.Afgerond
        ? cleanText(e.Inhoud || e.Omschrijving, MAX_HOMEWORK_CHARS) ||
          "Huiswerk"
        : "";
    const test = cleanText(
      testLabel(e.InfoType) ||
        (e.InfoType != null && e.InfoType >= 2 && e.InfoType <= 5
          ? e.Omschrijving
          : ""),
      MAX_TEST_CHARS,
    );
    const note =
      e.InfoType !== 1 &&
      e.InfoType !== 2 &&
      e.InfoType !== 3 &&
      e.InfoType !== 4 &&
      e.InfoType !== 5
        ? cleanText(e.Inhoud, MAX_NOTE_CHARS)
        : "";
    out.push({
      day,
      start: startMin,
      end: endMin,
      subject,
      ...(teacher ? { teacher } : {}),
      ...(room ? { room } : {}),
      ...(homework ? { homework } : {}),
      ...(test ? { test } : {}),
      ...(note ? { note } : {}),
    });
  }
  return out.sort((a, b) => a.day - b.day || a.start - b.start);
}

export function buildSnapshot(input: {
  id: string;
  name: string;
  events: ReadonlyArray<CalendarEvent>;
  windowStart: string;
  days?: number;
  now?: Date;
}): ScheduleSnapshot {
  const days = Math.min(MAX_DAYS, Math.max(1, input.days ?? 14));
  return {
    id: input.id,
    name: cleanName(input.name) || "Vriend",
    createdAt: Math.floor((input.now ?? new Date()).getTime() / 60000),
    windowStart: input.windowStart,
    days,
    lessons: lessonsFromEvents(input.events, input.windowStart, days),
  };
}

/** The lessons as absolute times, for comparing. */
export interface AbsoluteLesson {
  start: number; // ms
  end: number;
  subject: string;
  teacher?: string;
  room?: string;
  homework?: string;
  test?: string;
  note?: string;
}

export function absoluteLessons(s: ScheduleSnapshot): AbsoluteLesson[] {
  return s.lessons.map((l) => {
    const midnight = localMidnight(s.windowStart, l.day);
    const at = (min: number) =>
      new Date(
        midnight.getFullYear(),
        midnight.getMonth(),
        midnight.getDate(),
        Math.floor(min / 60),
        min % 60,
      ).getTime();
    return {
      start: at(l.start),
      end: at(l.end),
      subject: l.subject,
      ...(l.teacher ? { teacher: l.teacher } : {}),
      ...(l.room ? { room: l.room } : {}),
      ...(l.homework ? { homework: l.homework } : {}),
      ...(l.test ? { test: l.test } : {}),
      ...(l.note ? { note: l.note } : {}),
    };
  });
}

/** Local-midnight range (ms) that a snapshot covers: from its first to its last day. */
export function snapshotRange(
  s: Pick<ScheduleSnapshot, "windowStart" | "days">,
): { from: number; to: number } {
  const { y, m, d } = parseDay(s.windowStart);
  return {
    from: new Date(y, m - 1, d).getTime(),
    to: new Date(y, m - 1, d + s.days).getTime(),
  };
}

// ---------------------------------------------------------------- encode / decode

function writeBody(s: ScheduleSnapshot): Uint8Array {
  const enc = new TextEncoder();
  const bytes: number[] = [];
  const id = s.id.toLowerCase();
  if (!/^[0-9a-f]{8}$/.test(id)) throw new FriendLinkError("Ongeldig id.");
  for (let i = 0; i < 8; i += 2) bytes.push(parseInt(id.slice(i, i + 2), 16));
  bytes.push(...varintBytes(s.createdAt));
  bytes.push(...varintBytes(daysSinceEpoch(s.windowStart)));
  bytes.push(s.days);
  const name = enc.encode(cleanName(s.name));
  bytes.push(name.length, ...name);

  const subjects: string[] = [];
  for (const l of s.lessons)
    if (!subjects.includes(l.subject)) subjects.push(l.subject);
  if (subjects.length > MAX_SUBJECTS)
    throw new FriendLinkError("Te veel vakken in je rooster om te delen.");
  bytes.push(subjects.length);
  for (const sub of subjects) {
    const b = enc.encode(cleanSubject(sub));
    bytes.push(b.length, ...b);
  }
  for (let d = 0; d < s.days; d++) {
    const day = s.lessons
      .filter((l) => l.day === d)
      .sort((a, b) => a.start - b.start);
    if (day.length > MAX_LESSONS_PER_DAY)
      throw new FriendLinkError("Te veel lessen op één dag om te delen.");
    bytes.push(day.length);
    for (const l of day) {
      bytes.push(
        (l.start - TIME_BASE_MIN) / UNIT,
        (l.end - l.start) / UNIT,
        subjects.indexOf(l.subject),
      );
    }
  }
  const body = Uint8Array.from(bytes);
  const crc = crc16(body);
  const out = new Uint8Array(body.length + 2);
  out.set(body);
  out[body.length] = crc >> 8;
  out[body.length + 1] = crc & 0xff;
  return out;
}

interface JsonSnapshot {
  v: 2;
  id: string;
  name: string;
  createdAt: number;
  windowStart: string;
  days: number;
  lessons: SharedLesson[];
}

function appendCrc(body: Uint8Array): Uint8Array {
  const crc = crc16(body);
  const out = new Uint8Array(body.length + 2);
  out.set(body);
  out[body.length] = crc >> 8;
  out[body.length + 1] = crc & 0xff;
  return out;
}

async function encodeJsonSnapshot(s: ScheduleSnapshot): Promise<string> {
  const doc: JsonSnapshot = {
    v: 2,
    id: s.id,
    name: cleanName(s.name),
    createdAt: s.createdAt,
    windowStart: s.windowStart,
    days: s.days,
    lessons: s.lessons,
  };
  const json = new TextEncoder().encode(JSON.stringify(doc));
  const body = appendCrc(json);
  const packed = await deflate(body);
  const useDeflate = packed !== null && packed.length < body.length;
  const data = useDeflate ? packed : body;
  const out = new Uint8Array(data.length + 1);
  out[0] = useDeflate ? FORMAT_JSON_DEFLATE : FORMAT_JSON;
  out.set(data, 1);
  return toBase64Url(out);
}

function decodeJsonSnapshot(withCrc: Uint8Array): ScheduleSnapshot {
  if (withCrc.length < 4)
    throw new FriendLinkError("De link is niet compleet. Kopieer hem opnieuw.");
  const body = withCrc.slice(0, -2);
  const crc = (withCrc[withCrc.length - 2] << 8) | withCrc[withCrc.length - 1];
  if (crc16(body) !== crc)
    throw new FriendLinkError(
      "De link is beschadigd of afgekapt. Kopieer hem opnieuw.",
    );
  let doc: JsonSnapshot;
  try {
    doc = JSON.parse(new TextDecoder().decode(body)) as JsonSnapshot;
  } catch {
    throw new FriendLinkError("De link is beschadigd.");
  }
  if (
    !doc ||
    doc.v !== 2 ||
    !/^[0-9a-f]{8}$/i.test(doc.id ?? "") ||
    !/^\d{4}-\d{2}-\d{2}$/.test(doc.windowStart ?? "") ||
    !Number.isInteger(doc.days) ||
    doc.days < 1 ||
    doc.days > MAX_DAYS ||
    !Array.isArray(doc.lessons)
  ) {
    throw new FriendLinkError("De link is beschadigd.");
  }
  const lessons: SharedLesson[] = [];
  for (const raw of doc.lessons) {
    if (lessons.length >= MAX_DAYS * MAX_LESSONS_PER_DAY) break;
    const day = Number(raw.day);
    const start = Number(raw.start);
    const end = Number(raw.end);
    if (
      !Number.isInteger(day) ||
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      day < 0 ||
      day >= doc.days ||
      start < 0 ||
      end <= start ||
      end > 24 * 60
    ) {
      continue;
    }
    lessons.push({
      day,
      start,
      end,
      subject: cleanSubject(raw.subject || "Les") || "Les",
      ...(raw.teacher
        ? { teacher: cleanText(raw.teacher, MAX_TEACHER_CHARS) }
        : {}),
      ...(raw.room ? { room: cleanText(raw.room, MAX_ROOM_CHARS) } : {}),
      ...(raw.homework
        ? { homework: cleanText(raw.homework, MAX_HOMEWORK_CHARS) }
        : {}),
      ...(raw.test ? { test: cleanText(raw.test, MAX_TEST_CHARS) } : {}),
      ...(raw.note ? { note: cleanText(raw.note, MAX_NOTE_CHARS) } : {}),
    });
  }
  return {
    id: doc.id.toLowerCase(),
    name: cleanName(doc.name ?? "") || "Vriend",
    createdAt: Number.isFinite(doc.createdAt) ? doc.createdAt : 0,
    windowStart: doc.windowStart,
    days: doc.days,
    lessons: lessons.sort((a, b) => a.day - b.day || a.start - b.start),
  };
}

/** The text after `#friend=` in a share link. */
export async function encodeSnapshot(s: ScheduleSnapshot): Promise<string> {
  if (
    s.lessons.some((l) => l.teacher || l.room || l.homework || l.test || l.note)
  ) {
    return encodeJsonSnapshot(s);
  }
  const body = writeBody(s);
  const packed = await deflate(body);
  const useDeflate = packed !== null && packed.length < body.length;
  const data = useDeflate ? packed : body;
  const out = new Uint8Array(data.length + 1);
  out[0] = useDeflate ? FORMAT_DEFLATE : FORMAT_RAW;
  out.set(data, 1);
  return toBase64Url(out);
}

export async function decodeSnapshot(
  payload: string,
): Promise<ScheduleSnapshot> {
  const raw = fromBase64Url(payload.trim());
  if (raw.length < 4 || raw.length > 32 * 1024)
    throw new FriendLinkError("Dit is geen geldige Friday-link.");
  const format = raw[0];
  if (format === FORMAT_JSON || format === FORMAT_JSON_DEFLATE) {
    const withCrc =
      format === FORMAT_JSON_DEFLATE
        ? await inflate(raw.slice(1))
        : raw.slice(1);
    return decodeJsonSnapshot(withCrc);
  }
  if (format !== FORMAT_RAW && format !== FORMAT_DEFLATE) {
    throw new FriendLinkError(
      "Deze link komt van een nieuwere versie van Friday. Werk je app bij.",
    );
  }
  const withCrc =
    format === FORMAT_DEFLATE ? await inflate(raw.slice(1)) : raw.slice(1);
  if (withCrc.length < 4)
    throw new FriendLinkError("De link is niet compleet. Kopieer hem opnieuw.");
  const body = withCrc.slice(0, -2);
  const crc = (withCrc[withCrc.length - 2] << 8) | withCrc[withCrc.length - 1];
  if (crc16(body) !== crc)
    throw new FriendLinkError(
      "De link is beschadigd of afgekapt. Kopieer hem opnieuw.",
    );

  const r = new Reader(body);
  const idBytes = r.bytes(4);
  const id = Array.from(idBytes, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  const createdAt = r.varint();
  const windowStart = dayFromEpochDays(r.varint());
  const days = r.byte();
  if (days < 1 || days > MAX_DAYS)
    throw new FriendLinkError("De link is beschadigd.");
  const name = cleanName(r.string(MAX_NAME_CHARS)) || "Vriend";
  const subjectCount = r.byte();
  if (subjectCount > MAX_SUBJECTS)
    throw new FriendLinkError("De link is beschadigd.");
  const subjects: string[] = [];
  for (let i = 0; i < subjectCount; i++)
    subjects.push(cleanSubject(r.string(MAX_SUBJECT_CHARS)) || "Les");

  const lessons: SharedLesson[] = [];
  for (let d = 0; d < days; d++) {
    const count = r.byte();
    if (count > MAX_LESSONS_PER_DAY)
      throw new FriendLinkError("De link is beschadigd.");
    for (let i = 0; i < count; i++) {
      const start = TIME_BASE_MIN + r.byte() * UNIT;
      const dur = r.byte() * UNIT;
      const subject = subjects[r.byte()];
      if (dur <= 0 || subject === undefined || start + dur > 24 * 60)
        throw new FriendLinkError("De link is beschadigd.");
      lessons.push({ day: d, start, end: start + dur, subject });
    }
  }
  if (!r.done) throw new FriendLinkError("De link is beschadigd.");
  return { id, name, createdAt, windowStart, days, lessons };
}

// ---------------------------------------------------------------- links

export async function makeShareLink(
  s: ScheduleSnapshot,
  base: string = SHARE_BASE,
): Promise<string> {
  const root = base.endsWith("/") ? base : `${base}/`;
  return `${root}#friend=${await encodeSnapshot(s)}`;
}

/**
 * Finds the payload in whatever was pasted: a full link, just the part after the
 * `#`, a WhatsApp message with the link in it, or the bare payload.
 */
export function extractPayload(text: string): string | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  const m = /friend=([A-Za-z0-9_-]{8,})/.exec(t);
  if (m) return m[1];
  const bare = /^[A-Za-z0-9_-]{16,}$/.exec(t);
  return bare ? bare[0] : null;
}

export async function readShareLink(text: string): Promise<ScheduleSnapshot> {
  const payload = extractPayload(text);
  if (!payload)
    throw new FriendLinkError("Dit lijkt geen Friday-link. Plak de hele link.");
  return decodeSnapshot(payload);
}

// ---------------------------------------------------------------- changes

const lessonKey = (l: SharedLesson) =>
  `${l.day}|${l.start}|${l.end}|${l.subject}|${l.teacher ?? ""}|${
    l.room ?? ""
  }|${l.homework ?? ""}|${l.test ?? ""}|${l.note ?? ""}`;

/** Same schedule => same signature. Used to notice that a new QR is needed. */
export function scheduleSignature(
  lessons: ReadonlyArray<SharedLesson>,
): string {
  const keys = lessons.map(lessonKey).sort().join(";");
  let h = 5381;
  for (let i = 0; i < keys.length; i++)
    h = ((h << 5) + h + keys.charCodeAt(i)) | 0;
  return `${lessons.length}:${(h >>> 0).toString(36)}`;
}

export interface ScheduleDiff {
  added: number;
  removed: number;
  changed: boolean;
}

export function diffLessons(
  prev: ReadonlyArray<SharedLesson>,
  next: ReadonlyArray<SharedLesson>,
): ScheduleDiff {
  const a = new Map<string, number>();
  for (const l of prev) a.set(lessonKey(l), (a.get(lessonKey(l)) ?? 0) + 1);
  let added = 0;
  for (const l of next) {
    const k = lessonKey(l);
    const n = a.get(k) ?? 0;
    if (n > 0) a.set(k, n - 1);
    else added++;
  }
  let removed = 0;
  for (const n of a.values()) removed += n;
  return { added, removed, changed: added > 0 || removed > 0 };
}
