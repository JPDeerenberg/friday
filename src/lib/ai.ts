import { invoke } from "@tauri-apps/api/core";
import { WebApiError } from "./backend.ts";
import { loadWebSession, sessionTierA, webBackend } from "./web-session.ts";
import {
  loadWebAiConfig,
  saveWebAiConfig,
  toPublicConfig,
} from "./web-ai-store.ts";
import {
  MAX_PLAN_WRITES_PER_TURN,
  NOTES_TOOLS,
  NOTES_WRITE_TOOLS,
  PLAN_WRITE_TOOLS,
  WEB_TOOL_DEFS,
  confirmWebPendingAction,
  executeWebTool,
} from "./web-ai-tools.ts";
import { loadSettings } from "./stores.ts";
import { formatNowBlock } from "./ai-time.ts";
import { formatNotesBlock, getNotes, type NotesPrompt } from "./ai-notes.ts";
import {
  getPromptSections,
  getToolsSpec,
  renderPrompt,
  renderToolList,
} from "./ai-spec.ts";
import { TurnBudget } from "./ai-budget.ts";
import {
  runToolLoop,
  type LoopActivity,
  type LoopTurnTrace,
} from "./ai-loop.ts";
import {
  clearAiDiagnostics as clearLocalDiag,
  getAiDiagnostics as getLocalDiag,
  providerTypeOf,
  recordAiDiag,
  shapeOfMessage,
  type AiDiagEntry,
} from "./ai-diagnostics.ts";
import { classifyAiError } from "./ai-errors.ts";
import type { AiErrorInfo } from "./ai-errors.ts";

function isWeb(): boolean {
  return typeof window !== "undefined" && !(window as any).__TAURI__;
}

export type AiProviderType =
  | "openai"
  | "anthropic"
  | "gemini"
  | "deepseek"
  | "mistral"
  | "openai_compatible";

export interface AiConfig {
  api_key: string;
  base_url: string;
  model: string;
  enabled: boolean;
  provider: AiProviderType;
  use_data_access: boolean;
  /** True when an API key is stored (the key itself is never sent to the frontend). */
  has_api_key: boolean;
  /** Whether the AI may edit AI-Geheugen notes (default on, switch in Settings). */
  ai_notes_ai_can_edit: boolean;
  /** Whether notes are injected into new chats (default on, switch in Settings). */
  ai_notes_use_in_chats: boolean;
}

export interface AiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  name?: string;
  tool_calls?: Array<{
    id: string;
    name: string;
    arguments: any;
    status: "Pending" | "Completed" | "Failed";
  }>;
  /** Set on failed turns (item 9): rendered as an error bubble with retry. */
  error?: AiErrorInfo;
  /** Set when the user stopped generation mid-turn (item 7). */
  stopped?: boolean;
  /** Compact tool trace of the turn that produced this message (Phase 5). */
  trace?: LoopTurnTrace[];
}

/** A side-effecting action the AI staged that still awaits user confirmation. */
export interface PendingActionInfo {
  status: string;
  action_id: string;
  action_type: string;
  recipients?: Array<{ id: number; type?: string }>;
  subject?: string;
  body?: string;
  message_ids?: number[];
  message?: string;
  start?: string;
  einde?: string;
  omschrijving?: string;
}

/** Live callbacks for a turn: streamed text deltas + liveness line. */
export interface AiChatHooks {
  onTextDelta?: (delta: string) => void;
  onActivity?: (activity: LoopActivity) => void;
}

/** Result of a tools-enabled AI chat. */
export interface AiChatWithToolsResult {
  content: string;
  pending_actions: PendingActionInfo[];
  /** True when the user stopped generation mid-turn (partial content kept). */
  stopped: boolean;
  /** True when an AI plan mutation succeeded this turn (undo chip). */
  plan_changed: boolean;
  /** Compact per-turn tool trace for persistence (Phase 5 item 4). */
  trace: LoopTurnTrace[];
}

export const DEFAULT_AI_CONFIG: AiConfig = {
  api_key: "",
  base_url: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  enabled: false,
  provider: "openai",
  use_data_access: true,
  has_api_key: false,
  ai_notes_ai_can_edit: true,
  ai_notes_use_in_chats: true,
};

