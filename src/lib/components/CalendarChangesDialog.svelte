<script lang="ts">
  import {
    calendarChangesPopup,
    describeChange,
    groupByDay,
  } from "$lib/calendar-changes";
  import { currentPage } from "$lib/stores";

  const changes = $derived($calendarChangesPopup);
  const groups = $derived(changes ? groupByDay(changes) : []);

  function close() {
    calendarChangesPopup.set(null);
  }

  function openCalendar() {
    currentPage.set("calendar");
    close();
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") close();
  }

  const TONE: Record<string, string> = {
    bad: "text-red-300 bg-red-500/10 border-red-500/20",
    warn: "text-amber-300 bg-amber-500/10 border-amber-500/20",
    good: "text-emerald-300 bg-emerald-500/10 border-emerald-500/20",
  };
</script>

<svelte:window onkeydown={changes ? onKey : undefined} />

{#if changes}
  <div
    class="fixed inset-0 z-[70] flex items-end sm:items-center justify-center"
  >
    <button
      type="button"
      class="absolute inset-0 bg-black/60 backdrop-blur-[2px]"
      aria-label="Sluiten"
      onclick={close}
    ></button>

    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="calendar-changes-title"
      class="relative w-full sm:max-w-md max-h-[85dvh] flex flex-col glass rounded-t-3xl sm:rounded-3xl border border-white/10 shadow-2xl pb-[env(safe-area-inset-bottom)]"
    >
      <div class="px-5 pt-5 pb-3">
        <h2
          id="calendar-changes-title"
          class="text-title-large font-bold text-white"
        >
          {changes.length === 0
            ? "Agenda"
            : changes.length === 1
              ? "1 wijziging in je agenda"
              : `${changes.length} wijzigingen in je agenda`}
        </h2>
        {#if changes.length > 0}
          <p class="text-label-medium text-gray-500 mt-0.5">
            Alles wat is veranderd sinds je voor het laatst keek.
          </p>
        {/if}
      </div>

      <div class="px-5 pb-2 overflow-y-auto space-y-4">
        {#if changes.length === 0}
          <p class="text-body-medium text-gray-400 pb-3">
            Er zijn geen openstaande wijzigingen meer. Lessen die al zijn
            begonnen worden niet meer getoond.
          </p>
        {/if}

        {#each groups as group (group.key)}
          <section>
            <h3
              class="text-label-large font-bold text-gray-400 capitalize mb-2"
            >
              {group.label}
            </h3>
            <ul class="space-y-2">
              {#each group.items as change (change.id)}
                {@const view = describeChange(change)}
                <li
                  class="p-3 rounded-2xl bg-surface-800/60 border border-white/5"
                >
                  <div class="flex items-start justify-between gap-2">
                    <p
                      class="text-title-small font-semibold text-gray-100 min-w-0 break-words"
                    >
                      {change.title}
                    </p>
                    <div class="flex flex-wrap justify-end gap-1 shrink-0">
                      {#each view.labels as label, i}
                        <span
                          class="text-[10px] font-bold px-1.5 py-0.5 rounded-md border {i ===
                          0
                            ? TONE[view.tone]
                            : 'text-gray-300 bg-surface-700 border-white/5'}"
                          >{label}</span
                        >
                      {/each}
                    </div>
                  </div>
                  {#each view.details as line}
                    <p class="text-body-small text-gray-400 mt-1">{line}</p>
                  {/each}
                </li>
              {/each}
            </ul>
          </section>
        {/each}
      </div>

      <div class="flex gap-2 justify-end px-5 py-4 border-t border-white/5">
        <button
          type="button"
          class="px-4 py-2 rounded-full text-label-large font-bold text-gray-300 hover:bg-white/5"
          onclick={close}>Sluiten</button
        >
        <button
          type="button"
          class="px-5 py-2 rounded-full text-label-large font-bold bg-primary-500 text-white hover:bg-primary-400"
          onclick={openCalendar}>Open agenda</button
        >
      </div>
    </div>
  </div>
{/if}
