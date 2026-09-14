/**
 * Tier-B Magister logic for the web build (plan v2, §1/§3).
 *
 * The Rust commands in `src-tauri/src/commands/` are thin wrappers around
 * `MagisterClient::get/post/...` plus JSON shaping. Tier A (pure passthrough)
 * is `WebBackend.magister()`; everything here is the shaping half, ported
 * 1:1 so the UI gets byte-identical behavior on web and desktop:
 *
 * - calendar: afspraken+absenties merge, self_url extraction, InfoType
 *   coherence on create (see commands/calendar.rs)
 * - grades: peildatum truncation (full ISO → Magister 500!), multi-format
 *   Items/items/array/CijferVakken parsing, concurrency-5 bulk fetch
 * - messages: query building, /api/ prefix stripping, PATCH/DELETE bodies
 * - assignments: date truncation, hand-in, 3-step blob upload (direct PUT,
 *   browsers handle the CORS preflight themselves)
 *
 * HTML sanitization happens at this boundary, mirroring `api.ts`.
 * Relative imports only (`./backend`, `./sanitize`, `./types`) so this
 * module also runs under plain `node` for unit tests.
 */

import type { MagisterMethod, SessionTokens } from "./backend.ts";
import { sanitizeHtml } from "./sanitize.ts";
import type {
  Absence,
  Assignment,
  CalendarEvent,
  Contact,
  Grade,
  GradeExtraInfo,
  Link,
  Message,
  MessagesFolder,
  Schoolyear,
} from "./types.ts";

/** Minimal Tier-A surface Tier-B builds on. `WebBackend` satisfies this structurally. */
export interface TierA {
  magister<T>(tokens: SessionTokens, method: MagisterMethod, path: string, body?: unknown): Promise<T>;
  /** Raw bytes (photos, files). Optional: helpers needing it fall back when absent. */
  magisterBytes?(tokens: SessionTokens, path: string): Promise<Uint8Array | null>;
}

/** MIME sniff for fetched bytes (PNG/JPEG/GIF magic). */
export function sniffImageMime(bytes: Uint8Array): string {
  if (bytes.length > 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes.length > 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return "image/gif";
  }
  return "image/jpeg";
}

/**
 * Authorized image URL for `<img>` tags. Magister image URLs need a Bearer
 * header, which `<img>` can't send — so same-endpoint images are fetched
 * through the proxy into a Blob object URL. Foreign hosts pass through
 * untouched (browser handles CORS; element onError covers failure).
 * Returns null when unresolvable; callers render a fallback instead.
 */
const authedImageCache = new Map<string, string>();

export async function webAuthedImageUrl(
  be: TierA,
  tokens: SessionTokens,
  url: string | null | undefined,
): Promise<string | null> {
  if (!url) return null;
  const hit = authedImageCache.get(url);
  if (hit) return hit;
  const endpoint = tokens.apiEndpoint.replace(/\/$/, "");
  let resolved: string | null = null;
  if (url.startsWith(endpoint)) {
    const path = url.slice(endpoint.length).replace(/^\//, "");
    try {
      const bytes = await be.magisterBytes?.(tokens, path);
      if (bytes && bytes.length > 0) {
        resolved = URL.createObjectURL(new Blob([bytes as BlobPart], { type: sniffImageMime(bytes) }));
      }
    } catch {
      resolved = null;
    }
  } else if (!/^https?:\/\//.test(url)) {
    resolved = url; // site-relative asset: nothing to authorize
  } else {
    resolved = url; // foreign host: best effort, element onError covers it
  }
  if (resolved) authedImageCache.set(url, resolved);
  return resolved;
}

// ─── Pure helpers (unit-tested) ────────────────────────────────────────────

/** Magister wants YYYY-MM-DD; longer ISO strings cause 500s on some endpoints. */
export function truncateDate(s: string): string {
  return s.length >= 10 ? s.slice(0, 10) : s;
}

/**
 * Normalize a Magister link to an endpoint-relative path. Handles all shapes
 * seen in the wild: `/api/personen/1`, `api/personen/1`, `personen/1`,
 * full `https://host/api/...` URLs are reduced separately by callers.
 * (A previous version stripped leading slashes BEFORE the prefix check,
 * producing `api/api/personen/...` → Magister 404. Never again.)
 */
export function stripApiPrefix(href: string): string {
  const noLead = href.replace(/^\/+/, "");
  return noLead.startsWith("api/") ? noLead.slice("api/".length) : noLead;
}

/**
 * Magister wraps lists inconsistently: `{"Items": [...]}`, `{"items": [...]}`,
 * or a bare array. Returns the array or [] — never throws.
 */
export function itemsArray(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj["Items"])) return obj["Items"] as unknown[];
    if (Array.isArray(obj["items"])) return obj["items"] as unknown[];
  }
  return [];
}