/** Provider display names and default models */
export const AI_PROVIDERS: Record<
  AiProviderType,
  {
    label: string;
    defaultModel: string;
    defaultBaseUrl: string;
    description: string;
  }
> = {
  openai: {
    label: "OpenAI",
    defaultModel: "gpt-4o-mini",
    defaultBaseUrl: "https://api.openai.com/v1",
    description: "GPT-4o, GPT-4o-mini, o1, o3",
  },
  anthropic: {
    label: "Anthropic Claude",
    defaultModel: "claude-sonnet-4-20250514",
    defaultBaseUrl: "https://api.anthropic.com",
    description: "Claude Sonnet, Claude Haiku",
  },
  gemini: {
    label: "Google Gemini",
    defaultModel: "gemini-2.0-flash",
    defaultBaseUrl: "https://generativelanguage.googleapis.com",
    description: "Gemini 1.5/2.0 Flash, Gemini 2.0 Pro",
  },
  deepseek: {
    label: "DeepSeek",
    defaultModel: "deepseek-chat",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    description: "DeepSeek-V3, DeepSeek-R1",
  },
  mistral: {
    label: "Mistral",
    defaultModel: "mistral-large-latest",
    defaultBaseUrl: "https://api.mistral.ai/v1",
    description: "Mistral Large, Mistral Small, Codestral",
  },
  openai_compatible: {
    label: "OpenAI-compatibel (Groq, OpenRouter, Ollama, etc.)",
    defaultModel: "mixtral-8x7b-32768",
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    description: "Elke OpenAI-compatibele API",
  },
};

/**
 * Get the current AI configuration.
 * The API key is stored encrypted on disk via Rust.
 */
export async function getAiConfig(): Promise<AiConfig> {
  if (isWeb()) {
    try {
      return toPublicConfig(await loadWebAiConfig());
    } catch (e) {
      console.error("Failed to get AI config:", e);
      return DEFAULT_AI_CONFIG;
    }
  }
  try {
    return await invoke("get_ai_config");
  } catch (e) {
    console.error("Failed to get AI config:", e);
    return DEFAULT_AI_CONFIG;
  }
}

/**
 * Set the AI configuration.
 */
export async function setAiConfig(
  apiKey: string,
  baseUrl: string,
  model: string,
  enabled: boolean,
  provider?: string,
  useDataAccess?: boolean,
  notesAiCanEdit?: boolean,
  notesUseInChats?: boolean,
): Promise<void> {
  if (isWeb()) {
    // Empty key keeps the stored one (Settings shows an empty field even
    // when a key is stored — same contract as desktop).
    await saveWebAiConfig({
      apiKey,
      baseUrl,
      model,
      enabled,
      provider: (provider as AiConfig["provider"]) || "openai",
      useDataAccess: useDataAccess ?? true,
      notesAiCanEdit: notesAiCanEdit ?? true,
      notesUseInChats: notesUseInChats ?? true,
    });
    return;
  }
  return invoke("set_ai_config", {
    apiKey,
    baseUrl,
    model,
    enabled,
    provider: provider || "openai",
    useDataAccess: useDataAccess ?? true,
    ai_notes_ai_can_edit: notesAiCanEdit ?? true,
    ai_notes_use_in_chats: notesUseInChats ?? true,
  });
}

/**
 * Validate the configured API key by testing the connection.
 */
export async function validateAiKey(): Promise<boolean> {
  if (isWeb()) {
    try {
      const cfg = await loadWebAiConfig();
      if (!cfg.enabled || !cfg.apiKey.trim()) return false;
      const out = await webBackend().aiProxy<{ ok: boolean }>("validate", {
        provider: cfg.provider,
        baseUrl: cfg.baseUrl,
        model: cfg.model,
        apiKey: cfg.apiKey,
      });
      return out.ok === true;
    } catch (e) {
      // Re-throw server failures with message + ref so the Settings test
      // button shows *why* (bad key? bad URL? provider down?) instead of a
      // generic "check key and URL". Only true network failures return false.
      if (e instanceof WebApiError) throw new Error(e.withRef());
      console.error("AI key validation failed:", e);
      return false;
    }
  }
  try {
    return await invoke("validate_ai_key");
  } catch (e) {
    console.error("AI key validation failed:", e);
    return false;
  }
}

