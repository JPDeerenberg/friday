/**
 * Browser port of `src-tauri/src/ai/tools.rs` (minus the AI-Schedule family,
 * whose feature isn't on web yet): same tool names, same Dutch descriptions,
 * same argument shapes, same simplified/redacted result shapes, same
 * stage-then-confirm write semantics (15-min TTL pending store).
 *
 * Reads run against Tier-A raw JSON (like the Rust `client.get` calls);
 * privacy redaction of teacher names is applied before anything reaches the
 * model — the regular UI is unaffected.
 */

import type { MagisterMethod, SessionTokens } from "./backend.ts";
import type { TierA } from "./web-tier-b.ts";

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
const pendingActions = new Map<string, { action: PendingAction; args: Record<string, unknown>; createdAt: number }>();

function generateActionId(): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 16)
      : Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0") +
        Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
  return `act-${Date.now().toString(16)}-${rand}`;
}

function prunePendingActions(): void {
  const now = Date.now() / 1000;
  for (const [id, entry] of pendingActions) {
    if (now - entry.createdAt > PENDING_ACTION_TTL_SECS) pendingActions.delete(id);
  }
}

function stageAction(actionType: string, args: Record<string, unknown>): string {
  prunePendingActions();
  const action_id = generateActionId();
  pendingActions.set(action_id, { action: { action_id, action_type: actionType, args, created_at: Date.now() / 1000 } as PendingAction, args, createdAt: Date.now() / 1000 });
  return action_id;
}

/** Test hook: inspect staged actions. */
export function __pendingForTests(): Map<string, { args: Record<string, unknown>; createdAt: number }> {
  const out = new Map<string, { args: Record<string, unknown>; createdAt: number }>();
  for (const [id, entry] of pendingActions) out.set(id, { args: entry.args, createdAt: entry.createdAt });
  return out;
}

/** Test hook: clear staged actions. */
export function __clearPendingForTests(): void {
  pendingActions.clear();
}

// ─── Tool definitions (same names + Dutch copy as desktop) ─────────────────