/** Flatten `CijferVakken[*].Cijfers` (grade-overview shape) into one grade list. */
export function extractVakGrades(vakken: unknown): Grade[] {
  if (!Array.isArray(vakken)) return [];
  const out: Grade[] = [];
  for (const vak of vakken) {
    const cijfers = (vak as Record<string, unknown>)?.["Cijfers"];
    if (Array.isArray(cijfers)) {
      for (const c of cijfers) out.push(c as Grade);
    }
  }
  return out;
}

/**
 * Grade endpoints return Items/items/array/CijferVakken/nested-CijferVakken.
 * Mirrors the fallback chain in commands/grades.rs.
 */
export function normalizeGrades(data: unknown): Grade[] {
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    const direct = itemsArray(data);
    if (direct.length > 0 || Array.isArray(obj["Items"]) || Array.isArray(obj["items"])) {
      return direct as Grade[];
    }
    if (Array.isArray(data)) return data as Grade[];
    const flat = extractVakGrades(obj["CijferVakken"]);
    if (flat.length > 0) return flat;
    const nested = (obj["CijferOverzicht"] as Record<string, unknown> | undefined)?.["CijferVakken"];
    const flatNested = extractVakGrades(nested);
    if (flatNested.length > 0) return flatNested;
  }
  if (Array.isArray(data)) return data as Grade[];
  return [];
}

export function selfUrlFromLinks(links: Link[] | null | undefined): string | null {
  const href = links?.find((l) => l.Rel === "Self")?.Href;
  if (!href) return null;
  return stripApiPrefix(href);
}

/**
 * Merge absences into events via the nested `Afspraak.Id`
 * (commands/calendar.rs matches `absence.afspraak.id`, not a scalar).
 */
export function mergeAbsencesIntoEvents(events: CalendarEvent[], absences: Absence[]): CalendarEvent[] {
  const byId = new Map<number, CalendarEvent>();
  for (const e of events) byId.set(e.Id, e);
  for (const a of absences) {
    const targetId = a.Afspraak?.Id ?? a.AfspraakId ?? null;
    if (targetId == null) continue;
    const ev = byId.get(targetId);
    if (ev) ev.merged_absence = a;
  }
  for (const e of events) {
    if (!e.self_url) e.self_url = selfUrlFromLinks(e.Links);
  }
  return events;
}

export function buildMessagesQuery(top?: number, skip?: number, query?: string): string {
  const params = [`top=${top ?? 15}`, `skip=${skip ?? 0}`];
  if (query) params.push(`trefwoorden=${encodeURIComponent(query)}`);
  return params.join("&");
}

export function buildSendMessageBody(p: {
  recipients: number[];
  copyRecipients: number[];
  blindCopyRecipients: number[];
  subject: string;
  htmlContent: string;
  hasPriority: boolean;
  isConcept: boolean;
  sendOption?: string;
  relatedMessageId?: number;
  attachmentIds: number[];
}): { endpoint: string; body: unknown } {
  const refs = (ids: number[]) => ids.map((id) => ({ id, ref_type: "persoon" }));
  return {
    endpoint: p.isConcept ? "berichten/concepten" : "berichten/berichten",
    body: {
      ontvangers: refs(p.recipients),
      kopie_ontvangers: refs(p.copyRecipients),
      blinde_kopie_ontvangers: refs(p.blindCopyRecipients),
      heeft_prioriteit: p.hasPriority,
      inhoud: p.htmlContent,
      onderwerp: p.subject,
      verzend_optie: p.sendOption ?? "standaard",
      gerelateerd_bericht_id: p.relatedMessageId ?? null,
      bijlagen: p.attachmentIds.map((id) => ({ id, ref_type: "upload" })),
    },
  };
}

export function buildPatchBody(messageIds: number[], path: "/IsGelezen" | "/MapId", value: boolean | number): unknown {
  return {
    berichten: messageIds.map((id) => ({
      berichtId: id,
      operations: [{ op: "replace", path, value }],
    })),
  };
}

export function buildDeleteBody(messageIds: number[], areConcepts: boolean): { endpoint: string; body: unknown } {
  return areConcepts
    ? { endpoint: "berichten/concepten", body: messageIds.map((id) => ({ conceptId: id })) }
    : { endpoint: "berichten/berichten", body: messageIds.map((id) => ({ berichtId: id })) };
}