/**
 * Resolve the AI-Geheugen prompt block for a chat. Never throws: without
 * memory the chat simply proceeds.
 */
async function notesPromptFor(
  useInChats: boolean | undefined,
  canEdit: boolean | undefined,
): Promise<{
  prompt: NotesPrompt | null;
  writable: boolean;
  enabled: boolean;
}> {
  const enabled = useInChats !== false;
  const writable = enabled && canEdit !== false;
  if (!enabled) return { prompt: null, writable: false, enabled: false };
  try {
    const snap = await getNotes();
    return {
      prompt: {
        content: snap.content,
        revision: snap.revision,
        updatedBy: snap.updated_by,
        writable,
      },
      writable,
      enabled,
    };
  } catch {
    return { prompt: null, writable, enabled };
  }
}

/**
 * Subscribe to the desktop backend's `ai-activity` events for the duration
 * of `fn`, forwarding them to the turn hooks (same shape as the web loop's
 * onActivity/onTextDelta). Desktop-only; resolves `fn()` directly when the
 * caller passed no hooks.
 */
async function withDesktopActivity<T>(
  hooks: AiChatHooks | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!hooks || (!hooks.onTextDelta && !hooks.onActivity)) return fn();
  const { listen } = await import("@tauri-apps/api/event");
  const unlisten = await listen<{
    kind: string;
    tool?: string;
    delta?: string;
  }>("ai-activity", (e) => {
    const p = e.payload;
    if (p.kind === "text" && p.delta) hooks.onTextDelta?.(p.delta);
    else if (p.kind === "answer") hooks.onActivity?.({ kind: "answer" });
    else if (p.kind === "tool")
      hooks.onActivity?.({ kind: "tool", tool: p.tool });
    else if (p.kind === "idle") hooks.onActivity?.({ kind: "idle" });
  });
  try {
    return await fn();
  } finally {
    unlisten();
  }
}

/**
 * Send a chat message to the AI and get a response.
 * @param messages Array of chat messages
 * @param pageContext Optional context about the current page
 * @returns The AI response text
 */
export async function aiChat(
  messages: AiMessage[],
  pageContext?: string,
  signal?: AbortSignal,
  hooks?: AiChatHooks,
): Promise<string> {
  if (isWeb()) {
    const cfg = await requireWebAi();
    const { prompt: notes } = await notesPromptFor(
      cfg.notesUseInChats,
      cfg.notesAiCanEdit,
    );
    const diagStart = Date.now();
    try {
      const out = await webBackend().aiProxyStreamChat(
        {
          provider: cfg.provider,
          baseUrl: cfg.baseUrl,
          model: cfg.model,
          apiKey: cfg.apiKey,
          messages: [
            {
              role: "system",
              content: buildWebSystemPrompt(pageContext, false, notes),
            },
            ...messages,
          ],
          tools: [],
        },
        {
          signal,
          onText: (delta) => hooks?.onTextDelta?.(delta),
        },
      );
      recordAiDiag({
        provider: cfg.provider,
        model: cfg.model,
        op: "chat",
        status: "ok",
        durationMs: Date.now() - diagStart,
      });
      return out.content;
    } catch (e) {
      const kind = classifyAiError(e).kind;
      recordAiDiag({
        provider: cfg.provider,
        model: cfg.model,
        op: "chat",
        status: kind === "aborted" ? "aborted" : "error",
        durationMs: Date.now() - diagStart,
        errorClass: kind,
        // 4xx shape logging: roles + counts only, never content/keys.
        messageShape: ["system", ...messages.map((m) => shapeOfMessage(m))],
        providerType: providerTypeOf(e),
      });
      throw e;
    }
  }
  let result: string;
  try {
    result = await withDesktopActivity(hooks, () =>
      invoke("ai_chat", {
        messagesJson: JSON.stringify(messages),
        pageContext: pageContext || null,
      }),
    );
  } catch (e) {
    throw new Error(e as string);
  }
  return result;
}

/**
 * Send a chat message with full Magister data access via tool calling.
 * The AI can fetch real school data (schedule, grades, assignments, etc.)
 * @param messages Array of chat messages
 * @param pageContext Optional context about the current page
 * @param personId The person ID for fetching school data
 * @returns The AI response text plus any staged actions awaiting confirmation
 */
