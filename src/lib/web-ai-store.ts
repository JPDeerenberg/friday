/**
 * Browser-side AI configuration + key storage (BYO key).
 *
 * The API key lives ONLY here (IndexedDB `friday-ai`) and travels to the
 * server per-request, in memory only — the server never logs, stores, or
 * caches it (see web-api/src/ai.rs). Mirrors the desktop contract where the
 * frontend never sees the raw key back (`has_api_key` flag instead).
 */

import { openDB, type IDBPDatabase } from "idb";
import type { AiConfig, AiProviderType } from "./ai.ts";

const DB_NAME = "friday-ai";
const STORE_NAME = "config";
const CONFIG_KEY = "current";

export interface WebAiStoredConfig {
  provider: AiProviderType;
  baseUrl: string;
  model: string;
  enabled: boolean;
  useDataAccess: boolean;
  apiKey: string;
}

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
      },
    });
  }
  return dbPromise;
}

export const DEFAULT_WEB_AI: WebAiStoredConfig = {
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  enabled: false,
  useDataAccess: true,
  apiKey: "",
};

/** Load stored config. The key is returned ONLY to in-memory callers that
 * forward it straight into the next fetch — never render or log it. */
export async function loadWebAiConfig(): Promise<WebAiStoredConfig> {
  try {
    const db = await getDb();
    const stored = (await db.get(STORE_NAME, CONFIG_KEY)) as Partial<WebAiStoredConfig> | undefined;
    if (!stored) return { ...DEFAULT_WEB_AI };
    return { ...DEFAULT_WEB_AI, ...stored };
  } catch {
    return { ...DEFAULT_WEB_AI };
  }
}

export async function saveWebAiConfig(partial: Partial<WebAiStoredConfig>): Promise<void> {
  const current = await loadWebAiConfig();
  // Empty key field means "keep the stored one" (matches the Settings form,
  // which shows an empty field even when a key is stored).
  const next: WebAiStoredConfig = { ...current, ...partial };
  if (partial.apiKey === "") next.apiKey = current.apiKey;
  const db = await getDb();
  await db.put(STORE_NAME, next, CONFIG_KEY);
}

export async function clearWebAiConfig(): Promise<void> {
  try {
    const db = await getDb();
    await db.delete(STORE_NAME, CONFIG_KEY);
  } catch {
    // Clearing must never fail logout/cleanup flows.
  }
}

/** Public-facing config (key redacted, like desktop `has_api_key`). */
export function toPublicConfig(stored: WebAiStoredConfig): AiConfig {
  return {
    api_key: "",
    base_url: stored.baseUrl,
    model: stored.model,
    enabled: stored.enabled,
    provider: stored.provider,
    use_data_access: stored.useDataAccess,
    has_api_key: stored.apiKey.trim().length > 0,
  };
}
