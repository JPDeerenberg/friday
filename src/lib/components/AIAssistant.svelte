<script lang="ts">
  import {
    aiChat,
    aiChatWithTools,
    confirmPendingAction,
    getAiConfig,
    type AiConfig,
    type AiMessage,
    type PendingActionInfo,
  } from "$lib/ai";
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

  // Generate a simple page context string from the current page
  function getPageContext(): string {
    const page = $currentPage;
    const name = $accountInfo?.Persoon?.Roepnaam ?? "Gebruiker";
    const pageNames: Record<string, string> = {
      dashboard: "Dashboard - het hoofdoverzicht met vandaag lessen, cijfers en opdrachten",
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
      studiewijzers: "Studiewijzers - studiehandleidingen en planningen per vak",
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
  async function ensureMarkdownRendered(idx: number, content: string) {
    if (messages[idx]?.role !== "assistant") {
      renderedHtml[idx] = null;
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
    const nearBottom =
      el.scrollTop + el.clientHeight >= el.scrollHeight - 80;
    if (nearBottom) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
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
    }
    if (isOpen && firstOpen && messages.length === 0) {
      firstOpen = false;
      const greeting = "👋 Hoi! Ik ben Friday AI, jouw persoonlijke schoolassistent. Stel me vragen over je cijfers, opdrachten, planning of vraag om uitleg!";
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
  }

  async function sendMessage() {
    const text = inputText.trim();
    if (!text || isLoading) return;

    inputText = "";
    messages = [...messages, { role: "user", content: text }];
    isLoading = true;

    try {
      const context = getPageContext();
      const messagePayload = messages.map((m) => ({ role: m.role, content: m.content }));

      // Use aiChatWithTools when data access is enabled AND we have a personId
      const canUseTools = useDataAccess && currentPersonId !== null;
      if (canUseTools) {
        const result = await aiChatWithTools(messagePayload, context, currentPersonId!);
        messages = [...messages, { role: "assistant", content: result.content }];
        if (result.pending_actions.length > 0) {
          pendingActions = [...pendingActions, ...result.pending_actions];
        }
      } else {
        const response = await aiChat(messagePayload, context);
        messages = [...messages, { role: "assistant", content: response }];
      }
    } catch (e) {
      console.error("[AIAssistant] sendMessage failed:", e);
      let errorMsg = String(e);
      if (errorMsg.includes("niet geconfigureerd")) {
        errorMsg =
          "⚠️ AI is nog niet ingesteld. Ga naar Instellingen > AI om je API-sleutel in te voeren.";
        isConfigured = false;
      } else {
        errorMsg = "⚠️ " + errorMsg;
      }
      messages = [...messages, { role: "assistant", content: errorMsg }];
    } finally {
      isLoading = false;
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  function clearChat() {
    messages = [];
    renderedHtml = [];
    inputText = "";
    pendingActions = [];
  }

  // Quick actions
  const quickActions = [
    { label: "Dagoverzicht", icon: "📋", query: "Geef een kort dagoverzicht van wat ik vandaag heb op basis van mijn rooster." },
    { label: "Studietips", icon: "💡", query: "Geef me algemene studietips voor vandaag." },
    { label: "Prioriteiten", icon: "🎯", query: "Wat zijn mijn belangrijkste prioriteiten voor vandaag op basis van deadlines?" },
  ];

  async function quickAction(query: string) {
    messages = [...messages, { role: "user", content: query }];
    isLoading = true;

    try {
      const context = getPageContext();
      const messagePayload = [
        { role: "system" as const, content: "Je bent Friday AI. Reageer kort en behulpzaam." },
        { role: "user" as const, content: query },
      ];

      const canUseTools = useDataAccess && currentPersonId !== null;
      if (canUseTools) {
        const result = await aiChatWithTools(messagePayload, context, currentPersonId!);
        messages = [...messages, { role: "assistant", content: result.content }];
        if (result.pending_actions.length > 0) {
          pendingActions = [...pendingActions, ...result.pending_actions];
        }
      } else {
        const response = await aiChat(messagePayload, context);
        messages = [...messages, { role: "assistant", content: response }];
      }
    } catch (e) {
      console.error("[AIAssistant] quickAction failed:", e);
      messages = [...messages, { role: "assistant", content: "⚠️ " + String(e) }];
    } finally {
      isLoading = false;
    }
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
      messages = [...messages, { role: "assistant", content: "⚠️ " + String(e) }];
    } finally {
      pendingActions = pendingActions.filter((a) => a.action_id !== action.action_id);
      confirmingActionId = null;
    }
  }

  function dismissAction(action: PendingActionInfo) {
    if (confirmingActionId !== null) return;
    pendingActions = pendingActions.filter((a) => a.action_id !== action.action_id);
    messages = [
      ...messages,
      { role: "assistant", content: "❌ Actie geannuleerd — er is niets verzonden." },
    ];
  }

  function formatRecipients(recipients?: PendingActionInfo["recipients"]): string {
    if (!recipients || recipients.length === 0) return "—";
    return recipients.map((r) => `#${r.id}${r.type ? ` (${r.type})` : ""}`).join(", ");
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
      <svg class="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
    {:else}
      <svg class="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 2a4 4 0 0 1 4 4c0 2-2 3-4 5-2-2-4-3-4-5a4 4 0 0 1 4-4z"/>
        <path d="M12 14l-2 6h4l-2-6z"/>
        <path d="M2 12h4"/>
        <path d="M18 12h4"/>
        <path d="M12 2v2"/>
        <path d="M12 14v2"/>
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
    <div class="shrink-0 px-5 py-4 border-b border-white/10 flex items-center justify-between bg-surface-900/80">
      <div class="flex items-center gap-3">
        <div class="w-8 h-8 rounded-xl bg-gradient-to-br from-primary-500 to-accent-500 flex items-center justify-center">
          <svg class="w-4 h-4 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2a4 4 0 0 1 4 4c0 2-2 3-4 5-2-2-4-3-4-5a4 4 0 0 1 4-4z"/><path d="M12 14l-2 6h4l-2-6z"/></svg>
        </div>
        <div>
          <h3 class="text-sm font-black text-white uppercase tracking-tight">Friday AI</h3>
            <p class="text-[9px] font-bold text-emerald-400 uppercase tracking-widest flex items-center gap-1">
             <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
             Online
          </p>
        </div>
      </div>
      <div class="flex items-center gap-1">
        <button onclick={clearChat} class="p-2 rounded-xl text-gray-500 hover:text-gray-300 hover:bg-surface-800 transition-all text-[10px] font-bold uppercase tracking-wider" title="Wis gesprek">
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
        </button>
        <button onclick={() => isOpen = false} aria-label="Sluit assistent" class="p-2 rounded-xl text-gray-500 hover:text-gray-300 hover:bg-surface-800 transition-all">
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
      </div>
    </div>

    <!-- Messages -->
    <div class="flex-1 overflow-y-auto px-5 py-4 space-y-4 no-scrollbar scroll-smooth" bind:this={messagesContainer}>
      {#each messages as msg, i (i)}
        <div
          class="flex {msg.role === 'user' ? 'justify-end' : 'justify-start'}"
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
            {:else}
              <MarkdownRenderer content={msg.content} html={renderedHtml[i] ?? null} />
            {/if}
          </div>
        </div>
      {/each}

      {#each pendingActions as action (action.action_id)}
        <div class="flex justify-start" in:fly={{ y: 10, duration: 200 }}>
          <div
            class="max-w-[92%] w-full rounded-2xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-gray-200"
          >
            <p class="text-[11px] font-black uppercase tracking-widest text-amber-400 mb-1">
              ⚠️ Bevestiging vereist
            </p>
            <p class="text-[12px] text-gray-300 mb-2">
              De AI wil namens jou {actionLabel(action.action_type)}. Er is nog niets uitgevoerd.
            </p>
            {#if action.action_type === "send_message"}
              <div class="space-y-1 text-[13px]">
                <p class="break-words">
                  <span class="font-bold text-white">Naar:</span> {formatRecipients(action.recipients)}
                </p>
                <p class="break-words">
                  <span class="font-bold text-white">Onderwerp:</span> {action.subject ?? "—"}
                </p>
                <p class="break-words whitespace-pre-wrap">
                  <span class="font-bold text-white">Inhoud:</span> {action.body ?? "—"}
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
                  <span class="font-bold text-white">Afspraak:</span> {action.omschrijving ?? "—"}
                </p>
                <p class="break-words">
                  <span class="font-bold text-white">Start:</span> {action.start ?? "—"}
                </p>
                <p class="break-words">
                  <span class="font-bold text-white">Einde:</span> {action.einde ?? "—"}
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
          <div class="bg-surface-800/60 border border-white/5 rounded-2xl rounded-tl-md px-5 py-4">
            <div class="flex items-center gap-2">
              <div class="w-2 h-2 rounded-full bg-primary-400 animate-bounce" style="animation-delay: 0ms"></div>
              <div class="w-2 h-2 rounded-full bg-primary-400 animate-bounce" style="animation-delay: 150ms"></div>
              <div class="w-2 h-2 rounded-full bg-primary-400 animate-bounce" style="animation-delay: 300ms"></div>
            </div>
          </div>
        </div>
      {/if}

      {#if messages.length === 0 && !isLoading}
        <div class="flex-1 flex flex-col items-center justify-center text-center py-8">
          <svg class="w-12 h-12 text-primary-500/30 mb-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M12 2a4 4 0 0 1 4 4c0 2-2 3-4 5-2-2-4-3-4-5a4 4 0 0 1 4-4z"/>
            <path d="M12 14l-2 6h4l-2-6z"/>
            <path d="M2 12h4"/>
            <path d="M18 12h4"/>
            <path d="M12 2v2"/>
            <path d="M12 14v2"/>
          </svg>
          <p class="text-gray-500 text-sm font-medium">Stel een vraag over je schoolzaken</p>
        </div>
      {/if}
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
      <div class="flex items-center gap-2">
        <input
          type="text"
          bind:value={inputText}
          onkeydown={handleKeydown}
          placeholder="Stel een vraag..."
          disabled={isLoading}
          class="flex-1 bg-surface-800/80 border border-white/10 rounded-2xl px-4 py-3 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-primary-500/50 transition-all disabled:opacity-50"
        />
        <button
          onclick={sendMessage}
          disabled={!inputText.trim() || isLoading}
          aria-label="Verstuur bericht"
          class="shrink-0 w-11 h-11 rounded-2xl bg-primary-500 text-white hover:bg-primary-400 transition-all flex items-center justify-center disabled:opacity-30 disabled:cursor-not-allowed active:scale-90"
        >
          <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-11 20-4-7-7-4 20-11z"/></svg>
        </button>
      </div>
    </div>
    </div>
  {/if}
{/if}

<style>
  .no-scrollbar::-webkit-scrollbar { display: none; }
  .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
</style>