export async function aiChatWithTools(
  messages: AiMessage[],
  pageContext?: string,
  personId?: number,
  signal?: AbortSignal,
  hooks?: AiChatHooks,
): Promise<AiChatWithToolsResult> {
  if (isWeb()) {
    return webChatWithToolsLoop(
      messages,
      pageContext,
      personId ?? 0,
      signal,
      hooks,
    );
  }
  let result: AiChatWithToolsResult;
  try {
    result = await withDesktopActivity(
      hooks,
      () =>
        invoke("ai_chat_with_tools", {
          messagesJson: JSON.stringify(messages),
          pageContext: pageContext || null,
          personId: personId || 0,
          // Frontend AI-Planning settings so the AI replan respects them.
          planSettings: loadSettings().aiSchedule ?? null,
        }) as Promise<AiChatWithToolsResult>,
    );
  } catch (e) {
    throw new Error(e as string);
  }
  return result;
}

/**
 * Ask a running desktop tool loop to stop at the next checkpoint (plan
 * item 7). Best-effort and idempotent; no-op on web (AbortController
 * handles cancellation there).
 */
export async function cancelAiChat(): Promise<void> {
  if (isWeb()) return;
  try {
    await invoke("cancel_ai_chat");
  } catch {
    // The loop may already be done — stopping is best-effort.
  }
}

/** Buffered AI diagnostics, newest first (Settings > AI > Diagnose). */
export async function getAiDiagnostics(): Promise<AiDiagEntry[]> {
  if (isWeb()) return getLocalDiag();
  try {
    return (await invoke("get_ai_diagnostics")) as AiDiagEntry[];
  } catch {
    return [];
  }
}

export async function clearAiDiagnostics(): Promise<void> {
  if (isWeb()) {
    clearLocalDiag();
    return;
  }
  try {
    await invoke("clear_ai_diagnostics");
  } catch {
    // Best-effort.
  }
}

/**
 * Confirm and execute a previously-staged AI action (e.g. sending a message).
 * This is the only path that actually sends data on the user's behalf.
 * @param actionId The id of the staged action to confirm
 * @returns A JSON string describing the outcome
 */
export async function confirmPendingAction(actionId: string): Promise<string> {
  if (isWeb()) {
    const tokens = await loadWebSession();
    if (!tokens) throw new Error("Niet ingelogd.");
    const outcome = await confirmWebPendingAction(
      { be: sessionTierA(), tokens, personId: tokens.personId ?? 0 },
      actionId,
    );
    return JSON.stringify(outcome);
  }
  let result: string;
  try {
    result = await invoke("confirm_pending_action", { actionId });
  } catch (e) {
    throw new Error(e as string);
  }
  return result;
}

/**
 * Get a quick AI insight for a specific page with context data.
 * @param page The page name (e.g. "dashboard", "grades")
 * @param data The page data to analyze
 * @param query The question to ask about the data
 * @returns The AI insight text
 */
export async function aiPageInsight(
  page: string,
  data: any,
  query: string,
): Promise<string> {
  if (isWeb()) {
    const dataJson = JSON.stringify(data);
    const pageContext =
      page === "dashboard"
        ? `Pagina: Dashboard (overzicht)\nData: ${dataJson}\nVraag: ${query}`
        : page === "grades"
          ? `Pagina: Cijfers\nData: ${dataJson}\nVraag: ${query}`
          : `Pagina: ${page}\nData: ${dataJson}\nVraag: ${query}`;
    const cfg = await requireWebAi();
    const out = await webBackend().aiProxy<{
      content: string;
      toolCalls: unknown[];
    }>("chat", {
      provider: cfg.provider,
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      apiKey: cfg.apiKey,
      messages: [
        { role: "system", content: buildWebSystemPrompt(pageContext, false) },
        { role: "user", content: query },
      ],
      tools: [],
    });
    return out.content;
  }
  let result: string;
  try {
    result = await invoke("ai_page_insight", {
      page,
      dataJson: JSON.stringify(data),
      query,
    });
  } catch (e) {
    throw new Error(e as string);
  }
  return result;
}

/**
 * List available models from the configured provider.
 */
