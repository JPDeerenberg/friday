/**
 * Browser port of `src-tauri/src/ai/tools.rs` (including the AI-Schedule
 * family since Phase 7): same tool names, same Dutch descriptions, same
 * argument shapes, same simplified/redacted result shapes, same
 * stage-then-confirm write semantics (15-min TTL pending store).
 *
 * Reads run against Tier-A raw JSON (like the Rust `client.get` calls);
 * privacy redaction of teacher names is applied before anything reaches the
 * model — the regular UI is unaffected.
 */

import type { MagisterMethod, SessionTokens } from "./backend.ts";
import type { TierA } from "./web-tier-b.ts";
import {
  addDays,
  currentTimeJson,
  diffDays,
  getContextWindow,
  isValidDateStr,
  todayAmsterdam,
} from "./ai-time.ts";
import {
  webAppendNote,
  webEditNote,
  webReadNotes,
  webReplaceNote,
} from "./ai-notes.ts";
import { getToolsSpec } from "./ai-spec.ts";
import {
  DEFAULT_PAGE_CHARS,
  MAX_DOWNLOAD_BYTES,
  cacheGet,
  cachePut,
  capExtracted,
  extractText,
  isEmptyText,
  isReadableExtension,
  pageText,
  registryGet,
  registryPut,
  unsupportedReason,
  validateAttachmentUrl,
} from "./ai-files.ts";
import type { AiScheduleItem } from "./ai-schedule-types.ts";
import {
  aiCreatePlanItem,
  aiUpdatePlanItem,
  completeAiScheduleItem,
  deleteAiScheduleItem,
  dismissAiScheduleItem,
  getAiSchedule,
  getAiScheduleItem,
  getFreeSlots,
  getPlanSettings,
  moveAiScheduleItem,
  setHomeworkDuration,
  toPlanLessons,
  undoLastAiPlanChange,
  updateAiSchedule,
  PlanGuardrailError,
} from "./ai-schedule.ts";
import type { PlanLesson } from "./web-planner.ts";
import { loadWebAiConfig } from "./web-ai-store.ts";

/** AI-Geheugen schrijftools (sequentieel uitvoeren, nooit parallel). */
export const NOTES_WRITE_TOOLS = ["append_note", "edit_note", "replace_notes"];

/** Alle AI-Geheugen tools (lezen + schrijven). */
export const NOTES_TOOLS = ["read_notes", ...NOTES_WRITE_TOOLS];

/** Max AI plan item writes per turn (bulk cap). Mirrors Rust. */
export const MAX_PLAN_WRITES_PER_TURN = 10;

/** Plan-mutating tools covered by the bulk cap (run_update excluded: single
 * planned op with already-bounded output). */
export const PLAN_WRITE_TOOLS = [
  "create_ai_schedule_item",
  "update_ai_schedule_item",
  "complete_ai_schedule_item",
  "dismiss_ai_schedule_item",
  "delete_ai_schedule_item",
  "move_ai_schedule_item",
  "set_homework_duration",
];

/** Setting-gate voor schrijfacties: uit = alleen lezen. Faalt open — de
 * opslagfout zelf is dan de zichtbare fout. */
async function notesWritable(): Promise<boolean> {
  try {
    return (await loadWebAiConfig()).notesAiCanEdit !== false;
  } catch {
    return true;
  }
}

/** Structured unreadable-file result (keeps the reason visible to the model). */
function unreadable(tool: string, reason: string): WebToolResult {
  return {
    tool,
    success: false,
    data: { readable: false, reason },
    error: reason,
  };
}

function baseNameOf(url: string): string {
  const clean = url.split("?")[0].split("#")[0];
  const last = clean.replace(/\/+$/, "").split("/").pop() ?? "";
  return last || "bijlage";
}

function subjectNameOf(v: unknown): string | null {
  if (typeof v === "string" && v.trim()) return v.trim();
  const r = asRecord(v);
  if (!r) return null;
  for (const k of ["Omschrijving", "Afkorting", "Naam"]) {
    const s = r[k];
    if (typeof s === "string" && s.trim()) return s.trim();
  }
  return null;
}

function extensionOf(name: string): string {
  const base = name.toLowerCase().split("?")[0];
  const dot = base.lastIndexOf(".");
  if (dot < 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1);
}

interface HarvestedFile {
  file_id: string;
  name: string;
  extension: string;
  size_bytes: number | null;
  source: string;
  context: {
    subject: string | null;
    title: string | null;
    due: string | null;
    date: string | null;
  };
  readable: boolean;
  url: string;
}

function harvestBijlagen(
  out: HarvestedFile[],
  source: string,
  parentId: string,
  bijlagen: unknown,
  context: HarvestedFile["context"],
): void {
  if (!Array.isArray(bijlagen)) return;
  bijlagen.forEach((b, idx) => {
    const r = asRecord(b) ?? {};
    const url =
      (r["Url"] as string | undefined) ??
      (r["url"] as string | undefined) ??
      "";
    if (!url) return;
    const name =
      (r["Naam"] as string | undefined) ??
      (r["naam"] as string | undefined) ??
      "bijlage";
    const rawId =
      (r["Id"] as number | undefined) ?? (r["id"] as number | undefined);
    const attachmentId = typeof rawId === "number" ? `${rawId}` : `idx${idx}`;
    const fileId = `${source.slice(0, 1)}:${parentId}:${attachmentId}`;
    const sizeRaw =
      (r["Grootte"] as number | undefined) ??
      (r["grootte"] as number | undefined);
    registryPut(fileId, { url, name, source });
    out.push({
      file_id: fileId,
      name,
      extension: extensionOf(name),
      size_bytes: typeof sizeRaw === "number" && sizeRaw >= 0 ? sizeRaw : null,
      source,
      context,
      readable: isReadableExtension(name, false),
      url,
    });
  });
}

/** Default-folder message list link (first folder, like get_messages). */
async function inboxMessageLink(ctx: WebToolContext): Promise<string> {
  const foldersData = await get(ctx.be, ctx.tokens, "berichten/mappen/alle");
  const folders = itemsOf(foldersData);
  const f = asRecord(folders[0]) ?? {};
  const arr = f["Links"];
  let link = "";
  if (Array.isArray(arr) && arr[0]) {
    const l0 = asRecord(arr[0]) ?? {};
    link = ((l0["Href"] ?? l0["href"]) as string | undefined) ?? "";
  }
  if (!link) {
    const fid = (f["Id"] ?? f["id"]) as number | undefined;
    if (typeof fid === "number" && fid !== 0)
      link = `berichten/mappen/${fid}/berichten`;
  } else {
    link = link.replace(/^\/api\//, "").replace(/^\//, "");
  }
  if (!link) throw new Error("Geen berichtenlink gevonden.");
  return link;
}

/** Fetch day lessons for plan guardrails (best-effort: empty + unchecked). */
async function fetchPlanLessons(
  ctx: WebToolContext,
  start?: string,
  end?: string,
): Promise<{ lessons: PlanLesson[]; checked: boolean }> {
  const van = (start ?? "").slice(0, 10);
  const tot = (end ?? van).slice(0, 10);
  if (!van) return { lessons: [], checked: false };
  try {
    const data = await get(
      ctx.be,
      ctx.tokens,
      `personen/${ctx.personId}/afspraken?tot=${tot}&van=${van}`,
    );
    return { lessons: toPlanLessons(itemsOf(data)), checked: true };
  } catch {
    return { lessons: [], checked: false };
  }
}

export interface WebToolDef {
  name: string;
  description: string;
  parameters: unknown;
}

export interface WebToolResult {
  tool: string;
  success: boolean;
  data: unknown;
  error: string | null;
}

export interface WebToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface PendingAction {
  action_id: string;
  action_type: string;
  recipients?: Array<{ id: number; type?: string }>;
  subject?: string;
  body?: string;
  message?: string;
  message_ids?: number[];
  start?: string;
  einde?: string;
  omschrijving?: string;
  // Raw staged args for replay on confirm.
  args: Record<string, unknown>;
  created_at: number;
}

export const PENDING_ACTION_TTL_SECS = 15 * 60;
const pendingActions = new Map<
  string,
  { action: PendingAction; args: Record<string, unknown>; createdAt: number }
>();

function generateActionId(): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 16)
      : Math.floor(Math.random() * 0xffffffff)
          .toString(16)
          .padStart(8, "0") +
        Math.floor(Math.random() * 0xffffffff)
          .toString(16)
          .padStart(8, "0");
  return `act-${Date.now().toString(16)}-${rand}`;
}

function prunePendingActions(): void {
  const now = Date.now() / 1000;
  for (const [id, entry] of pendingActions) {
    if (now - entry.createdAt > PENDING_ACTION_TTL_SECS)
      pendingActions.delete(id);
  }
}

function stageAction(
  actionType: string,
  args: Record<string, unknown>,
): string {
  prunePendingActions();
  const action_id = generateActionId();
  pendingActions.set(action_id, {
    action: {
      action_id,
      action_type: actionType,
      args,
      created_at: Date.now() / 1000,
    } as PendingAction,
    args,
    createdAt: Date.now() / 1000,
  });
  return action_id;
}

/** Test hook: inspect staged actions. */
export function __pendingForTests(): Map<
  string,
  { args: Record<string, unknown>; createdAt: number }
> {
  const out = new Map<
    string,
    { args: Record<string, unknown>; createdAt: number }
  >();
  for (const [id, entry] of pendingActions)
    out.set(id, { args: entry.args, createdAt: entry.createdAt });
  return out;
}

/** Test hook: clear staged actions. */
export function __clearPendingForTests(): void {
  pendingActions.clear();
}

