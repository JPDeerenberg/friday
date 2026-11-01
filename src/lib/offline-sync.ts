/**
 * Automatisch bewaren: haalt op de achtergrond alles op wat je offline nodig
 * hebt (agenda 4 weken terug / 8 weken vooruit, cijfers, berichten, opdrachten,
 * ...). Alles gaat via de gewone api-functies, die elk resultaat zelf bewaren.
 *
 * Rustig en achter elkaar (nooit parallel) om Magister niet te hameren, en
 * direct gestopt zodra blijkt dat er geen verbinding is.
 */

import { get } from "svelte/store";
import {
  getAbsences,
  getActivities,
  getAssignmentDetail,
  getAssignments,
  getBulkGradeExtraInfo,
  getCareerInfo,
  getExternalBronSources,
  getGrades,
  getLeermiddelen,
  getMessageDetail,
  getMessageFolders,
  getMessages,
  getProfileAddresses,
  getProfileInfo,
  getRecentGrades,
  getSchoolyears,
  getStudiewijzers,
  getCalendarEvents,
  formatDate,
  isWebBuild,
  prefetchAttachment,
} from "./api.ts";
import {
  hasStored,
  isOfflineEnabled,
  offlineKey,
  offlineStatus,
  pruneItemsBefore,
  setLastSyncAt,
} from "./offline.ts";

/** Agenda: 4 weken terug, 8 weken vooruit. */
export const CALENDAR_DAYS_BACK = 28;
export const CALENDAR_DAYS_AHEAD = 56;
const MESSAGE_DETAILS = 15;
const ASSIGNMENT_DETAILS = 15;
const ATTACHMENTS_PER_SYNC = 10;
export const MIN_SYNC_INTERVAL_MS = 30 * 60 * 1000;

let running: Promise<SyncResult> | null = null;
let lastStartedAt = 0;

export interface SyncResult {
  ran: boolean;
  /** Aantal onderdelen dat is bijgewerkt. */
  done: number;
  /** Onderdelen die mislukten. */
  failed: string[];
  /** Gestopt omdat er geen verbinding bleek te zijn. */
  offline: boolean;
}

function day(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return formatDate(d);
}

const isStale = () => get(offlineStatus).stale;
const noNetwork = () =>
  typeof navigator !== "undefined" && navigator.onLine === false;

/**
 * Bewaar alles voor offline gebruik. `force` negeert het minimale interval
 * (knop in de instellingen); automatisch draait het hooguit elke 30 minuten.
 */
export function runOfflineSync(
  pid: number,
  opts: { force?: boolean } = {},
): Promise<SyncResult> {
  if (!isOfflineEnabled() || !pid) {
    return Promise.resolve({ ran: false, done: 0, failed: [], offline: false });
  }
  if (running) return running;
  if (!opts.force && Date.now() - lastStartedAt < MIN_SYNC_INTERVAL_MS) {
    return Promise.resolve({ ran: false, done: 0, failed: [], offline: false });
  }
  lastStartedAt = Date.now();
  running = doSync(pid).finally(() => {
    running = null;
  });
  return running;
}

