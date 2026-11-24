/**
 * Cross-device sync via one hidden Magister personal appointment per chunk.
 *
 * Magister is the only backend Friday has, so the sync document lives in
 * `Inhoud` of Type 1 / InfoType 6 appointments named "Friday Sync". These are
 * filtered out of every agenda view. Nothing is sent to a Friday server.
 *
 * Merge model: one entry per logical value (`settings.startPage`,
 * `plan.<itemId>`, `friends.state`, ...) with a logical revision and a
 * last-writer-wins timestamp. Deletions become tombstones. This survives
 * offline edits on two devices without a server clock.
 */
import { get, writable } from "svelte/store";
import {
  createCalendarEvent,
  deleteCalendarEvent,
  getCalendarEvents,
} from "./api.ts";
import { getAiConfig, setAiConfig, type AiConfig } from "./ai.ts";
import { userSettings, letterScan } from "./stores.ts";
import { friends } from "./friends-store.ts";
import { sanitizeState } from "./friends-state.ts";
import { quests } from "./quests-store.ts";
import { sanitizeQuestState } from "./quests.ts";
import { gradeRevealState, sanitizeGradeRevealState } from "./grade-reveal.ts";
import {
  dbAddMessage,
  dbGetMessages,
  dbListConversations,
  dbPutConversation,
} from "./web-ai-chats-store.ts";
import { getNotes, saveNotes } from "./ai-notes.ts";
import {
  getAllAiScheduleItems,
  replaceAiScheduleItems,
} from "./ai-schedule.ts";
import { loadCombinations, saveCombinations } from "./grades/combinations.ts";
import {
  CHUNK_PAYLOAD,
  decodeSyncChunks,
  deriveSyncKey,
  encodeSyncDoc,
  parseSyncChunk,
  stableHash,
} from "./sync-codec.ts";
import { entriesEqual, mergeEntries } from "./sync-merge.ts";
import {
  SYNC_DB_KEY,
  SYNC_DESCRIPTION,
  SYNC_LOCATION,
  SYNC_META_KEY,
  SYNC_SETTINGS_KEY,
  type SyncCategory,
  type SyncDoc,
  type SyncEntry,
  type SyncMeta,
  type SyncResult,
  type SyncSettings,
} from "./sync-types.ts";
import type { Conversation, StoredMessage } from "./ai-chats.ts";
import type { AiScheduleItem } from "./ai-schedule-types.ts";
import type { CalendarEvent } from "./types.ts";
import type { FriendsState } from "./friends-state.ts";
import type { QuestState } from "./quests.ts";
import type { AiNotes } from "./ai-notes.ts";
import type { GradeCombination } from "./grades/combinations.ts";

const MAX_CHUNKS = 200;
/** Chunk sizes tried in order; Magister may reject long `Inhoud` values. */
const CHUNK_PAYLOAD_SIZES = [CHUNK_PAYLOAD, 800, 400, 200];
/** Settings that describe this device only and must not travel between clients. */
const LOCAL_SETTING_KEYS = new Set(["downloadDir"]);
/** Local UI caches synced via the settings category (never via userSettings). */
const LOCAL_UI_CACHE_KEYS: Array<{ syncKey: string; storageKey: string }> = [
  { syncKey: "ui.bronnenCurrent", storageKey: "bronnen_current_items" },
  { syncKey: "ui.bronnenPath", storageKey: "bronnen_path_history" },
  { syncKey: "ui.gradesUi", storageKey: "grades_ui_state" },
];
/** Rough cap for one UI cache; larger values stay on this device. */
const MAX_UI_CACHE_CHARS = 12_000;
const MAX_SYNC_CHAT_CONVERSATIONS = 25;
const MAX_SYNC_CHAT_MESSAGES = 40;
const MAX_SYNC_CHAT_CHARS = 60_000;
const DEFAULT_CATEGORIES: Record<SyncCategory, { enabled: boolean }> = {
  settings: { enabled: true },
  plan: { enabled: true },
  friends: { enabled: true },
  notes: { enabled: true },
  quests: { enabled: true },
  cards: { enabled: true },
  ai: { enabled: true },
  letterScan: { enabled: true },
  calendar: { enabled: true },
  grades: { enabled: true },
  chats: { enabled: true },
};

export const syncStatus = writable<{
  state: "idle" | "syncing" | "ok" | "error";
  message: string;
  at: number | null;
  lastResult: SyncResult | null;
}>({ state: "idle", message: "", at: null, lastResult: null });

