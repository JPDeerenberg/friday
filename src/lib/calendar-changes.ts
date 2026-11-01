/**
 * Agenda-wijzigingen uit een notificatie.
 *
 * Tikt de gebruiker op een agenda-notificatie, dan geeft de Android-app via
 * `window.FridayNative` door waar de app voor geopend is en wat er sinds de
 * vorige keer is veranderd (afgelast, verplaatst, ander lokaal/docent, nieuw
 * of verwijderd). Hier staat de (testbare) vertaling daarvan naar tekst.
 */

import { writable } from "svelte/store";

export type ChangeKind =
  "cancelled" | "removed" | "new" | "moved" | "room" | "teacher";

export interface CalendarChange {
  id: number;
  title: string;
  /** Magister-tijdstippen (UTC, ISO). */
  start: string;
  end: string;
  kinds: ChangeKind[];
  oldStart?: string;
  oldEnd?: string;
  oldRoom?: string;
  newRoom?: string;
  oldTeacher?: string;
  newTeacher?: string;
}

export interface NotificationTap {
  page: string;
  changes: CalendarChange[];
}

/** Gevuld = popup tonen (lege lijst = "geen openstaande wijzigingen"). */
export const calendarChangesPopup = writable<CalendarChange[] | null>(null);

const KINDS: ChangeKind[] = [
  "cancelled",
  "removed",
  "new",
  "moved",
  "room",
  "teacher",
];

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function parseChange(raw: unknown): CalendarChange | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const kinds = (Array.isArray(o.kinds) ? o.kinds : []).filter(
    (k): k is ChangeKind => KINDS.includes(k as ChangeKind),
  );
  const start = asString(o.start);
  if (kinds.length === 0 || !start) return null;
  return {
    id: Number(o.id) || 0,
    title: asString(o.title)?.trim() || "Afspraak",
    start,
    end: asString(o.end) ?? start,
    kinds,
    oldStart: asString(o.oldStart),
    oldEnd: asString(o.oldEnd),
    oldRoom: asString(o.oldRoom),
    newRoom: asString(o.newRoom),
    oldTeacher: asString(o.oldTeacher),
    newTeacher: asString(o.newTeacher),
  };
}

/** Leest het antwoord van `FridayNative.consumeNotificationTap()`. */
export function parseNotificationTap(
  raw: string | null | undefined,
): NotificationTap | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as { page?: unknown; changes?: unknown };
    if (typeof o.page !== "string" || !o.page) return null;
    const changes = (Array.isArray(o.changes) ? o.changes : [])
      .map(parseChange)
      .filter((c): c is CalendarChange => c !== null)
      .sort((a, b) => a.start.localeCompare(b.start));
    return { page: o.page, changes };
  } catch {
    return null;
  }
}

/** Vraagt de Android-app of we via een notificatie zijn geopend. Eenmalig. */
export function consumeNotificationTap(): NotificationTap | null {
  if (typeof window === "undefined") return null;
  const bridge = (
    window as unknown as {
      FridayNative?: { consumeNotificationTap?: () => string };
    }
  ).FridayNative;
  if (!bridge?.consumeNotificationTap) return null;
  try {
    return parseNotificationTap(bridge.consumeNotificationTap());
  } catch (e) {
    console.warn("[CalendarChanges] bridge failed", e);
    return null;
  }
}

// ─── Weergave ───────────────────────────────────────────────────────

export interface ChangeView {
  /** Belangrijkste soort wijziging, voor kleur en kop. */
  label: string;
  tone: "bad" | "warn" | "good";
  /** Alle soorten, voor chips. */
  labels: string[];
  /** Eén regel per verandering. */
  details: string[];
}

const LABEL: Record<ChangeKind, string> = {
  cancelled: "Vervallen",
  removed: "Verwijderd",
  new: "Nieuw",
  moved: "Verplaatst",
  room: "Ander lokaal",
  teacher: "Andere docent",
};

function time(iso: string | undefined, locale: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
}

function dayKey(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? iso.slice(0, 10)
    : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function slot(
  start: string | undefined,
  end: string | undefined,
  locale: string,
): string {
  const a = time(start, locale);
  const b = time(end, locale);
  return a && b ? `${a}–${b}` : a || b;
}

export function describeChange(
  c: CalendarChange,
  locale = "nl-NL",
): ChangeView {
  const kinds = KINDS.filter((k) => c.kinds.includes(k));
  const main = kinds[0];
  const tone: ChangeView["tone"] =
    main === "cancelled" || main === "removed"
      ? "bad"
      : main === "new"
        ? "good"
        : "warn";

  const details: string[] = [];
  const newWhen = slot(c.start, c.end, locale);
  if (kinds.includes("cancelled")) {
    details.push(newWhen ? `Gepland om ${newWhen}` : "Deze afspraak vervalt");
  }
  if (kinds.includes("removed")) {
    details.push(
      newWhen ? `Stond gepland om ${newWhen}` : "Staat niet meer in de agenda",
    );
  }
  if (kinds.includes("new")) {
    details.push(newWhen ? `Om ${newWhen}` : "Nieuw in je agenda");
  }
  if (kinds.includes("moved")) {
    const sameDay = !!c.oldStart && dayKey(c.oldStart) === dayKey(c.start);
    const oldDay =
      c.oldStart && !sameDay
        ? new Date(c.oldStart).toLocaleDateString(locale, {
            weekday: "short",
            day: "numeric",
            month: "short",
          }) + " "
        : "";
    const newDay = !sameDay
      ? new Date(c.start).toLocaleDateString(locale, {
          weekday: "short",
          day: "numeric",
          month: "short",
        }) + " "
      : "";
    details.push(
      `Was ${oldDay}${slot(c.oldStart, c.oldEnd, locale)}, nu ${newDay}${newWhen}`,
    );
  }
  if (kinds.includes("room")) {
    details.push(
      c.oldRoom
        ? `Lokaal ${c.oldRoom} → ${c.newRoom || "onbekend"}`
        : `Nu in lokaal ${c.newRoom || "onbekend"}`,
    );
  }
  if (kinds.includes("teacher")) {
    details.push(
      c.oldTeacher
        ? `Docent ${c.oldTeacher} → ${c.newTeacher || "onbekend"}`
        : `Docent: ${c.newTeacher || "onbekend"}`,
    );
  }

  return {
    label: LABEL[main],
    tone,
    labels: kinds.map((k) => LABEL[k]),
    details,
  };
}

export interface DayGroup {
  key: string;
  label: string;
  items: CalendarChange[];
}

/** Groepeert per dag ("Vandaag", "Morgen", "ma 3 nov"), op tijd gesorteerd. */
export function groupByDay(
  changes: CalendarChange[],
  now = new Date(),
  locale = "nl-NL",
): DayGroup[] {
  const sorted = [...changes].sort((a, b) => a.start.localeCompare(b.start));
  const groups: DayGroup[] = [];
  const today = dayKey(now.toISOString());
  const tomorrowDate = new Date(now);
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrow = dayKey(tomorrowDate.toISOString());
  for (const c of sorted) {
    const key = dayKey(c.start);
    let g = groups.find((x) => x.key === key);
    if (!g) {
      const label =
        key === today
          ? "Vandaag"
          : key === tomorrow
            ? "Morgen"
            : new Date(c.start).toLocaleDateString(locale, {
                weekday: "long",
                day: "numeric",
                month: "long",
              });
      g = { key, label, items: [] };
      groups.push(g);
    }
    g.items.push(c);
  }
  return groups;
}
