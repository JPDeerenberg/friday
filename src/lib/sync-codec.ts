/** Encode/decode a sync document into small appointment-content chunks. */
import { crc16 } from "./friends-share.ts";
import { SYNC_FORMAT, type SyncChunk, type SyncDoc } from "./sync-types.ts";

export const CHUNK_PAYLOAD = 1200;
const ENCRYPTED_PREFIX = `${SYNC_FORMAT}E`;
const KDF_SALT = "friday-sync-v1";

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Copy into a plain ArrayBuffer so WebCrypto's BufferSource type accepts it. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === "undefined") return null;
  try {
    const stream = new Blob([bytes as BlobPart])
      .stream()
      .pipeThrough(new CompressionStream("deflate-raw"));
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined")
    throw new Error("Geen decompressie beschikbaar.");
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

/** Derive the opt-in sync password key. It is never persisted. */
export async function deriveSyncKey(passphrase: string): Promise<CryptoKey> {
  if (!passphrase.trim()) throw new Error("Voer een sync-wachtwoord in.");
  if (!crypto?.subtle) throw new Error("Versleuteling wordt niet ondersteund.");
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: new TextEncoder().encode(KDF_SALT),
      iterations: 210_000,
      hash: "SHA-256",
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Split a document into chunks that fit in one appointment Inhoud.
 *
 * `payloadSize` is the number of encoded characters per chunk. Magister can
 * reject long `Inhoud` values, so a caller may retry a document with smaller
 * chunks; the resulting document is identical after decoding.
 */
export async function encodeSyncDoc(
  doc: SyncDoc,
  encryptionKey?: CryptoKey | null,
  payloadSize = CHUNK_PAYLOAD,
): Promise<string[]> {
  // A zero/negative/NaN step would never terminate; fall back to the default.
  const size = Math.max(1, Math.floor(payloadSize)) || CHUNK_PAYLOAD;
  const json = new TextEncoder().encode(JSON.stringify(doc));
  const checksum = crc16(json);
  const deflated = await deflate(json);
  const body =
    deflated && deflated.length < json.length
      ? new Uint8Array([1, ...deflated])
      : new Uint8Array([0, ...json]);
  const encoded = bytesToBase64Url(body);
  const parts: string[] = [];
  for (let i = 0; i < encoded.length; i += size) {
    parts.push(encoded.slice(i, i + size));
  }
  if (parts.length === 0) parts.push("");
  if (encryptionKey) {
    const chunks = await Promise.all(
      parts.map(async (data, index) => {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const cipher = await crypto.subtle.encrypt(
          { name: "AES-GCM", iv },
          encryptionKey,
          new TextEncoder().encode(data),
        );
        return `${ENCRYPTED_PREFIX}|${doc.docId}|${index}|${parts.length}|${checksum}|${bytesToBase64Url(iv)}|${bytesToBase64Url(new Uint8Array(cipher))}`;
      }),
    );
    return chunks;
  }
  return parts.map(
    (data, index) =>
      `${SYNC_FORMAT}|${doc.docId}|${index}|${parts.length}|${checksum}|${data}`,
  );
}

export function parseSyncChunk(value: string): SyncChunk | null {
  const parts = value.split("|");
  const encrypted = parts[0] === ENCRYPTED_PREFIX;
  if (
    (parts[0] !== SYNC_FORMAT && !encrypted) ||
    (encrypted ? parts.length < 7 : parts.length < 6)
  ) {
    return null;
  }
  const index = Number(parts[2]);
  const total = Number(parts[3]);
  const crc = Number(parts[4]);
  if (
    !Number.isInteger(index) ||
    !Number.isInteger(total) ||
    index < 0 ||
    total <= 0 ||
    index >= total ||
    !Number.isInteger(crc)
  ) {
    return null;
  }
  if (encrypted) {
    return {
      docId: parts[1],
      index,
      total,
      crc,
      iv: parts[5],
      data: parts.slice(6).join("|"),
      encrypted: true,
    };
  }
  return {
    docId: parts[1],
    index,
    total,
    crc,
    data: parts.slice(5).join("|"),
  };
}

/** Rebuild a document from all chunks of one docId. */
export async function decodeSyncChunks(
  chunks: SyncChunk[],
  encryptionKey?: CryptoKey | null,
): Promise<SyncDoc | null> {
  if (chunks.length === 0) return null;
  const total = chunks[0].total;
  if (chunks.length !== total) return null;
  const ordered = [...chunks].sort((a, b) => a.index - b.index);
  const encrypted = ordered[0].encrypted === true;
  if (encrypted && !encryptionKey) return null;
  for (let i = 0; i < ordered.length; i++) {
    if (ordered[i].index !== i || ordered[i].total !== total) return null;
    if (ordered[i].crc !== ordered[0].crc) return null;
    if ((ordered[i].encrypted === true) !== encrypted) return null;
  }
  let encoded: string;
  if (encrypted && encryptionKey) {
    try {
      const clear = await Promise.all(
        ordered.map(async (chunk) => {
          const cipher = base64UrlToBytes(chunk.data);
          const iv = base64UrlToBytes(chunk.iv ?? "");
          const plain = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: toArrayBuffer(iv) },
            encryptionKey,
            toArrayBuffer(cipher),
          );
          return new TextDecoder().decode(plain);
        }),
      );
      encoded = clear.join("");
    } catch {
      return null;
    }
  } else {
    encoded = ordered.map((c) => c.data).join("");
  }
  let body: Uint8Array;
  try {
    body = base64UrlToBytes(encoded);
  } catch {
    return null;
  }
  const flag = body[0];
  const payload = body.slice(1);
  let jsonBytes: Uint8Array;
  if (flag === 1) {
    try {
      jsonBytes = await inflate(payload);
    } catch {
      return null;
    }
  } else {
    jsonBytes = payload;
  }
  if (crc16(jsonBytes) !== ordered[0].crc) return null;
  try {
    const doc = JSON.parse(new TextDecoder().decode(jsonBytes)) as SyncDoc;
    if (doc?.version !== 2 || !Array.isArray(doc.entries)) return null;
    return doc;
  } catch {
    return null;
  }
}

/** Stable, fast hash for detecting local changes. */
export function stableHash(value: unknown): string {
  const text = JSON.stringify(value) ?? "";
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= c + i;
    h2 = Math.imul(h2, 0x85ebca6b);
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
}