let running: Promise<SyncResult> | null = null;
let syncKey: CryptoKey | null = null;

/** Unlock an encrypted remote document for this app session. */
export async function unlockSync(passphrase: string): Promise<void> {
  syncKey = await deriveSyncKey(passphrase);
}

export function lockSync(): void {
  syncKey = null;
}

export function isSyncUnlocked(): boolean {
  return syncKey != null;
}

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Local wall-clock ISO without a timezone suffix, matching Calendar create. */
function localIso(d: Date): string {
  return `${isoDate(d)}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:00`;
}

function currentSchoolYear(now = new Date()): { year: number; date: string } {
  const year = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
  return { year, date: `${year}-09-01` };
}

function newDeviceId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function loadSyncSettings(): SyncSettings {
  const school = currentSchoolYear();
  const fallback: SyncSettings = {
    enabled: true,
    date: school.date,
    remoteDate: null,
    deviceId: newDeviceId(),
    encrypted: false,
    remoteEncrypted: false,
    categories: DEFAULT_CATEGORIES,
    lastSyncAt: null,
    lastError: null,
  };
  try {
    const raw =
      typeof localStorage !== "undefined"
        ? localStorage.getItem(SYNC_SETTINGS_KEY)
        : null;
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<SyncSettings>;
    const categories = { ...DEFAULT_CATEGORIES };
    for (const key of Object.keys(categories) as SyncCategory[]) {
      if (parsed.categories?.[key]?.enabled === false)
        categories[key] = { enabled: false };
    }
    return {
      ...fallback,
      ...parsed,
      date: /^\d{4}-\d{2}-\d{2}$/.test(parsed.date ?? "")
        ? parsed.date!
        : fallback.date,
      remoteDate:
        typeof parsed.remoteDate === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(parsed.remoteDate)
          ? parsed.remoteDate
          : null,
      deviceId: parsed.deviceId || fallback.deviceId,
      encrypted: parsed.encrypted === true,
      remoteEncrypted: parsed.remoteEncrypted === true,
      categories,
    };
  } catch {
    return fallback;
  }
}

export function saveSyncSettings(settings: SyncSettings): void {
  try {
    localStorage.setItem(SYNC_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // storage blocked; sync still works in memory for this session
  }
}

function loadMeta(): SyncMeta {
  try {
    const raw = localStorage.getItem(SYNC_META_KEY);
    return raw ? (JSON.parse(raw) as SyncMeta) : {};
  } catch {
    return {};
  }
}

function saveMeta(meta: SyncMeta): void {
  try {
    localStorage.setItem(SYNC_META_KEY, JSON.stringify(meta));
  } catch {
    // ignore
  }
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore
  }
}

/** Only plain JSON objects/arrays travel; scalars are never a UI cache. */
function isUiCacheValue(value: unknown): boolean {
  return Array.isArray(value) || (!!value && typeof value === "object");
}

function serializeUiCache(value: unknown): string | null {
  if (!isUiCacheValue(value)) return null;
  try {
    const serialized = JSON.stringify(value);
    return serialized && serialized.length <= MAX_UI_CACHE_CHARS
      ? serialized
      : null;
  } catch {
    return null;
  }
}

/** Read a local UI cache, refusing values that are missing, scalar or too big. */
function readUiCache(storageKey: string): unknown | null {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw || raw.length > MAX_UI_CACHE_CHARS) return null;
    const value: unknown = JSON.parse(raw);
    return isUiCacheValue(value) ? value : null;
  } catch {
    return null;
  }
}

/** Apply a remote UI cache; invalid or oversized values keep the local copy. */
function applyUiCache(storageKey: string, value: unknown): void {
  const serialized = serializeUiCache(value);
  if (serialized === null) return;
  try {
    localStorage.setItem(storageKey, serialized);
  } catch {
    // Storage blocked; the next sync simply retries.
  }
}

interface ChatsPayload {
  conversations: Array<{
    conversation: Conversation;
    messages: StoredMessage[];
  }>;
}

