/**
 * Pure helpers for the "translate homework" button: turning homework markup into
 * text, deciding whether a translation is worth offering, and building and
 * cleaning the translation request. No network and no Svelte, so it is testable.
 */

/** Homework markup -> plain text with line breaks kept. */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return "";
  return html
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)\s*>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const DUTCH = new Set(
  "het een van maak maken lees leer leren bladzijde blz opdracht opdrachten hoofdstuk paragraaf niet wordt naar bij ook dat dit jij uit voor met zijn hebben moet moeten toets huiswerk klaar boek schrijf vragen woordjes".split(
    " ",
  ),
);
const OTHER = new Set(
  (
    // English
    "the and to read write exercise exercises chapter page pages homework of for with your you is are do make learn study " +
    // French
    "le la les des du et une pour avec lire faire exercice exercices chapitre devoir apprendre " +
    // German
    "der die das und ein eine nicht lesen schreiben aufgabe aufgaben seite kapitel hausaufgabe " +
    // Spanish
    "el los las y una para con leer hacer ejercicio ejercicios página capítulo tarea"
  ).split(" "),
);

function words(text: string): string[] {
  return text.toLowerCase().match(/[a-zà-öø-ÿ]{2,}/g) ?? [];
}

/**
 * Whether a translation button is worth showing: there are recognisably
 * non-Dutch words, and more of them than Dutch ones. Text with no recognisable
 * words (just "p. 45 ex. 3") is left alone.
 */
export function shouldOfferTranslation(text: string): boolean {
  let dutch = 0;
  let other = 0;
  for (const w of words(text)) {
    if (DUTCH.has(w)) dutch++;
    else if (OTHER.has(w)) other++;
  }
  return other >= 1 && other > dutch;
}

const MAX_CHARS = 4000;

/** The request for the AI: strict about returning only the translation. */
export function buildTranslationPrompt(text: string): string {
  const body = text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text;
  return (
    "Vertaal de tekst tussen <tekst> en </tekst> naar het Nederlands. Het is " +
    "huiswerk van een school. Geef ALLEEN de vertaling terug: geen uitleg, geen " +
    "aanhalingstekens, geen label. Behoud regeleinden, nummering, getallen en " +
    "opsommingstekens. Laat eigennamen en titels staan. Als de tekst al " +
    "Nederlands is, geef hem ongewijzigd terug.\n\n<tekst>\n" +
    body +
    "\n</tekst>"
  );
}

/** Removes the wrapping models like to add: code fences, a "Vertaling:" label, quotes. */
export function cleanTranslation(out: string): string {
  let t = out.trim();
  const fence = /^```[a-z]*\n([\s\S]*?)\n```$/i.exec(t);
  if (fence) t = fence[1].trim();
  t = t.replace(/^(vertaling|translation|nederlandse vertaling)\s*:\s*/i, "");
  t = t.replace(/^<tekst>\s*|\s*<\/tekst>$/gi, "").trim();
  if (/^(["“„']).*(["”']$)/s.test(t) && !t.slice(1, -1).includes('"')) t = t.slice(1, -1).trim();
  return t;
}

/** Small stable key for caching a translation. */
export function translationKey(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `${text.length}:${(h >>> 0).toString(36)}`;
}
