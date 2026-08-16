import { invoke } from "@tauri-apps/api/core";

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