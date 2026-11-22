/**
 * Plain-text helpers for Magister's editor HTML.
 *
 * These never return markup: they exist for text (translation prompts,
 * "has content" checks, previews). DOMPurify in `sanitize.ts` stays the XSS
 * boundary for anything rendered with `{@html}`.
 */

const ENTITIES: Record<string, string> = {
  nbsp: " ",
  "#160": " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  apos: "'",
};

/**
 * Decodes the entities Magister emits, in one pass. A single pass matters:
 * replacing `&amp;` first and `&lt;` afterwards would turn `&amp;lt;` into `<`
 * (double unescaping).
 */
export function decodeEntities(text: string): string {
  return text.replace(
    /&(nbsp|#160|amp|lt|gt|quot|#39|apos);/gi,
    (entity, name: string) => {
      return ENTITIES[name.toLowerCase()] ?? entity;
    },
  );
}

/**
 * Removes tags until nothing tag-shaped is left — one pass alone leaves
 * `<scr<script>ipt>` as `<script>` — then drops stray angle brackets. The
 * result never contains `<` or `>`.
 */
export function stripTags(html: string): string {
  let text = html;
  let previous: string;
  do {
    previous = text;
    text = text.replace(/<\/?[a-z][^>]*>/gi, "");
  } while (text !== previous);
  return text.replace(/[<>]/g, "");
}