/**
 * Magister validates Inhoud ↔ InfoType coherence: InfoType 0 (Geen) is
 * invalid with non-empty Inhoud, and lesson-bound types 1-5 are rejected
 * for personal appointments — content gets InfoType 7 (Notitie).
 * Mirrors create_calendar_event in commands/calendar.rs.
 */
export function buildCreateEventBody(p: {
  start: string;
  einde: string;
  duurtHeleDag: boolean;
  omschrijving: string;
  lokatie?: string;
  inhoud?: string;
  eventType?: number;
}): unknown {
  const clean = (s?: string) => {
    const t = (s ?? "").trim();
    return t === "" ? undefined : t;
  };
  const inhoud = clean(p.inhoud);
  return {
    Start: p.start,
    Einde: p.einde,
    DuurtHeleDag: p.duurtHeleDag,
    Omschrijving: p.omschrijving.trim(),
    Lokatie: clean(p.lokatie) ?? null,
    Inhoud: inhoud ?? null,
    InfoType: inhoud !== undefined ? 7 : 0,
    Type: p.eventType ?? 1,
    Status: 2,
  };
}

// Sanitizers (same boundary as api.ts).
function sanitizeEvent(e: CalendarEvent): CalendarEvent {
  if (typeof e.Inhoud === "string") e.Inhoud = sanitizeHtml(e.Inhoud);
  return e;
}

function sanitizeMessage(m: Message): Message {
  const rec = m as unknown as Record<string, unknown>;
  if (typeof rec["inhoud"] === "string") rec["inhoud"] = sanitizeHtml(rec["inhoud"] as string);
  return m;
}

function sanitizeAssignment(a: Assignment): Assignment {
  const rec = a as unknown as Record<string, unknown>;
  if (typeof rec["Omschrijving"] === "string") rec["Omschrijving"] = sanitizeHtml(rec["Omschrijving"] as string);
  return a;
}

// ─── Calendar ──────────────────────────────────────────────────────────────

export async function webGetCalendarEvents(
  be: TierA,
  tokens: SessionTokens,
  personId: number,
  start: string,
  end: string,
): Promise<CalendarEvent[]> {
  const s = truncateDate(start);
  const e = truncateDate(end);
  const [eventsData, absencesData] = await Promise.all([
    be.magister<unknown>(tokens, "GET", `personen/${personId}/afspraken?tot=${e}&van=${s}`),
    be.magister<unknown>(tokens, "GET", `personen/${personId}/absenties?tot=${e}&van=${s}`),
  ]);
  const events = itemsArray(eventsData) as CalendarEvent[];
  const absences = itemsArray(absencesData) as Absence[];
  return mergeAbsencesIntoEvents(events, absences).map(sanitizeEvent);
}

export async function webGetAbsences(
  be: TierA,
  tokens: SessionTokens,
  personId: number,
  van: string,
  tot: string,
): Promise<Absence[]> {
  const data = await be.magister<unknown>(
    tokens,
    "GET",
    `personen/${personId}/absenties?van=${truncateDate(van)}&tot=${truncateDate(tot)}`,
  );
  return itemsArray(data) as Absence[];
}

export async function webGetCalendarEvent(
  be: TierA,
  tokens: SessionTokens,
  personId: number,
  eventId: number,
): Promise<CalendarEvent> {
  const event = await be.magister<CalendarEvent>(tokens, "GET", `personen/${personId}/afspraken/${eventId}`);
  event.self_url = `personen/${personId}/afspraken/${eventId}`;
  return sanitizeEvent(event);
}

export async function webCreateCalendarEvent(
  be: TierA,
  tokens: SessionTokens,
  personId: number,
  params: {
    start: string;
    einde: string;
    duurtHeleDag: boolean;
    omschrijving: string;
    lokatie?: string;
    inhoud?: string;
    eventType?: number;
  },
): Promise<void> {
  await be.magister(tokens, "POST", `personen/${personId}/afspraken`, buildCreateEventBody(params));
}

export async function webUpdateCalendarEvent(
  be: TierA,
  tokens: SessionTokens,
  selfUrl: string,
  eventJson: string,
): Promise<void> {
  await be.magister(tokens, "PUT", selfUrl, JSON.parse(eventJson));
}

export async function webDeleteCalendarEvent(be: TierA, tokens: SessionTokens, selfUrl: string): Promise<void> {
  await be.magister(tokens, "DELETE", selfUrl);
}

