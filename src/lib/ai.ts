import { invoke } from "@tauri-apps/api/core";
import { WebApiError } from "./backend.ts";
import { loadWebSession, sessionTierA, webBackend } from "./web-session.ts";
import { loadWebAiConfig, saveWebAiConfig, toPublicConfig } from "./web-ai-store.ts";
import {
  WEB_TOOL_DEFS,
  confirmWebPendingAction,
  executeWebTool,
} from "./web-ai-tools.ts";

function isWeb(): boolean {
  return typeof window !== "undefined" && !(window as any).__TAURI__;
}

export type AiProviderType = "openai" | "anthropic" | "gemini" | "deepseek" | "mistral" | "openai_compatible";

export interface AiConfig {
  api_key: string;
  base_url: string;
  model: string;
  enabled: boolean;
  provider: AiProviderType;
  use_data_access: boolean;
  /** True when an API key is stored (the key itself is never sent to the frontend). */
  has_api_key: boolean;
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

/** Result of a tools-enabled AI chat. */
export interface AiChatWithToolsResult {
  content: string;
  pending_actions: PendingActionInfo[];
}

export const DEFAULT_AI_CONFIG: AiConfig = {
  api_key: "",
  base_url: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  enabled: false,
  provider: "openai",
  use_data_access: true,
  has_api_key: false,
};

/** Provider display names and default models */
export const AI_PROVIDERS: Record<
  AiProviderType,
  { label: string; defaultModel: string; defaultBaseUrl: string; description: string }
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
 * Send a chat message to the AI and get a response.
 * @param messages Array of chat messages
 * @param pageContext Optional context about the current page
 * @returns The AI response text
 */
export async function aiChat(
  messages: AiMessage[],
  pageContext?: string,
): Promise<string> {
  if (isWeb()) {
    const cfg = await requireWebAi();
    const out = await webBackend().aiProxy<{ content: string; toolCalls: unknown[] }>("chat", {
      provider: cfg.provider,
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      apiKey: cfg.apiKey,
      messages: [{ role: "system", content: buildWebSystemPrompt(pageContext, false) }, ...messages],
      tools: [],
    });
    return out.content;
  }
  let result: string;
  try {
    result = await invoke("ai_chat", {
      messagesJson: JSON.stringify(messages),
      pageContext: pageContext || null,
    });
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
): Promise<AiChatWithToolsResult> {
  if (isWeb()) {
    return webChatWithToolsLoop(messages, pageContext, personId ?? 0);
  }
  let result: AiChatWithToolsResult;
  try {
    result = await invoke("ai_chat_with_tools", {
      messagesJson: JSON.stringify(messages),
      pageContext: pageContext || null,
      personId: personId || 0,
    });
  } catch (e) {
    throw new Error(e as string);
  }
  return result;
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
    const out = await webBackend().aiProxy<{ content: string; toolCalls: unknown[] }>("chat", {
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
    throw new Error("AI is niet geconfigureerd: vul een API-sleutel in bij Instellingen > AI Assistent.");
  }
  if (!cfg.model.trim()) throw new Error("AI is niet geconfigureerd: kies een model.");
  return cfg;
}

function dutchWeekday(date: Date): string {
  const s = new Intl.DateTimeFormat("nl-NL", { weekday: "long" }).format(date);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function localYMD(date: Date): string {
  const m = `${date.getMonth() + 1}`.padStart(2, "0");
  const d = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${m}-${d}`;
}

function localHM(date: Date): string {
  return `${`${date.getHours()}`.padStart(2, "0")}:${`${date.getMinutes()}`.padStart(2, "0")}`;
}

/**
 * Port of `build_school_context_system_prompt` (ai_client.rs), minus the
 * AI-Schedule tool family (that feature isn't on web yet — the model must
 * not be instructed to call tools that don't exist here).
 */
export function buildWebSystemPrompt(pageContext: string | undefined, toolsEnabled: boolean): string {
  const now = new Date();
  const dateContext =
    `Vandaag is ${dutchWeekday(now)}, ${localYMD(now)} (${localHM(now)} uur, tijdzone Europe/Amsterdam). ` +
    `Gebruik altijd deze datum als 'vandaag' bij het bepalen van datumbereiken voor tools zoals ` +
    `get_calendar_events, get_assignments en get_full_grade_overview — verzin nooit zelf een datum.`;
  let base =
    `${dateContext}\n\nJe bent Friday AI, een behulpzame assistent voor scholieren in het Nederlandse middelbaar onderwijs. ` +
    `Je helpt met schoolgerelateerde vragen, planning, studieadvies en uitleg. ` +
    `Je spreekt altijd Nederlands en reageert bondig en helder. ` +
    `Gebruik waar mogelijk opsommingen en concrete voorbeelden. ` +
    `Wees aanmoedigend maar realistisch. ` +
    `Als je iets niet weet, zeg dat dan eerlijk. ` +
    `Als een tool een fout teruggeeft of een leeg resultaat (geen items, geen data), zeg dat dan plain tegen de gebruiker in plaats van plausible klinkende data te verzinnen — no hallucineren. ` +
    `Formateer je antwoorden met Markdown waar dat helpt: gebruik ## kopjes, **vet**, *cursief*, opsommingen (- of 1.), tabellen voor cijfers/rooster, ` +
    `inline code en codeblokken voor voorbeelden, en [links](url) waar relevant. Houd het beknopt.`;
  if (pageContext) base += `\n\nContext van de huidige pagina:\n${pageContext}`;
  if (!toolsEnabled) return base;

  const toolLines = WEB_TOOL_DEFS.map((t) => `- ${t.name}: ${(t.description as string).split(".")[0]}`).join("\n");
  base +=
    `\n\nJe hebt toegang tot de volgende tools om schoolgegevens op te vragen en acties uit te voeren:\n${toolLines}\n\n` +
    `Gebruik deze tools wanneer de gebruiker vraagt naar specifieke schoolinformatie of acties wil uitvoeren (zoals berichten sturen, opdrachten bekijken, bestanden downloaden).\n` +
    `Bij vragen over gemiddelden per vak: gebruik eerst get_schoolyears, dan get_full_grade_overview.\n` +
    `Bij 'wat heb ik nodig'-vragen over cijfers (bv. 'welk cijfer moet ik halen om te slagen'): gebruik get_schoolyears, get_full_grade_overview, en daarna calculate_grade_scenario om het daadwerkelijk te berekenen — geef niet alleen ruwe cijfers terug.\n` +
    `Bij een opdracht met een bijlage (uit get_assignment_detail) waarvan de gebruiker hulp wil met de inhoud: gebruik read_attachment_text om de bijlage te lezen voordat je antwoord geeft. Alleen platte tekstbijlagen kunnen worden gelezen.\n` +
    `Bij vragen over berichtinhoud: gebruik eerst get_messages, dan get_message_content, of stuur een bericht met send_message.\n` +
    `Bij acties met een echte bijwerking (send_message, mark_messages_read, create_calendar_event): de tool zet de actie klaar en de gebruiker bevestigt deze in de app voordat er iets gebeurt. Vertel de gebruiker wat er klaarstaat.\n`;
  return base;
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
  const tools = WEB_TOOL_DEFS.map((t) => ({ name: t.name, description: t.description as string, parameters: t.parameters }));

  const current: AiMessage[] = [{ role: "system", content: buildWebSystemPrompt(pageContext, true) }, ...messages];
  let finalContent = "";
  const staged: PendingActionInfo[] = [];
  const maxRounds = 5;

  for (let round = 0; round < maxRounds; round++) {
    const res = await be.aiProxy<{ content: string; toolCalls: Array<{ id: string; name: string; arguments: unknown }> }>(
      "chat",
      { ...proxyBase, messages: current, tools },
    );
    if (res.content) finalContent = res.content;
    if (!res.toolCalls || res.toolCalls.length === 0) break;

    current.push({
      role: "assistant",
      content: res.content,
      tool_calls: res.toolCalls.map((tc) => ({ ...tc, status: "Pending" as const })),
    });

    for (const tc of res.toolCalls) {
      let resultText: string;
      try {
        const r = await executeWebTool({ be: sessionTierA(), tokens, personId }, tc.name, tc.arguments);
        resultText = r.success ? JSON.stringify(r.data) : `Fout bij ophalen van data: ${r.error ?? "Onbekende fout"}`;
        const data = r.data as Record<string, unknown> | null;
        if (r.success && data && data["status"] === "pending_user_confirmation") {
          staged.push(data as unknown as PendingActionInfo);
        }
      } catch (e) {
        resultText = `Fout bij ophalen van data: ${e instanceof Error ? e.message : String(e)}`;
      }
      current.push({ role: "tool", content: resultText, tool_call_id: tc.id, name: tc.name });
    }

    if (round === maxRounds - 1 && !finalContent) {
      finalContent = "Ik heb de beschikbare data opgehaald. Meer details nodig? Stel gerust een vervolgvraag!";
    }
  }

  return { content: finalContent, pending_actions: staged };
}