async function doSync(pid: number): Promise<SyncResult> {
  const result: SyncResult = { ran: true, done: 0, failed: [], offline: false };

  // Eén stap: faalt hij, dan merken we dat aan een "stale" terugval.
  // Geeft false terug als we moeten stoppen (geen verbinding).
  async function step(name: string, fn: () => Promise<unknown>) {
    if (!isOfflineEnabled()) return false;
    if (noNetwork()) {
      result.offline = true;
      return false;
    }
    try {
      await fn();
      if (isStale()) {
        // De api gaf een bewaarde kopie terug: live lukte niet.
        result.failed.push(name);
        result.offline = true;
        return false;
      }
      result.done++;
    } catch (e) {
      console.warn(`[OfflineSync] ${name} failed`, e);
      result.failed.push(name);
    }
    return true;
  }

  // 1. Agenda eerst: dat is wat je het vaakst nodig hebt.
  for (let from = -CALENDAR_DAYS_BACK; from < CALENDAR_DAYS_AHEAD; from += 28) {
    const to = Math.min(from + 27, CALENDAR_DAYS_AHEAD);
    const ok = await step(`agenda ${from}..${to}`, () =>
      getCalendarEvents(pid, day(from), day(to)),
    );
    if (!ok && result.offline) return finish(result, pid);
  }
  await pruneItemsBefore("calendar", pid, day(-CALENDAR_DAYS_BACK));

  // 2. Cijfers: huidig jaar volledig, eerdere jaren voor de voortgangsgrafiek.
  let years: Awaited<ReturnType<typeof getSchoolyears>> = [];
  if (
    !(await step("schooljaren", async () => {
      years = await getSchoolyears(pid, "2013-01-01", day(0));
    }))
  )
    return finish(result, pid);
  await step("schooljaren (kort)", () => getSchoolyears(pid));

  const now = new Date();
  const current =
    years.find(
      (y) =>
        y.begin &&
        y.einde &&
        new Date(y.begin) <= now &&
        new Date(y.einde) >= now,
    ) ?? years[years.length - 1];

  for (const y of [current, ...years.filter((x) => x !== current)]) {
    if (!y?.id || !y.einde) continue;
    const yearId = y.id;
    const peil = y.einde.split("T")[0];
    const ok = await step(`cijfers ${yearId}`, async () => {
      const grades = await getGrades(pid, yearId, peil);
      // Weging/omschrijving alleen voor het huidige jaar, net als de cijferpagina.
      if (y === current) {
        const cols = [
          ...new Set(
            grades
              .filter((g) => g.CijferKolom?.KolomSoort === 1)
              .map((g) => g.CijferKolom.Id),
          ),
        ];
        if (cols.length) await getBulkGradeExtraInfo(pid, yearId, cols);
      }
    });
    if (!ok && result.offline) return finish(result, pid);
  }
  await step("laatste cijfers", () => getRecentGrades(pid, 5));

  // 3. Opdrachten.
  let assignments: Awaited<ReturnType<typeof getAssignments>> = [];
  await step("opdrachten", async () => {
    assignments = await getAssignments(
      pid,
      "2013-01-01",
      formatDate(new Date(Date.now() + 365 * 86400000)),
    );
  });
  const open = assignments
    .filter((a) => !a.Afgesloten)
    .sort((a, b) => a.InleverenVoor.localeCompare(b.InleverenVoor))
    .slice(0, ASSIGNMENT_DETAILS);
  let attachmentBudget = ATTACHMENTS_PER_SYNC;
  for (const a of open) {
    const link = a.Links?.find((l) => l.Rel === "Self")?.Href;
    if (!link) continue;
    let detail: Awaited<ReturnType<typeof getAssignmentDetail>> | null = null;
    const ok = await step(`opdracht ${a.Id}`, async () => {
      detail = await getAssignmentDetail(link);
    });
    if (!ok && result.offline) return finish(result, pid);
    // Kleine bijlagen ook bewaren (alleen web; op desktop/Android staat een
    // gedownload bestand al op het apparaat).
    if (detail && isWebBuild()) {
      for (const b of (
        detail as {
          Bijlagen?: Array<{
            Grootte: number;
            Links?: Array<{ Rel: string; Href: string }>;
          }>;
        }
      ).Bijlagen ?? []) {
        if (attachmentBudget <= 0) break;
        const url = b.Links?.find((l) => l.Rel === "Self")?.Href;
        if (!url) continue;
        if (await prefetchAttachment(url, b.Grootte)) attachmentBudget--;
      }
    }
  }

  // 4. Berichten: mappen, eerste map, en de nieuwste berichten volledig.
  let folders: Awaited<ReturnType<typeof getMessageFolders>> = [];
  await step("berichtmappen", async () => {
    folders = await getMessageFolders();
  });
  const first = folders[0];
  const href = first?.links?.berichten?.href;
  if (href) {
    let list: Awaited<ReturnType<typeof getMessages>> = [];
    await step("berichten", async () => {
      list = await getMessages(href, 50, 0);
    });
    for (const m of list.slice(0, MESSAGE_DETAILS)) {
      const link = m.links?.self?.href;
      if (!link) continue;
      if (await hasStored(offlineKey("message", link))) continue;
      const ok = await step(`bericht ${m.id}`, () => getMessageDetail(link));
      if (!ok && result.offline) return finish(result, pid);
    }
  }

  // 5. Rest: profiel, absenties, studiewijzers, activiteiten, ...
  await step("profiel", () => getProfileInfo(pid));
  await step("adressen", () => getProfileAddresses(pid));
  await step("opleiding", () => getCareerInfo(pid));
  await step("absenties", async () => {
    const list = await getSchoolyears(pid);
    const newest = [...list].sort(
      (a, b) => new Date(b.begin).getTime() - new Date(a.begin).getTime(),
    )[0];
    if (newest) {
      await getAbsences(
        pid,
        newest.begin.split("T")[0],
        newest.einde.split("T")[0],
      );
    }
  });
  await step("studiewijzers", () => getStudiewijzers(pid));
  await step("activiteiten", () => getActivities(pid));
  await step("leermiddelen", () => getLeermiddelen(pid));
  await step("bronnen", () => getExternalBronSources(pid));

  return finish(result, pid);
}

function finish(result: SyncResult, _pid: number): SyncResult {
  // Een ronde telt als geslaagd zodra er iets is bijgewerkt en we niet
  // halverwege zonder verbinding kwamen te zitten.
  if (result.done > 0 && !result.offline) setLastSyncAt(Date.now());
  return result;
}