async function collectChats(): Promise<ChatsPayload> {
  // Chat history can grow far beyond what fits in a Magister appointment.
  // Sync only the most recent slice; older local messages stay on the device.
  const conversations = (await dbListConversations()).slice(
    0,
    MAX_SYNC_CHAT_CONVERSATIONS,
  );
  const out: ChatsPayload["conversations"] = [];
  let used = 0;
  for (const conversation of conversations) {
    const messages = await dbGetMessages(conversation.id);
    const recent = messages.slice(-MAX_SYNC_CHAT_MESSAGES);
    const size =
      JSON.stringify(recent).length + JSON.stringify(conversation).length;
    if (out.length > 0 && used + size > MAX_SYNC_CHAT_CHARS) break;
    out.push({ conversation, messages: recent });
    used += size;
  }
  return { conversations: out };
}

async function collectLocal(
  settings: SyncSettings,
  meta: SyncMeta,
  firstSync: boolean,
): Promise<{ entries: SyncEntry[]; meta: SyncMeta }> {
  const nextMeta: SyncMeta = { ...meta };
  const entries: SyncEntry[] = [];
  const now = Date.now();
  const device = settings.deviceId;

  const add = (key: string, category: SyncCategory, value: unknown) => {
    if (!settings.categories[category].enabled) return;
    const hash = stableHash(value);
    const prev = nextMeta[key];
    let rev = prev?.rev ?? 0;
    let updatedAt = prev?.updatedAt ?? 0;
    if (!prev || prev.hash !== hash) {
      // A brand-new local entry on a device that has never synced must not
      // beat an existing remote document with default settings.
      rev = (prev?.rev ?? 0) + 1;
      updatedAt = firstSync && !prev ? 0 : now;
    }
    nextMeta[key] = { rev, updatedAt, hash };
    entries.push({
      key,
      category,
      rev,
      updatedAt,
      device,
      value,
    });
  };

  const remove = (key: string, category: SyncCategory) => {
    if (!settings.categories[category].enabled) return;
    const prev = nextMeta[key];
    if (!prev) return;
    const rev = prev.rev + 1;
    nextMeta[key] = { rev, updatedAt: now, hash: "" };
    entries.push({
      key,
      category,
      rev,
      updatedAt: now,
      device,
      deleted: true,
    });
  };

  const s = get(userSettings);
  for (const [key, value] of Object.entries(s)) {
    if (key === "aiSchedule" || LOCAL_SETTING_KEYS.has(key)) continue;
    add(`settings.${key}`, "settings", value);
  }

  add("plan.settings", "plan", s.aiSchedule);
  const planItems = await getAllAiScheduleItems();
  const planIds = new Set<string>();
  for (const item of planItems) {
    planIds.add(`plan.${item.id}`);
    add(`plan.${item.id}`, "plan", item);
  }
  for (const key of Object.keys(nextMeta)) {
    if (
      key.startsWith("plan.") &&
      key !== "plan.settings" &&
      !planIds.has(key) &&
      nextMeta[key].hash !== ""
    ) {
      remove(key, "plan");
    }
  }

  add("friends.state", "friends", get(friends));
  add("quests.state", "quests", get(quests));
  add("cards.state", "cards", get(gradeRevealState));
  add("letterScan.state", "letterScan", get(letterScan));
  add(
    "calendar.overrides",
    "calendar",
    readJson<Record<string, string>>("calendar_overrides", {}),
  );
  add("grades.combinations", "grades", loadCombinations());
  // UI caches live in localStorage, not in userSettings, but they travel in
  // the settings category so they never need a separate Settings switch.
  for (const { syncKey, storageKey } of LOCAL_UI_CACHE_KEYS) {
    const value = readUiCache(storageKey);
    if (value !== null) add(syncKey, "settings", value);
  }

  if (settings.categories.notes.enabled) {
    const notes = await getNotes();
    // Only content is synced. Revision/timestamp are device-local metadata;
    // syncing them would make every pull look like a new local edit and
    // trigger an endless revision ping-pong.
    add("notes.state", "notes", { content: notes.content });
  }
  if (settings.categories.ai.enabled) {
    const cfg = await getAiConfig();
    add("ai.state", "ai", {
      base_url: cfg.base_url,
      model: cfg.model,
      enabled: cfg.enabled,
      provider: cfg.provider,
      use_data_access: cfg.use_data_access,
      ai_notes_ai_can_edit: cfg.ai_notes_ai_can_edit,
      ai_notes_use_in_chats: cfg.ai_notes_use_in_chats,
    });
  }
  if (settings.categories.chats.enabled) {
    add("chats.state", "chats", await collectChats());
  }

  return { entries, meta: nextMeta };
}

