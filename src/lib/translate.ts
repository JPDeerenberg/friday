/**
 * Translating homework into Dutch with the student's own AI connection (the key
 * they set up under Settings > AI Assistent). Nothing is sent anywhere else, and
 * nothing is sent until the student taps the button.
 */
import { aiChat, getAiConfig } from "#lib/ai.ts";
import {
  buildTranslationPrompt,
  cleanTranslation,
  translationKey,
} from "#lib/translate-text.ts";

const cache = new Map<string, string>();
const MAX_CACHED = 200;

/** True when an AI key is set up, so translating can work. */
export async function canTranslate(): Promise<boolean> {
  try {
    const cfg = await getAiConfig();
    return cfg.enabled && cfg.has_api_key;
  } catch {
    return false;
  }
}

/** Translates `text` to Dutch. Throws an Error with a readable message on failure. */
export async function translateToDutch(text: string): Promise<string> {
  const clean = text.trim();
  if (!clean) return "";
  const key = translationKey(clean);
  const hit = cache.get(key);
  if (hit) return hit;

  if (!(await canTranslate())) {
    throw new Error("Stel eerst AI in bij Instellingen > AI Assistent om te kunnen vertalen.");
  }
  const raw = await aiChat([{ role: "user", content: buildTranslationPrompt(clean) }]);
  const out = cleanTranslation(raw);
  if (!out) throw new Error("De vertaling kwam leeg terug. Probeer het nog eens.");

  if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value as string);
  cache.set(key, out);
  return out;
}