export async function webToggleCalendarEventDone(
  be: TierA,
  tokens: SessionTokens,
  event: CalendarEvent,
): Promise<void> {
  const updated = { ...event, Afgerond: !event.Afgerond };
  let url = event.self_url;
  if (!url) {
    const href = event.Links?.find((l: Link) => l.Rel === "Self")?.Href;
    if (href) url = stripApiPrefix(href);
  }
  if (!url) throw new Error("No selfUrl found for event");
  await webUpdateCalendarEvent(be, tokens, url, JSON.stringify(updated));
}

/**
 * Web download: resolve Magister's indirection link server-side (JSON
 * `{"location": ...}` wrapper or 302 — browsers swallow the latter silently)
 * and return a Blob for the browser to save.
 */
export async function webDownloadFile(be: TierA, tokens: SessionTokens, url: string): Promise<Blob> {
  let path = stripApiPrefix(url);
  const endpoint = tokens.apiEndpoint.replace(/\/$/, "");
  if (/^https?:\/\//.test(path)) {
    if (!path.startsWith(endpoint)) {
      // Foreign host: fetch directly (browser handles CORS/CSP).
      const res = await fetch(path);
      if (!res.ok) throw new Error(`Download mislukt (HTTP ${res.status})`);
      return await res.blob();
    }
    path = path.slice(endpoint.length).replace(/^\/+/, "");
  }
  const sep = path.includes("?") ? "&" : "?";
  // Fast path: JSON location wrapper answered inline.
  try {
    const first = await be.magister<unknown>(tokens, "GET", path);
    if (first && typeof first === "object" && typeof (first as Record<string, unknown>)["location"] === "string") {
      return await fetchBlob((first as Record<string, unknown>)["location"] as string);
    }
    if (first instanceof Blob) return first;
  } catch {
    // Fall through to byte-level inspection + server-side resolve below.
  }
  // An HTML answer here is a "Doorsturen" redirect page, not file bytes:
  // hand its target back so the UI opens it in a tab instead of saving HTML.
  const raw = await fetchBytes(be, tokens, path);
  if (raw && /<html|<!doctype/i.test(raw.text.trimStart().slice(0, 500))) {
    const redirect = extractHtmlRedirect(raw.text);
    if (redirect) throw new Error(`OPEN_IN_BROWSER:${redirect}`);
  }
  const resolved = await be.magister<{ location?: string }>(tokens, "GET", `${path}${sep}__resolve=1`);
  if (!resolved?.location) throw new Error("Kon downloadlink niet resolven.");
  return await fetchBlob(resolved.location);
}