async function applyEntries(entries: SyncEntry[]): Promise<void> {
  const settingsPatch: Record<string, unknown> = {};
  let planSettings: unknown = null;
  let planChanged = false;
  let friendsState: FriendsState | null = null;
  let questState: QuestState | null = null;
  let cardsState: unknown = null;
  let letterScanState: unknown = null;
  let aiState: AiConfig | null = null;
  let notesState: AiNotes | null = null;
  let chatsState: ChatsPayload | null = null;
  let calendar: Record<string, string> | null = null;
  let gradeCombos: GradeCombination[] | null = null;
  const planItems = await getAllAiScheduleItems();
  const planMap = new Map(planItems.map((i) => [i.id, i]));

  for (const entry of entries) {
    if (entry.deleted) {
      if (entry.key.startsWith("plan.") && entry.key !== "plan.settings") {
        planMap.delete(entry.key.slice("plan.".length));
        planChanged = true;
      }
      continue;
    }
    if (entry.key.startsWith("settings.")) {
      const key = entry.key.slice("settings.".length);
      if (key !== "aiSchedule" && !LOCAL_SETTING_KEYS.has(key))
        settingsPatch[key] = entry.value;
    } else if (entry.key === "plan.settings") {
      planSettings = entry.value;
    } else if (entry.key.startsWith("plan.")) {
      const item = entry.value as AiScheduleItem;
      if (item && typeof item.id === "string") {
        planMap.set(item.id, item);
        planChanged = true;
      }
    } else if (entry.key === "friends.state") {
      friendsState = entry.value as FriendsState;
    } else if (entry.key === "quests.state") {
      questState = entry.value as QuestState;
    } else if (entry.key === "cards.state") {
      cardsState = entry.value;
    } else if (entry.key === "letterScan.state") {
      letterScanState = entry.value;
    } else if (entry.key === "ai.state") {
      aiState = entry.value as AiConfig;
    } else if (entry.key === "notes.state") {
      notesState = entry.value as AiNotes;
    } else if (entry.key === "chats.state") {
      chatsState = entry.value as ChatsPayload;
    } else if (entry.key === "calendar.overrides") {
      calendar = entry.value as Record<string, string>;
    } else if (entry.key === "grades.combinations") {
      gradeCombos = entry.value as GradeCombination[];
    } else {
      // Local UI caches (ui.bronnenCurrent, ui.bronnenPath, ui.gradesUi) are
      // written straight to localStorage; they are never part of userSettings.
      const uiCache = LOCAL_UI_CACHE_KEYS.find((c) => c.syncKey === entry.key);
      if (uiCache) applyUiCache(uiCache.storageKey, entry.value);
    }
  }

  if (Object.keys(settingsPatch).length > 0 || planSettings) {
    userSettings.update((s) => ({
      ...s,
      ...(settingsPatch as Partial<typeof s>),
      ...(planSettings
        ? { aiSchedule: planSettings as typeof s.aiSchedule }
        : {}),
    }));
  }
  if (planChanged) await replaceAiScheduleItems([...planMap.values()]);
  const safeFriends = sanitizeState(friendsState);
  if (safeFriends) friends.set(safeFriends);
  if (questState) quests.set(sanitizeQuestState(questState, new Date()));
  const safeCards = sanitizeGradeRevealState(cardsState);
  if (safeCards) gradeRevealState.set(safeCards);
  if (Array.isArray(letterScanState)) {
    const clean = letterScanState.filter(
      (d): d is Record<string, unknown> =>
        !!d && typeof d === "object" && typeof (d as any).token === "string",
    );
    letterScan.set(clean as any);
    try {
      localStorage.setItem("letter_grade_scan", JSON.stringify(clean));
    } catch {}
  }
  if (aiState && typeof aiState.model === "string" && aiState.model) {
    // Never sync the API key: an empty key tells the store/backend to keep
    // the key that already exists on this device.
    await setAiConfig(
      "",
      aiState.base_url || "",
      aiState.model,
      aiState.enabled === true,
      aiState.provider,
      aiState.use_data_access !== false,
      aiState.ai_notes_ai_can_edit !== false,
      aiState.ai_notes_use_in_chats !== false,
    );
  }
  if (notesState && typeof notesState.content === "string") {
    const current = await getNotes();
    if (current.content !== notesState.content) {
      await saveNotes(notesState.content, current.revision);
    }
  }
  if (calendar) writeJson("calendar_overrides", calendar);
  if (gradeCombos) saveCombinations(gradeCombos);
  if (chatsState && Array.isArray(chatsState.conversations)) {
    for (const { conversation, messages } of chatsState.conversations) {
      if (!conversation || !Array.isArray(messages)) continue;
      const local = (await dbListConversations()).find(
        (c) => c.id === conversation.id,
      );
      if (!local || local.updated_at <= conversation.updated_at) {
        await dbPutConversation(conversation);
        for (const message of messages) await dbAddMessage(message);
      }
    }
  }
}

