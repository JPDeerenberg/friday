<script lang="ts">
  /**
   * Give teachers a name you like better. The rename applies everywhere in the app
   * (agenda, home screen, messages, grades, assignments). The list fills itself with
   * the teachers the app has come across; a name can also be added by hand.
   */
  import { onMount } from "svelte";
  import { userSettings } from "$lib/stores";
  import {
    listSeenTeachers,
    registerTeacherNames,
    stripTeacherCode,
    teacherKey,
    withAlias,
  } from "$lib/teachers";
  import Button from "$lib/components/Button.svelte";

  let seen = $state<{ key: string; name: string }[]>([]);
  let query = $state("");
  let newName = $state("");
  let newAlias = $state("");

  onMount(() => {
    seen = listSeenTeachers();
  });

  const aliases = $derived($userSettings.teacherAliases ?? {});

  // Teachers that have a rename but are not in the seen list (added by hand, or seen on another device).
  const rows = $derived.by(() => {
    const byKey = new Map<string, string>(seen.map((t) => [t.key, t.name]));
    for (const key of Object.keys(aliases)) if (!byKey.has(key)) byKey.set(key, key);
    const q = query.trim().toLowerCase();
    return [...byKey.entries()]
      .map(([key, name]) => ({ key, name }))
      .filter(
        (r) =>
          !q || r.name.toLowerCase().includes(q) || (aliases[r.key] ?? "").toLowerCase().includes(q),
      )
      .sort((a, b) => a.name.localeCompare(b.name, "nl", { sensitivity: "base" }));
  });

  function save(name: string, value: string) {
    userSettings.update((s) => ({
      ...s,
      teacherAliases: withAlias(s.teacherAliases ?? {}, name, value),
    }));
  }

  function addManual() {
    const name = stripTeacherCode(newName).trim();
    if (!name || !newAlias.trim()) return;
    registerTeacherNames([name]);
    seen = listSeenTeachers();
    save(name, newAlias);
    newName = "";
    newAlias = "";
  }

  const fieldClass =
    "w-full px-3 py-2 rounded-m3-xs bg-surface-950 border border-surface-700 text-label-large text-gray-100 focus:outline-none focus:border-primary-500";
</script>

<div class="w-full space-y-3">
  <p class="text-label-small text-gray-500 leading-relaxed">
    Tik achter een docent een andere naam in. Die verschijnt dan overal in de
    app. Docenten komen hier vanzelf bij als je je agenda of cijfers opent.
  </p>

  {#if rows.length > 6}
    <input
      type="search"
      bind:value={query}
      placeholder="Zoek een docent"
      aria-label="Zoek een docent"
      class={fieldClass}
    />
  {/if}

  {#if rows.length === 0}
    <p class="text-label-medium text-gray-500">
      {query ? "Geen docent gevonden." : "Nog geen docenten gezien. Open eerst je agenda."}
    </p>
  {:else}
    <ul class="space-y-2">
      {#each rows as row (row.key)}
        <li class="flex items-center gap-2">
          <span class="w-2/5 min-w-0 truncate text-label-medium text-gray-400" title={row.name}>
            {row.name}
          </span>
          <input
            type="text"
            value={aliases[row.key] ?? ""}
            placeholder="Eigen naam"
            maxlength="60"
            aria-label="Eigen naam voor {row.name}"
            onchange={(e) => save(row.name, e.currentTarget.value)}
            class={fieldClass}
          />
          {#if aliases[row.key]}
            <button
              type="button"
              class="shrink-0 px-2 py-1 text-label-large text-gray-500 hover:text-gray-200"
              aria-label="Terug naar {row.name}"
              title="Terug naar de originele naam"
              onclick={() => save(row.name, "")}>✕</button
            >
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  <details class="text-label-medium text-gray-400">
    <summary class="cursor-pointer select-none">Docent zelf toevoegen</summary>
    <div class="mt-2 flex flex-col gap-2 sm:flex-row">
      <input
        type="text"
        bind:value={newName}
        placeholder="Naam zoals in Magister"
        aria-label="Naam zoals in Magister"
        class={fieldClass}
      />
      <input
        type="text"
        bind:value={newAlias}
        placeholder="Eigen naam"
        aria-label="Eigen naam"
        maxlength="60"
        class={fieldClass}
      />
      <Button
        variant="tonal"
        onclick={addManual}
        disabled={!teacherKey(newName) || !newAlias.trim()}>Toevoegen</Button
      >
    </div>
  </details>
</div>