// ─── Tool definitions (same names + Dutch copy as desktop) ─────────────────

// ─── Tool definitions (generated from shared/ai-spec/tools.json) ─────────────
// Single source of truth (see src/lib/ai-spec.ts). Do not hand-edit defs
// here — edit the spec; src/lib/ai-parity.test.ts fails CI on drift.
export const WEB_TOOL_DEFS: WebToolDef[] = getToolsSpec().tools.map((t) => ({
  name: t.name,
  description: t.description,
  parameters: t.parameters,
}));

// ─── Privacy redaction (port of redact_docent & co.) ───────────────────────

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asStr(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** Teacher object → {id, code?, naam: code-or-last-name}. Never full names to the model. */
export function redactDocent(v: unknown): Record<string, unknown> {
  const r = asRecord(v) ?? {};
  const code = asStr(r["Docentcode"])?.trim();
  const naam = asStr(r["Naam"])?.trim() ?? "";
  const redactedNaam =
    code && code.length > 0
      ? code
      : naam
        ? (() => {
            const last = naam.split(/\s+/).filter(Boolean).pop() ?? naam;
            return last.split(",")[0].replace(/^[(),]+|[(),]+$/g, "");
          })()
        : "";
  const id = r["Id"] ?? null;
  return code && code.length > 0
    ? { id, code, naam: redactedNaam }
    : { id, naam: redactedNaam };
}

export function redactDocentenArray(
  arr: unknown[] | null | undefined,
): unknown[] {
  if (!Array.isArray(arr)) return [];
  return arr.map(redactDocent);
}

/** Plain teacher-name string → code in parentheses, else last name only. */
export function redactTeacherNameStr(name: string): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return "";
  const open = trimmed.lastIndexOf("(");
  const close = trimmed.lastIndexOf(")");
  if (open >= 0 && close > open + 1) {
    const code = trimmed.slice(open + 1, close).trim();
    if (code && code.length <= 10 && /^[A-Za-z0-9\-_]+$/.test(code))
      return code;
  }
  return trimmed;
}

// ─── Grade math (exact port of grade_calc.rs rules + formatting) ───────────

export interface GradePoint {
  value: number;
  weight: number;
}

export function weightedSum(points: GradePoint[]): [number, number] {
  let p = 0;
  let w = 0;
  for (const g of points) {
    p += g.value * g.weight;
    w += g.weight;
  }
  return [p, w];
}

export function parseDutchGrade(s: string): number | null {
  const v = Number(String(s).trim().replace(",", "."));
  return Number.isFinite(v) ? v : null;
}

function fmt(v: number, decimals: number): string {
  return v.toFixed(decimals);
}

export function requiredGrade(
  totalPoints: number,
  totalWeight: number,
  targetAverage: number,
  gradeWeight: number,
  simulation: GradePoint[],
  decimalPoints: number,
): string {
  if (totalWeight === 0) return "?";
  const [sp, sw] = weightedSum(simulation);
  const cp = totalPoints + sp;
  const cw = totalWeight + sw;
  const required = (targetAverage * (cw + gradeWeight) - cp) / gradeWeight;
  if (required > 10) return "Onmogelijk (>10)";
  if (required < 1) return "1.0";
  return fmt(required, decimalPoints);
}

export function predictedAverage(
  totalPoints: number,
  totalWeight: number,
  simulation: GradePoint[],
  includeSimulation: boolean,
  decimalPoints: number,
): string {
  const [sp, sw] = weightedSum(simulation);
  const tp = totalPoints + (includeSimulation ? sp : 0);
  const tw = totalWeight + (includeSimulation ? sw : 0);
  return tw > 0 ? fmt(tp / tw, decimalPoints) : "0";
}

export type MinGradeForPass =
  | { kind: "needed"; value: string }
  | { kind: "already_passing" }
  | { kind: "impossible" };

export function minGradeForPass(
  totalPoints: number,
  totalWeight: number,
  threshold: number,
): MinGradeForPass {
  if (totalWeight === 0) return { kind: "impossible" };
  const required = (threshold * (totalWeight + 1) - totalPoints) / 1;
  if (required <= 1) return { kind: "already_passing" };
  if (required > 10) return { kind: "impossible" };
  return { kind: "needed", value: required.toFixed(1) };
}

export function averageForGrade(
  totalPoints: number,
  totalWeight: number,
  grade: number,
  weight: number,
  decimalPoints: number,
): string {
  const tp = totalPoints + grade * weight;
  const tw = totalWeight + weight;
  return tw > 0 ? fmt(tp / tw, decimalPoints) : "0";
}

export function newOverallAverage(
  subjects: Array<[string, number]>,
  subjectName: string,
  replacementAvg: number,
  decimalPoints: number,
): string {
  const valid = subjects.filter(([, avg]) => avg > 0);
  if (valid.length === 0) return fmt(replacementAvg, decimalPoints);
  const total = valid.reduce(
    (s, [name, avg]) =>
      s +
      (name.toLowerCase() === subjectName.toLowerCase() ? replacementAvg : avg),
    0,
  );
  return fmt(total / valid.length, decimalPoints);
}

export function predictedEnd(
  totalPoints: number,
  totalWeight: number,
  remainingTests: number,
  expectedGrade: number,
): number {
  const pp = totalPoints + expectedGrade * remainingTests;
  const pw = totalWeight + remainingTests;
  return pw > 0 ? pp / pw : 0;
}

function numOrNull(v: number): number | null {
  return Number.isFinite(v) ? v : null;
}

// ─── Tool execution context ────────────────────────────────────────────────

export interface WebToolContext {
  be: TierA;
  tokens: SessionTokens;
  personId: number;
}

function ok(tool: string, data: unknown): WebToolResult {
  return { tool, success: true, data, error: null };
}

function fail(tool: string, error: unknown): WebToolResult {
  return {
    tool,
    success: false,
    data: null,
    error: error instanceof Error ? error.message : String(error),
  };
}

function itemsOf(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  const r = asRecord(data);
  if (!r) return [];
  if (Array.isArray(r["Items"])) return r["Items"] as unknown[];
  if (Array.isArray(r["items"])) return r["items"] as unknown[];
  return [];
}

async function get(
  be: TierA,
  tokens: SessionTokens,
  path: string,
): Promise<unknown> {
  return be.magister<unknown>(tokens, "GET", path);
}

function strArg(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === "string" ? v : "";
}

function intArg(
  args: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const v = args[key];
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : fallback;
}

/** Resolve scenario grades: explicit array, or overview lookup by schoolyear+subject. */
async function resolveScenarioGrades(
  ctx: WebToolContext,
  args: Record<string, unknown>,
  peildatum: string,
): Promise<{
  tp: number;
  tw: number;
  count: number;
  subjectName: string;
  allSubjects: Array<[string, number]>;
}> {
  let subjectName = strArg(args, "subject");
  const arr = args["grades"];
  if (Array.isArray(arr)) {
    const points: GradePoint[] = [];
    for (const g of arr) {
      const r = asRecord(g);
      if (!r) continue;
      let value: number | null = null;
      if (typeof r["value"] === "number") value = r["value"] as number;
      else if (typeof r["cijfer"] === "number") value = r["cijfer"] as number;
      else if (typeof r["cijfer"] === "string")
        value = parseDutchGrade(r["cijfer"] as string);
      if (value == null) continue;
      const weight =
        typeof r["weight"] === "number"
          ? (r["weight"] as number)
          : typeof r["weging"] === "number"
            ? (r["weging"] as number)
            : 1;
      points.push({ value, weight });
    }
    const [tp, tw] = weightedSum(points);
    return { tp, tw, count: points.length, subjectName, allSubjects: [] };
  }

  const schoolyearId = intArg(args, "schoolyear_id", 0);
  const query = subjectName.trim().toLowerCase();
  if (!schoolyearId || !query) {
    throw new Error(
      "Geef `grades` (lijst van {value, weight}) óf `schoolyear_id` + `subject` op.",
    );
  }
  const data = (await get(
    ctx.be,
    ctx.tokens,
    `personen/${ctx.personId}/aanmeldingen/${schoolyearId}/cijfers/cijferoverzichtvooraanmelding?actievePerioden=false&alleenBerekendeKolommen=false&alleenPTAKolommen=false&peildatum=${peildatum}`,
  )) as Record<string, unknown>;
  const rawVakken =
    data["CijferVakken"] ??
    asRecord(data["CijferOverzicht"])?.["CijferVakken"] ??
    [];
  const vakken = Array.isArray(rawVakken) ? rawVakken : [];

  const vakName = (vak: unknown): string =>
    (asRecord(asRecord(vak)?.["Vak"])?.["Omschrijving"] as
      string | undefined) ?? "";
  const vakAbbr = (vak: unknown): string =>
    (asRecord(asRecord(vak)?.["Vak"])?.["Afkorting"] as string | undefined) ??
    "";

  const allSubjects: Array<[string, number]> = [];
  for (const vak of vakken) {
    const [tp, tw] = subjectTotals(vak);
    const name = vakName(vak);
    if (tw > 0) allSubjects.push([name, tp / tw]);
  }
  const found = vakken.find((vak) => {
    const name = vakName(vak).toLowerCase();
    const abbr = vakAbbr(vak).toLowerCase();
    return (
      name === query ||
      abbr === query ||
      (name !== "" && name.includes(query)) ||
      (query !== "" && query.includes(name))
    );
  });
  if (!found) {
    const known = vakken.map(vakName).filter(Boolean).join(", ");
    throw new Error(
      `Vak '${query}' niet gevonden in het cijferoverzicht. Bekende vakken: ${known}`,
    );
  }
  subjectName = vakName(found) || subjectName;
  const [tp, tw, count] = subjectTotals(found);
  return { tp, tw, count, subjectName, allSubjects };
}