export async function listAiModels(): Promise<string[]> {
  if (isWeb()) {
    try {
      const cfg = await loadWebAiConfig();
      if (!cfg.apiKey.trim()) return [];
      const out = await webBackend().aiProxy<{ models: string[] }>("models", {
        provider: cfg.provider,
        baseUrl: cfg.baseUrl,
        model: cfg.model,
        apiKey: cfg.apiKey,
      });
      return Array.isArray(out.models) ? out.models : [];
    } catch (e) {
      console.warn("Failed to list AI models:", e);
      return [];
    }
  }
  try {
    return await invoke("list_ai_models");
  } catch (e) {
    console.warn("Failed to list AI models:", e);
    return [];
  }
}

/**
 * Get a system prompt for the AI assistant with school context.
 */
export function getDefaultSystemPrompt(): AiMessage {
  return {
    role: "system",
    content:
      "Je bent Friday AI, een behulpzame assistent voor scholieren in het Nederlandse middelbaar onderwijs. " +
      "Je helpt met schoolgerelateerde vragen, planning, studieadvies en uitleg. " +
      "Je spreekt altijd Nederlands en reageert bondig en helder. " +
      "Gebruik waar mogelijk opsommingen en concrete voorbeelden. " +
      "Wees aanmoedigend maar realistisch.",
  };
}

/**
 * Get a quick summary of data by asking the AI.
 * Handles the case where AI is not configured gracefully.
 */
export async function tryAiInsight(
  page: string,
  data: any,
  query: string,
): Promise<string | null> {
  try {
    const config = await getAiConfig();
    if (!config.enabled || !config.has_api_key) {
      return null; // AI not configured
    }
    return await aiPageInsight(page, data, query);
  } catch (e) {
    console.warn("AI insight failed:", e);
    return null;
  }
}

// ─── Web-only internals (BYO key + browser tool loop) ──────────────────────

async function requireWebAi() {
  const cfg = await loadWebAiConfig();
  if (!cfg.enabled || !cfg.apiKey.trim()) {
    // AIAssistant maps "niet geconfigureerd" to its Settings hint — keep it.
    throw new Error(
      "AI is niet geconfigureerd: vul een API-sleutel in bij Instellingen > AI Assistent.",
    );
  }
  if (!cfg.model.trim())
    throw new Error("AI is niet geconfigureerd: kies een model.");
  return cfg;
}

/**
 * Web twin of `build_school_context_system_prompt` (ai_client.rs).
 *
 * Single source of truth: `shared/ai-spec/prompt.nl.md`, rendered with the
 * same section order as desktop. `toolDefs` carries the settings-filtered
 * defs offered to the provider (defaults to the full spec); listed tools
 * always match offered tools.
 */
export function buildWebSystemPrompt(
  pageContext: string | undefined,
  toolsEnabled: boolean,
  notes?: NotesPrompt | null,
  toolDefs?: Array<{ name: string; description: string }>,
): string {
  // NOW block is rebuilt on every call so "vandaag" is never stale.
  const sections = getPromptSections();
  const list = toolsEnabled
    ? renderToolList(toolDefs ?? getToolsSpec().tools)
    : null;
  return renderPrompt(sections, {
    now: formatNowBlock(),
    notes: notes
      ? formatNotesBlock(
          notes.content,
          notes.revision,
          notes.updatedBy,
          notes.writable,
        )
      : null,
    context: pageContext || null,
    toolList: list,
  });
}

/**
 * Browser twin of desktop `ai_chat_with_tools`: up to 5 rounds of
 * chat → execute tools locally via Tier-B → feed results back.
 * Write tools stage pending actions; nothing with side effects runs
 * without the user tapping confirm (same contract as desktop).
 */