function syncEventRange(date: string): { start: string; end: string } {
  const base = new Date(`${date}T12:00:00`);
  const start = new Date(base);
  start.setDate(start.getDate() - 1);
  const end = new Date(base);
  end.setDate(end.getDate() + 1);
  return { start: isoDate(start), end: isoDate(end) };
}

function isSyncEvent(event: CalendarEvent): boolean {
  return event.Omschrijving === SYNC_DESCRIPTION;
}

const SYNC_INDEX_PREFIX = "FSYIDX1|";

interface SyncIndex {
  date: string;
  updatedAt: number;
  encrypted: boolean;
}

function syncIndexDates(now = new Date()): string[] {
  const year = currentSchoolYear(now).year;
  return [`${year}-09-01`, `${year - 1}-09-01`, `${year - 2}-09-01`];
}

function parseSyncIndex(value: string | null | undefined): SyncIndex | null {
  if (!value?.startsWith(SYNC_INDEX_PREFIX)) return null;
  const [, date, stamp, encrypted] = value.split("|");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) return null;
  const updatedAt = Number(stamp);
  if (!Number.isFinite(updatedAt)) return null;
  return { date, updatedAt, encrypted: encrypted === "1" };
}

/**
 * The chosen sync date is device-local. A tiny index at the start of the
 * current (or previous) school year tells a fresh device where the chunks are.
 */
async function readSyncIndex(personId: number): Promise<{
  index: SyncIndex | null;
  events: CalendarEvent[];
}> {
  // Check the current school year first. In the common case the profile has
  // exactly one index and scanning three years on every sync would be wasteful.
  for (const date of syncIndexDates()) {
    // The index lives at 03:30 and never overlaps the 04:00+ chunk events.
    // Query only that hour so a normal sync does not download every chunk
    // twice (once for discovery, once for the document itself).
    const start = `${date}T03:00:00`;
    const end = `${date}T03:59:00`;
    const found = await getCalendarEvents(personId, start, end, true, true);
    const events = found.filter(isSyncEvent);
    const indexes = events
      .map((event) => parseSyncIndex(event.Inhoud))
      .filter((index): index is SyncIndex => index !== null);
    if (indexes.length > 0) {
      indexes.sort((a, b) => b.updatedAt - a.updatedAt);
      return { index: indexes[0], events };
    }
  }
  return { index: null, events: [] };
}

async function writeSyncIndex(
  personId: number,
  date: string,
  encrypted: boolean,
  previous: CalendarEvent[],
): Promise<void> {
  const start = new Date(`${syncIndexDates()[0]}T03:30:00`);
  const end = new Date(start.getTime() + 60_000);
  const inhoud = `${SYNC_INDEX_PREFIX}${date}|${Date.now()}|${encrypted ? 1 : 0}`;
  await createCalendarEvent({
    personId,
    start: localIso(start),
    einde: localIso(end),
    duurtHeleDag: false,
    omschrijving: SYNC_DESCRIPTION,
    lokatie: SYNC_LOCATION,
    inhoud,
    eventType: 1,
  });
  for (const event of previous) {
    if (!parseSyncIndex(event.Inhoud) || event.Inhoud === inhoud) continue;
    const url = selfUrlOf(event);
    if (url) await deleteCalendarEvent(url).catch(() => {});
  }
}

async function deleteRemoteDocAt(
  personId: number,
  date: string,
): Promise<void> {
  const range = syncEventRange(date);
  const events = await getCalendarEvents(
    personId,
    range.start,
    range.end,
    true,
    true,
  );
  for (const event of events) {
    if (!isSyncEvent(event) || !parseSyncChunk(event.Inhoud ?? "")) continue;
    const url = selfUrlOf(event);
    if (url) await deleteCalendarEvent(url).catch(() => {});
  }
}

function selfUrlOf(event: CalendarEvent): string | null {
  return (
    event.self_url ||
    event.Links?.find((l) => l.Rel === "Self")?.Href?.replace("/api/", "") ||
    null
  );
}