async function fetchBlob(url: string): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download mislukt (HTTP ${res.status})`);
  return await res.blob();
}

// ─── Grades ────────────────────────────────────────────────────────────────

export async function webGetSchoolyears(
  be: TierA,
  tokens: SessionTokens,
  personId: number,
  start?: string,
  end?: string,
): Promise<Schoolyear[]> {
  const path =
    start !== undefined && end !== undefined
      ? `leerlingen/${personId}/aanmeldingen?begin=${truncateDate(start)}&einde=${truncateDate(end)}`
      : `leerlingen/${personId}/aanmeldingen/`;
  const data = await be.magister<unknown>(tokens, "GET", path);
  return itemsArray(data) as Schoolyear[];
}

export async function webGetGrades(
  be: TierA,
  tokens: SessionTokens,
  personId: number,
  schoolyearId: number,
  einde: string,
): Promise<Grade[]> {
  const peildatum = truncateDate(einde);
  const data = await be.magister<unknown>(
    tokens,
    "GET",
    `personen/${personId}/aanmeldingen/${schoolyearId}/cijfers/cijferoverzichtvooraanmelding` +
      `?actievePerioden=false&alleenBerekendeKolommen=false&alleenPTAKolommen=false&peildatum=${peildatum}`,
  );
  return normalizeGrades(data);
}

export async function webGetGradeExtraInfo(
  be: TierA,
  tokens: SessionTokens,
  personId: number,
  schoolyearId: number,
  kolomId: number,
): Promise<GradeExtraInfo> {
  return be.magister<GradeExtraInfo>(
    tokens,
    "GET",
    `personen/${personId}/aanmeldingen/${schoolyearId}/cijfers/extracijferkolominfo/${kolomId}`,
  );
}

/** Concurrency-5 fan-out; per-item failures are skipped (never fatal). */
export async function webGetBulkGradeExtraInfo(
  be: TierA,
  tokens: SessionTokens,
  fetchOne: (kolomId: number) => Promise<GradeExtraInfo>,
  kolomIds: number[],
  concurrency = 5,
): Promise<Record<number, GradeExtraInfo>> {
  const out: Record<number, GradeExtraInfo> = {};
  const queue = [...kolomIds];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const id = queue.shift();
      if (id === undefined) return;
      try {
        out[id] = await fetchOne(id);
      } catch {
        // Skip failed columns, mirroring the Rust collect-ok behavior.
      }
    }
  });
  await Promise.all(workers);
  return out;
}

export async function webGetRecentGrades(
  be: TierA,
  tokens: SessionTokens,
  personId: number,
  top = 5,
): Promise<Grade[]> {
  const data = await be.magister<unknown>(tokens, "GET", `personen/${personId}/cijfers/laatste?top=${top}&skip=0`);
  return normalizeGrades(data);
}

// ─── Messages ──────────────────────────────────────────────────────────────

export async function webGetMessageFolders(be: TierA, tokens: SessionTokens): Promise<MessagesFolder[]> {
  const data = await be.magister<{ Items?: MessagesFolder[]; items?: MessagesFolder[] }>(
    tokens,
    "GET",
    "berichten/mappen/alle",
  );
  return data.Items ?? data.items ?? [];
}

export async function webGetMessages(
  be: TierA,
  tokens: SessionTokens,
  berichtenLink: string,
  top?: number,
  skip?: number,
  query?: string,
): Promise<Message[]> {
  const link = stripApiPrefix(berichtenLink);
  const data = await be.magister<{ Items?: Message[]; items?: Message[] }>(
    tokens,
    "GET",
    `${link}?${buildMessagesQuery(top, skip, query)}`,
  );
  return (data.Items ?? data.items ?? []).map(sanitizeMessage);
}

export async function webGetMessageDetail(be: TierA, tokens: SessionTokens, selfLink: string): Promise<Message> {
  const msg = await be.magister<Message>(tokens, "GET", stripApiPrefix(selfLink));
  return sanitizeMessage(msg);
}

export async function webSendMessage(
  be: TierA,
  tokens: SessionTokens,
  params: {
    recipients: number[];
    copyRecipients: number[];
    blindCopyRecipients: number[];
    subject: string;
    htmlContent: string;
    hasPriority: boolean;
    isConcept: boolean;
    sendOption?: string;
    relatedMessageId?: number;
    attachmentIds: number[];
  },
): Promise<void> {
  const { endpoint, body } = buildSendMessageBody(params);
  await be.magister(tokens, "POST", endpoint, body);
}

export async function webMarkMessagesAsRead(
  be: TierA,
  tokens: SessionTokens,
  messageIds: number[],
  read: boolean,
): Promise<void> {
  await be.magister(tokens, "PATCH", "berichten/berichten", buildPatchBody(messageIds, "/IsGelezen", read));
}

export async function webMoveMessagesToFolder(
  be: TierA,
  tokens: SessionTokens,
  messageIds: number[],
  folderId: number,
): Promise<void> {
  await be.magister(tokens, "PATCH", "berichten/berichten", buildPatchBody(messageIds, "/MapId", folderId));
}

export async function webDeleteMessages(
  be: TierA,
  tokens: SessionTokens,
  messageIds: number[],
  areConcepts: boolean,
): Promise<void> {
  const { endpoint, body } = buildDeleteBody(messageIds, areConcepts);
  await be.magister(tokens, "DELETE", endpoint, body);
}

export async function webSearchContacts(
  be: TierA,
  tokens: SessionTokens,
  query: string,
  maxResults = 250,
): Promise<Contact[]> {
  const data = await be.magister<{ Items?: Contact[]; items?: Contact[] }>(
    tokens,
    "GET",
    `contacten/personen?q=${encodeURIComponent(query)}&top=${maxResults}&type=alle`,
  );
  return data.Items ?? data.items ?? [];
}

// ─── Assignments ───────────────────────────────────────────────────────────

export async function webGetAssignments(
  be: TierA,
  tokens: SessionTokens,
  personId: number,
  start: string,
  end: string,
): Promise<Assignment[]> {
  const data = await be.magister<{ Items?: Assignment[]; items?: Assignment[] }>(
    tokens,
    "GET",
    `personen/${personId}/opdrachten?van=${truncateDate(start)}&tot=${truncateDate(end)}`,
  );
  return (data.Items ?? data.items ?? []).map(sanitizeAssignment);
}

export async function webGetAssignmentDetail(
  be: TierA,
  tokens: SessionTokens,
  selfUrl: string,
): Promise<Assignment> {
  const detail = await be.magister<Assignment>(tokens, "GET", stripApiPrefix(selfUrl));
  return sanitizeAssignment(detail);
}

export async function webHandInAssignment(
  be: TierA,
  tokens: SessionTokens,
  selfUrl: string,
  opdrachtId: number,
  versionJson: string,
): Promise<void> {
  await be.magister(tokens, "POST", `${stripApiPrefix(selfUrl)}?opdrachtId=${opdrachtId}`, JSON.parse(versionJson));
}

/**
 * 3-step blob upload (mirrors commands/assignments.rs): request slot via
 * Tier-A, then PUT the bytes directly to the returned Azure URI — browsers
 * send the CORS preflight themselves, no proxy needed.
 */
export async function webUploadAssignmentAttachment(
  be: TierA,
  tokens: SessionTokens,
  file: File,
): Promise<[number, string]> {
  const slot = await be.magister<{ id: number; storageId: string; uri: string; method: string }>(
    tokens,
    "POST",
    "bestanden/upload",
    { name: file.name },
  );
  const put = await fetch(slot.uri, {
    method: "PUT",
    headers: {
      "x-ms-blob-content-type": file.type || "application/octet-stream",
      "x-ms-blob-type": "BlockBlob",
    },
    body: file,
  });
  if (!put.ok) throw new Error(`Upload mislukt (HTTP ${put.status})`);
  return [slot.id, slot.storageId];
}

// ─── Export ────────────────────────────────────────────────────────────────
// Mirrors commands/export.rs: the same 9 categories as RAW Magister JSON
// (desktop saves raw responses per file), combined into one download since
// browsers can't write a folder of files.

export interface WebExportResult {
  filename: string;
  files: string[];
  warnings: string[];
  json: string;
}

export async function webExportAllData(
  be: TierA,
  tokens: SessionTokens,
  personId: number,
): Promise<WebExportResult> {
  const now = new Date();
  const year = now.getFullYear();
  const start = `${year}-01-01`;
  const end = `${year}-12-31`;
  const today = todayLocal();

  const settle = async (key: string, fn: () => Promise<unknown>): Promise<[string, unknown, string | null]> => {
    try {
      return [key, await fn(), null];
    } catch (e) {
      return [key, null, `${key}: ${e instanceof Error ? e.message : String(e)}`];
    }
  };

  const gradesChain = async (): Promise<unknown> => {
    const sy = await be.magister<unknown>(
      tokens,
      "GET",
      `leerlingen/${personId}/aanmeldingen?begin=${year - 4}-01-01&einde=${year}-12-31`,
    );
    const first = itemsArray(sy)[0] as Record<string, unknown> | undefined;
    const sid = first?.["Id"] ?? first?.["id"];
    if (sid == null) throw new Error("geen schooljaren gevonden");
    const eindeRaw = (first?.["Einde"] ?? first?.["einde"]) as string | undefined;
    const peildatum = eindeRaw ? truncateDate(eindeRaw) : `${year + 1}-08-01`;
    return be.magister<unknown>(
      tokens,
      "GET",
      `personen/${personId}/aanmeldingen/${sid}/cijfers/cijferoverzichtvooraanmelding` +
        `?actievePerioden=false&alleenBerekendeKolommen=false&alleenPTAKolommen=false&peildatum=${peildatum}`,
    );
  };

  const messagesChain = async (): Promise<unknown> => {
    const folders = await be.magister<unknown>(tokens, "GET", "berichten/mappen/alle");
    const first = itemsArray(folders)[0] as Record<string, unknown> | undefined;
    const inboxId = first?.["Id"] ?? first?.["id"];
    if (inboxId == null) throw new Error("geen inbox-map gevonden");
    return be.magister<unknown>(tokens, "GET", `berichten/mappen/${inboxId}/berichten?top=200&skip=0`);
  };

  const studiewijzersCombined = async (): Promise<unknown> => {
    const [sw, proj] = await Promise.all([
      be.magister<unknown>(tokens, "GET", `leerlingen/${personId}/studiewijzers?peildatum=${today}`).catch(() => null),
      be.magister<unknown>(tokens, "GET", `leerlingen/${personId}/projecten?peildatum=${today}`).catch(() => null),
    ]);
    return { Items: [...itemsArray(sw), ...itemsArray(proj)] };
  };

  const parts = await Promise.all([
    settle("lessen", () => be.magister(tokens, "GET", `personen/${personId}/afspraken?van=${start}&tot=${end}`)),
    settle("cijfers", gradesChain),
    settle("opdrachten", () => be.magister(tokens, "GET", `personen/${personId}/opdrachten?van=${start}&tot=${end}`)),
    settle("berichten", messagesChain),
    settle("afwezigheid", () => be.magister(tokens, "GET", `personen/${personId}/absenties?van=${start}&tot=${end}`)),
    settle("studiewijzers", studiewijzersCombined),
    settle("leermiddelen", () => be.magister(tokens, "GET", `personen/${personId}/lesmateriaal`)),
    settle("bronnen", () => be.magister(tokens, "GET", `personen/${personId}/bronnen?soort=0`)),
    settle("activiteiten", () => be.magister(tokens, "GET", `personen/${personId}/activiteiten`)),
  ]);

  const combined: Record<string, unknown> = { geexporteerdOp: new Date().toISOString() };
  const files: string[] = [];
  const warnings: string[] = [];
  for (const [key, data, err] of parts) {
    if (err) {
      warnings.push(err);
      continue;
    }
    combined[key] = data;
    files.push(`${key}.json`);
  }

  const filename = `friday-export-${today}.json`;
  return { filename, files, warnings, json: JSON.stringify(combined, null, 2) };
}

// ─── Leermiddelen / Activities / Bronnen / Studiewijzers ───────────────────
// All pure Tier-A passthroughs with Items/items tolerance (see
// commands/leermiddelen.rs, activities.rs, bronnen.rs, studiewijzers.rs).
// All pure Tier-A passthroughs with Items/items tolerance (see
// commands/leermiddelen.rs, activities.rs, bronnen.rs, studiewijzers.rs).

export async function webGetLeermiddelen(be: TierA, tokens: SessionTokens, personId: number): Promise<any[]> {
  const data = await be.magister<unknown>(tokens, "GET", `personen/${personId}/lesmateriaal`);
  return itemsArray(data);
}

/**
 * Launch-URL resolve (mirrors get_leermiddel_launch_url): Magister links are
 * indirection links with three answers: a JSON `location` wrapper, a 302
 * (resolved server-side via `__resolve`), or — for publisher books — an
 * HTTP-200 HTML "Doorsturen" page with a meta-refresh/script redirect into
 * federated SSO. Browsers must open that final URL in a tab (it completes
 * login flows our Bearer token can't complete).
 */
export function extractHtmlRedirect(html: string): string | null {
  const meta = html.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]*content=["']?\d+\s*;\s*url=([^"'>\s]+)/i);
  if (meta?.[1]) return meta[1].replace(/&amp;/g, "&");
  const script = html.match(/window\.location(?:\.href)?\s*=\s*["']([^"']+)["']/);
  if (script?.[1]) return script[1].replace(/&amp;/g, "&");
  return null;
}

async function fetchBytes(be: TierA, tokens: SessionTokens, path: string): Promise<{ text: string } | null> {
  if (!be.magisterBytes) return null;
  try {
    const bytes = await be.magisterBytes(tokens, path);
    if (!bytes || bytes.length === 0 || bytes.length > 2 * 1024 * 1024) return null;
    return { text: new TextDecoder("utf-8", { fatal: false }).decode(bytes) };
  } catch {
    return null;
  }
}

export async function webGetLeermiddelLaunchUrl(be: TierA, tokens: SessionTokens, href: string): Promise<string> {
  // Normalize to an endpoint-relative path: same-host absolute URLs are
  // stripped, anything else can't be authorized and is rejected.
  let path = stripApiPrefix(href);
  const endpoint = tokens.apiEndpoint.replace(/\/$/, "");
  if (/^https?:\/\//.test(path)) {
    if (!path.startsWith(endpoint)) throw new Error("Kon de startlink niet openen.");
    path = path.slice(endpoint.length).replace(/^\/+/, "");
  }
  try {
    const data = await be.magister<unknown>(tokens, "GET", path);
    if (data && typeof data === "object" && typeof (data as Record<string, unknown>)["location"] === "string") {
      return (data as Record<string, unknown>)["location"] as string;
    }
    if (typeof data === "string") {
      if (data.startsWith("http")) return data;
      const redirect = extractHtmlRedirect(data);
      if (redirect) return redirect;
    }
  } catch {
    // Fall through to byte-level inspection + server-side resolve below.
  }
  // Same endpoint, raw bytes: catches the HTML "Doorsturen" redirect page
  // that JSON parsing (above) and plain redirects both miss.
  const raw = await fetchBytes(be, tokens, path);
  if (raw) {
    const trimmed = raw.text.trimStart();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const data = JSON.parse(trimmed) as Record<string, unknown>;
        if (typeof data["location"] === "string") return data["location"] as string;
      } catch {
        // Not JSON after all — continue to __resolve.
      }
    } else if (/<html|<!doctype/i.test(trimmed.slice(0, 500))) {
      const redirect = extractHtmlRedirect(raw.text);
      if (redirect) return redirect;
    }
  }
  const sep = path.includes("?") ? "&" : "?";
  const resolved = await be.magister<{ location?: string }>(tokens, "GET", `${path}${sep}__resolve=1`);
  if (resolved?.location) return resolved.location;
  throw new Error("Kon de startlink niet openen.");
}

function sanitizeActivity(a: any): any {
  if (a && typeof a.Details === "string") a.Details = sanitizeHtml(a.Details);
  return a;
}

export async function webGetActivities(be: TierA, tokens: SessionTokens, personId: number): Promise<any[]> {
  const data = await be.magister<unknown>(tokens, "GET", `personen/${personId}/activiteiten`);
  return itemsArray(data).map(sanitizeActivity);
}

export async function webGetActivityElements(
  be: TierA,
  tokens: SessionTokens,
  personId: number,
  activityId: number,
): Promise<any[]> {
  const data = await be.magister<unknown>(
    tokens,
    "GET",
    `personen/${personId}/activiteiten/${activityId}/onderdelen`,
  );
  return itemsArray(data).map(sanitizeActivity);
}

export async function webGetBronnen(be: TierA, tokens: SessionTokens, path: string): Promise<any[]> {
  const data = await be.magister<unknown>(tokens, "GET", stripApiPrefix(path));
  return itemsArray(data);
}

export async function webGetExternalBronSources(be: TierA, tokens: SessionTokens, personId: number): Promise<any[]> {
  const data = await be.magister<unknown>(tokens, "GET", `personen/${personId}/bronnen?soort=0`);
  return itemsArray(data);
}

/** Local YYYY-MM-DD (studiewijzers peildatum uses device-local date in Rust). */
export function todayLocal(): string {
  const d = new Date();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * Studiewijzers + projecten are fetched concurrently and merged; each side
 * failing (or unparsable) only drops that side — mirrors studiewijzers.rs.
 */
export async function webGetStudiewijzers(
  be: TierA,
  tokens: SessionTokens,
  personId: number,
): Promise<any[]> {
  const today = todayLocal();
  const [sw, proj] = await Promise.all([
    be
      .magister<unknown>(tokens, "GET", `leerlingen/${personId}/studiewijzers?peildatum=${today}`)
      .then(itemsArray)
      .catch(() => [] as unknown[]),
    be
      .magister<unknown>(tokens, "GET", `leerlingen/${personId}/projecten?peildatum=${today}`)
      .then(itemsArray)
      .catch(() => [] as unknown[]),
  ]);
  return [...sw, ...proj];
}

function sanitizeStudiewijzerDetail(detail: any): any {
  if (!detail) return detail;
  if (typeof detail.Omschrijving === "string") detail.Omschrijving = sanitizeHtml(detail.Omschrijving);
  const items = detail.Onderdelen?.Items;
  if (Array.isArray(items)) {
    for (const onderdeel of items) {
      if (onderdeel && typeof onderdeel.Omschrijving === "string") {
        onderdeel.Omschrijving = sanitizeHtml(onderdeel.Omschrijving);
      }
    }
  }
  return detail;
}

export async function webGetStudiewijzerDetail(
  be: TierA,
  tokens: SessionTokens,
  personId: number,
  id: number,
  isProject: boolean,
): Promise<any> {
  const base = isProject ? "projecten" : "studiewijzers";
  const detail = await be.magister<any>(tokens, "GET", `leerlingen/${personId}/${base}/${id}`);
  return sanitizeStudiewijzerDetail(detail);
}

export async function webGetStudiewijzerOnderdeelDetail(
  be: TierA,
  tokens: SessionTokens,
  personId: number,
  swId: number,
  onderdeelId: number,
  isProject: boolean,
): Promise<any> {
  const base = isProject ? "projecten" : "studiewijzers";
  const detail = await be.magister<any>(
    tokens,
    "GET",
    `leerlingen/${personId}/${base}/${swId}/onderdelen/${onderdeelId}?gebruikMappenStructuur=true`,
  );
  return sanitizeStudiewijzerDetail(detail);
}