async function webChatWithToolsLoop(
  messages: AiMessage[],
  pageContext: string | undefined,
  personId: number,
  signal?: AbortSignal,
  hooks?: AiChatHooks,
): Promise<AiChatWithToolsResult> {
  const cfg = await requireWebAi();
  const tokens = await loadWebSession();
  if (!tokens) throw new Error("Niet ingelogd.");
  const be = webBackend();
  const proxyBase = {
    provider: cfg.provider,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    apiKey: cfg.apiKey,
  };
  const notes = await notesPromptFor(cfg.notesUseInChats, cfg.notesAiCanEdit);
  const tools = WEB_TOOL_DEFS.filter(
    (t) => notes.enabled || !NOTES_TOOLS.includes(t.name),
  )
    .filter((t) => notes.writable || !NOTES_WRITE_TOOLS.includes(t.name))
    .map((t) => ({
      name: t.name,
      description: t.description as string,
      parameters: t.parameters,
    }));
  // Phase 3 budget: all successful tool payloads of this turn counted together.
  const budget = new TurnBudget();
  // Bulk cap + undo chip (plan item 5).
  let planWrites = 0;
  let planChanged = false;
  // Diagnostics (item 12): per-turn metadata only.
  const diagStart = Date.now();
  const diagTools: string[] = [];

  const out = await runToolLoop({
    systemPrompt: buildWebSystemPrompt(
      pageContext,
      true,
      notes.prompt,
      tools.map((t) => ({
        name: t.name,
        description: t.description as string,
      })),
    ),
    initialMessages: messages.map((m) => ({
      role: m.role,
      content: m.content,
    })),
    chat: async (msgs, opts) => {
      const res = await be.aiProxyStreamChat(
        { ...proxyBase, messages: msgs, tools: opts.toolsEnabled ? tools : [] },
        {
          signal: opts.signal,
          onText: (delta) => opts.onTextDelta?.(delta),
        },
      );
      return { content: res.content ?? "", toolCalls: res.toolCalls ?? [] };
    },
    executeTool: async (name, args) => {
      if (!diagTools.includes(name)) diagTools.push(name);
      // Bulk cap: max 10 AI plan item writes per turn, counted on attempts.
      if (PLAN_WRITE_TOOLS.includes(name)) {
        if (planWrites >= MAX_PLAN_WRITES_PER_TURN) {
          const error =
            `Limiet planwijzigingen bereikt (max ${MAX_PLAN_WRITES_PER_TURN} per beurt). ` +
            "Vat samen wat je hebt gedaan en vraag de gebruiker welke wijzigingen eerst moeten.";
          return { ok: false, data: { error, retryable: false }, error };
        }
        planWrites += 1;
      }
      const r = await executeWebTool(
        { be: sessionTierA(), tokens, personId },
        name,
        args,
      );
      const data = r.data as Record<string, unknown> | null;
      const staged =
        r.success && data && data["status"] === "pending_user_confirmation"
          ? (data as unknown as PendingActionInfo)
          : undefined;
      // Mirrors desktop: run_update_ai_schedule records no undo entries,
      // so it must not raise the undo chip (it would pop a stale entry or
      // throw "Niets om ongedaan te maken").
      if (r.success && PLAN_WRITE_TOOLS.includes(name)) {
        planChanged = true;
      }
      return {
        ok: r.success,
        data: r.data,
        error: r.error ?? undefined,
        staged,
      };
    },
    isWriteTool: (name) =>
      name === "send_message" ||
      name === "mark_messages_read" ||
      name === "create_calendar_event" ||
      NOTES_WRITE_TOOLS.includes(name) ||
      PLAN_WRITE_TOOLS.includes(name) ||
      name === "run_update_ai_schedule" ||
      name === "undo_last_ai_plan_change",
    onBudgetAccount: (data) => budget.account(data),
    onActivity: (activity) => hooks?.onActivity?.(activity),
    onTextDelta: (delta) => hooks?.onTextDelta?.(delta),
    signal,
  }).then(
    (out) => {
      recordAiDiag({
        provider: cfg.provider,
        model: cfg.model,
        op: "tools",
        status: out.stopped ? "stopped" : "ok",
        durationMs: Date.now() - diagStart,
        toolNames: diagTools,
      });
      return out;
    },
    (e) => {
      const kind = classifyAiError(e).kind;
      recordAiDiag({
        provider: cfg.provider,
        model: cfg.model,
        op: "tools",
        status: kind === "aborted" ? "aborted" : "error",
        durationMs: Date.now() - diagStart,
        errorClass: kind,
        toolNames: diagTools,
        // 4xx shape logging: roles + counts only, never content/keys.
        messageShape: ["system", ...messages.map((m) => shapeOfMessage(m))],
        providerType: providerTypeOf(e),
      });
      throw e;
    },
  );

  return {
    content: out.content,
    pending_actions: out.staged as PendingActionInfo[],
    stopped: out.stopped,
    plan_changed: planChanged,
    trace: out.trace,
  };
}