async function readRemoteDoc(
  personId: number,
  settings: SyncSettings,
): Promise<{ doc: SyncDoc | null; events: CalendarEvent[] }> {
  const range = syncEventRange(settings.date);
  const events = await getCalendarEvents(
    personId,
    range.start,
    range.end,
    true,
    true,
  );
  // Index events share the title but are not sync chunks; never let the
  // chunk cleanup below delete the discovery index.
  const syncEvents = events.filter(
    (event) => isSyncEvent(event) && !!parseSyncChunk(event.Inhoud ?? ""),
  );
  const byDoc = new Map<string, ReturnType<typeof parseSyncChunk>[]>();
  for (const event of syncEvents) {
    const chunk = parseSyncChunk(event.Inhoud ?? "");
    if (!chunk) continue;
    const list = byDoc.get(chunk.docId) ?? [];
    list.push(chunk);
    byDoc.set(chunk.docId, list);
  }
  let best: SyncDoc | null = null;
  let failedEncrypted = false;
  for (const chunks of byDoc.values()) {
    const valid = chunks.filter((c): c is NonNullable<typeof c> => !!c);
    const total = valid[0]?.total;
    const complete =
      typeof total === "number" &&
      valid.length === total &&
      new Set(valid.map((c) => c.index)).size === total;
    const doc = await decodeSyncChunks(valid, syncKey);
    if (doc && (!best || doc.updatedAt > best.updatedAt)) best = doc;
    // A partially written encrypted generation is safe to ignore: the next
    // successful write replaces it. A *complete* one that does not decrypt is
    // a wrong password or corruption, and overwriting it could lose data.
    if (!doc && complete && chunks.some((c) => c?.encrypted))
      failedEncrypted = true;
  }
  if (failedEncrypted) {
    throw new Error(
      "Sync-wachtwoord onjuist of het versleutelde document is onvolledig. Er is niets overschreven.",
    );
  }
  return { doc: best, events: syncEvents };
}

/**
 * Delete the chunks a failed write attempt managed to create.
 *
 * `createCalendarEvent` returns nothing, so the only handle is the exact
 * `Inhoud` string of every chunk. Chunks of the previous valid document carry
 * a different docId and can never match, so this cleanup leaves the old
 * document intact. A create that was accepted server-side but failed on the
 * response is missed here; the fresh docId per attempt keeps such an orphan
 * from corrupting the retried document.
 */
async function deleteAttemptedChunks(
  personId: number,
  date: string,
  contents: string[],
): Promise<void> {
  if (contents.length === 0) return;
  const attempted = new Set(contents);
  const range = syncEventRange(date);
  let events: CalendarEvent[];
  try {
    events = await getCalendarEvents(
      personId,
      range.start,
      range.end,
      true,
      true,
    );
  } catch {
    return;
  }
  for (const event of events) {
    if (!isSyncEvent(event) || !event.Inhoud || !attempted.has(event.Inhoud)) {
      continue;
    }
    const url = selfUrlOf(event);
    if (!url) continue;
    try {
      await deleteCalendarEvent(url);
    } catch {
      // Harmless: readers ignore an incomplete generation.
    }
  }
}

async function writeRemoteDoc(
  personId: number,
  settings: SyncSettings,
  doc: SyncDoc,
  existing: CalendarEvent[],
): Promise<number> {
  const key = settings.encrypted ? syncKey : null;
  const base = new Date(`${settings.date}T04:00:00`);
  let chunks: string[] = [];
  let lastError: unknown = null;

  for (let attempt = 0; attempt < CHUNK_PAYLOAD_SIZES.length; attempt++) {
    const payloadSize = CHUNK_PAYLOAD_SIZES[attempt];
    // Every attempt gets its own docId. If cleanup after a failed attempt
    // misses a chunk, the retry is still a separate generation instead of a
    // second `total` under the same docId (which would decode as corrupt).
    chunks = await encodeSyncDoc(
      { ...doc, docId: `${doc.docId}-${attempt}` },
      key,
      payloadSize,
    );
    if (chunks.length > MAX_CHUNKS) {
      throw new Error(
        `Sync-data is te groot (${chunks.length} blokken van ${payloadSize} tekens, max ${MAX_CHUNKS}). Zet AI-gesprekken of notities uit.`,
      );
    }
    const created: string[] = [];
    try {
      for (let i = 0; i < chunks.length; i++) {
        const start = new Date(base.getTime() + i * 60_000);
        const end = new Date(start.getTime() + 60_000);
        await createCalendarEvent({
          personId,
          start: localIso(start),
          einde: localIso(end),
          duurtHeleDag: false,
          omschrijving: SYNC_DESCRIPTION,
          lokatie: SYNC_LOCATION,
          inhoud: chunks[i],
          eventType: 1,
        });
        created.push(chunks[i]);
      }
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
      await deleteAttemptedChunks(personId, settings.date, created);
    }
  }
  if (lastError) throw lastError;

  // Only remove the previous generation after the new one is fully written.
  // A failed delete leaves an older, complete document behind; readers pick
  // the newest complete document, so no data is lost.
  for (const event of existing) {
    if (event.Inhoud && chunks.includes(event.Inhoud)) continue;
    const url = selfUrlOf(event);
    if (!url) continue;
    try {
      await deleteCalendarEvent(url);
    } catch {
      // Harmless: the older document is ignored once the new one is complete.
    }
  }
  return chunks.length;
}

