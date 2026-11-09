/**
 * Pure helpers for the Opdrachten page: status, filtering, versions and the
 * hand-in request. No Tauri, no network, so everything here is unit-tested.
 *
 * How Magister models an assignment (same as Discipulus):
 *  - an assignment has *versions*; a new one is created when the teacher asks to
 *    hand in again (`OpnieuwInleveren`);
 *  - the assignment only lists its versions as `VersieNavigatieItems` (a link
 *    each); the content of a version — the student's comment and attachments,
 *    the teacher's feedback and grade — is behind that link;
 *  - handing in means POSTing the *latest* version back, with the comment and the
 *    uploaded files filled in.
 */
import type {
  Assignment,
  AssignmentAttachment,
  AssignmentLink,
  AssignmentVersion,
} from "./types.ts";

// ─── Status ────────────────────────────────────────────────────────────────

export type StatusKey = "closed" | "graded" | "submitted" | "overdue" | "open";

export function isOverdue(a: Assignment, now: Date = new Date()): boolean {
  if (a.IsTeLaat === true) return true;
  if (a.IsTeLaat !== undefined && a.IsTeLaat !== null) return false;
  return !a.IngeleverdOp && !a.Afgesloten && new Date(a.InleverenVoor) < now;
}

export function getAssignmentStatus(
  a: Assignment,
  now: Date = new Date(),
): { label: string; key: StatusKey } {
  if (a.Afgesloten) return { label: "Afgesloten", key: "closed" };
  if (a.BeoordeeldOp) return { label: "Beoordeeld", key: "graded" };
  if (a.IngeleverdOp) return { label: "Ingeleverd", key: "submitted" };
  if (isOverdue(a, now)) return { label: "Te laat", key: "overdue" };
  if (a.MagInleveren) return { label: "In te leveren", key: "open" };
  return { label: "Openstaand", key: "open" };
}

/** Whether the hand-in form should be offered. */
export function canHandIn(a: Assignment): boolean {
  return !a.Afgesloten && (a.MagInleveren || a.OpnieuwInleveren);
}

// ─── Filtering and sorting ─────────────────────────────────────────────────

export type StatusFilter = "all" | "open" | "submitted" | "graded" | "overdue";
export type SortMode = "deadline-desc" | "deadline-asc" | "title";

export interface ListFilters {
  status: StatusFilter;
  /** Exact subject name, or null for every subject. */
  vak: string | null;
  /** Inclusive date range of a school year, or null for all years. */
  year: { begin: string; einde: string } | null;
  sort: SortMode;
}

const dayOf = (iso: string) => (iso ?? "").slice(0, 10);

export function filterAssignments(
  list: ReadonlyArray<Assignment>,
  filters: ListFilters,
  now: Date = new Date(),
): Assignment[] {
  const out = list.filter((a) => {
    if (filters.status !== "all" && getAssignmentStatus(a, now).key !== filters.status) {
      return false;
    }
    if (filters.vak !== null && (a.Vak ?? "") !== filters.vak) return false;
    if (filters.year) {
      const day = dayOf(a.InleverenVoor);
      if (day < dayOf(filters.year.begin) || day > dayOf(filters.year.einde)) return false;
    }
    return true;
  });
  const byDeadline = (a: Assignment, b: Assignment) =>
    (a.InleverenVoor ?? "").localeCompare(b.InleverenVoor ?? "");
  switch (filters.sort) {
    case "deadline-asc":
      return out.sort(byDeadline);
    case "title":
      return out.sort((a, b) => (a.Titel ?? "").localeCompare(b.Titel ?? "", "nl", { sensitivity: "base" }));
    default:
      return out.sort((a, b) => byDeadline(b, a));
  }
}

/** Subjects present in `list`, alphabetically; assignments without a subject are skipped. */
export function vakOptions(list: ReadonlyArray<Assignment>): string[] {
  const set = new Set<string>();
  for (const a of list) if (a.Vak) set.add(a.Vak);
  return [...set].sort((a, b) => a.localeCompare(b, "nl", { sensitivity: "base" }));
}

// ─── Versions ──────────────────────────────────────────────────────────────