export const WEB_TOOL_DEFS: WebToolDef[] = [
  {
    name: "get_calendar_events",
    description: "Haal agenda-items/lessen op voor een datumbereik (bijv. vandaag of deze week).",
    parameters: {
      type: "object",
      properties: {
        start: { type: "string", description: "Startdatum in yyyy-MM-dd formaat" },
        end: { type: "string", description: "Einddatum in yyyy-MM-dd formaat" },
      },
      required: ["start", "end"],
    },
  },
  {
    name: "get_grades",
    description: "Haal recente cijfers op.",
    parameters: {
      type: "object",
      properties: { top: { type: "integer", description: "Aantal cijfers om op te halen (max 20)", default: 10 } },
      required: [],
    },
  },
  {
    name: "get_full_grade_overview",
    description:
      "Haal het volledige cijferoverzicht op met gemiddelden per vak. Gebruik dit als de gebruiker vraagt hoe hij/zij ervoor staat per vak, of om gemiddelden te bekijken. Eerst moet je get_schoolyears ophalen voor de juiste IDs.",
    parameters: {
      type: "object",
      properties: {
        schoolyear_id: { type: "integer", description: "ID van het schooljaar (uit get_schoolyears)" },
        einde: { type: "string", description: "Peildatum in yyyy-MM-dd formaat (gebruik vandaag of einde schooljaar)" },
      },
      required: ["schoolyear_id", "einde"],
    },
  },
  {
    name: "get_schoolyears",
    description: "Haal schooljaren op voor deze leerling. Nodig voor get_full_grade_overview.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_assignments",
    description: "Haal huiswerk/opdrachten op voor een datumbereik.",
    parameters: {
      type: "object",
      properties: {
        start: { type: "string", description: "Startdatum in yyyy-MM-dd formaat" },
        end: { type: "string", description: "Einddatum in yyyy-MM-dd formaat" },
      },
      required: ["start", "end"],
    },
  },
  {
    name: "get_assignment_detail",
    description: "Haal de volledige details van een specifieke opdracht op, inclusief bijlagen (bestanden).",
    parameters: {
      type: "object",
      properties: { assignment_id: { type: "integer", description: "ID van de opdracht" } },
      required: ["assignment_id"],
    },
  },
  {
    name: "get_messages",
    description:
      "Haal berichten op uit een map (bijv. 'Postvak IN', 'Verzonden items', 'Verwijderde items'). Zonder folder-parameter wordt de eerste map gebruikt (meestal Postvak IN).",
    parameters: {
      type: "object",
      properties: {
        folder: { type: "string", description: "Map naam zoals getoond in Magister (bijv. 'Postvak IN'). Laat leeg voor de standaardmap." },
        top: { type: "integer", description: "Aantal berichten om op te halen", default: 10 },
      },
      required: [],
    },
  },
  {
    name: "get_message_content",
    description: "Haal de inhoud van een specifiek bericht op. Gebruik dit als de gebruiker wil weten wat er in een bericht staat.",
    parameters: {
      type: "object",
      properties: { message_id: { type: "integer", description: "ID van het bericht om op te halen" } },
      required: ["message_id"],
    },
  },
  {
    name: "send_message",
    description: "Stuur een bericht via Magister. Gebruik dit om een bericht te verzenden naar een medeleerling, docent of klas.",
    parameters: {
      type: "object",
      properties: {
        subject: { type: "string", description: "Onderwerp van het bericht" },
        body: { type: "string", description: "Inhoud van het bericht" },
        recipients: {
          type: "array",
          description: "Lijst van ontvangers, elk met id en type (leerling/docent/klas).",
          items: {
            type: "object",
            properties: {
              id: { type: "integer" },
              type: { type: "string", enum: ["leerling", "docent", "klas"], default: "leerling" },
            },
            required: ["id"],
          },
        },
      },
      required: ["subject", "body", "recipients"],
    },
  },
  {
    name: "mark_messages_read",
    description: "Markeer een of meerdere berichten als gelezen. Geef de bericht-ID's op.",
    parameters: {
      type: "object",
      properties: {
        message_ids: { type: "array", items: { type: "integer" }, description: "Lijst van bericht-ID's om als gelezen te markeren." },
      },
      required: ["message_ids"],
    },
  },
  {
    name: "get_absences",
    description: "Haal absentie/verzuim op voor een datumbereik.",
    parameters: {
      type: "object",
      properties: {
        start: { type: "string", description: "Startdatum in yyyy-MM-dd formaat" },
        end: { type: "string", description: "Einddatum in yyyy-MM-dd formaat" },
      },
      required: ["start", "end"],
    },
  },
  {
    name: "get_studiewijzers",
    description: "Haal studiewijzers op (studiehandleidingen per vak).",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_activities",
    description: "Haal buitenschoolse activiteiten op.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_bronnen",
    description: "Haal digitale leermaterialen en bronnen op (bijv. lesmateriaal links, websites).",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_leermiddelen",
    description: "Haal digitale leermiddelen op (lesmateriaal, digitale boeken).",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_profile_info",
    description: "Haal uitgebreide profielinformatie op: naam, klas, adres, opleidingsgegevens, mentor.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_today_summary",
    description: "Krijg een compleet overzicht van vandaag: rooster, cijfers, opdrachten, berichten, alle data in één keer.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "read_attachment_text",
    description:
      "Lees de tekstinhoud van een bijlage (tekstbestand). Gebruik dit als een opdracht een bijlage heeft en de gebruiker hulp wil met de inhoud. Alleen platte tekst wordt gelezen (geen PDF/Word op web).",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL van de bijlage (uit get_assignment_detail of get_message_content)" },
        filename: { type: "string", description: "Bestandsnaam van de bijlage; helpt bij het bepalen van het bestandstype" },
      },
      required: ["url"],
    },
  },
  {
    name: "calculate_grade_scenario",
    description:
      "Bereken cijfer-scenario's voor een vak: benodigd cijfer voor de volgende toets om een streefcijfer te halen, voorspeld gemiddelde na een hypothetisch cijfer, minimum cijfer om te slagen, en het effect op je totale gemiddelde. Geef de huidige cijfers mee (grades: lijst van {value, weight}) óf een schoolyear_id + subject zodat de tool ze zelf ophaalt. Gebruik dit voor 'wat heb ik nodig'-vragen over cijfers.",
    parameters: {
      type: "object",
      properties: {
        schoolyear_id: { type: "integer", description: "ID van het schooljaar (uit get_schoolyears). Nodig als je geen grades meegeeft." },
        subject: { type: "string", description: "Naam of afkorting van het vak (bv. 'Wiskunde'). Nodig als je geen grades meegeeft." },
        grades: {
          type: "array",
          description: "Optioneel: lijst van huidige cijfers, elk met value (cijfer) en weight (weging) — of cijfer/weging zoals get_full_grade_overview ze teruggeeft.",
          items: {
            type: "object",
            properties: {
              value: { type: "number", description: "Het cijfer, bv. 7.5 (ook 'cijfer' geaccepteerd)" },
              cijfer: { type: "number", description: "Het cijfer, bv. 7.5 (alias voor value)" },
              weight: { type: "number", description: "Weging (default 1)" },
              weging: { type: "number", description: "Weging (alias voor weight)" },
            },
            required: [],
          },
        },
        peildatum: { type: "string", description: "Peildatum yyyy-MM-dd (default: vandaag)" },
        target_average: { type: "number", description: "Streefcijfer (bv. 6.0) om te berekenen welk cijfer je voor de volgende toets nodig hebt." },
        next_grade: { type: "number", description: "Hypothetisch cijfer voor de volgende toets, om het voorspelde gemiddelde te berekenen." },
        next_grade_weight: { type: "number", description: "Weging van de volgende toets (default 1)" },
        remaining_tests: { type: "integer", description: "Aantal nog komende toetsen, om een eindgemiddelde-projectie te berekenen." },
        threshold: { type: "number", description: "Voldoende-grens (default 5.5) voor het minimum-cijfer-om-te-slagen." },
        simulation_grades: {
          type: "array",
          description: "Optioneel: extra cijfers om mee te simuleren (zoals in de app-rekenmachine).",
          items: {
            type: "object",
            properties: { value: { type: "number" }, weight: { type: "number", default: 1 } },
            required: ["value"],
          },
        },
        include_simulation: { type: "boolean", description: "Of simulatiecijfers meetellen in voorspellingen (default true)" },
        decimal_points: { type: "integer", description: "Aantal decimalen (default 2)" },
      },
      required: [],
    },
  },
  {
    name: "create_calendar_event",
    description:
      "Maak een persoonlijke agenda-afspraak/herinnering aan (bijv. een studiemoment of deadline-reminder). Deze actie wordt pas uitgevoerd nadat de gebruiker deze bevestigt.",
    parameters: {
      type: "object",
      properties: {
        start: { type: "string", description: "Startdatum/tijd in ISO-formaat (yyyy-MM-ddTHH:mm:ss)" },
        einde: { type: "string", description: "Einddatum/tijd in ISO-formaat (yyyy-MM-ddTHH:mm:ss)" },
        omschrijving: { type: "string", description: "Titel/korte omschrijving van de afspraak" },
        duurt_hele_dag: { type: "boolean", description: "Hele dag (default false)", default: false },
        lokatie: { type: "string", description: "Locatie (optioneel)" },
        inhoud: { type: "string", description: "Volledige omschrijving (optioneel)" },
      },
      required: ["start", "einde", "omschrijving"],
    },
  },
  {
    name: "download_file",
    description:
      "Download een bestand van een opgegeven URL (uit de Magister API). Geeft de bestandsgrootte en het MIME-type terug. Gebruik read_attachment_text als je de inhoud van een tekstbestand wilt lezen.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Volledige URL of relatief pad naar het bestand (zoals opgehaald uit assignment attachments of message attachments)." },
      },
      required: ["url"],
    },
  },
];

