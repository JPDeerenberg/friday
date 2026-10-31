<script lang="ts">
  import {
    userSettings,
    letterScan,
    personId,
    recordLetterScan,
  } from "$lib/stores";
  import { getSchoolyears, getGrades, formatDate } from "$lib/api";
  import {
    buildLetterTable,
    sanitizeRules,
    applyPreset,
    LETTER_PRESETS,
    normalizeToken,
    type LetterRule,
    type LetterStatus,
  } from "$lib/grades/scale";
  import Button from "$lib/components/Button.svelte";

  // Rows = the saved table plus what the app found in your grades. Saved rows
  // win; found letters without a row show as suggestions until you edit them.
  const rows = $derived(
    buildLetterTable($userSettings.letterGradeRules ?? [], $letterScan),
  );

  let scanning = $state(false);
  let scanMessage = $state<string | null>(null);

  function save(next: LetterRule[]) {
    userSettings.update((s) => ({
      ...s,
      letterGradeRules: sanitizeRules(next),
    }));
  }

  function currentRules(): LetterRule[] {
    return rows.map(({ token, status, value }) => ({ token, status, value }));
  }

  function patchRow(index: number, patch: Partial<LetterRule>) {
    const next = currentRules();
    next[index] = { ...next[index], ...patch };
    save(next);
  }

  function removeRow(index: number) {
    const next = currentRules();
    next.splice(index, 1);
    // A removed suggestion would just reappear; keep the user's choice as an
    // explicit neutral row instead of silently re-suggesting it.
    const removed = rows[index];
    if (!removed.saved && removed.count > 0) {
      next.push({ token: removed.token, status: "neutral", value: null });
    }
    save(next);
  }

  let newToken = $state("");
  function addRow() {
    const token = newToken.trim();
    if (!token) return;
    if (rows.some((r) => normalizeToken(r.token) === normalizeToken(token))) {
      newToken = "";
      return;
    }
    save([...currentRules(), { token, status: "neutral", value: null }]);
    newToken = "";
  }

  function parseValue(raw: string): number | null {
    const t = raw.trim().replace(",", ".");
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }

  async function scan() {
    const pid = $personId;
    if (pid === null) return;
    scanning = true;
    scanMessage = null;
    try {
      const years = await getSchoolyears(
        pid,
        "2013-01-01",
        formatDate(new Date()),
      );
      if (years.length === 0) {
        scanMessage = "Geen schooljaren gevonden.";
        return;
      }
      const now = new Date();
      const year =
        years.find(
          (y) => y.begin && y.einde && new Date(y.begin) <= now && new Date(y.einde) >= now,
        ) ?? years[years.length - 1];
      if (year.id == null || !year.einde) {
        scanMessage = "Schooljaar onvolledig.";
        return;
      }
      const grades = await getGrades(pid, year.id, year.einde.split("T")[0]);
      recordLetterScan(grades);
      scanMessage = "Klaar. Gevonden letters staan in de tabel.";
    } catch (e: any) {
      scanMessage = "Zoeken mislukt: " + (e?.message ?? String(e));
    } finally {
      scanning = false;
    }
  }

  const statusOptions: { value: LetterStatus; label: string }[] = [
    { value: "neutral", label: "Neutraal" },
    { value: "pass", label: "Voldoende" },
    { value: "fail", label: "Onvoldoende" },
  ];

  const fieldClass =
    "px-3 py-2 rounded-m3-xs bg-surface-950 border border-surface-700 text-label-large text-gray-100 focus:outline-none focus:border-primary-500";
</script>

<div class="w-full space-y-3">
  <div class="flex flex-wrap items-center gap-2">
    <Button variant="tonal" onclick={scan} disabled={scanning}>
      {scanning ? "Zoeken..." : "Zoek in mijn cijfers"}
    </Button>
    {#each LETTER_PRESETS as preset}
      <button
        type="button"
        class="px-3 py-1.5 rounded-full border border-surface-700 text-label-medium text-gray-300 hover:bg-surface-800 transition-colors"
        title="Voegt ontbrekende rijen toe als startpunt. Pas ze aan naar je school."
        onclick={() => save(applyPreset(currentRules(), preset))}
      >
        + {preset.label}
      </button>
    {/each}
  </div>
  {#if scanMessage}
    <p class="text-label-small text-gray-500">{scanMessage}</p>
  {/if}

  {#if rows.length === 0}
    <p class="text-label-medium text-gray-500 leading-relaxed">
      Nog geen letters gevonden. Open de Cijfers-pagina of tik op
      "Zoek in mijn cijfers", of voeg zelf een letter toe.
    </p>
  {:else}
    <div class="space-y-2">
      <div
        class="hidden sm:grid grid-cols-[1fr_9rem_5rem_2.5rem] gap-2 px-1 text-label-small text-gray-500"
      >
        <span>Letter</span><span>Telt als</span><span>Cijfer</span><span></span>
      </div>
      {#each rows as row, i (row.token)}
        <div
          class="grid grid-cols-[1fr_auto] sm:grid-cols-[1fr_9rem_5rem_2.5rem] gap-2 items-center p-2 rounded-m3-sm bg-surface-900/60 border border-white/5"
        >
          <div class="flex items-center gap-2 min-w-0">
            <input
              class="{fieldClass} w-20 font-bold"
              value={row.token}
              aria-label="Letter"
              onchange={(e) => patchRow(i, { token: e.currentTarget.value })}
            />
            {#if row.count > 0}
              <span class="text-label-small text-gray-500 whitespace-nowrap"
                >{row.count}×</span
              >
            {/if}
            {#if !row.saved}
              <span
                class="text-[10px] px-1.5 py-0.5 rounded-full bg-primary-500/15 text-primary-400 whitespace-nowrap"
                title="Automatisch gevonden. Pas aan om vast te leggen."
                >voorgesteld</span
              >
            {/if}
          </div>
          <button
            type="button"
            class="sm:order-last w-9 h-9 rounded-full text-gray-500 hover:text-red-400 hover:bg-surface-800 transition-colors justify-self-end"
            aria-label="Verwijder {row.token}"
            onclick={() => removeRow(i)}>✕</button
          >
          <select
            class="{fieldClass} sm:col-auto"
            value={row.status}
            aria-label="Telt als"
            onchange={(e) =>
              patchRow(i, { status: e.currentTarget.value as LetterStatus })}
          >
            {#each statusOptions as o}
              <option value={o.value}>{o.label}</option>
            {/each}
          </select>
          <input
            class="{fieldClass} w-full"
            inputmode="decimal"
            placeholder="–"
            value={row.value ?? ""}
            aria-label="Cijfer (optioneel)"
            onchange={(e) =>
              patchRow(i, { value: parseValue(e.currentTarget.value) })}
          />
        </div>
      {/each}
    </div>
  {/if}

  <div class="flex items-center gap-2">
    <input
      class="{fieldClass} w-28"
      placeholder="Nieuwe letter"
      bind:value={newToken}
      onkeydown={(e) => e.key === "Enter" && addRow()}
    />
    <Button variant="tonal" onclick={addRow} disabled={!newToken.trim()}
      >Toevoegen</Button
    >
  </div>

  <p class="text-label-small text-gray-500 leading-relaxed">
    Letters tellen alleen mee in een gemiddelde als Magister er een gewicht
    boven 0 aan geeft. "Cijfer" is optioneel: met een cijfer verschijnt de
    letter als schatting (≈) in grafieken en statistieken.
  </p>
</div>