/** Oldest first. */
export function sortVersions<T extends { VersieNummer: number | null; Id: number }>(
  items: ReadonlyArray<T> | null | undefined,
): T[] {
  return [...(items ?? [])].sort(
    (a, b) => (a.VersieNummer ?? -1) - (b.VersieNummer ?? -1) || a.Id - b.Id,
  );
}

/**
 * The version to hand in on: the highest version number. (`VersieNavigatieItems[0]`
 * was used before, but nothing says Magister lists them newest first.)
 */
export function latestVersion<T extends { VersieNummer: number | null; Id: number }>(
  items: ReadonlyArray<T> | null | undefined,
): T | null {
  const sorted = sortVersions(items);
  return sorted.length > 0 ? sorted[sorted.length - 1] : null;
}

export function selfHref(
  links: ReadonlyArray<AssignmentLink> | null | undefined,
): string | null {
  const found = (links ?? []).find((l) => (l.Rel ?? "").toLowerCase() === "self");
  return found?.Href ? found.Href : null;
}

/** True when `html` shows anything: text, or an image. `<p></p>` and `&nbsp;` do not count. */
export function htmlHasContent(html: string | null | undefined): boolean {
  if (!html) return false;
  if (/<img\b/i.test(html)) return true;
  const text = html
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/[\s\u00a0\u200b]+/g, "");
  return text.length > 0;
}

export function versionHasStudentContent(v: AssignmentVersion): boolean {
  return (
    htmlHasContent(v.LeerlingOpmerking) ||
    (v.LeerlingBijlagen?.length ?? 0) > 0 ||
    !!v.IngeleverdOp
  );
}

export function versionHasTeacherContent(v: AssignmentVersion): boolean {
  return (
    htmlHasContent(v.DocentOpmerking) ||
    (v.FeedbackBijlagen?.length ?? 0) > 0 ||
    !!(v.Beoordeling && v.Beoordeling.trim())
  );
}

// ─── Handing in ────────────────────────────────────────────────────────────

export interface HandInFile {
  /** Name shown to the teacher. */
  name: string;
  /** `storageId` Magister returned for the uploaded blob. */
  storageId: string;
  contentType: string;
}

export function validateHandIn(input: {
  comment: string;
  files: ReadonlyArray<HandInFile>;
}): string | null {
  if (!htmlHasContent(input.comment) && input.files.length === 0) {
    return "Voeg een opmerking of een bijlage toe om in te leveren.";
  }
  return null;
}

/**
 * The record Magister expects for a hand-in. It is the *fetched* latest version
 * with the comment and the newly uploaded files filled in — everything else
 * (status, dates, version number…) is sent back unchanged, exactly like
 * Discipulus does. Building it from the thin navigation item (as before) lost
 * `VersieNummer` and friends.
 */
export function buildHandInBody(
  version: AssignmentVersion,
  input: { comment: string; files: ReadonlyArray<HandInFile> },
): Record<string, unknown> {
  return {
    Id: version.Id,
    Vak: version.Vak ?? null,
    Status: version.Status ?? null,
    OpdrachtId: version.OpdrachtId ?? null,
    LeerlingOpmerking: htmlHasContent(input.comment) ? input.comment : null,
    DocentOpmerking: version.DocentOpmerking ?? null,
    InleverenVoor: version.InleverenVoor ?? null,
    IngeleverdOp: version.IngeleverdOp ?? null,
    GestartOp: version.GestartOp ?? null,
    Beoordeling: version.Beoordeling ?? null,
    BeoordeeldOp: version.BeoordeeldOp ?? null,
    VersieNummer: version.VersieNummer ?? null,
    IsTeLaat: version.IsTeLaat ?? false,
    Omschrijving: version.Omschrijving ?? null,
    LeerlingBijlagen: input.files.map((f) => ({
      Id: 0,
      Naam: f.name,
      ContentType: f.contentType || "application/octet-stream",
      Datum: null,
      Grootte: 0,
      Url: "",
      UniqueId: f.storageId,
      BronSoort: 1,
      Links: null,
    })),
  };
}

export function attachmentLabel(a: AssignmentAttachment): string {
  const size = a.Grootte > 0 ? ` (${formatBytes(a.Grootte)})` : "";
  return `${a.Naam}${size}`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