// ─── Privacy redaction (port of redact_docent & co.) ───────────────────────

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
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
  return code && code.length > 0 ? { id, code, naam: redactedNaam } : { id, naam: redactedNaam };
}

export function redactDocentenArray(arr: unknown[] | null | undefined): unknown[] {
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
    if (code && code.length <= 10 && /^[A-Za-z0-9\-_]+$/.test(code)) return code;
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

export type MinGradeForPass = { kind: "needed"; value: string } | { kind: "already_passing" } | { kind: "impossible" };

export function minGradeForPass(totalPoints: number, totalWeight: number, threshold: number): MinGradeForPass {
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
  const total = valid.reduce((s, [name, avg]) => s + (name.toLowerCase() === subjectName.toLowerCase() ? replacementAvg : avg), 0);
  return fmt(total / valid.length, decimalPoints);
}

export function predictedEnd(totalPoints: number, totalWeight: number, remainingTests: number, expectedGrade: number): number {
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
  return { tool, success: false, data: null, error: error instanceof Error ? error.message : String(error) };
}

function itemsOf(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  const r = asRecord(data);
  if (!r) return [];
  if (Array.isArray(r["Items"])) return r["Items"] as unknown[];
  if (Array.isArray(r["items"])) return r["items"] as unknown[];
  return [];
}

async function get(be: TierA, tokens: SessionTokens, path: string): Promise<unknown> {
  return be.magister<unknown>(tokens, "GET", path);
}

function strArg(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === "string" ? v : "";
}

function intArg(args: Record<string, unknown>, key: string, fallback: number): number {
  const v = args[key];
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : fallback;
}

/** Resolve scenario grades: explicit array, or overview lookup by schoolyear+subject. */
async function resolveScenarioGrades(
  ctx: WebToolContext,
  args: Record<string, unknown>,
  peildatum: string,
): Promise<{ tp: number; tw: number; count: number; subjectName: string; allSubjects: Array<[string, number]> }> {
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
      else if (typeof r["cijfer"] === "string") value = parseDutchGrade(r["cijfer"] as string);
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
    throw new Error("Geef `grades` (lijst van {value, weight}) óf `schoolyear_id` + `subject` op.");
  }
  const data = (await get(
    ctx.be,
    ctx.tokens,
    `personen/${ctx.personId}/aanmeldingen/${schoolyearId}/cijfers/cijferoverzichtvooraanmelding?actievePerioden=false&alleenBerekendeKolommen=false&alleenPTAKolommen=false&peildatum=${peildatum}`,
  )) as Record<string, unknown>;
  const rawVakken = data["CijferVakken"] ?? (asRecord(data["CijferOverzicht"])?.["CijferVakken"] ?? []);
  const vakken = Array.isArray(rawVakken) ? rawVakken : [];

  const vakName = (vak: unknown): string =>
    (asRecord(asRecord(vak)?.["Vak"])?.["Omschrijving"] as string | undefined) ?? "";
  const vakAbbr = (vak: unknown): string =>
    (asRecord(asRecord(vak)?.["Vak"])?.["Afkorting"] as string | undefined) ?? "";

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
      name === query || abbr === query || (name !== "" && name.includes(query)) || (query !== "" && query.includes(name))
    );
  });
  if (!found) {
    const known = vakken.map(vakName).filter(Boolean).join(", ");
    throw new Error(`Vak '${query}' niet gevonden in het cijferoverzicht. Bekende vakken: ${known}`);
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
async function resolveToBytes(ctx: WebToolContext, url: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  let path = url.replace(/^\/+/, "").replace(/^api\//, "");
  const endpoint = ctx.tokens.apiEndpoint.replace(/\/$/, "");
  if (/^https?:\/\//.test(path)) {
    if (!path.startsWith(endpoint)) return null;
    path = path.slice(endpoint.length).replace(/^\/+/, "");
  }
  const sep = path.includes("?") ? "&" : "?";
  try {
    const resolved = await ctx.be.magister<{ location?: string }>(ctx.tokens, "GET", `${path}${sep}__resolve=1`);
    if (!resolved?.location) return null;
    let loc = resolved.location;
    if (loc.startsWith(endpoint)) loc = loc.slice(endpoint.length).replace(/^\/+/, "");
    else if (/^https?:\/\//.test(loc)) return null; // foreign target: don't proxy blindly
    const bytes = await ctx.be.magisterBytes?.(ctx.tokens, loc);
    if (!bytes) return null;
    return { bytes, contentType: "application/octet-stream" };
  } catch {
    return null;
  }
}

/** Main dispatch — mirrors Rust `execute_tool` arm for arm. */
export async function executeWebTool(
  ctx: WebToolContext,
  toolName: string,
  rawArgs: unknown,
): Promise<WebToolResult> {
  const args = (asRecord(rawArgs) ?? {}) as Record<string, unknown>;
  const pid = ctx.personId;
  try {
    switch (toolName) {
      case "get_calendar_events": {
        const start = strArg(args, "start");
        const end = strArg(args, "end");
        const data = await get(ctx.be, ctx.tokens, `personen/${pid}/afspraken?tot=${end}&van=${start}`);
        const simplified = itemsOf(data).map((item) => {
          const r = asRecord(item) ?? {};
          const docenten = r["Docenten"];
          const first = Array.isArray(docenten) ? redactDocent(docenten[0]) : null;
          const vakken = r["Vakken"];
          const lokalen = r["Lokalen"];
          return {
            id: r["Id"] ?? null,
            start: r["Start"] ?? null,
            einde: r["Einde"] ?? null,
            vak: Array.isArray(vakken) ? (asRecord(vakken[0])?.["Naam"] ?? null) : null,
            docent: first ? (first["naam"] ?? null) : null,
            lokaal: Array.isArray(lokalen) ? (asRecord(lokalen[0])?.["Naam"] ?? null) : null,
            lesuur: r["LesuurVan"] ?? null,
            omschrijving: r["Omschrijving"] ?? null,
            inhoud: r["Inhoud"] ?? null,
            afgerond: r["Afgerond"] ?? null,
            type: r["Type"] ?? null,
            status: r["Status"] ?? null,
          };
        });
        return ok(toolName, { items: simplified, count: simplified.length });
      }

      case "get_grades": {
        const top = Math.min(intArg(args, "top", 10), 20);
        const data = await get(ctx.be, ctx.tokens, `personen/${pid}/cijfers/laatste?top=${top}&skip=0`);
        const simplified = itemsOf(data).map((item) => {
          const r = asRecord(item) ?? {};
          const dv = r["Docent"];
          let docent: unknown = null;
          if (typeof dv === "string") docent = redactTeacherNameStr(dv);
          else if (asRecord(dv)) docent = (redactDocent(dv)["naam"] ?? null) as unknown;
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
        return ok(toolName, { items: simplified, count: simplified.length });
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
        const rawVakken = data["CijferVakken"] ?? (asRecord(data["CijferOverzicht"])?.["CijferVakken"] ?? []);
        const simplified = (Array.isArray(rawVakken) ? rawVakken : []).map((vak) => {
          const v = asRecord(vak) ?? {};
          const vv = asRecord(v["Vak"]) ?? {};
          const cijfers = (Array.isArray(v["Cijfers"]) ? (v["Cijfers"] as unknown[]) : []).map((c) => {
            const cc = asRecord(c) ?? {};
            const ck = asRecord(cc["CijferKolom"]) ?? {};
            return { cijfer: cc["CijferStr"] ?? null, datum: cc["DatumIngevoerd"] ?? null, weging: cc["Weging"] ?? null, titel: ck["Titel"] ?? null };
          });
          return { vak: vv["Omschrijving"] ?? vv["Afkorting"] ?? null, gemiddelde: v["Gemiddelde"] ?? null, cijfers };
        });
        return ok(toolName, { vakken: simplified, count: simplified.length, peildatum });
      }

      case "get_schoolyears": {
        const today = new Date().toISOString().slice(0, 10);
        const data = await get(ctx.be, ctx.tokens, `leerlingen/${pid}/aanmeldingen?begin=2013-01-01&einde=${today}`);
        const simplified = itemsOf(data).map((item) => {
          const r = asRecord(item) ?? {};
          return { id: r["Id"] ?? null, naam: r["Naam"] ?? null, van: r["Van"] ?? null, tot: r["Tot"] ?? null, is_actief: r["IsActief"] ?? null };
        });
        return ok(toolName, { items: simplified, count: simplified.length });
      }

      case "get_assignments": {
        const start = strArg(args, "start");
        const end = strArg(args, "end");
        const data = await get(ctx.be, ctx.tokens, `personen/${pid}/opdrachten?van=${start}&tot=${end}`);
        const simplified = itemsOf(data).map((item) => {
          const r = asRecord(item) ?? {};
          return {
            id: r["Id"] ?? null, titel: r["Titel"] ?? null, vak: r["Vak"] ?? null,
            inleveren_voor: r["InleverenVoor"] ?? null, ingeleverd_op: r["IngeleverdOp"] ?? null,
            afgesloten: r["Afgesloten"] ?? null, omschrijving: r["Omschrijving"] ?? null, type: r["Type"] ?? null,
          };
        });
        return ok(toolName, { items: simplified, count: simplified.length });
      }

      case "get_assignment_detail": {
        const assignmentId = intArg(args, "assignment_id", 0);
        const data = (await get(ctx.be, ctx.tokens, `personen/${pid}/opdrachten/${assignmentId}`)) as Record<string, unknown>;
        const docenten = Array.isArray(data["Docenten"]) ? redactDocentenArray(data["Docenten"] as unknown[]) : [];
        const bijlagen = Array.isArray(data["Bijlagen"])
          ? (data["Bijlagen"] as unknown[]).map((a) => {
              const r = asRecord(a) ?? {};
              return { id: r["Id"] ?? null, naam: r["Naam"] ?? null, url: r["Url"] ?? null, grootte: r["Grootte"] ?? null, content_type: r["ContentType"] ?? null };
            })
          : null;
        return ok(toolName, {
          id: data["Id"] ?? null, titel: data["Titel"] ?? null, vak: data["Vak"] ?? null,
          inleveren_voor: data["InleverenVoor"] ?? null, ingeleverd_op: data["IngeleverdOp"] ?? null,
          omschrijving: data["Omschrijving"] ?? null, bijlagen, docenten,
          beoordeling: data["Beoordeling"] ?? null, beoordeeld_op: data["BeoordeeldOp"] ?? null,
          status_laatste_opdracht_versie: data["StatusLaatsteOpdrachtVersie"] ?? null,
        });
      }

      case "get_messages": {
        const folderArg = strArg(args, "folder").trim() || null;
        const top = intArg(args, "top", 10);
        const foldersData = await get(ctx.be, ctx.tokens, "berichten/mappen/alle");
        const folders = itemsOf(foldersData);
        if (folders.length === 0) return fail(toolName, "Geen mappen gevonden.");
        let folderItem = folders[0];
        if (folderArg) {
          folderItem =
            folders.find((f) => {
              const r = asRecord(f) ?? {};
              const n = (r["Naam"] ?? r["naam"]) as string | undefined;
              return typeof n === "string" && n.toLowerCase() === folderArg.toLowerCase();
            }) ?? folders[0];
        }
        const fr = asRecord(folderItem) ?? {};
        const folderName = ((fr["Naam"] ?? fr["naam"]) as string | undefined) ?? "";
        let link = "";
        const linksArr = fr["Links"];
        if (Array.isArray(linksArr) && linksArr[0]) {
          const l0 = asRecord(linksArr[0]) ?? {};
          link = ((l0["Href"] ?? l0["href"]) as string | undefined) ?? "";
        }
        if (!link) {
          const lo = asRecord(fr["links"]) ?? {};
          link = ((asRecord(lo["berichten"])?.["href"]) as string | undefined) ?? "";
        }
        if (!link) {
          const lo = asRecord(fr["Links"]) ?? {};
          link = ((asRecord(lo["berichten"])?.["href"]) as string | undefined) ?? "";
        }
        if (!link) {
          const fid = (fr["Id"] ?? fr["id"]) as number | undefined;
          link = typeof fid === "number" && fid !== 0 ? `berichten/mappen/${fid}/berichten` : "";
        } else {
          link = link.replace(/^\/api\//, "");
        }
        const msgs = await get(ctx.be, ctx.tokens, `${link.replace(/^\//, "")}/berichten?top=${top}`);
        const simplified = itemsOf(msgs).map((item) => {
          const r = asRecord(item) ?? {};
          return {
            id: r["Id"] ?? r["id"] ?? null,
            onderwerp: r["Onderwerp"] ?? r["onderwerp"] ?? null,
            afzender: (asRecord(r["Afzender"])?.["Naam"] ?? asRecord(r["afzender"])?.["naam"]) ?? null,
            datum: r["DatumVerzonden"] ?? r["verzondenOp"] ?? r["VerzondenOp"] ?? null,
            gelezen: r["IsGelezen"] ?? r["isGelezen"] ?? null,
            prioriteit: r["Prioriteit"] ?? r["heeftPrioriteit"] ?? null,
          };
        });
        return ok(toolName, { items: simplified, count: simplified.length, folder: folderName });
      }

      case "get_message_content": {
        const messageId = intArg(args, "message_id", 0);
        const data = (await get(ctx.be, ctx.tokens, `berichten/${messageId}`)) as Record<string, unknown>;
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
        const recipients = Array.isArray(args["recipients"]) ? (args["recipients"] as unknown[]) : [];
        if (!subject.trim() || !body.trim() || recipients.length === 0) {
          return fail(toolName, "Bericht ontbreekt: onderwerp, inhoud en minstens één ontvanger zijn verplicht.");
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
        const message_ids = (Array.isArray(args["message_ids"]) ? (args["message_ids"] as unknown[]) : [])
          .filter((v): v is number => typeof v === "number" && Number.isInteger(v));
        if (message_ids.length === 0) return fail(toolName, "Geen geldige bericht-ID's opgegeven.");
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
        const data = await get(ctx.be, ctx.tokens, `personen/${pid}/absenties?tot=${end}&van=${start}`);
        const arr = itemsOf(data);
        return ok(toolName, { items: arr, count: arr.length });
      }

      case "get_studiewijzers": {
        const data = await get(ctx.be, ctx.tokens, `personen/${pid}/studiewijzers`);
        const simplified = itemsOf(data).map((item) => {
          const r = asRecord(item) ?? {};
          return {
            id: r["Id"] ?? null, naam: r["Naam"] ?? null, vak: r["VakNaam"] ?? null,
            geldig_vanaf: r["GeldigVanaf"] ?? null, geldig_tot: r["GeldigTot"] ?? null,
          };
        });
        return ok(toolName, { items: simplified, count: simplified.length });
      }

      case "get_activities": {
        const data = await get(ctx.be, ctx.tokens, `personen/${pid}/activiteiten`);
        const simplified = itemsOf(data).map((item) => {
          const r = asRecord(item) ?? {};
          return {
            id: r["Id"] ?? null, naam: r["Naam"] ?? null, categorie: r["Categorie"] ?? null,
            begin: r["Begin"] ?? null, einde: r["Einde"] ?? null, status: r["Status"] ?? null,
          };
        });
        return ok(toolName, { items: simplified, count: simplified.length });
      }

      case "get_bronnen": {
        const data = await get(ctx.be, ctx.tokens, `personen/${pid}/bronnen?soort=0`);
        const simplified = itemsOf(data).map((item) => {
          const r = asRecord(item) ?? {};
          return {
            id: r["Id"] ?? null, naam: r["Naam"] ?? null, bron_soort: r["BronSoort"] ?? null,
            url: r["Url"] ?? null, is_favoriet: r["IsFavoriet"] ?? null,
          };
        });
        return ok(toolName, { items: simplified, count: simplified.length });
      }

      case "get_leermiddelen": {
        const data = await get(ctx.be, ctx.tokens, `personen/${pid}/lesmateriaal`);
        const simplified = itemsOf(data).map((item) => {
          const r = asRecord(item) ?? {};
          return {
            id: r["Id"] ?? null, titel: r["Titel"] ?? null, vak: r["VakNaam"] ?? null,
            uitgever: r["Uitgever"] ?? null, type: r["Type"] ?? null,
          };
        });
        return ok(toolName, { items: simplified, count: simplified.length });
      }

      case "get_profile_info": {
        // Privacy: no account, adressen, or geboortedatum to the model.
        const out: Record<string, unknown> = {};
        try {
          const profile = (await get(ctx.be, ctx.tokens, `personen/${pid}`)) as Record<string, unknown>;
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
          const career = (await get(ctx.be, ctx.tokens, `personen/${pid}/opleidinggegevensprofiel`)) as Record<string, unknown>;
          for (const key of ["Mentor", "mentor", "Docent", "docent", "Docenten"]) {
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

      case "get_today_summary": {
        const today = new Date().toISOString().slice(0, 10);
        const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
        const summary: Record<string, unknown> = {};
        try {
          const events = await get(ctx.be, ctx.tokens, `personen/${pid}/afspraken?tot=${today}&van=${today}`);
          summary["vandaag_lessen"] = itemsOf(events).map((item) => {
            const r = asRecord(item) ?? {};
            const docenten = r["Docenten"];
            return {
              ...r,
              Docenten: Array.isArray(docenten) ? redactDocentenArray(docenten) : [],
            };
          });
        } catch { /* omit section */ }
        try {
          const grades = await get(ctx.be, ctx.tokens, `personen/${pid}/cijfers/laatste?top=5&skip=0`);
          summary["recente_cijfers"] = itemsOf(grades).map((item) => {
            const r = { ...(asRecord(item) ?? {}) };
            if (typeof r["Docent"] === "string") r["Docent"] = redactTeacherNameStr(r["Docent"] as string);
            return r;
          });
        } catch { /* omit section */ }
        try {
          const assignments = await get(ctx.be, ctx.tokens, `personen/${pid}/opdrachten?van=${today}&tot=${nextWeek}`);
          summary["aankomende_opdrachten"] = itemsOf(assignments).map((item) => {
            const r = asRecord(item) ?? {};
            const docenten = r["Docenten"];
            return {
              ...r,
              Docenten: Array.isArray(docenten) ? redactDocentenArray(docenten) : [],
            };
          });
        } catch { /* omit section */ }
        try {
          const folders = await get(ctx.be, ctx.tokens, "berichten/mappen/alle");
          const unread = itemsOf(folders).reduce(
            (sum: number, f: unknown) =>
              sum + (Number((asRecord(f) ?? {})["aantalOngelezen"] ?? (asRecord(f) ?? {})["AantalOngelezen"] ?? 0) || 0),
            0,
          );
          summary["ongelezen_berichten"] = unread;
        } catch { /* omit section */ }
        try {
          const absences = await get(ctx.be, ctx.tokens, `personen/${pid}/absenties?tot=${today}&van=${today}`);
          summary["vandaag_absenties"] = itemsOf(absences);
        } catch { /* omit section */ }
        return ok(toolName, summary);
      }

      case "read_attachment_text": {
        const url = strArg(args, "url");
        const filename = strArg(args, "filename") || "bijlage";
        if (!url) return fail(toolName, "Geen URL opgegeven.");
        const lower = filename.toLowerCase();
        const isText =
          /\.(txt|md|markdown|csv|json|xml|log|yaml|yml|html?|css|js|ts)$/.test(lower) ||
          /^(tekst|text\/plain)/.test(lower);
        if (!isText) {
          return fail(
            toolName,
            "Alleen platte tekstbijlagen kunnen op web worden gelezen (geen PDF/Word-ondersteuning in de browser).",
          );
        }
        const resolved = await resolveToBytes(ctx, url);
        if (!resolved) return fail(toolName, "Kon download-link niet resolven.");
        let text: string;
        try {
          text = new TextDecoder("utf-8", { fatal: false }).decode(resolved.bytes);
        } catch (e) {
          return fail(toolName, `Kon tekst niet decoderen: ${e instanceof Error ? e.message : String(e)}`);
        }
        const MAX = 8000;
        const truncated = text.length > MAX;
        const clipped = truncated ? text.slice(0, MAX) : text;
        return ok(toolName, {
          filename,
          content_type: "text/plain",
          size_bytes: resolved.bytes.length,
          text: clipped,
          char_count: clipped.length,
          truncated,
          message: truncated
            ? "De tekst is afgekapt tot 8000 tekens om ruimte te besparen."
            : "De volledige tekst van de bijlage staat hierboven.",
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
        const resolved = await resolveToBytes(ctx, url);
        if (!resolved) return fail(toolName, "Kon download-link niet resolven.");
        // Cap the read: report size/type without pulling multi-MB blobs fully
        // into the model context (desktop downloads fully; browsers shouldn't).
        const CAP = 8 * 1024 * 1024;
        return ok(toolName, {
          url,
          size_bytes: resolved.bytes.length,
          size_mb: resolved.bytes.length / 1048576,
          mime_type: resolved.contentType,
          capped: resolved.bytes.length >= CAP,
          message: "Het bestand is gedownload. De AI kan de inhoud niet lezen, maar je kunt het openen via de link.",
        });
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
  const today = new Date().toISOString().slice(0, 10);
  const peil = peildatumRaw.length >= 10 ? peildatumRaw.slice(0, 10) : today;
  let resolved: { tp: number; tw: number; count: number; subjectName: string; allSubjects: Array<[string, number]> };
  try {
    resolved = await resolveScenarioGrades(ctx, args, peil);
  } catch (e) {
    return fail(toolName, e);
  }
  const { tp, tw, count, subjectName, allSubjects } = resolved;

  const targetAverage = typeof args["target_average"] === "number" ? (args["target_average"] as number) : null;
  const nextGrade = typeof args["next_grade"] === "number" ? (args["next_grade"] as number) : null;
  const nextGradeWeight = typeof args["next_grade_weight"] === "number" ? (args["next_grade_weight"] as number) : 1;
  const remainingTests = typeof args["remaining_tests"] === "number" ? Math.trunc(args["remaining_tests"] as number) : null;
  const threshold = typeof args["threshold"] === "number" ? (args["threshold"] as number) : null;
  const simulation: GradePoint[] = Array.isArray(args["simulation_grades"])
    ? (args["simulation_grades"] as unknown[])
        .map((g) => {
          const r = asRecord(g);
          if (!r) return null;
          let value: number | null = null;
          if (typeof r["value"] === "number") value = r["value"] as number;
          else if (typeof r["cijfer"] === "number") value = r["cijfer"] as number;
          else if (typeof r["cijfer"] === "string") value = parseDutchGrade(r["cijfer"] as string);
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
  const includeSimulation = typeof args["include_simulation"] === "boolean" ? (args["include_simulation"] as boolean) : true;

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
    const req = requiredGrade(tp, tw, targetAverage, nextGradeWeight, simulation, decimalPoints);
    result["required_grade"] = req;
    const n = Number(req);
    if (Number.isFinite(n)) result["required_grade_numeric"] = n;
    result["target_average"] = numOrNull(targetAverage);
    result["required_grade_grade_weight"] = numOrNull(nextGradeWeight);
  }

  if (nextGrade != null) {
    const withNext = [...simulation, { value: nextGrade, weight: nextGradeWeight }];
    const pa = predictedAverage(tp, tw, withNext, includeSimulation, decimalPoints);
    result["predicted_average"] = pa;
    const n = Number(pa);
    if (Number.isFinite(n)) result["predicted_average_numeric"] = n;
    result["average_for_grade"] = averageForGrade(tp, tw, nextGrade, nextGradeWeight, decimalPoints);
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
      pass.kind === "needed" ? pass.value : pass.kind === "already_passing" ? "already_passing" : "impossible";
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
  if (!entry) throw new Error("Actie verlopen of onbekend — vraag de AI het opnieuw klaar te zetten.");
  pendingActions.delete(actionId);
  const args = entry.args;
  const pid = ctx.personId;

  switch (entry.action.action_type) {
    case "send_message": {
      const subject = strArg(args, "subject");
      const body = strArg(args, "body");
      const recipients = (Array.isArray(args["recipients"]) ? (args["recipients"] as unknown[]) : []).map((r) => {
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
      const message_ids = (Array.isArray(args["message_ids"]) ? (args["message_ids"] as unknown[]) : []).filter(
        (v): v is number => typeof v === "number" && Number.isInteger(v),
      );
      await ctx.be.magister(ctx.tokens, "PUT", "berichten/gelezen", { BerichtIds: message_ids });
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
      await ctx.be.magister(ctx.tokens, "POST", `personen/${pid}/afspraken`, body);
      return { status: "aangemaakt", omschrijving };
    }

    default:
      throw new Error(`Onbekend actietype: ${entry.action.action_type}`);
  }
}
