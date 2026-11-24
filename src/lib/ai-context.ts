/**
 * Compact screen context for the AI assistant.
 *
 * Pages publish only ids, labels and counts — never full grades, messages or
 * attachments. The assistant uses this to resolve words like "deze les",
 * "die dag" and "deze vriend" without fetching everything again.
 */
import { writable } from "svelte/store";

export interface AiPageContext {
  page: string;
  selectedDate?: string | null;
  selectedLessonId?: number | null;
  selectedAssignmentId?: number | null;
  selectedSubject?: string | null;
  selectedFriendId?: string | null;
  selectedFriendName?: string | null;
  planItemCount?: number | null;
  lastPlanUpdate?: string | null;
  extra?: Record<string, string | number | boolean | null | undefined>;
}

export const aiPageContext = writable<AiPageContext | null>(null);

/** Publish context for the current page. */
export function setAiPageContext(ctx: AiPageContext): void {
  aiPageContext.set(ctx);
}

/** Remove context, but only when it still belongs to `page`. */
export function clearAiPageContext(page: string): void {
  aiPageContext.update((ctx) => (ctx?.page === page ? null : ctx));
}

/** Human-readable Dutch context block sent in the system prompt. */
export function describeAiPageContext(
  ctx: AiPageContext | null,
): string | null {
  if (!ctx) return null;
  const lines: string[] = [];
  if (ctx.selectedDate) lines.push(`Geselecteerde datum: ${ctx.selectedDate}`);
  if (ctx.selectedLessonId)
    lines.push(`Geselecteerde les/afspraak: id ${ctx.selectedLessonId}`);
  if (ctx.selectedAssignmentId)
    lines.push(`Geselecteerde opdracht: id ${ctx.selectedAssignmentId}`);
  if (ctx.selectedSubject)
    lines.push(`Geselecteerd vak: ${ctx.selectedSubject}`);
  if (ctx.selectedFriendId)
    lines.push(
      `Geselecteerde vriend: ${ctx.selectedFriendName ?? ctx.selectedFriendId}`,
    );
  if (ctx.planItemCount != null)
    lines.push(`Aantal items in Friday's Plan: ${ctx.planItemCount}`);
  if (ctx.lastPlanUpdate)
    lines.push(`Plan laatst bijgewerkt: ${ctx.lastPlanUpdate}`);
  for (const [key, value] of Object.entries(ctx.extra ?? {})) {
    if (value == null || value === "") continue;
    lines.push(`${key}: ${String(value).slice(0, 400)}`);
  }
  return lines.length > 0 ? lines.join("\n").slice(0, 2400) : null;
}
