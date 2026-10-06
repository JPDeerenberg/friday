<script lang="ts">
  import {
    aiChat,
    aiChatWithTools,
    cancelAiChat,
    confirmPendingAction,
    getAiConfig,
    type AiConfig,
    type AiMessage,
    type PendingActionInfo,
  } from "$lib/ai";
  import { classifyAiError, type AiErrorInfo } from "$lib/ai-errors";
  import {
    activityForTool,
    type LoopActivity,
    type LoopTurnTrace,
  } from "$lib/ai-loop";
  import { getNotes } from "$lib/ai-notes";
  import {
    appendMessage,
    createConversation,
    deleteConversation,
    fitHistoryForRequest,
    getConversation,
    getChatsRetentionDays,
    getLastConversationId,
    getMessages,
    isChatStoragePersistent,
    listConversations,
    pruneExpiredConversations,
    renameConversation,
    setConversationSummary,
    setLastConversationId,
    shouldSaveChats,
    summarizeDropped,
    summarySystemMessage,
    traceBlock,
    type Conversation,
    type ThreadMessage,
  } from "$lib/ai-chats";
  import { currentPage, accountInfo, personId } from "$lib/stores";
  import { onMount, untrack } from "svelte";
  import { fly, scale } from "svelte/transition";
  import MarkdownRenderer from "$lib/components/MarkdownRenderer.svelte";
  import {
    preloadMarkdown,
    renderMarkdownAsync,
    tryRenderMarkdownSync,
    getCachedHtml,
  } from "$lib/markdown";

  let isOpen = $state(false);
  let messages = $state<AiMessage[]>([]);
  let renderedHtml = $state<(string | null)[]>([]);
  let inputText = $state("");
  let isLoading = $state(false);
  let messagesContainer: HTMLDivElement | undefined = $state();
  let isConfigured = $state(false);
  let firstOpen = $state(true);
  let pendingActions = $state<PendingActionInfo[]>([]);
  let confirmingActionId = $state<string | null>(null);
  let abortController = $state<AbortController | null>(null);
  let copiedDetails = $state(false);
  /** Live-streamed answer text for the running turn (streaming, plan 6b). */
  let streamText = $state("");
  /** Dutch liveness line ("Cijfers ophalen…") for the running turn. */
  let activityLabel = $state<string | null>(null);
  /** Shown when the AI wrote to AI-Geheugen during the last turn. */
  let noteChip = $state(false);
  /** Shown when the AI changed Friday's Plan during the last turn. */
  let planChip = $state(false);
  // --- Chat persistence (Phase 5) ---
  let conversationId = $state<string | null>(null);
  let conversations = $state<Conversation[]>([]);
  let showHistory = $state(false);
  let editingTitleId = $state<string | null>(null);
  let editTitleValue = $state("");
  let storageNotice = $state(false);
  let storageNoticeDismissed = $state(false);
  let convSummary = $state<string | null>(null);
  let convSummaryThrough = $state(0);

  // Generate a simple page context string from the current page
  function getPageContext(): string {
    const page = $currentPage;
    const name = $accountInfo?.Persoon?.Roepnaam ?? "Gebruiker";
    const pageNames: Record<string, string> = {
      dashboard:
        "Dashboard - het hoofdoverzicht met vandaag lessen, cijfers en opdrachten",
      calendar: "Agenda - het lesrooster en afspraken",
      grades: "Cijfers - beoordelingen en gemiddelden per vak",
      messages: "Berichten - communicatie met school en docenten",
      assignments: "Opdrachten - huiswerk, projecten en deadlines",
      settings: "Instellingen - app configuratie",
      profile: "Profiel - persoonlijke gegevens en schoolinformatie",
      afwezigheid: "Afwezigheid - verzuim en absentie overzicht",
      activiteiten: "Activiteiten - buitenschoolse activiteiten",
      bronnen: "Bronnen - digitale leermaterialen, websites en externe bronnen",
      leermiddelen: "Leermiddelen - digitale schoolboeken en lesmateriaal",
      studiewijzers:
        "Studiewijzers - studiehandleidingen en planningen per vak",
    };
    return `Huidige gebruiker: ${name}\nHuidige pagina: ${pageNames[page] || page}`;
  }

  let useDataAccess = $state(false);
  let currentPersonId = $state<number | null>(null);

  // Subscribe to personId
  personId.subscribe((id) => {
    currentPersonId = id;
  });

  // Check/re-check AI configuration
  async function checkConfig() {
    try {
      const config = await getAiConfig();
      isConfigured = config.enabled && config.has_api_key;
      useDataAccess = config.use_data_access;
      if (isConfigured) preloadMarkdown();
    } catch {
      isConfigured = false;
      useDataAccess = false;
    }
  }

  // Render markdown for assistant messages only — cached per content, never re-parses.
  /** Oversized messages render as truncated plain text, never through markdown (6.10). */
  const MAX_RENDER_CHARS = 20000;
  function escapeHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  async function ensureMarkdownRendered(idx: number, content: string) {
    if (messages[idx]?.role !== "assistant") {
      renderedHtml[idx] = null;
      return;
    }
    if (content.length > MAX_RENDER_CHARS) {
      renderedHtml[idx] =
        `<p class="break-words">${escapeHtml(content.slice(0, MAX_RENDER_CHARS))}</p>` +
        `<p class="text-gray-500 text-xs mt-2">(Lang bericht afgekapt bij ${MAX_RENDER_CHARS} tekens.)</p>`;
      return;
    }
    const cached = getCachedHtml(content);
    if (cached !== undefined) {
      renderedHtml[idx] = cached;
      return;
    }
    const sync = tryRenderMarkdownSync(content);
    if (sync !== null) {
      renderedHtml[idx] = sync;
      return;
    }
    // Fallback: show plain text until chunk loads, then upgrade
    renderedHtml[idx] = null;
    try {
      const html = await renderMarkdownAsync(content);
      // Guard against race: index may have new content by now
      if (messages[idx]?.content === content) renderedHtml[idx] = html;
    } catch {}
  }

  function scheduleRenderForMessages(msgs: AiMessage[]) {
    // Keep renderedHtml length in sync; render only new/changed assistant msgs
    if (renderedHtml.length !== msgs.length) {
      renderedHtml = msgs.map((m, i) => renderedHtml[i] ?? null);
    }
    for (let i = 0; i < msgs.length; i++) {
      if (msgs[i].role === "assistant" && renderedHtml[i] == null) {
        if (msgs[i].content.length > MAX_RENDER_CHARS) {
          void ensureMarkdownRendered(i, msgs[i].content);
          continue;
        }
        const cached = getCachedHtml(msgs[i].content);
        if (cached !== undefined) {
          renderedHtml[i] = cached;
        } else {
          const sync = tryRenderMarkdownSync(msgs[i].content);
          if (sync !== null) renderedHtml[i] = sync;
          else void ensureMarkdownRendered(i, msgs[i].content);
        }
      } else if (msgs[i].role !== "assistant") {
        renderedHtml[i] = null;
      }
    }
  }

  onMount(() => {
    checkConfig();
  });

  // Auto-scroll to the newest message when one is added, unless the user has
  // scrolled up to read earlier chat history.
  $effect(() => {
    const last = messages[messages.length - 1];
    if (!last || !messagesContainer) return;
    const el = messagesContainer;
    const nearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 80;
    if (nearBottom) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }
  });

  // Keep the live answer visible while streaming (same near-bottom rule).
  $effect(() => {
    if (!streamText || !messagesContainer) return;
    const el = messagesContainer;
    const nearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 120;
    if (nearBottom) {
      el.scrollTo({ top: el.scrollHeight });
    }
  });

  // Schedule markdown rendering when messages change — only assistant msgs, cached.
  $effect(() => {
    const len = messages.length;
    const msgs = messages;
    if (len === 0) return;
    // Don't track renderedHtml reads inside schedule — avoids infinite loop
    untrack(() => scheduleRenderForMessages(msgs));
  });

  // Add greeting message when first opened. Re-check config every time the panel opens,
  // so users who just saved their API key in settings see it immediately.
  function handleOpen() {
    isOpen = !isOpen;
    if (isOpen) {
      // Re-check config whenever the panel opens (catches recently saved settings)
      checkConfig();
      preloadMarkdown();
      void ensureChatReady();
    }
  }

  function greet() {
    const greeting =
      "👋 Hoi! Ik ben Friday AI, jouw persoonlijke schoolassistent. Stel me vragen over je cijfers, opdrachten, planning of vraag om uitleg!";
    messages = [
      {
        role: "assistant",
        content: greeting,
      },
    ];
    // Render greeting immediately (sync if marked loaded, else async upgrade)
    const idx = 0;
    const cached = getCachedHtml(greeting);
    if (cached !== undefined) renderedHtml[idx] = cached;
    else {
      const sync = tryRenderMarkdownSync(greeting);
      renderedHtml[idx] = sync;
      if (sync === null) void ensureMarkdownRendered(idx, greeting);
    }
  }

  function toAiMessage(m: {
    role: string;
    text: string;
    trace?: LoopTurnTrace[] | undefined;
    error?: AiErrorInfo | null | undefined;
    stopped?: boolean | undefined;
  }): AiMessage {
    const out: AiMessage = {
      role: m.role as AiMessage["role"],
      content: m.text,
    };
    if (m.trace && m.trace.length > 0) out.trace = m.trace;
    if (m.error) out.error = m.error;
    if (m.stopped) out.stopped = true;
    return out;
  }

  /**
   * An assistant message with blank content and no tool trace: strict
   * providers (Mistral) reject it with `invalid_request_assistant_message`
   * when replayed. Never sent, never restored.
   */
  function isEmptyAssistant(m: AiMessage): boolean {
    return (
      m.role === "assistant" &&
      !m.error &&
      m.content.trim() === "" &&
      !(m.trace && m.trace.length > 0)
    );
  }

  /** Open a conversation from storage (restore thread + summary). */
  async function openConversation(id: string) {
    const stored = await getMessages(id).catch(() => []);
    // Older turns may hold empty stopped messages (persisted before the
    // empty-turn guard below): filter them so a restored chat never replays
    // a provider-rejected assistant message.
    messages = stored.map(toAiMessage).filter((m) => !isEmptyAssistant(m));
    renderedHtml = [];
    const conv = await getConversation(id).catch(() => null);
    convSummary = conv?.summary ?? null;
    convSummaryThrough = conv?.summary_through ?? 0;
    conversationId = id;
    setLastConversationId(id);
    showHistory = false;
    if (messages.length === 0 && firstOpen) {
      firstOpen = false;
      greet();
    }
  }

  /** Start a fresh conversation (the old one stays in history). */
  async function newChat() {
    if (!shouldSaveChats()) {
      conversationId = null;
      convSummary = null;
      convSummaryThrough = 0;
      messages = [];
      renderedHtml = [];
      showHistory = false;
      greet();
      return;
    }
    try {
      const conv = await createConversation();
      conversations = await listConversations().catch(() => conversations);
      await openConversation(conv.id);
    } catch {
      conversationId = null;
      messages = [];
      renderedHtml = [];
      showHistory = false;
    }
  }

  /** Restore last-open conversation (or start fresh) when the panel opens. */
  async function ensureChatReady() {
    if (!shouldSaveChats()) {
      if (firstOpen && messages.length === 0) {
        firstOpen = false;
        greet();
      }
      return;
    }
    try {
      await pruneExpiredConversations(getChatsRetentionDays()).catch(() => 0);
      conversations = await listConversations();
      const stillThere = conversationId
        ? conversations.some((c) => c.id === conversationId)
        : false;
      if (conversationId && stillThere) return; // e.g. cleared via Settings
      const lastId = getLastConversationId();
      const target = conversations.find((c) => c.id === lastId) ?? null;
      if (target) await openConversation(target.id);
      else await newChat();
    } catch {
      // Storage hiccup — chat still works in memory this session.
    }
    if (!isChatStoragePersistent() && !storageNoticeDismissed) {
      storageNotice = true;
    }
  }

  async function saveTitle(id: string) {
    const title = editTitleValue.trim();
    editingTitleId = null;
    if (!title) return;
    try {
      await renameConversation(id, title);
      conversations = await listConversations().catch(() => conversations);
    } catch {
      // Best-effort; the drawer refreshes on next open.
    }
  }

  async function deleteConversationUi(id: string) {
    if (!confirm("Gesprek verwijderen? Dit kan niet ongedaan worden gemaakt."))
      return;
    try {
      await deleteConversation(id);
      conversations = await listConversations().catch(() => conversations);
      if (id === conversationId) await newChat();
    } catch {
      // Best-effort.
    }
  }

  async function persistUserMessage(text: string): Promise<void> {
    if (!shouldSaveChats() || !conversationId) return;
    try {
      await appendMessage(conversationId, { role: "user", text });
      conversations = await listConversations().catch(() => conversations);
    } catch {
      // Memory fallback inside the facade already handled it.
    }
  }

  async function persistAssistant(msg: AiMessage): Promise<void> {
    if (!shouldSaveChats() || !conversationId) return;
    try {
      await appendMessage(conversationId, {
        role: "assistant",
        text: msg.content,
        trace: msg.trace,
        error: msg.error ?? null,
        stopped: msg.stopped,
      });
    } catch {
      // Chat already answered — persistence is best-effort.
    }
  }

  async function sendMessage() {
    const text = inputText.trim();
    if (!text || isLoading) return;

    inputText = "";
    await ensureChatReady();
    messages = [...messages, { role: "user", content: text }];
    await persistUserMessage(text);
    await runTurn();
  }

  /** Stop generation (plan item 7): abort the web request, cancel desktop. */
  function stopGeneration() {
    abortController?.abort();
    void cancelAiChat();
  }

  /**
   * Run one assistant turn over the current thread. The user's message is
   * never lost: failures land as an error bubble on the failed turn with an
   * "Opnieuw proberen" button (plan item 9).
   */
  async function runTurn() {
    if (isLoading) return;
    isLoading = true;
    noteChip = false;
    planChip = false;
    streamText = "";
    activityLabel = null;
    abortController = new AbortController();
    const signal = abortController.signal;
    // Live hooks: streamed deltas accumulate into the streaming bubble,
    // activity events drive the Dutch liveness line (streaming, plan 6b).
    const hooks = {
      onTextDelta: (delta: string) => {
        streamText += delta;
      },
      onActivity: (a: LoopActivity) => {
        if (a.kind === "tool" && a.tool)
          activityLabel = activityForTool(a.tool);
        else if (a.kind === "answer") {
          if (!streamText) activityLabel = "Antwoord schrijven…";
        } else if (a.kind === "idle") activityLabel = null;
      },
    };
    // Revision probe for the "Notitie bijgewerkt" chip (plan 4.7).
    let notesRevBefore: number | null = null;
    try {
      notesRevBefore = (await getNotes()).revision;
    } catch {
      notesRevBefore = null;
    }

    try {
      const context = getPageContext();
      // Error bubbles never go back to the provider; fields are stripped.
      // Older assistant turns replay with their compact tool trace (item 4).
      // Empty assistant turns (blank content, no trace — e.g. from a stopped
      // generation) are dropped too: replaying them trips Mistral's
      // `invalid_request_assistant_message` 400.
      const thread: ThreadMessage[] = messages
        .filter((m) => !(m.role === "assistant" && m.error))
        .filter((m) => !isEmptyAssistant(m))
        .map((m) => ({
          role: m.role,
          content: m.content,
          trace: m.trace,
        }));
      const fitted = fitHistoryForRequest(thread);
      const messagePayload = fitted.messages.map((m) => ({
        role: m.role,
        content: m.content + traceBlock(m.trace),
      }));
      // Rolling summary over dropped history (item 5); failure → truncation.
      if (fitted.dropped.length > convSummaryThrough) {
        const fresh = await summarizeDropped(fitted.dropped, (prompt) =>
          aiChat([{ role: "user", content: prompt }], undefined, signal),
        );
        if (fresh) {
          convSummary = fresh;
          convSummaryThrough = fitted.dropped.length;
          if (conversationId && shouldSaveChats()) {
            await setConversationSummary(
              conversationId,
              fresh,
              fitted.dropped.length,
            ).catch(() => {});
          }
        }
      }
      const payloadWithSummary = convSummary
        ? [
            {
              role: summarySystemMessage(convSummary).role,
              content: summarySystemMessage(convSummary).content,
            },
            ...messagePayload,
          ]
        : messagePayload;

      // Use aiChatWithTools when data access is enabled AND we have a personId
      const canUseTools = useDataAccess && currentPersonId !== null;
      if (canUseTools) {
        const result = await aiChatWithTools(
          payloadWithSummary,
          context,
          currentPersonId!,
          signal,
          hooks,
        );
        // A stopped turn with empty content carries nothing: appending and
        // persisting it would poison the next turn's history (400 on web).
        if (result.stopped && result.content.trim() === "") {
          return;
        }
        const assistantMsg: AiMessage = result.stopped
          ? { role: "assistant", content: result.content, stopped: true }
          : { role: "assistant", content: result.content };
        if (result.trace.length > 0) assistantMsg.trace = result.trace;
        messages = [...messages, assistantMsg];
        await persistAssistant(assistantMsg);
        if (result.pending_actions.length > 0) {
          pendingActions = [...pendingActions, ...result.pending_actions];
        }
        if (result.plan_changed) {
          planChip = true;
        }
      } else {
        const response = await aiChat(
          payloadWithSummary,
          context,
          signal,
          hooks,
        );
        const assistantMsg: AiMessage = {
          role: "assistant",
          content: response,
        };
        messages = [...messages, assistantMsg];
        await persistAssistant(assistantMsg);
      }
      // "Notitie bijgewerkt" chip: the AI wrote during this turn.
      if (notesRevBefore !== null) {
        try {
          const after = await getNotes();
          if (after.revision > notesRevBefore && after.updated_by === "ai") {
            noteChip = true;
          }
        } catch {
          // Memory unavailable — no chip, chat already answered.
        }
      }
    } catch (e) {
      console.error("[AIAssistant] turn failed:", e);
      const info = classifyAiError(e);
      if (info.kind === "not_configured") isConfigured = false;
      // Error bubbles stay session-only: persisting them would leave stale
      // failures above later answers after "Opnieuw proberen".
      const errMsg: AiMessage = { role: "assistant", content: "", error: info };
      messages = [...messages, errMsg];
    } finally {
      isLoading = false;
      abortController = null;
      streamText = "";
      activityLabel = null;
    }
  }

  /** Retry the failed turn without duplicating the user's message. */
  async function retryTurn() {
    if (isLoading) return;
    const last = messages[messages.length - 1];
    if (last?.role === "assistant" && last.error) {
      messages = messages.slice(0, -1);
    }
    await runTurn();
  }

  /** Error-bubble action button (plan item 8). */
  async function errorAction(kind: string, detail?: string, message?: string) {
    if (kind === "open-ai-settings") {
      currentPage.set("settings");
      isOpen = false;
    } else if (kind === "retry") {
      await retryTurn();
    } else if (kind === "copy-detail") {
      try {
        await navigator.clipboard.writeText(detail ?? message ?? "");
        copiedDetails = true;
        setTimeout(() => (copiedDetails = false), 2000);
      } catch {
        // Clipboard unavailable — the detail stays visible in the bubble.
      }
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  function clearChat() {
    // With persistence this starts a new chat; history stays in the drawer.
    void newChat();
    inputText = "";
    pendingActions = [];
  }

  // Quick actions
  const quickActions = [
    {
      label: "Dagoverzicht",
      icon: "📋",
      query:
        "Geef een kort dagoverzicht van wat ik vandaag heb op basis van mijn rooster.",
    },
    {
      label: "Studietips",
      icon: "💡",
      query: "Geef me algemene studietips voor vandaag.",
    },
    {
      label: "Prioriteiten",
      icon: "🎯",
      query:
        "Wat zijn mijn belangrijkste prioriteiten voor vandaag op basis van deadlines?",
    },
  ];

  async function quickAction(query: string) {
    if (isLoading) return;
    await ensureChatReady();
    messages = [...messages, { role: "user", content: query }];
    await persistUserMessage(query);
    await runTurn();
  }

  async function confirmAction(action: PendingActionInfo) {
    if (confirmingActionId !== null) return;
    confirmingActionId = action.action_id;
    try {
      await confirmPendingAction(action.action_id);
      const done =
        action.action_type === "send_message"
          ? "✅ Bericht verzonden."
          : "✅ Actie bevestigd en uitgevoerd.";
      messages = [...messages, { role: "assistant", content: done }];
    } catch (e) {
      messages = [
        ...messages,
        { role: "assistant", content: "⚠️ " + String(e) },
      ];
    } finally {
      pendingActions = pendingActions.filter(
        (a) => a.action_id !== action.action_id,
      );
      confirmingActionId = null;
    }
  }

  function dismissAction(action: PendingActionInfo) {
    if (confirmingActionId !== null) return;
    pendingActions = pendingActions.filter(
      (a) => a.action_id !== action.action_id,
    );
    messages = [
      ...messages,
      {
        role: "assistant",
        content: "❌ Actie geannuleerd — er is niets verzonden.",
      },
    ];
  }

  function formatRecipients(
    recipients?: PendingActionInfo["recipients"],
  ): string {
    if (!recipients || recipients.length === 0) return "—";
    return recipients
      .map((r) => `#${r.id}${r.type ? ` (${r.type})` : ""}`)
      .join(", ");
  }

  function actionLabel(actionType: string): string {
    switch (actionType) {
      case "send_message":
        return "een bericht verzenden";
      case "mark_messages_read":
        return "berichten als gelezen markeren";
      case "create_calendar_event":
        return "een agenda-afspraak aanmaken";
      default:
        return "een actie uitvoeren";
    }
  }
</script>

{#if isConfigured}
  <!-- Floating button -->
  <button
    onclick={handleOpen}
    class="fixed z-50 bottom-20 md:bottom-8 right-4 md:right-8 w-14 h-14 rounded-2xl bg-gradient-to-br from-primary-500 to-accent-500 text-white shadow-2xl shadow-primary-500/40 hover:scale-105 active:scale-95 transition-all duration-300 flex items-center justify-center group"
    aria-label="AI Assistent"
  >
    {#if isOpen}
      <svg
        class="w-6 h-6"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        ><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg
      >
    {:else}
      <svg
        class="w-6 h-6"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M12 2a4 4 0 0 1 4 4c0 2-2 3-4 5-2-2-4-3-4-5a4 4 0 0 1 4-4z" />
        <path d="M12 14l-2 6h4l-2-6z" />
        <path d="M2 12h4" />
        <path d="M18 12h4" />
        <path d="M12 2v2" />
        <path d="M12 14v2" />
      </svg>
    {/if}
  </button>

  <!-- Chat panel -->
  {#if isOpen}
    <div
      class="fixed z-50 bottom-36 md:bottom-24 right-4 md:right-8 w-[calc(100vw-2rem)] md:w-[400px] max-h-[600px] h-[60vh] md:h-[500px] rounded-3xl bg-surface-900/95 backdrop-blur-2xl border border-white/10 shadow-3xl flex flex-col overflow-hidden"
      transition:scale={{ start: 0.9, duration: 200 }}
    >
      <!-- Header -->
      <div
        class="shrink-0 px-5 py-4 border-b border-white/10 flex items-center justify-between bg-surface-900/80"
      >
        <div class="flex items-center gap-3">
          <div
            class="w-8 h-8 rounded-xl bg-gradient-to-br from-primary-500 to-accent-500 flex items-center justify-center"
          >
            <svg
              class="w-4 h-4 text-white"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              ><path
                d="M12 2a4 4 0 0 1 4 4c0 2-2 3-4 5-2-2-4-3-4-5a4 4 0 0 1 4-4z"
              /><path d="M12 14l-2 6h4l-2-6z" /></svg
            >
          </div>
          <div>
            <h3 class="text-sm font-black text-white uppercase tracking-tight">
              Friday AI
            </h3>
            <p
              class="text-[9px] font-bold text-emerald-400 uppercase tracking-widest flex items-center gap-1"
            >
              <span
                class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"
              ></span>
              Online
            </p>
          </div>
        </div>
        <div class="flex items-center gap-1">
          <button
            onclick={async () => {
              conversations = await listConversations().catch(() => []);
              showHistory = !showHistory;
            }}
            class="p-2 rounded-xl text-gray-500 hover:text-gray-300 hover:bg-surface-800 transition-all"
            title="Gesprekken"
            aria-label="Gesprekkenoverzicht"
          >
            <svg
              class="w-4 h-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              ><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /><path
                d="M12 7v5l3 3"
              /></svg
            >
          </button>
          <button
            onclick={clearChat}
            class="p-2 rounded-xl text-gray-500 hover:text-gray-300 hover:bg-surface-800 transition-all text-[10px] font-bold uppercase tracking-wider"
            title="Nieuwe chat"
          >
            <svg
              class="w-4 h-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              ><path d="M3 6h18" /><path
                d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"
              /><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" /></svg
            >
          </button>
          <button
            onclick={() => (isOpen = false)}
            aria-label="Sluit assistent"
            class="p-2 rounded-xl text-gray-500 hover:text-gray-300 hover:bg-surface-800 transition-all"
          >
            <svg
              class="w-4 h-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              ><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg
            >
          </button>
        </div>
      </div>

      {#if storageNotice}
        <div
          class="shrink-0 px-5 py-2 border-b border-amber-500/20 bg-amber-500/5"
        >
          <p class="text-[11px] text-amber-300">
            Gesprekken kunnen niet worden bewaard (opslag niet beschikbaar) —
            deze sessie werkt alleen in het geheugen.
            <button
              onclick={() => {
                storageNotice = false;
                storageNoticeDismissed = true;
              }}
              class="ml-2 underline hover:text-amber-100"
            >
              Verberg
            </button>
          </p>
        </div>
      {/if}

      {#if showHistory}
        <div
          class="absolute inset-y-0 left-0 w-[78%] max-w-[300px] z-10 flex flex-col bg-surface-900 border-r border-white/10 shadow-2xl"
        >
          <div
            class="flex items-center justify-between px-4 py-3 border-b border-white/10"
          >
            <p
              class="text-[11px] font-black uppercase tracking-widest text-gray-400"
            >
              Gesprekken
            </p>
            <button
              onclick={() => (showHistory = false)}
              aria-label="Sluit overzicht"
              class="p-1.5 rounded-lg text-gray-500 hover:text-gray-300 hover:bg-surface-800"
            >
              <svg
                class="w-4 h-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2.5"
                ><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg
              >
            </button>
          </div>
          <div class="px-3 pt-3">
            <button
              onclick={() => void newChat()}
              class="w-full px-3 py-2 rounded-xl bg-primary-500/20 border border-primary-500/30 text-[11px] font-bold uppercase tracking-wide text-primary-200 hover:bg-primary-500/30 transition-all active:scale-95"
            >
              + Nieuwe chat
            </button>
          </div>
          <div
            class="flex-1 overflow-y-auto px-3 py-3 space-y-1.5 no-scrollbar"
          >
            {#if conversations.length === 0}
              <p class="px-2 py-4 text-[12px] text-gray-500">
                {shouldSaveChats()
                  ? "Nog geen bewaarde gesprekken."
                  : "Gesprekken bewaren staat uit (Instellingen > AI Geheugen)."}
              </p>
            {/if}
            {#each conversations as conv (conv.id)}
              <div
                class="group rounded-xl border px-3 py-2 transition-all {conv.id ===
                conversationId
                  ? 'border-primary-500/40 bg-primary-500/10'
                  : 'border-white/5 bg-surface-800/40 hover:bg-surface-800'}"
              >
                {#if editingTitleId === conv.id}
                  <input
                    type="text"
                    bind:value={editTitleValue}
                    onkeydown={(e) => {
                      if (e.key === "Enter") void saveTitle(conv.id);
                      if (e.key === "Escape") editingTitleId = null;
                    }}
                    onblur={() => void saveTitle(conv.id)}
                    class="w-full bg-surface-900/80 border border-primary-500/40 rounded-lg px-2 py-1 text-[12px] text-white focus:outline-none"
                  />
                {:else}
                  <button
                    onclick={() => void openConversation(conv.id)}
                    class="block w-full text-left"
                  >
                    <p class="truncate text-[13px] font-medium text-gray-100">
                      {conv.title}
                    </p>
                    <p class="text-[10px] text-gray-500">
                      {new Date(conv.updated_at).toLocaleString("nl-NL", {
                        day: "numeric",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </p>
                  </button>
                  <div class="mt-1 hidden group-hover:flex gap-1">
                    <button
                      onclick={() => {
                        editingTitleId = conv.id;
                        editTitleValue = conv.title;
                      }}
                      class="px-2 py-0.5 rounded-lg text-[10px] font-bold uppercase tracking-wide text-gray-400 hover:text-white hover:bg-surface-700"
                    >
                      Hernoem
                    </button>
                    <button
                      onclick={() => void deleteConversationUi(conv.id)}
                      class="px-2 py-0.5 rounded-lg text-[10px] font-bold uppercase tracking-wide text-red-400/80 hover:text-red-300 hover:bg-surface-700"
                    >
                      Verwijder
                    </button>
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        </div>
      {/if}

      <!-- Messages -->
      <div
        class="flex-1 overflow-y-auto px-5 py-4 space-y-4 no-scrollbar scroll-smooth"
        bind:this={messagesContainer}
      >
        <svelte:boundary>
          {#each messages as msg, i (i)}
            <div
              class="flex {msg.role === 'user'
                ? 'justify-end'
                : 'justify-start'}"
              in:fly={{ y: 10, duration: 200 }}
            >
              <div
                class="max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed
              {msg.role === 'user'
                  ? 'bg-primary-500/20 border border-primary-500/20 text-white rounded-tr-md'
                  : 'bg-surface-800/60 border border-white/5 text-gray-200 rounded-tl-md'}"
              >
                {#if msg.role === "user"}
                  <p class="whitespace-pre-wrap text-[13px]">{msg.content}</p>
                {:else if msg.error}
                  <div>
                    <p class="text-[13px] text-red-300">
                      ⚠️ {msg.error.message}
                    </p>
                    {#if msg.error.detail}
                      <p class="mt-1 text-[11px] text-gray-500 break-words">
                        {msg.error.detail}
                      </p>
                    {/if}
                    <div class="mt-2 flex flex-wrap gap-2">
                      <button
                        onclick={retryTurn}
                        class="px-3 py-1.5 rounded-xl bg-surface-700/80 border border-white/10 text-[11px] font-bold uppercase tracking-wide text-gray-200 hover:text-white hover:bg-surface-600 transition-all active:scale-95"
                      >
                        Opnieuw proberen
                      </button>
                      {#if msg.error.action && msg.error.action.kind !== "retry"}
                        <button
                          onclick={() =>
                            errorAction(
                              msg.error!.action!.kind,
                              msg.error!.detail,
                              msg.error!.message,
                            )}
                          class="px-3 py-1.5 rounded-xl bg-primary-500/20 border border-primary-500/30 text-[11px] font-bold uppercase tracking-wide text-primary-200 hover:bg-primary-500/30 transition-all active:scale-95"
                        >
                          {msg.error.action.kind === "copy-detail" &&
                          copiedDetails
                            ? "Gekopieerd!"
                            : msg.error.action.label}
                        </button>
                      {/if}
                    </div>
                  </div>
                {:else}
                  {#if msg.stopped}
                    <p
                      class="mb-1 text-[10px] font-bold uppercase tracking-widest text-amber-400"
                    >
                      ⏹ Gestopt — gedeeltelijk antwoord
                    </p>
                  {/if}
                  <MarkdownRenderer
                    content={msg.content}
                    html={renderedHtml[i] ?? null}
                  />
                {/if}
              </div>
            </div>
          {/each}

          {#each pendingActions as action (action.action_id)}
            <div class="flex justify-start" in:fly={{ y: 10, duration: 200 }}>
              <div
                class="max-w-[92%] w-full rounded-2xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-gray-200"
              >
                <p
                  class="text-[11px] font-black uppercase tracking-widest text-amber-400 mb-1"
                >
                  ⚠️ Bevestiging vereist
                </p>
                <p class="text-[12px] text-gray-300 mb-2">
                  De AI wil namens jou {actionLabel(action.action_type)}. Er is
                  nog niets uitgevoerd.
                </p>
                {#if action.action_type === "send_message"}
                  <div class="space-y-1 text-[13px]">
                    <p class="break-words">
                      <span class="font-bold text-white">Naar:</span>
                      {formatRecipients(action.recipients)}
                    </p>
                    <p class="break-words">
                      <span class="font-bold text-white">Onderwerp:</span>
                      {action.subject ?? "—"}
                    </p>
                    <p class="break-words whitespace-pre-wrap">
                      <span class="font-bold text-white">Inhoud:</span>
                      {action.body ?? "—"}
                    </p>
                  </div>
                {:else if action.action_type === "mark_messages_read"}
                  <p class="text-[13px] break-words">
                    <span class="font-bold text-white">Bericht-ID's:</span>
                    {(action.message_ids ?? []).join(", ")}
                  </p>
                {:else if action.action_type === "create_calendar_event"}
                  <div class="space-y-1 text-[13px]">
                    <p class="break-words">
                      <span class="font-bold text-white">Afspraak:</span>
                      {action.omschrijving ?? "—"}
                    </p>
                    <p class="break-words">
                      <span class="font-bold text-white">Start:</span>
                      {action.start ?? "—"}
                    </p>
                    <p class="break-words">
                      <span class="font-bold text-white">Einde:</span>
                      {action.einde ?? "—"}
                    </p>
                  </div>
                {/if}
                <div class="flex gap-2 mt-3">
                  <button
                    onclick={() => confirmAction(action)}
                    disabled={confirmingActionId !== null}
                    class="flex-1 px-3 py-2 rounded-xl bg-emerald-500 text-white text-[11px] font-bold uppercase tracking-wide hover:bg-emerald-400 transition-all active:scale-95 disabled:opacity-50"
                  >
                    {confirmingActionId === action.action_id
                      ? "Bezig..."
                      : action.action_type === "send_message"
                        ? "Bevestig en verzend"
                        : "Bevestigen"}
                  </button>
                  <button
                    onclick={() => dismissAction(action)}
                    disabled={confirmingActionId !== null}
                    class="flex-1 px-3 py-2 rounded-xl bg-surface-800 border border-white/10 text-[11px] font-bold uppercase tracking-wide text-gray-300 hover:text-white hover:bg-surface-700 transition-all active:scale-95 disabled:opacity-50"
                  >
                    Annuleren
                  </button>
                </div>
              </div>
            </div>
          {/each}

          {#if isLoading}
            <div class="flex justify-start" in:fly={{ y: 10, duration: 200 }}>
              <div
                class="bg-surface-800/60 border border-white/5 rounded-2xl rounded-tl-md px-5 py-4 max-w-[85%]"
              >
                {#if activityLabel}
                  <p class="text-[11px] text-gray-500 mb-2">{activityLabel}</p>
                {/if}
                {#if streamText}
                  <p
                    class="text-sm text-gray-100 whitespace-pre-wrap break-words"
                  >
                    {streamText}<span class="animate-pulse">▍</span>
                  </p>
                {:else}
                  <div class="flex items-center gap-2">
                    <div
                      class="w-2 h-2 rounded-full bg-primary-400 animate-bounce"
                      style="animation-delay: 0ms"
                    ></div>
                    <div
                      class="w-2 h-2 rounded-full bg-primary-400 animate-bounce"
                      style="animation-delay: 150ms"
                    ></div>
                    <div
                      class="w-2 h-2 rounded-full bg-primary-400 animate-bounce"
                      style="animation-delay: 300ms"
                    ></div>
                  </div>
                {/if}
              </div>
            </div>
          {/if}

          {#if messages.length === 0 && !isLoading}
            <div
              class="flex-1 flex flex-col items-center justify-center text-center py-8"
            >
              <svg
                class="w-12 h-12 text-primary-500/30 mb-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
              >
                <path
                  d="M12 2a4 4 0 0 1 4 4c0 2-2 3-4 5-2-2-4-3-4-5a4 4 0 0 1 4-4z"
                />
                <path d="M12 14l-2 6h4l-2-6z" />
                <path d="M2 12h4" />
                <path d="M18 12h4" />
                <path d="M12 2v2" />
                <path d="M12 14v2" />
              </svg>
              <p class="text-gray-500 text-sm font-medium">
                Stel een vraag over je schoolzaken
              </p>
            </div>
          {/if}

          {#snippet failed(error, reset)}
            <div
              class="rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200"
            >
              <p class="font-bold mb-1">
                Er ging iets mis bij het tonen van dit gesprek.
              </p>
              <p class="text-xs text-red-200/70 mb-3">
                Je berichten zijn bewaard — alleen de weergave is vastgelopen.
              </p>
              <button
                onclick={() => reset()}
                class="px-3 py-1.5 rounded-xl bg-red-500/20 border border-red-500/40 text-[11px] font-bold uppercase tracking-wide hover:bg-red-500/30 transition-all active:scale-95"
              >
                Opnieuw tonen
              </button>
            </div>
          {/snippet}
        </svelte:boundary>
      </div>

      <!-- Quick actions -->
      {#if messages.length <= 1}
        <div class="shrink-0 px-5 pb-2 flex flex-wrap gap-2">
          {#each quickActions as action (action.label)}
            <button
              onclick={() => quickAction(action.query)}
              disabled={isLoading}
              class="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-surface-800/60 border border-white/5 text-[10px] font-bold text-gray-400 hover:text-white hover:bg-surface-700/60 hover:border-primary-500/30 transition-all active:scale-95 disabled:opacity-50"
            >
              <span>{action.icon}</span>
              <span>{action.label}</span>
            </button>
          {/each}
        </div>
      {/if}

      <!-- Input -->
      <div class="shrink-0 px-5 py-3 border-t border-white/5 bg-surface-900/80">
        {#if noteChip}
          <div class="mb-2 flex justify-center">
            <button
              onclick={() => {
                currentPage.set("settings");
                isOpen = false;
              }}
              class="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-primary-500/10 border border-primary-500/20 text-[10px] font-bold text-primary-300 hover:bg-primary-500/20 transition-all active:scale-95"
            >
              <span>📝</span>
              <span>Notitie bijgewerkt — bekijk AI Geheugen</span>
            </button>
          </div>
        {/if}
        {#if planChip}
          <div class="mb-2 flex justify-center">
            <button
              onclick={() => {
                planChip = false;
                messages = [
                  ...messages,
                  {
                    role: "user",
                    content: "Maak je laatste planwijziging ongedaan.",
                  },
                ];
                void runTurn();
              }}
              class="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-amber-500/10 border border-amber-500/20 text-[10px] font-bold text-amber-300 hover:bg-amber-500/20 transition-all active:scale-95"
            >
              <span>↩️</span>
              <span>Plan gewijzigd — Ongedaan maken</span>
            </button>
          </div>
        {/if}
        <div class="flex items-center gap-2">
          <input
            type="text"
            bind:value={inputText}
            onkeydown={handleKeydown}
            placeholder="Stel een vraag..."
            disabled={isLoading}
            class="flex-1 bg-surface-800/80 border border-white/10 rounded-2xl px-4 py-3 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-primary-500/50 transition-all disabled:opacity-50"
          />
          {#if isLoading}
            <button
              onclick={stopGeneration}
              aria-label="Stop genereren"
              class="shrink-0 h-11 px-4 rounded-2xl bg-red-500/20 border border-red-500/40 text-red-200 hover:bg-red-500/30 transition-all flex items-center gap-2 text-[11px] font-bold uppercase tracking-wide active:scale-90"
            >
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"
                ><rect x="6" y="6" width="12" height="12" rx="2" /></svg
              >
              Stop
            </button>
          {:else}
            <button
              onclick={sendMessage}
              disabled={!inputText.trim()}
              aria-label="Verstuur bericht"
              class="shrink-0 w-11 h-11 rounded-2xl bg-primary-500 text-white hover:bg-primary-400 transition-all flex items-center justify-center disabled:opacity-30 disabled:cursor-not-allowed active:scale-90"
            >
              <svg
                class="w-5 h-5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2.5"
                stroke-linecap="round"
                stroke-linejoin="round"
                ><path d="m22 2-11 20-4-7-7-4 20-11z" /></svg
              >
            </button>
          {/if}
        </div>
      </div>
    </div>
  {/if}
{/if}

<style>
  .no-scrollbar::-webkit-scrollbar {
    display: none;
  }
  .no-scrollbar {
    -ms-overflow-style: none;
    scrollbar-width: none;
  }
</style>