/** Pull remote changes, merge, apply and push the merged document. */
export async function runSync(
  personId: number,
  opts: { direction?: "both" | "push" | "pull" } = {},
): Promise<SyncResult> {
  if (running) return running;
  const direction = opts.direction ?? "both";
  running = (async () => {
    syncStatus.set({
      state: "syncing",
      message: "Synchroniseren…",
      at: null,
      lastResult: null,
    });
    const settings = loadSyncSettings();
    if (!settings.enabled) throw new Error("Synchronisatie staat uit.");
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(settings.date) ||
      isNaN(new Date(`${settings.date}T04:00:00`).getTime())
    ) {
      throw new Error(
        "Kies een geldige sync-datum bij Instellingen → Synchronisatie.",
      );
    }
    const docPrefix = `friday-${personId}`;
    const docId = `${docPrefix}-${Date.now()}`;
    const meta = loadMeta();
    const firstSync = Object.keys(meta).length === 0;

    let indexInfo: Awaited<ReturnType<typeof readSyncIndex>> | null = null;
    let knownIndexDate = settings.remoteDate;
    indexInfo = await readSyncIndex(personId);
    if (indexInfo.index) {
      knownIndexDate = indexInfo.index.date;
      settings.remoteEncrypted = indexInfo.index.encrypted;
      if (
        direction !== "push" &&
        (!settings.remoteDate ||
          (settings.date === settings.remoteDate &&
            settings.date !== indexInfo.index.date))
      ) {
        // A fresh device has no idea which date the user picked. Follow the
        // index unless this device has an unsynced local date change.
        settings.date = indexInfo.index.date;
        settings.remoteDate = indexInfo.index.date;
      }
      // The index describes how the *remote* document is stored. Keep the
      // local write preference untouched so turning encryption off can
      // decrypt the old document and migrate it to plaintext.
      saveSyncSettings(settings);
    }
    if ((settings.encrypted || settings.remoteEncrypted) && !syncKey) {
      throw new Error(
        settings.remoteEncrypted && !settings.encrypted
          ? "Het bestaande sync-document is versleuteld. Voer je sync-wachtwoord in bij Instellingen → Synchronisatie om het te ontgrendelen."
          : "Deze sync is vergrendeld. Voer je sync-wachtwoord in bij Instellingen → Synchronisatie.",
      );
    }
    const local = await collectLocal(settings, meta, firstSync);
    const writeIndex =
      knownIndexDate !== settings.date ||
      !indexInfo?.index ||
      indexInfo.index.encrypted !== settings.encrypted;
    const remoteDate = settings.remoteDate || settings.date;
    const remote = await readRemoteDoc(personId, {
      ...settings,
      date: remoteDate,
    });
    const remoteDoc =
      remote.doc &&
      (remote.doc.docId === docPrefix ||
        remote.doc.docId.startsWith(`${docPrefix}-`))
        ? remote.doc
        : null;

    let merged = local.entries;
    let fromRemote: SyncEntry[] = [];
    let conflicts = 0;
    if (remoteDoc && direction !== "push") {
      const result = mergeEntries(local.entries, remoteDoc.entries);
      merged = result.merged;
      fromRemote = result.fromRemote;
      conflicts = result.conflicts;
      if (fromRemote.length > 0)
        await applyEntries(
          fromRemote.filter(
            (entry) => settings.categories[entry.category]?.enabled !== false,
          ),
        );
    }

    const nextMeta: SyncMeta = { ...local.meta };
    for (const entry of merged) {
      nextMeta[entry.key] = {
        rev: entry.rev,
        updatedAt: entry.updatedAt,
        hash: entry.deleted ? "" : stableHash(entry.value),
      };
    }
    saveMeta(nextMeta);

    let pushed = 0;
    const unchanged =
      remoteDoc != null && entriesEqual(merged, remoteDoc.entries);
    if (direction !== "pull" && (!unchanged || writeIndex)) {
      const school = currentSchoolYear();
      const doc: SyncDoc = {
        version: 2,
        docId,
        schoolYear: String(school.year),
        device: settings.deviceId,
        updatedAt: Date.now(),
        entries: merged,
      };
      pushed = await writeRemoteDoc(personId, settings, doc, remote.events);
      if (writeIndex) {
        await writeSyncIndex(
          personId,
          settings.date,
          settings.encrypted,
          indexInfo?.events ?? [],
        );
      }
      // The user moved the sync date: leave no stale chunk behind.
      if (remoteDate !== settings.date) {
        await deleteRemoteDocAt(personId, remoteDate).catch(() => {});
      }
      settings.remoteDate = settings.date;
      settings.remoteEncrypted = settings.encrypted;
    }

    const result: SyncResult = {
      pulled: fromRemote.length,
      pushed,
      conflicts,
      entries: merged.length,
    };
    const now = Date.now();
    settings.lastSyncAt = now;
    settings.lastError = null;
    saveSyncSettings(settings);
    syncStatus.set({
      state: "ok",
      message: `${
        pushed > 0
          ? `Bijgewerkt: ${result.pulled} ontvangen, sync-document van ${pushed} blokken opgeslagen.`
          : unchanged
            ? "Alles is al up-to-date."
            : `Bijgewerkt: ${result.pulled} ontvangen.`
      }${conflicts > 0 ? ` ${conflicts} item(s) overschreven op basis van de nieuwste wijziging.` : ""}`,
      at: now,
      lastResult: result,
    });
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(SYNC_DB_KEY));
      window.dispatchEvent(new CustomEvent("friday:ai-schedule-changed"));
    }
    return result;
  })()
    .catch((err) => {
      const settings = loadSyncSettings();
      settings.lastError = String(err);
      // If the remote document turned out to be encrypted without a readable
      // index, surface the password field so the user can unlock it.
      if (/versleuteld|Sync-wachtwoord/i.test(String(err))) {
        settings.remoteEncrypted = true;
      }
      saveSyncSettings(settings);
      syncStatus.set({
        state: "error",
        message: `Sync mislukt: ${err}`,
        at: Date.now(),
        lastResult: null,
      });
      throw err;
    })
    .finally(() => {
      running = null;
    });
  return running;
}

