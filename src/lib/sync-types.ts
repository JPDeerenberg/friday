/** Cross-device sync stored in a hidden Magister personal appointment. */

export const SYNC_DESCRIPTION = "Friday Sync";
export const SYNC_LOCATION = "Friday";
export const SYNC_FORMAT = "FSY2";
export const SYNC_DB_KEY = "friday_sync_v1";
export const SYNC_SETTINGS_KEY = "friday_sync_settings_v1";
export const SYNC_META_KEY = "friday_sync_meta_v1";

export type SyncCategory =
  | "settings"
  | "plan"
  | "friends"
  | "notes"
  | "quests"
  | "casino"
  | "cards"
  | "ai"
  | "letterScan"
  | "calendar"
  | "grades"
  | "chats";

export interface SyncCategoryState {
  enabled: boolean;
}

export interface SyncSettings {
  enabled: boolean;
  /** ISO date (YYYY-MM-DD) chosen by the user for the hidden sync appointment. */
  date: string;
  /** Date the remote document currently lives on (discovered via the index). */
  remoteDate: string | null;
  deviceId: string;
  /** Opt-in AES-GCM encryption of the sync document this device writes. */
  encrypted: boolean;
  /** Whether the document currently on the server is encrypted. */
  remoteEncrypted: boolean;
  categories: Record<SyncCategory, SyncCategoryState>;
  lastSyncAt: number | null;
  lastError: string | null;
}

export interface SyncEntry {
  key: string;
  category: SyncCategory;
  rev: number;
  updatedAt: number;
  device: string;
  deleted?: boolean;
  value?: unknown;
}

export interface SyncDoc {
  version: 2;
  docId: string;
  schoolYear: string;
  device: string;
  updatedAt: number;
  entries: SyncEntry[];
}

export interface SyncMetaEntry {
  rev: number;
  updatedAt: number;
  hash: string;
}

export type SyncMeta = Record<string, SyncMetaEntry>;

export interface SyncChunk {
  docId: string;
  index: number;
  total: number;
  crc: number;
  data: string;
  encrypted?: boolean;
  iv?: string;
  eventId?: number;
  selfUrl?: string;
}

export interface SyncResult {
  pulled: number;
  pushed: number;
  conflicts: number;
  entries: number;
}