function subjectTotals(vak: unknown): [number, number, number] {
  let tp = 0;
  let tw = 0;
  let count = 0;
  const cijfers = asRecord(vak)?.["Cijfers"];
  if (!Array.isArray(cijfers)) return [tp, tw, count];
  for (const c of cijfers) {
    const r = asRecord(c);
    if (!r) continue;
    const s = asStr(r["CijferStr"]) ?? "";
    if (!s) continue;
    if (r["TeltMee"] === false) continue;
    const val = parseDutchGrade(s);
    if (val == null) continue;
    const w = typeof r["Weging"] === "number" ? (r["Weging"] as number) : 1;
    tp += val * w;
    tw += w;
    count += 1;
  }
  return [tp, tw, count];
}

/** Resolve an indirection link to bytes via the server __resolve + proxy. */
async function resolveToBytes(
  ctx: WebToolContext,
  url: string,
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  let path = url.replace(/^\/+/, "").replace(/^api\//, "");
  const endpoint = ctx.tokens.apiEndpoint.replace(/\/$/, "");
  if (/^https?:\/\//.test(path)) {
    if (!path.startsWith(endpoint)) return null;
    path = path.slice(endpoint.length).replace(/^\/+/, "");
  }
  const sep = path.includes("?") ? "&" : "?";
  try {
    const resolved = await ctx.be.magister<{ location?: string }>(
      ctx.tokens,
      "GET",
      `${path}${sep}__resolve=1`,
    );
    if (!resolved?.location) return null;
    let loc = resolved.location;
    if (loc.startsWith(endpoint))
      loc = loc.slice(endpoint.length).replace(/^\/+/, "");
    else if (/^https?:\/\//.test(loc)) return null; // foreign target: don't proxy blindly
    const bytes = await ctx.be.magisterBytes?.(ctx.tokens, loc);
    if (!bytes) return null;
    return { bytes, contentType: "application/octet-stream" };
  } catch {
    return null;
  }
}

// ─── Phase 2: agenda windowing + pagination (mirrors Rust tools.rs) ─────────

/** Max agenda span per get_calendar_events call (clamped, never an error). */
export const CALENDAR_MAX_SPAN_DAYS = 62;
/** Default page size for range tools. */
export const CALENDAR_DEFAULT_LIMIT = 60;
/** Hard cap per page. */
export const CALENDAR_MAX_LIMIT = 200;

export interface CalendarRange {
  /** Requested range after default-window fill, before clamping. */
  start: string;
  end: string;
  /** Effective end after the 62-day clamp. */
  effectiveEnd: string;
  clamped: boolean;
  windowDefault: { start: string; end: string };
}

/**
 * Resolve a (possibly partial) model-supplied range to the effective fetch
 * range. Omitted sides fall back to the 3-week default window; spans over
 * 62 days are clamped, never rejected. Throws on malformed dates.
 */
export function resolveCalendarRange(
  startArg: string,
  endArg: string,
  today: string,
): CalendarRange {
  const win = getContextWindow(today);
  const start = startArg || win.start;
  const end = endArg || win.end;
  if (!isValidDateStr(start) || !isValidDateStr(end)) {
    throw new Error(
      `Ongeldige datum (verwacht yyyy-MM-dd): '${startArg}' t/m '${endArg}'. Vraag get_current_time om 'vandaag'.`,
    );
  }
  if (diffDays(start, end) < 0) {
    throw new Error(
      `Einddatum ${end} ligt voor startdatum ${start}. Wissel ze om.`,
    );
  }
  let effectiveEnd = end;
  let clamped = false;
  if (diffDays(start, end) > CALENDAR_MAX_SPAN_DAYS) {
    effectiveEnd = addDays(start, CALENDAR_MAX_SPAN_DAYS);
    clamped = true;
  }
  return { start, end, effectiveEnd, clamped, windowDefault: win };
}

export interface Page<T> {
  page: T[];
  truncated: boolean;
  nextOffset: number | null;
}

/** Slice a sorted list into a page; `nextOffset` continues the round-trip. */
export function paginateItems<T>(
  items: T[],
  offset: number,
  limit: number,
): Page<T> {
  const safeOffset = Number.isFinite(offset)
    ? Math.max(0, Math.trunc(offset))
    : 0;
  const safeLimit = Number.isFinite(limit)
    ? Math.min(CALENDAR_MAX_LIMIT, Math.max(1, Math.trunc(limit)))
    : CALENDAR_DEFAULT_LIMIT;
  const page = items.slice(safeOffset, safeOffset + safeLimit);
  const truncated = safeOffset + safeLimit < items.length;
  return {
    page,
    truncated,
    nextOffset: truncated ? safeOffset + safeLimit : null,
  };
}

/** Cut to 120 chars without splitting a surrogate pair. */
function cut120(s: string): string {
  if (Array.from(s).length <= 120) return s;
  return `${Array.from(s).slice(0, 120).join("")}…`;
}

/**
 * Slim one raw afspraak to the compact model shape. Nulls/empties are
 * dropped; teacher names stay redacted; the long homework text (`Inhoud`)
 * lives behind get_calendar_event_detail.
 */
export function slimCalendarEvent(item: unknown): Record<string, unknown> {
  const r = asRecord(item) ?? {};
  const out: Record<string, unknown> = {};
  const set = (k: string, v: unknown): void => {
    if (v === null || v === undefined || v === "") return;
    out[k] = v;
  };
  set("id", r["Id"] ?? null);
  const start = typeof r["Start"] === "string" ? (r["Start"] as string) : "";
  const einde = typeof r["Einde"] === "string" ? (r["Einde"] as string) : "";
  if (/^\d{4}-\d{2}-\d{2}/.test(start)) set("date", start.slice(0, 10));
  set("start", start || null);
  set("end", einde || null);
  const vakken = r["Vakken"];
  if (Array.isArray(vakken)) set("vak", asRecord(vakken[0])?.["Naam"] ?? null);
  const docenten = r["Docenten"];
  if (Array.isArray(docenten) && docenten.length > 0) {
    const naam = redactDocent(docenten[0])["naam"];
    set("docent", typeof naam === "string" && naam ? naam : null);
  }
  const lokalen = r["Lokalen"];
  if (Array.isArray(lokalen))
    set("lokaal", asRecord(lokalen[0])?.["Naam"] ?? null);
  const omschrijving =
    typeof r["Omschrijving"] === "string" ? (r["Omschrijving"] as string) : "";
  if (omschrijving.trim()) set("omschrijving", cut120(omschrijving));
  const inhoud = typeof r["Inhoud"] === "string" ? (r["Inhoud"] as string) : "";
  out["huiswerk"] = inhoud.trim().length > 0;
  set("type", r["Type"] ?? null);
  set("afgerond", r["Afgerond"] ?? null);
  return out;
}

/** Main dispatch — mirrors Rust `execute_tool` arm for arm. */
export async function executeWebTool(
  ctx: WebToolContext,
  toolName: string,
  rawArgs: unknown,
): Promise<WebToolResult> {
  // Some providers send arguments as a JSON string; a model can send junk.
  // Never throw on it (plan item 2).
  let parsed: unknown = rawArgs;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return fail(
        toolName,
        "Ongeldige argumenten: geen geldige JSON, probeer opnieuw.",
      );
    }
  }
  const args = (asRecord(parsed) ?? {}) as Record<string, unknown>;
  const pid = ctx.personId;
  try {
    switch (toolName) {
      case "get_calendar_events": {
        const startArg = strArg(args, "start").slice(0, 10);
        const endArg = strArg(args, "end").slice(0, 10);
        const offset = intArg(args, "offset", 0);
        const limit = intArg(args, "limit", CALENDAR_DEFAULT_LIMIT);
        let range: CalendarRange;
        try {
          range = resolveCalendarRange(startArg, endArg, todayAmsterdam());
        } catch (e) {
          return fail(toolName, e);
        }
        const data = await get(
          ctx.be,
          ctx.tokens,
          `personen/${pid}/afspraken?tot=${range.effectiveEnd}&van=${range.start}`,
        );
        const sorted = itemsOf(data)
          .map(slimCalendarEvent)
          .sort((a, b) => {
            const sa = `${a["start"] ?? ""}`;
            const sb = `${b["start"] ?? ""}`;
            return sa < sb ? -1 : sa > sb ? 1 : 0;
          });
        const { page, truncated, nextOffset } = paginateItems(
          sorted,
          offset,
          limit,
        );
        const days: Array<{ date: string; count: number }> = [];
        for (const item of page) {
          const d = item["date"];
          if (typeof d !== "string") continue;
          const last = days[days.length - 1];
          if (last && last.date === d) last.count += 1;
          else days.push({ date: d, count: 1 });
        }
        return ok(toolName, {
          items: page,
          count: page.length,
          days,
          meta: {
            requested: { start: range.start, end: range.end },
            effective: { start: range.start, end: range.effectiveEnd },
            clamped: range.clamped,
            returned: page.length,
            total: sorted.length,
            truncated,
            next_offset: nextOffset,
            window_default: range.windowDefault,
          },
        });
      }

      case "get_calendar_event_detail": {
        const id = intArg(args, "id", 0);
        if (!id) return fail(toolName, "Geen geldig agenda-item ID opgegeven.");
        const dateArg = strArg(args, "date").slice(0, 10) || todayAmsterdam();
        if (!isValidDateStr(dateArg)) {
          return fail(
            toolName,
            `Ongeldige datum '${dateArg}' (verwacht yyyy-MM-dd).`,
          );
        }
        const data = await get(
          ctx.be,
          ctx.tokens,
          `personen/${pid}/afspraken?tot=${dateArg}&van=${dateArg}`,
        );
        const found = itemsOf(data).find(
          (item) => (asRecord(item) ?? {})["Id"] === id,
        );
        if (!found) {
          return fail(
            toolName,
            `Agenda-item ${id} niet gevonden op ${dateArg}. Roep get_calendar_events aan voor het juiste bereik en probeer opnieuw.`,
          );
        }
        const r = asRecord(found) ?? {};
        const docenten = r["Docenten"];
        const inhoud =
          typeof r["Inhoud"] === "string" ? (r["Inhoud"] as string) : "";
        return ok(toolName, {
          id: r["Id"] ?? null,
          date: dateArg,
          start: r["Start"] ?? null,
          end: r["Einde"] ?? null,
          vak: Array.isArray(r["Vakken"])
            ? (asRecord(r["Vakken"][0])?.["Naam"] ?? null)
            : null,
          docent: Array.isArray(docenten) ? redactDocentenArray(docenten) : [],
          lokaal: Array.isArray(r["Lokalen"])
            ? (asRecord(r["Lokalen"][0])?.["Naam"] ?? null)
            : null,
          lesuur: r["LesuurVan"] ?? null,
          omschrijving: r["Omschrijving"] ?? null,
          inhoud: inhoud || null,
          huiswerk: inhoud.trim().length > 0,
          afgerond: r["Afgerond"] ?? null,
          type: r["Type"] ?? null,
          status: r["Status"] ?? null,
        });
      }

      case "get_grades": {
        const top = Math.min(intArg(args, "top", 10), 20);
        const data = await get(
          ctx.be,
          ctx.tokens,
          `personen/${pid}/cijfers/laatste?top=${top}&skip=0`,
        );
        const simplified = itemsOf(data).map((item) => {
          const r = asRecord(item) ?? {};
          const dv = r["Docent"];
          let docent: unknown = null;
          if (typeof dv === "string") docent = redactTeacherNameStr(dv);
          else if (asRecord(dv))
            docent = (redactDocent(dv)["naam"] ?? null) as unknown;
          const kolom = asRecord(r["CijferKolom"]) ?? {};
          const vak = asRecord(r["Vak"]) ?? {};
          return {
            id: r["Id"] ?? null,
            vak: vak["Omschrijving"] ?? null,
            cijfer: r["CijferStr"] ?? null,
            datum: r["DatumIngevoerd"] ?? null,
            weging: kolom["Weging"] ?? null,
            docent,
            titel: kolom["Titel"] ?? null,
          };
        });
        // Magister exposes no list total here; total == returned (bound by top).
        return ok(toolName, {
          items: simplified,
          count: simplified.length,
          total: simplified.length,
        });
      }

      case "get_full_grade_overview": {
        const schoolyearId = intArg(args, "schoolyear_id", 0);
        const einde = strArg(args, "einde");
        const peildatum = einde.length > 10 ? einde.slice(0, 10) : einde;
        const data = (await get(
          ctx.be,
          ctx.tokens,
          `personen/${pid}/aanmeldingen/${schoolyearId}/cijfers/cijferoverzichtvooraanmelding?actievePerioden=false&alleenBerekendeKolommen=false&alleenPTAKolommen=false&peildatum=${peildatum}`,
        )) as Record<string, unknown>;
        const rawVakken =
          data["CijferVakken"] ??
          asRecord(data["CijferOverzicht"])?.["CijferVakken"] ??
          [];
        const simplified = (Array.isArray(rawVakken) ? rawVakken : []).map(
          (vak) => {
            const v = asRecord(vak) ?? {};
            const vv = asRecord(v["Vak"]) ?? {};
            const cijfers = (
              Array.isArray(v["Cijfers"]) ? (v["Cijfers"] as unknown[]) : []
            ).map((c) => {
              const cc = asRecord(c) ?? {};
              const ck = asRecord(cc["CijferKolom"]) ?? {};
              return {
                cijfer: cc["CijferStr"] ?? null,
                datum: cc["DatumIngevoerd"] ?? null,
                weging: cc["Weging"] ?? null,
                titel: ck["Titel"] ?? null,
              };
            });
            return {
              vak: vv["Omschrijving"] ?? vv["Afkorting"] ?? null,
              gemiddelde: v["Gemiddelde"] ?? null,
              cijfers,
            };
          },
        );
        return ok(toolName, {
          vakken: simplified,
          count: simplified.length,
          peildatum,
        });
      }

      case "get_schoolyears": {
        const today = todayAmsterdam();
        const data = await get(
          ctx.be,
          ctx.tokens,
          `leerlingen/${pid}/aanmeldingen?begin=2013-01-01&einde=${today}`,
        );
        const simplified = itemsOf(data).map((item) => {
          const r = asRecord(item) ?? {};
          return {
            id: r["Id"] ?? null,
            naam: r["Naam"] ?? null,
            van: r["Van"] ?? null,
            tot: r["Tot"] ?? null,
            is_actief: r["IsActief"] ?? null,
          };
        });
        return ok(toolName, { items: simplified, count: simplified.length });
      }

      case "get_assignments": {
        const start = strArg(args, "start");
        const end = strArg(args, "end");
        const data = await get(
          ctx.be,
          ctx.tokens,
          `personen/${pid}/opdrachten?van=${start}&tot=${end}`,
        );
        const simplified = itemsOf(data).map((item) => {
          const r = asRecord(item) ?? {};
          // Attachment names only (no contents): awareness without cost.
          const bijlagen = Array.isArray(r["Bijlagen"])
            ? (r["Bijlagen"] as unknown[])
                .map((a) => (asRecord(a) ?? {})["Naam"])
                .filter((n): n is string => typeof n === "string" && !!n)
            : [];
          return {
            id: r["Id"] ?? null,
            titel: r["Titel"] ?? null,
            vak: r["Vak"] ?? null,
            inleveren_voor: r["InleverenVoor"] ?? null,
            ingeleverd_op: r["IngeleverdOp"] ?? null,
            afgesloten: r["Afgesloten"] ?? null,
            omschrijving: r["Omschrijving"] ?? null,
            type: r["Type"] ?? null,
            bijlagen,
          };
        });
        return ok(toolName, { items: simplified, count: simplified.length });
      }

      case "get_assignment_detail": {
        const assignmentId = intArg(args, "assignment_id", 0);
        const data = (await get(
          ctx.be,
          ctx.tokens,
          `personen/${pid}/opdrachten/${assignmentId}`,
        )) as Record<string, unknown>;
        const docenten = Array.isArray(data["Docenten"])
          ? redactDocentenArray(data["Docenten"] as unknown[])
          : [];
        const bijlagen = Array.isArray(data["Bijlagen"])
          ? (data["Bijlagen"] as unknown[]).map((a) => {
              const r = asRecord(a) ?? {};
              return {
                id: r["Id"] ?? null,
                naam: r["Naam"] ?? null,
                url: r["Url"] ?? null,
                grootte: r["Grootte"] ?? null,
                content_type: r["ContentType"] ?? null,
              };
            })
          : null;
        return ok(toolName, {
          id: data["Id"] ?? null,
          titel: data["Titel"] ?? null,
          vak: data["Vak"] ?? null,
          inleveren_voor: data["InleverenVoor"] ?? null,
          ingeleverd_op: data["IngeleverdOp"] ?? null,
          omschrijving: data["Omschrijving"] ?? null,
          bijlagen,
          docenten,
          beoordeling: data["Beoordeling"] ?? null,
          beoordeeld_op: data["BeoordeeldOp"] ?? null,
          status_laatste_opdracht_versie:
            data["StatusLaatsteOpdrachtVersie"] ?? null,
        });
      }

      case "get_messages": {
        const folderArg = strArg(args, "folder").trim() || null;
        const top = intArg(args, "top", 10);
        const foldersData = await get(
          ctx.be,
          ctx.tokens,
          "berichten/mappen/alle",
        );
        const folders = itemsOf(foldersData);
        if (folders.length === 0)
          return fail(toolName, "Geen mappen gevonden.");
        let folderItem = folders[0];
        if (folderArg) {
          folderItem =
            folders.find((f) => {
              const r = asRecord(f) ?? {};
              const n = (r["Naam"] ?? r["naam"]) as string | undefined;
              return (
                typeof n === "string" &&
                n.toLowerCase() === folderArg.toLowerCase()
              );
            }) ?? folders[0];
        }
        const fr = asRecord(folderItem) ?? {};
        const folderName =
          ((fr["Naam"] ?? fr["naam"]) as string | undefined) ?? "";
        let link = "";
        const linksArr = fr["Links"];
        if (Array.isArray(linksArr) && linksArr[0]) {
          const l0 = asRecord(linksArr[0]) ?? {};
          link = ((l0["Href"] ?? l0["href"]) as string | undefined) ?? "";
        }
        if (!link) {
          const lo = asRecord(fr["links"]) ?? {};
          link =
            (asRecord(lo["berichten"])?.["href"] as string | undefined) ?? "";
        }
        if (!link) {
          const lo = asRecord(fr["Links"]) ?? {};
          link =
            (asRecord(lo["berichten"])?.["href"] as string | undefined) ?? "";
        }
        if (!link) {
          const fid = (fr["Id"] ?? fr["id"]) as number | undefined;
          link =
            typeof fid === "number" && fid !== 0
              ? `berichten/mappen/${fid}/berichten`
              : "";
        } else {
          link = link.replace(/^\/api\//, "");
        }
        const msgs = await get(
          ctx.be,
          ctx.tokens,
          `${link.replace(/^\//, "")}/berichten?top=${top}`,
        );
        const simplified = itemsOf(msgs).map((item) => {
          const r = asRecord(item) ?? {};
          return {
            id: r["Id"] ?? r["id"] ?? null,
            onderwerp: r["Onderwerp"] ?? r["onderwerp"] ?? null,
            afzender:
              asRecord(r["Afzender"])?.["Naam"] ??
              asRecord(r["afzender"])?.["naam"] ??
              null,
            datum:
              r["DatumVerzonden"] ??
              r["verzondenOp"] ??
              r["VerzondenOp"] ??
              null,
            gelezen: r["IsGelezen"] ?? r["isGelezen"] ?? null,
            prioriteit: r["Prioriteit"] ?? r["heeftPrioriteit"] ?? null,
          };
        });
        return ok(toolName, {
          items: simplified,
          count: simplified.length,
          // The folder endpoint exposes no message total; total == returned.
          total: simplified.length,
          folder: folderName,
        });
      }

      case "get_message_content": {
        const messageId = intArg(args, "message_id", 0);
        const data = (await get(
          ctx.be,
          ctx.tokens,
          `berichten/${messageId}`,
        )) as Record<string, unknown>;
        return ok(toolName, {
          id: data["Id"] ?? null,
          onderwerp: data["Onderwerp"] ?? null,
          afzender: asRecord(data["Afzender"])?.["Naam"] ?? null,
          datum: data["DatumVerzonden"] ?? null,
          inhoud: data["Inhoud"] ?? null,
          bijlagen: data["Bijlagen"] ?? null,
          is_gelezen: data["IsGelezen"] ?? null,
        });
      }

      case "send_message": {
        const subject = strArg(args, "subject");
        const body = strArg(args, "body");
        const recipients = Array.isArray(args["recipients"])
          ? (args["recipients"] as unknown[])
          : [];
        if (!subject.trim() || !body.trim() || recipients.length === 0) {
          return fail(
            toolName,
            "Bericht ontbreekt: onderwerp, inhoud en minstens één ontvanger zijn verplicht.",
          );
        }
        const action_id = stageAction("send_message", args);
        return ok(toolName, {
          status: "pending_user_confirmation",
          action_id,
          action_type: "send_message",
          recipients,
          subject,
          body,
          message: `Het bericht '${subject}' is klaargezet en wacht op bevestiging door de gebruiker. Er is nog NIETS verzonden. Vertel de gebruiker dat het bericht klaarstaat en dat hij/zij het expliciet moet bevestigen voordat het daadwerkelijk wordt verstuurd.`,
        });
      }

      case "mark_messages_read": {
        const message_ids = (
          Array.isArray(args["message_ids"])
            ? (args["message_ids"] as unknown[])
            : []
        ).filter(
          (v): v is number => typeof v === "number" && Number.isInteger(v),
        );
        if (message_ids.length === 0)
          return fail(toolName, "Geen geldige bericht-ID's opgegeven.");
        const action_id = stageAction("mark_messages_read", args);
        return ok(toolName, {
          status: "pending_user_confirmation",
          action_id,
          action_type: "mark_messages_read",
          message_ids,
          message:
            "De berichten zijn klaargezet om als gelezen te markeren en wachten op bevestiging door de gebruiker. Er is nog NIETS gemarkeerd. Vertel de gebruiker dat er bevestiging nodig is.",
        });
      }

      case "get_absences": {
        const start = strArg(args, "start");
        const end = strArg(args, "end");
        const data = await get(
          ctx.be,
          ctx.tokens,
          `personen/${pid}/absenties?tot=${end}&van=${start}`,
        );
        const arr = itemsOf(data);
        return ok(toolName, { items: arr, count: arr.length });
      }

      case "get_studiewijzers": {
        const data = await get(
          ctx.be,
          ctx.tokens,
          `personen/${pid}/studiewijzers`,
        );
        const simplified = itemsOf(data).map((item) => {
          const r = asRecord(item) ?? {};
          return {
            id: r["Id"] ?? null,
            naam: r["Naam"] ?? null,
            vak: r["VakNaam"] ?? null,
            geldig_vanaf: r["GeldigVanaf"] ?? null,
            geldig_tot: r["GeldigTot"] ?? null,
          };
        });
        return ok(toolName, { items: simplified, count: simplified.length });
      }

      case "get_activities": {
        const data = await get(
          ctx.be,
          ctx.tokens,
          `personen/${pid}/activiteiten`,
        );
        const simplified = itemsOf(data).map((item) => {
          const r = asRecord(item) ?? {};
          return {
            id: r["Id"] ?? null,
            naam: r["Naam"] ?? null,
            categorie: r["Categorie"] ?? null,
            begin: r["Begin"] ?? null,
            einde: r["Einde"] ?? null,
            status: r["Status"] ?? null,
          };
        });
        return ok(toolName, { items: simplified, count: simplified.length });
      }

      case "get_bronnen": {
        const data = await get(
          ctx.be,
          ctx.tokens,
          `personen/${pid}/bronnen?soort=0`,
        );
        const simplified = itemsOf(data).map((item) => {
          const r = asRecord(item) ?? {};
          return {
            id: r["Id"] ?? null,
            naam: r["Naam"] ?? null,
            bron_soort: r["BronSoort"] ?? null,
            url: r["Url"] ?? null,
            is_favoriet: r["IsFavoriet"] ?? null,
          };
        });
        return ok(toolName, { items: simplified, count: simplified.length });
      }

      case "get_leermiddelen": {
        const data = await get(
          ctx.be,
          ctx.tokens,
          `personen/${pid}/lesmateriaal`,
        );
        const simplified = itemsOf(data).map((item) => {
          const r = asRecord(item) ?? {};
          return {
            id: r["Id"] ?? null,
            titel: r["Titel"] ?? null,
            vak: r["VakNaam"] ?? null,
            uitgever: r["Uitgever"] ?? null,
            type: r["Type"] ?? null,
          };
        });
        return ok(toolName, { items: simplified, count: simplified.length });
      }

      case "get_profile_info": {
        // Privacy: no account, adressen, or geboortedatum to the model.
        const out: Record<string, unknown> = {};
        try {
          const profile = (await get(
            ctx.be,
            ctx.tokens,
            `personen/${pid}`,
          )) as Record<string, unknown>;
          out["persoon"] = {
            roepnaam: profile["Roepnaam"] ?? null,
            voorletter: profile["Voorletter"] ?? null,
            achternaam: profile["Achternaam"] ?? null,
            klas: profile["Groep"] ?? null,
          };
        } catch {
          // Partial results are fine.
        }
        try {
          const career = (await get(
            ctx.be,
            ctx.tokens,
            `personen/${pid}/opleidinggegevensprofiel`,
          )) as Record<string, unknown>;
          for (const key of [
            "Mentor",
            "mentor",
            "Docent",
            "docent",
            "Docenten",
          ]) {
            const doc = career[key];
            if (asRecord(doc)) career[key] = redactDocent(doc);
            else if (Array.isArray(doc)) career[key] = redactDocentenArray(doc);
          }
          out["opleiding"] = career;
        } catch {
          // Partial results are fine.
        }
        return ok(toolName, out);
      }

      case "get_current_time": {
        return ok(toolName, currentTimeJson());
      }

      case "read_notes": {
        return ok(toolName, await webReadNotes());
      }

      case "append_note": {
        if (!(await notesWritable())) {
          return fail(
            toolName,
            "Notities bewerken staat uit (Instellingen > AI). Alleen lezen is mogelijk.",
          );
        }
        const text = strArg(args, "text");
        if (!text.trim())
          return fail(toolName, "Geen tekst opgegeven om te onthouden.");
        try {
          return ok(
            toolName,
            await webAppendNote(strArg(args, "section") || null, text),
          );
        } catch (e) {
          return fail(toolName, e);
        }
      }

      case "edit_note": {
        if (!(await notesWritable())) {
          return fail(
            toolName,
            "Notities bewerken staat uit (Instellingen > AI). Alleen lezen is mogelijk.",
          );
        }
        try {
          return ok(
            toolName,
            await webEditNote(
              strArg(args, "old_text"),
              strArg(args, "new_text"),
            ),
          );
        } catch (e) {
          return fail(toolName, e);
        }
      }

      case "replace_notes": {
        if (!(await notesWritable())) {
          return fail(
            toolName,
            "Notities bewerken staat uit (Instellingen > AI). Alleen lezen is mogelijk.",
          );
        }
        try {
          return ok(
            toolName,
            await webReplaceNote(
              strArg(args, "content"),
              intArg(args, "expected_revision", -1),
            ),
          );
        } catch (e) {
          return fail(toolName, e);
        }
      }

      case "get_today_summary": {
        const today = todayAmsterdam();
        const nextWeek = addDays(today, 7);
        const summary: Record<string, unknown> = {};
        try {
          const events = await get(
            ctx.be,
            ctx.tokens,
            `personen/${pid}/afspraken?tot=${today}&van=${today}`,
          );
          summary["vandaag_lessen"] = itemsOf(events).map((item) => {
            const r = asRecord(item) ?? {};
            const docenten = r["Docenten"];
            return {
              ...r,
              Docenten: Array.isArray(docenten)
                ? redactDocentenArray(docenten)
                : [],
            };
          });
        } catch {
          /* omit section */
        }
        try {
          const grades = await get(
            ctx.be,
            ctx.tokens,
            `personen/${pid}/cijfers/laatste?top=5&skip=0`,
          );
          summary["recente_cijfers"] = itemsOf(grades).map((item) => {
            const r = { ...(asRecord(item) ?? {}) };
            if (typeof r["Docent"] === "string")
              r["Docent"] = redactTeacherNameStr(r["Docent"] as string);
            return r;
          });
        } catch {
          /* omit section */
        }
        try {
          const assignments = await get(
            ctx.be,
            ctx.tokens,
            `personen/${pid}/opdrachten?van=${today}&tot=${nextWeek}`,
          );
          summary["aankomende_opdrachten"] = itemsOf(assignments).map(
            (item) => {
              const r = asRecord(item) ?? {};
              const docenten = r["Docenten"];
              return {
                ...r,
                Docenten: Array.isArray(docenten)
                  ? redactDocentenArray(docenten)
                  : [],
              };
            },
          );
        } catch {
          /* omit section */
        }
        try {
          const folders = await get(
            ctx.be,
            ctx.tokens,
            "berichten/mappen/alle",
          );
          const unread = itemsOf(folders).reduce(
            (sum: number, f: unknown) =>
              sum +
              (Number(
                (asRecord(f) ?? {})["aantalOngelezen"] ??
                  (asRecord(f) ?? {})["AantalOngelezen"] ??
                  0,
              ) || 0),
            0,
          );
          summary["ongelezen_berichten"] = unread;
        } catch {
          /* omit section */
        }
        try {
          const absences = await get(
            ctx.be,
            ctx.tokens,
            `personen/${pid}/absenties?tot=${today}&van=${today}`,
          );
          summary["vandaag_absenties"] = itemsOf(absences);
        } catch {
          /* omit section */
        }
        return ok(toolName, summary);
      }

      case "list_files": {
        const scopeRaw = strArg(args, "scope") || "all";
        const scope = ["assignment", "message", "lesson"].includes(scopeRaw)
          ? scopeRaw
          : "all";
        const subjectFilter =
          strArg(args, "subject").trim().toLowerCase() || null;
        const startArg = strArg(args, "start").slice(0, 10);
        const endArg = strArg(args, "end").slice(0, 10);
        let range: CalendarRange;
        try {
          range = resolveCalendarRange(startArg, endArg, todayAmsterdam());
        } catch (e) {
          return fail(toolName, e);
        }
        const matchesSubject = (subject: string | null): boolean => {
          if (!subjectFilter) return true;
          return (subject ?? "").toLowerCase().includes(subjectFilter);
        };
        const harvested: HarvestedFile[] = [];

        if (scope === "all" || scope === "assignment") {
          try {
            const data = await get(
              ctx.be,
              ctx.tokens,
              `personen/${pid}/opdrachten?van=${range.start}&tot=${range.effectiveEnd}`,
            );
            for (const item of itemsOf(data)) {
              const r = asRecord(item) ?? {};
              const aid = r["Id"] as number | undefined;
              if (typeof aid !== "number" || !aid) continue;
              const rawBijlagen = Array.isArray(r["Bijlagen"])
                ? (r["Bijlagen"] as unknown[])
                : [];
              let src: Record<string, unknown> = r;
              if (rawBijlagen.length === 0) {
                try {
                  src = (await get(
                    ctx.be,
                    ctx.tokens,
                    `personen/${pid}/opdrachten/${aid}`,
                  )) as Record<string, unknown>;
                } catch {
                  continue;
                }
              }
              const vak = subjectNameOf(src["Vak"] ?? r["Vak"]);
              if (!matchesSubject(vak)) continue;
              const bijlagen = (asRecord(src)?.["Bijlagen"] as unknown[]) ?? [];
              harvestBijlagen(harvested, "assignment", `${aid}`, bijlagen, {
                subject: vak,
                title: (src["Titel"] as string | undefined) ?? null,
                due: (src["InleverenVoor"] as string | undefined) ?? null,
                date: null,
              });
            }
          } catch {
            // Assignment source best-effort; other sources still list.
          }
        }

        if (scope === "all" || scope === "message") {
          // Messages carry no subject; a subject filter excludes them.
          if (!subjectFilter) {
            try {
              const link = await inboxMessageLink(ctx);
              const msgs = await get(
                ctx.be,
                ctx.tokens,
                `${link}/berichten?top=10`,
              );
              for (const item of itemsOf(msgs).slice(0, 10)) {
                const r = asRecord(item) ?? {};
                const mid =
                  (r["Id"] as number | undefined) ??
                  (r["id"] as number | undefined) ??
                  0;
                if (!mid) continue;
                const rawBijlagen =
                  (r["Bijlagen"] as unknown[]) ??
                  (r["bijlagen"] as unknown[]) ??
                  [];
                let src: Record<string, unknown> = r;
                if (!Array.isArray(rawBijlagen) || rawBijlagen.length === 0) {
                  try {
                    src = (await get(
                      ctx.be,
                      ctx.tokens,
                      `berichten/${mid}`,
                    )) as Record<string, unknown>;
                  } catch {
                    continue;
                  }
                }
                const bijlagen =
                  (src["Bijlagen"] as unknown[]) ??
                  (src["bijlagen"] as unknown[]) ??
                  [];
                if (!Array.isArray(bijlagen) || bijlagen.length === 0) continue;
                harvestBijlagen(harvested, "message", `${mid}`, bijlagen, {
                  subject: null,
                  title:
                    ((src["Onderwerp"] ?? src["onderwerp"]) as
                      string | undefined) ?? null,
                  due: null,
                  date:
                    ((src["DatumVerzonden"] ??
                      src["verzondenOp"] ??
                      src["VerzondenOp"]) as string | undefined) ?? null,
                });
              }
            } catch {
              // Message source best-effort.
            }
          }
        }

        if (scope === "all" || scope === "lesson") {
          try {
            const data = await get(
              ctx.be,
              ctx.tokens,
              `personen/${pid}/afspraken?tot=${range.effectiveEnd}&van=${range.start}`,
            );
            for (const item of itemsOf(data)) {
              const r = asRecord(item) ?? {};
              const bijlagen =
                (r["Bijlagen"] as unknown[]) ??
                (r["bijlagen"] as unknown[]) ??
                [];
              if (!Array.isArray(bijlagen) || bijlagen.length === 0) continue;
              const vakken = r["Vakken"];
              const vak = Array.isArray(vakken)
                ? subjectNameOf(asRecord(vakken[0])?.["Naam"])
                : null;
              if (!matchesSubject(vak)) continue;
              const start = (r["Start"] as string | undefined) ?? "";
              harvestBijlagen(
                harvested,
                "lesson",
                `${(r["Id"] as number | undefined) ?? 0}`,
                bijlagen,
                {
                  subject: vak,
                  title: (r["Omschrijving"] as string | undefined) ?? null,
                  due: null,
                  date: /^\d{4}-\d{2}-\d{2}/.test(start)
                    ? start.slice(0, 10)
                    : null,
                },
              );
            }
          } catch {
            // Lesson source best-effort.
          }
        }

        const total = harvested.length;
        const truncated = total > 100;
        const files = (truncated ? harvested.slice(0, 100) : harvested).map(
          ({ url: _url, ...pub }) => pub,
        );
        return ok(toolName, {
          files,
          count: files.length,
          total,
          truncated,
          scope,
          window_default: range.windowDefault,
        });
      }

      case "read_attachment_text": {
        const fileId = strArg(args, "file_id");
        const urlArg = strArg(args, "url");
        const filenameArg = strArg(args, "filename");
        const offset = Math.max(0, intArg(args, "offset", 0));
        const maxChars = Math.min(
          DEFAULT_PAGE_CHARS,
          Math.max(1, intArg(args, "max_chars", DEFAULT_PAGE_CHARS)),
        );
        const endpoint = ctx.tokens.apiEndpoint.replace(/\/$/, "");
        const cacheKey = fileId ? `id:${fileId}` : `url:${urlArg}`;

        let targetUrl: string;
        let name: string;
        if (fileId) {
          const ref = registryGet(fileId);
          if (!ref)
            return fail(
              toolName,
              "Onbekend file_id. Roep eerst list_files aan.",
            );
          targetUrl = ref.url;
          name = ref.name;
        } else {
          if (!urlArg) return fail(toolName, "Geen file_id of URL opgegeven.");
          const check = validateAttachmentUrl(urlArg, endpoint);
          if (!check.ok) return fail(toolName, check.reason);
          targetUrl = urlArg;
          name = filenameArg || baseNameOf(urlArg);
        }

        const cached = cacheGet(cacheKey, targetUrl);
        if (cached) {
          if (offset > cached.total_chars) {
            return fail(
              toolName,
              `Offset ${offset} voorbij het einde (${cached.total_chars} tekens).`,
            );
          }
          const { page, nextOffset, total } = pageText(
            cached.text,
            offset,
            maxChars,
          );
          return ok(toolName, {
            name: cached.name,
            total_chars: total,
            offset,
            next_offset: nextOffset,
            text: page,
            truncated: cached.truncated,
            cached: true,
          });
        }

        const preReason = unsupportedReason(name, "", false);
        if (preReason) return unreadable(toolName, preReason);

        const resolved = await resolveToBytes(ctx, targetUrl);
        if (!resolved)
          return fail(toolName, "Kon download-link niet resolven.");
        if (resolved.bytes.length > MAX_DOWNLOAD_BYTES) {
          return fail(
            toolName,
            `Bestand te groot (${(resolved.bytes.length / 1048576).toFixed(1)} MB, max 15 MB).`,
          );
        }
        const postReason = unsupportedReason(name, resolved.contentType, false);
        if (postReason) return unreadable(toolName, postReason);

        let raw: string;
        try {
          raw = await extractText(resolved.bytes, name, resolved.contentType);
        } catch (e) {
          return fail(toolName, e instanceof Error ? e.message : String(e));
        }
        if (isEmptyText(raw))
          return unreadable(toolName, "geen tekstlaag (gescand)");
        const [capped, truncated] = capExtracted(raw);
        const total = Array.from(capped).length;
        if (offset > total) {
          return fail(
            toolName,
            `Offset ${offset} voorbij het einde (${total} tekens).`,
          );
        }
        cachePut(cacheKey, {
          url: targetUrl,
          name,
          text: capped,
          total_chars: total,
          size_bytes: resolved.bytes.length,
          truncated,
        });
        const { page, nextOffset } = pageText(capped, offset, maxChars);
        return ok(toolName, {
          name,
          total_chars: total,
          offset,
          next_offset: nextOffset,
          text: page,
          truncated,
        });
      }

      case "calculate_grade_scenario": {
        return calculateScenario(ctx, args);
      }

      case "create_calendar_event": {
        const start = strArg(args, "start");
        const einde = strArg(args, "einde");
        const omschrijving = strArg(args, "omschrijving");
        if (!start || !einde || !omschrijving) {
          return fail(toolName, "Start, einde en omschrijving zijn verplicht.");
        }
        const action_id = stageAction("create_calendar_event", args);
        return ok(toolName, {
          status: "pending_user_confirmation",
          action_id,
          action_type: "create_calendar_event",
          start,
          einde,
          omschrijving,
          message:
            "De agenda-afspraak is klaargezet en wacht op bevestiging door de gebruiker. Er is nog NIETS aangemaakt. Vertel de gebruiker dat er bevestiging nodig is.",
        });
      }

      case "download_file": {
        const url = strArg(args, "url");
        if (!url) return fail(toolName, "Geen URL opgegeven.");
        const endpoint = ctx.tokens.apiEndpoint.replace(/\/$/, "");
        const check = validateAttachmentUrl(url, endpoint);
        if (!check.ok) return fail(toolName, check.reason);
        const resolved = await resolveToBytes(ctx, url);
        if (!resolved)
          return fail(toolName, "Kon download-link niet resolven.");
        if (resolved.bytes.length > MAX_DOWNLOAD_BYTES) {
          return fail(
            toolName,
            `Bestand te groot (${(resolved.bytes.length / 1048576).toFixed(1)} MB, max 15 MB).`,
          );
        }
        // Cap the read: report size/type without pulling multi-MB blobs fully
        // into the model context (desktop downloads fully; browsers shouldn't).
        return ok(toolName, {
          url,
          size_bytes: resolved.bytes.length,
          size_mb: resolved.bytes.length / 1048576,
          mime_type: resolved.contentType,
          capped: false,
          message:
            "Het bestand is gedownload. De AI kan de inhoud niet lezen, maar je kunt het openen via de link.",
        });
      }

      case "get_ai_schedule": {
        const startArg = strArg(args, "start").slice(0, 10);
        const endArg = strArg(args, "end").slice(0, 10);
        const offset = intArg(args, "offset", 0);
        const limit = intArg(args, "limit", CALENDAR_DEFAULT_LIMIT);
        let range: CalendarRange;
        try {
          range = resolveCalendarRange(startArg, endArg, todayAmsterdam());
        } catch (e) {
          return fail(toolName, e);
        }
        const fetched = await getAiSchedule(
          `${range.start}T00:00:00`,
          `${range.effectiveEnd}T23:59:59`,
        );
        const sorted = [...fetched].sort((a, b) =>
          a.start < b.start ? -1 : a.start > b.start ? 1 : 0,
        );
        const { page, truncated, nextOffset } = paginateItems(
          sorted,
          offset,
          limit,
        );
        return ok(toolName, {
          items: page,
          count: page.length,
          meta: {
            requested: { start: range.start, end: range.end },
            effective: { start: range.start, end: range.effectiveEnd },
            clamped: range.clamped,
            returned: page.length,
            total: sorted.length,
            truncated,
            next_offset: nextOffset,
            window_default: range.windowDefault,
          },
        });
      }

      case "create_ai_schedule_item": {
        const itemType = strArg(args, "item_type") || "custom";
        const validTypes = [
          "assignment_work",
          "study_block",
          "homework_review",
          "custom",
          "break",
          "free_time",
          "sleep",
        ];
        const { lessons, checked } = await fetchPlanLessons(
          ctx,
          strArg(args, "start"),
          strArg(args, "end"),
        );
        try {
          const created = await aiCreatePlanItem(
            {
              title: strArg(args, "title"),
              description: strArg(args, "description") || undefined,
              item_type: (validTypes.includes(itemType)
                ? itemType
                : "custom") as AiScheduleItem["item_type"],
              start: strArg(args, "start"),
              end: strArg(args, "end"),
              urgency: intArg(args, "urgency", 3),
              related_assignment_id:
                intArg(args, "related_assignment_id", 0) || undefined,
              related_subject: strArg(args, "related_subject") || undefined,
              estimated_minutes:
                intArg(args, "estimated_minutes", 0) || undefined,
            },
            lessons,
            checked,
          );
          return ok(toolName, created);
        } catch (e) {
          if (e instanceof PlanGuardrailError) {
            return {
              tool: toolName,
              success: false,
              data: {
                reason: e.message,
                conflict_with: e.conflictWith,
                suggestions: e.suggestions,
                lessons_checked: e.lessonsChecked,
              },
              error: `${e.message} Kies een van de voorgestelde vrije plekken.`,
            };
          }
          return fail(toolName, e);
        }
      }

      case "update_ai_schedule_item": {
        const id = strArg(args, "id");
        if (!id) return fail(toolName, "ID is verplicht.");
        let current: AiScheduleItem;
        try {
          current = await getAiScheduleItem(id);
        } catch (e) {
          return fail(toolName, e);
        }
        const patched: AiScheduleItem = { ...current };
        const maybeStr = (k: string): void => {
          const v = strArg(args, k);
          if (v) (patched as unknown as Record<string, unknown>)[k] = v;
        };
        maybeStr("title");
        maybeStr("description");
        const newType = strArg(args, "item_type");
        if (
          newType &&
          [
            "assignment_work",
            "study_block",
            "homework_review",
            "custom",
            "break",
            "free_time",
            "sleep",
          ].includes(newType)
        ) {
          patched.item_type = newType as AiScheduleItem["item_type"];
        }
        maybeStr("start");
        maybeStr("end");
        if (typeof args["urgency"] === "number")
          patched.urgency = intArg(args, "urgency", 3);
        if (typeof args["estimated_minutes"] === "number") {
          patched.estimated_minutes =
            intArg(args, "estimated_minutes", 0) || null;
        }
        if (typeof args["status"] === "string" && args["status"]) {
          patched.status = strArg(args, "status") as AiScheduleItem["status"];
        }
        const { lessons, checked } = await fetchPlanLessons(
          ctx,
          patched.start,
          patched.end,
        );
        try {
          return ok(
            toolName,
            await aiUpdatePlanItem(patched, lessons, checked),
          );
        } catch (e) {
          if (e instanceof PlanGuardrailError) {
            return {
              tool: toolName,
              success: false,
              data: {
                reason: e.message,
                conflict_with: e.conflictWith,
                suggestions: e.suggestions,
                lessons_checked: e.lessonsChecked,
              },
              error: `${e.message} Kies een van de voorgestelde vrije plekken.`,
            };
          }
          return fail(toolName, e);
        }
      }

      case "complete_ai_schedule_item": {
        const id = strArg(args, "id");
        if (!id) return fail(toolName, "ID is verplicht.");
        try {
          await completeAiScheduleItem(id);
          return ok(toolName, { id, status: "completed" });
        } catch (e) {
          return fail(toolName, e);
        }
      }

      case "dismiss_ai_schedule_item": {
        const id = strArg(args, "id");
        if (!id) return fail(toolName, "ID is verplicht.");
        try {
          await dismissAiScheduleItem(id);
          return ok(toolName, { id, status: "dismissed" });
        } catch (e) {
          return fail(toolName, e);
        }
      }

      case "delete_ai_schedule_item": {
        const id = strArg(args, "id");
        if (!id) return fail(toolName, "ID is verplicht.");
        try {
          await deleteAiScheduleItem(id);
          return ok(toolName, { id, status: "deleted" });
        } catch (e) {
          return fail(toolName, e);
        }
      }

      case "move_ai_schedule_item": {
        const id = strArg(args, "id");
        const newStart = strArg(args, "new_start");
        if (!id || !newStart)
          return fail(toolName, "ID en new_start zijn verplicht.");
        const { lessons, checked } = await fetchPlanLessons(
          ctx,
          newStart,
          newStart,
        );
        try {
          return ok(
            toolName,
            await moveAiScheduleItem(id, newStart, lessons, checked),
          );
        } catch (e) {
          if (e instanceof PlanGuardrailError) {
            return {
              tool: toolName,
              success: false,
              data: {
                reason: e.message,
                conflict_with: e.conflictWith,
                suggestions: e.suggestions,
                lessons_checked: e.lessonsChecked,
              },
              error: `${e.message} Kies een van de voorgestelde vrije plekken.`,
            };
          }
          return fail(toolName, e);
        }
      }

      case "get_plan_settings": {
        return ok(toolName, getPlanSettings());
      }

      case "get_free_slots": {
        const date = strArg(args, "date").slice(0, 10);
        const end = strArg(args, "end").slice(0, 10) || null;
        const minMinutes = intArg(args, "min_minutes", 0);
        if (date && end && end < date) {
          return fail(
            toolName,
            "Einddatum ligt voor startdatum. Wissel ze om.",
          );
        }
        if (date && end && diffDays(date, end) > CALENDAR_MAX_SPAN_DAYS) {
          return fail(
            toolName,
            `Bereik te groot (max ${CALENDAR_MAX_SPAN_DAYS} dagen). Vernauw het bereik.`,
          );
        }
        const { lessons, checked } = await fetchPlanLessons(
          ctx,
          date || undefined,
          (end || date || undefined) ?? undefined,
        );
        try {
          return ok(
            toolName,
            await getFreeSlots(
              date,
              end,
              Math.max(0, minMinutes),
              lessons,
              checked,
            ),
          );
        } catch (e) {
          return fail(toolName, e);
        }
      }

      case "set_homework_duration": {
        const assignmentId = intArg(args, "assignment_id", 0);
        const minutes = intArg(args, "estimated_minutes", 0);
        if (!assignmentId || !minutes) {
          return fail(
            toolName,
            "assignment_id en estimated_minutes zijn verplicht.",
          );
        }
        try {
          return ok(
            toolName,
            await setHomeworkDuration(
              assignmentId,
              minutes,
              typeof args["urgency"] === "number"
                ? intArg(args, "urgency", 3)
                : undefined,
            ),
          );
        } catch (e) {
          return fail(toolName, e);
        }
      }

      case "run_update_ai_schedule": {
        try {
          const items = await updateAiSchedule();
          const total = items.length;
          const page = items.slice(0, 60);
          return ok(toolName, {
            items: page,
            count: page.length,
            total,
            truncated: total > page.length,
            message: "Planning bijgewerkt voor deze week + volgende week.",
          });
        } catch (e) {
          return fail(toolName, e);
        }
      }

      case "undo_last_ai_plan_change": {
        try {
          return ok(toolName, await undoLastAiPlanChange());
        } catch (e) {
          return fail(toolName, e);
        }
      }

      default:
        return fail(toolName, `Onbekende tool: ${toolName}`);
    }
  } catch (e) {
    return fail(toolName, e);
  }
}

async function calculateScenario(
  ctx: WebToolContext,
  args: Record<string, unknown>,
): Promise<WebToolResult> {
  const toolName = "calculate_grade_scenario";
  const decimalPoints = Math.max(0, intArg(args, "decimal_points", 2));
  const peildatumRaw = strArg(args, "peildatum");
  const today = todayAmsterdam();
  const peil = peildatumRaw.length >= 10 ? peildatumRaw.slice(0, 10) : today;
  let resolved: {
    tp: number;
    tw: number;
    count: number;
    subjectName: string;
    allSubjects: Array<[string, number]>;
  };
  try {
    resolved = await resolveScenarioGrades(ctx, args, peil);
  } catch (e) {
    return fail(toolName, e);
  }
  const { tp, tw, count, subjectName, allSubjects } = resolved;

  const targetAverage =
    typeof args["target_average"] === "number"
      ? (args["target_average"] as number)
      : null;
  const nextGrade =
    typeof args["next_grade"] === "number"
      ? (args["next_grade"] as number)
      : null;
  const nextGradeWeight =
    typeof args["next_grade_weight"] === "number"
      ? (args["next_grade_weight"] as number)
      : 1;
  const remainingTests =
    typeof args["remaining_tests"] === "number"
      ? Math.trunc(args["remaining_tests"] as number)
      : null;
  const threshold =
    typeof args["threshold"] === "number"
      ? (args["threshold"] as number)
      : null;
  const simulation: GradePoint[] = Array.isArray(args["simulation_grades"])
    ? (args["simulation_grades"] as unknown[])
        .map((g) => {
          const r = asRecord(g);
          if (!r) return null;
          let value: number | null = null;
          if (typeof r["value"] === "number") value = r["value"] as number;
          else if (typeof r["cijfer"] === "number")
            value = r["cijfer"] as number;
          else if (typeof r["cijfer"] === "string")
            value = parseDutchGrade(r["cijfer"] as string);
          if (value == null) return null;
          const weight =
            typeof r["weight"] === "number"
              ? (r["weight"] as number)
              : typeof r["weging"] === "number"
                ? (r["weging"] as number)
                : 1;
          return { value, weight };
        })
        .filter((g): g is GradePoint => g !== null)
    : [];
  const includeSimulation =
    typeof args["include_simulation"] === "boolean"
      ? (args["include_simulation"] as boolean)
      : true;

  const currentAvg = tw > 0 ? tp / tw : 0;
  const result: Record<string, unknown> = {
    subject: subjectName,
    current_average: currentAvg.toFixed(decimalPoints),
    current_average_numeric: numOrNull(currentAvg),
    total_points: numOrNull(tp),
    total_weight: numOrNull(tw),
    grade_count: count,
    peildatum: peil,
  };

  if (targetAverage != null) {
    const req = requiredGrade(
      tp,
      tw,
      targetAverage,
      nextGradeWeight,
      simulation,
      decimalPoints,
    );
    result["required_grade"] = req;
    const n = Number(req);
    if (Number.isFinite(n)) result["required_grade_numeric"] = n;
    result["target_average"] = numOrNull(targetAverage);
    result["required_grade_grade_weight"] = numOrNull(nextGradeWeight);
  }

  if (nextGrade != null) {
    const withNext = [
      ...simulation,
      { value: nextGrade, weight: nextGradeWeight },
    ];
    const pa = predictedAverage(
      tp,
      tw,
      withNext,
      includeSimulation,
      decimalPoints,
    );
    result["predicted_average"] = pa;
    const n = Number(pa);
    if (Number.isFinite(n)) result["predicted_average_numeric"] = n;
    result["average_for_grade"] = averageForGrade(
      tp,
      tw,
      nextGrade,
      nextGradeWeight,
      decimalPoints,
    );
    result["next_grade"] = numOrNull(nextGrade);
    result["next_grade_weight"] = numOrNull(nextGradeWeight);
    if (remainingTests != null) {
      const rt = Math.max(0, remainingTests);
      const pe = predictedEnd(tp, tw, rt, nextGrade);
      result["predicted_end"] = pe.toFixed(decimalPoints);
      result["predicted_end_remaining_tests"] = remainingTests;
    }
    if (allSubjects.length > 0) {
      const replacement = Number(pa);
      result["new_overall_average"] = newOverallAverage(
        allSubjects,
        subjectName,
        Number.isFinite(replacement) ? replacement : currentAvg,
        decimalPoints,
      );
    }
  }

  if (threshold != null) {
    result["threshold"] = numOrNull(threshold);
    const pass = minGradeForPass(tp, tw, threshold);
    result["min_grade_for_pass"] =
      pass.kind === "needed"
        ? pass.value
        : pass.kind === "already_passing"
          ? "already_passing"
          : "impossible";
  }

  return ok(toolName, result);
}

/**
 * Execute a staged action after explicit user confirmation. The ONLY path
 * that performs real writes — replay endpoints mirror desktop
 * `execute_pending_action` exactly (including its dedicated send/read
 * endpoints, which differ from the regular commands).
 */
export async function confirmWebPendingAction(
  ctx: WebToolContext,
  actionId: string,
): Promise<unknown> {
  prunePendingActions();
  const entry = pendingActions.get(actionId);
  if (!entry)
    throw new Error(
      "Actie verlopen of onbekend — vraag de AI het opnieuw klaar te zetten.",
    );
  pendingActions.delete(actionId);
  const args = entry.args;
  const pid = ctx.personId;

  switch (entry.action.action_type) {
    case "send_message": {
      const subject = strArg(args, "subject");
      const body = strArg(args, "body");
      const recipients = (
        Array.isArray(args["recipients"])
          ? (args["recipients"] as unknown[])
          : []
      ).map((r) => {
        const rr = asRecord(r) ?? {};
        return {
          id: typeof rr["id"] === "number" ? rr["id"] : 0,
          type: typeof rr["type"] === "string" ? rr["type"] : "leerling",
        };
      });
      await ctx.be.magister(ctx.tokens, "POST", "berichten/verzenden", {
        ontvangers: recipients,
        kopieOntvangers: [],
        blindeKopieOntvangers: [],
        heeftPrioriteit: false,
        inhoud: body,
        onderwerp: subject,
        verzendOptie: "standaard",
        bijlagen: [],
      });
      return { status: "verzonden", subject };
    }

    case "mark_messages_read": {
      const message_ids = (
        Array.isArray(args["message_ids"])
          ? (args["message_ids"] as unknown[])
          : []
      ).filter(
        (v): v is number => typeof v === "number" && Number.isInteger(v),
      );
      await ctx.be.magister(ctx.tokens, "PUT", "berichten/gelezen", {
        BerichtIds: message_ids,
      });
      return { status: "gemarkeerd", aantal: message_ids.length };
    }

    case "create_calendar_event": {
      const start = strArg(args, "start");
      const einde = strArg(args, "einde");
      const duurt_hele_dag = args["duurt_hele_dag"] === true;
      const omschrijving = strArg(args, "omschrijving").trim();
      const lokatie = strArg(args, "lokatie").trim() || null;
      const inhoud = strArg(args, "inhoud").trim() || null;
      // Live-probed 2026-09: content on Type 1 needs InfoType 6, 0 when empty.
      const info_type = inhoud ? 6 : 0;
      const body: Record<string, unknown> = {
        Start: start,
        Einde: einde,
        DuurtHeleDag: duurt_hele_dag,
        Omschrijving: omschrijving,
        Type: 1,
        Status: 2,
        InfoType: info_type,
      };
      if (lokatie) body["Lokatie"] = lokatie;
      if (inhoud) body["Inhoud"] = inhoud;
      await ctx.be.magister(
        ctx.tokens,
        "POST",
        `personen/${pid}/afspraken`,
        body,
      );
      return { status: "aangemaakt", omschrijving };
    }

    default:
      throw new Error(`Onbekend actietype: ${entry.action.action_type}`);
  }
}