let autoTimer: ReturnType<typeof setTimeout> | null = null;
let autoInterval: ReturnType<typeof setInterval> | null = null;
let lastPerson: number | null = null;

/** Debounced auto-sync after login/resume, plus a slow periodic backstop. */
export function scheduleAutoSync(personId: number | null): void {
  if (personId == null) return;
  lastPerson = personId;
  if (autoTimer) clearTimeout(autoTimer);
  autoTimer = setTimeout(() => {
    if (lastPerson == null) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    const settings = loadSyncSettings();
    if (!settings.enabled) return;
    if ((settings.encrypted || settings.remoteEncrypted) && !syncKey) return;
    void runSync(lastPerson).catch(() => {});
  }, 3000);
  if (!autoInterval) {
    autoInterval = setInterval(() => {
      if (lastPerson == null) return;
      if (typeof navigator !== "undefined" && navigator.onLine === false)
        return;
      const settings = loadSyncSettings();
      if (!settings.enabled) return;
      if ((settings.encrypted || settings.remoteEncrypted) && !syncKey) return;
      if (typeof document !== "undefined" && document.hidden) return;
      void runSync(lastPerson).catch(() => {});
    }, 10 * 60_000);
  }
}

export function stopAutoSync(): void {
  lastPerson = null;
  if (autoTimer) clearTimeout(autoTimer);
  autoTimer = null;
  if (autoInterval) clearInterval(autoInterval);
  autoInterval = null;
  lockSync();
}

/** Forget local sync bookkeeping (not the remote appointment). */
export function resetSyncMeta(): void {
  try {
    localStorage.removeItem(SYNC_META_KEY);
  } catch {
    // ignore
  }
}
