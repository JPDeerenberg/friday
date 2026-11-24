<script lang="ts">
  /**
   * The "Kaarten" tab: level + XP, showcase, a binder with one page per subject
   * (face-down tiles for grades that are still hidden), and achievements.
   * Opened-state, XP and pins come from the persisted collection state.
   */
  import { fade, fly } from "svelte/transition";
  import GradeCardView from "#lib/components/GradeCardView.svelte";
  import Icon from "#lib/components/Icon.svelte";
  import {
    ACHIEVEMENTS,
    RARITIES,
    RARITY_META,
    STAMP_META,
    achievementProgress,
    careerInfo,
    countCompleteSets,
    levelInfo,
    seasonLabel,
    seasonOf,
    seasonXp,
    seasonsOf,
    type CardData,
    type Rarity,
    type Stamp,
  } from "#lib/cards.ts";
  import {
    DEFAULT_FILTERS,
    activeFilterCount,
    filterAndSort,
    subjectsOf,
    type CatalogFilters,
    type CatalogSort,
    type CatalogStatus,
  } from "#lib/card-catalog.ts";
  import { gradeRevealState, toggleShowcase } from "#lib/grade-reveal.ts";
  import { quests, seedCardXpOnce } from "#lib/quests-store.ts";

  let {
    cards,
    calm = false,
    lite = false,
    hiddenCount,
    onopen,
    onpack,
  }: {
    cards: CardData[];
    calm?: boolean;
    lite?: boolean;
    /** Grades that are still hidden (for the "Open pakket" button). */
    hiddenCount: number;
    /** Open specific cards (tap on a face-down tile). */
    onopen: (ids: number[]) => void;
    onpack: () => void;
  } = $props();

  const openedSet = $derived(new Set($gradeRevealState.opened));
  const tally = $derived($gradeRevealState.tally);
  // Levels are per school year ("seizoen"), so a student with one more year of
  // history is not unreachably far ahead. All-time XP lives on as the career rank.
  const seasons = $derived(seasonsOf(cards));
  let season = $state<string | null>(null);
  const activeSeason = $derived(
    season && seasons.includes(season) ? season : seasons[0],
  );
  const seasonPoints = $derived(seasonXp(cards, openedSet, activeSeason));
  const currentSeason = seasonOf(null);
  const gradeXp = $derived(seasonXp(cards, openedSet, currentSeason));
  /** Opened within the album currently shown (one school year), not all time. */
  const openedCount = $derived(cards.filter((c) => openedSet.has(c.id)).length);
  // The current season shows the shared wallet (missions + cards + Blackjack);
  // older season tabs stay grade-only.
  const li = $derived(
    levelInfo(activeSeason === currentSeason ? $quests.xp : seasonPoints),
  );
  const career = $derived(careerInfo(tally.xp));
  const completeSets = $derived(countCompleteSets(cards, openedSet));

  $effect(() => {
    if (cards.length > 0) seedCardXpOnce(gradeXp);
  });

  const bySubject = $derived.by(() => {
    const map = new Map<string, CardData[]>();
    for (const c of cards) {
      if (!map.has(c.subject)) map.set(c.subject, []);
      map.get(c.subject)!.push(c);
    }
    for (const list of map.values()) {
      list.sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  });

  let selected = $state<string | null>(null);
  const activeName = $derived(
    selected && bySubject.some(([n]) => n === selected)
      ? selected
      : (bySubject[0]?.[0] ?? null),
  );
  const activeCards = $derived(
    bySubject.find(([n]) => n === activeName)?.[1] ?? [],
  );
  const activeOpened = $derived(
    activeCards.filter((c) => openedSet.has(c.id)).length,
  );
  const activeComplete = $derived(
    activeCards.length >= 3 && activeOpened === activeCards.length,
  );

  const showcaseCards = $derived(
    $gradeRevealState.showcase
      .map((id) => cards.find((c) => c.id === id))
      .filter((c): c is CardData => !!c),
  );

  const achievementRows = $derived(
    ACHIEVEMENTS.map((a) => ({
      a,
      p: achievementProgress(a, tally, { completeSets }),
      at: $gradeRevealState.unlocked[a.id] ?? null,
    })).sort(
      (x, y) => Number(y.p.done) - Number(x.p.done) || y.p.pct - x.p.pct,
    ),
  );
  const unlockedCount = $derived(
    achievementRows.filter((r) => r.p.done).length,
  );

  let gridW = $state(340);
  const tileScale = $derived(
    Math.max(4.6, Math.min(8.2, (gridW - 24) / 3 / 16)),
  );

  let detail = $state<CardData | null>(null);

  // "Alle kaarten": the complete list with filters.
  let view = $state<"vak" | "alle">("vak");
  let filters = $state<CatalogFilters>({ ...DEFAULT_FILTERS });
  const filterCount = $derived(activeFilterCount(filters));
  const catalog = $derived(filterAndSort(cards, openedSet, filters));
  const subjectNames = $derived(subjectsOf(cards));
  const SORTS: { id: CatalogSort; label: string }[] = [
    { id: "newest", label: "Nieuwste" },
    { id: "oldest", label: "Oudste" },
    { id: "rarity", label: "Zeldzaamheid" },
    { id: "value", label: "Hoogste cijfer" },
    { id: "subject", label: "Vak A–Z" },
  ];
  const STATUSES: { id: CatalogStatus; label: string }[] = [
    { id: "all", label: "Alles" },
    { id: "opened", label: "Geopend" },
    { id: "hidden", label: "Verborgen" },
  ];
  function toggleRarity(r: Rarity) {
    filters.rarities = filters.rarities.includes(r)
      ? filters.rarities.filter((x) => x !== r)
      : [...filters.rarities, r];
  }
  function resetFilters() {
    filters = { ...DEFAULT_FILTERS, sort: filters.sort };
  }

  /** Page-turn transition between subjects. */
  function pageFlip(
    _node: Element,
    { duration = 520 }: { duration?: number } = {},
  ) {
    return {
      duration,
      css: (t: number) =>
        `transform: perspective(1200px) rotateY(${(1 - t) * -75}deg); transform-origin: left center; opacity: ${Math.min(1, t * 1.6)};`,
    };
  }

  function tileTap(c: CardData) {
    if (openedSet.has(c.id)) detail = c;
    else onopen([c.id]);
  }
</script>

<div class="space-y-6 keep-dark">
  <!-- ======= level + stats ======= -->
  <section class="hero glass-ish rounded-3xl p-5 space-y-4">
    <div class="flex items-center justify-between gap-3">
      <div class="min-w-0">
        <p class="text-label-medium text-gray-400">
          Level {li.level} · seizoen {seasonLabel(activeSeason)}
        </p>
        <h2 class="text-headline-small text-white truncate">{li.title}</h2>
      </div>
      <div class="lvlbadge" aria-hidden="true">{li.level}</div>
    </div>
    <div>
      <div class="xpbar"><i style="width:{li.pct * 100}%"></i></div>
      <div
        class="mt-1 flex justify-between text-label-small text-gray-500 tabular-nums"
      >
        <span>{li.into} / {li.need} XP</span>
        <span title="Alleen XP uit cijferkaarten, zonder missies en Blackjack"
          >Cijfer-XP: {seasonPoints}</span
        >
      </div>
      <p class="mt-1 text-label-small text-gray-500">
        Je level telt cijfers, missies en Blackjack mee; cijfer-XP is alleen wat
        je met kaarten verdient. Elk schooljaar begin je opnieuw.
      </p>
    </div>
    {#if seasons.length > 1}
      <div class="seasons no-scrollbar" role="tablist" aria-label="Seizoen">
        {#each seasons as sn}
          <button
            type="button"
            role="tab"
            aria-selected={sn === activeSeason}
            class="tab"
            class:on={sn === activeSeason}
            onclick={() => (season = sn)}>{seasonLabel(sn)}</button
          >
        {/each}
      </div>
    {/if}
    <div class="career" title="Alle XP van alle schooljaren samen">
      <span
        class="text-label-medium text-gray-300 inline-flex items-center gap-1.5"
      >
        <Icon name="trophy" size={14} class="text-amber-300" /> Carrière:
        <b class="text-white">{career.rank}</b>
      </span>
      <span class="text-label-small text-gray-500 tabular-nums">
        {career.xp} XP{career.nextAt !== null
          ? ` · nog ${career.nextAt - career.xp} tot de volgende rang`
          : ""}
      </span>
    </div>
    <div class="flex flex-wrap gap-2">
      <span class="chip"
        ><Icon name="cards" size={13} />
        {openedCount} / {cards.length} geopend</span
      >
      {#if tally.bestStreak > 1}<span class="chip"
          ><Icon name="trend-up" size={13} /> beste reeks {tally.bestStreak}</span
        >{/if}
      {#if tally.shiny > 0}<span class="chip"
          ><Icon name="sparkles" size={13} /> {tally.shiny} shiny</span
        >{/if}
      {#each RARITIES as r}
        {#if tally.byRarity[r] > 0}
          <span class="chip" style="--c:{RARITY_META[r].color}">
            <i class="dot"></i>{RARITY_META[r].label}
            {tally.byRarity[r]}
          </span>
        {/if}
      {/each}
    </div>
    {#if hiddenCount > 0}
      <button type="button" class="packbtn" onclick={onpack}>
        <span class="packicon"><Icon name="gift" size={26} /></span>
        <span class="flex-1 text-left">
          <b class="block">Open pakket</b>
          <small class="block opacity-80"
            >{hiddenCount} verborgen {hiddenCount === 1 ? "kaart" : "kaarten"} · de
            nieuwste eerst</small
          >
        </span>
      </button>
    {/if}
  </section>

  <!-- ======= showcase ======= -->
  <section class="space-y-2">
    <h3 class="text-label-large text-gray-400 px-1">Vitrine</h3>
    <div class="flex gap-3 justify-center">
      {#each [0, 1, 2] as slot}
        {@const c = showcaseCards[slot]}
        {#if c}
          <button
            type="button"
            class="slot"
            onclick={() => (detail = c)}
            aria-label="{c.subject} {c.value}"
          >
            <GradeCardView card={c} scale={6.2} calm={calm || true} {lite} />
          </button>
        {:else}
          <div class="slot empty" aria-hidden="true">
            <span>＋</span><small>Pin een kaart</small>
          </div>
        {/if}
      {/each}
    </div>
  </section>

  <!-- ======= binder ======= -->
  <section class="space-y-3">
    <div class="flex items-center justify-between gap-3 px-1">
      <h3 class="text-label-large text-gray-400">Verzameling</h3>
      {#if cards.length > 0}
        <div class="seg" role="tablist" aria-label="Weergave">
          <button
            type="button"
            role="tab"
            aria-selected={view === "vak"}
            class:on={view === "vak"}
            onclick={() => (view = "vak")}>Per vak</button
          >
          <button
            type="button"
            role="tab"
            aria-selected={view === "alle"}
            class:on={view === "alle"}
            onclick={() => (view = "alle")}>Alle kaarten</button
          >
        </div>
      {/if}
    </div>
    {#if bySubject.length === 0}
      <p class="text-body-medium text-gray-500 px-1">Nog geen kaarten.</p>
    {:else if view === "alle"}
      <div class="filters">
        <div class="frow no-scrollbar">
          {#each RARITIES as r}
            <button
              type="button"
              class="fchip"
              class:on={filters.rarities.includes(r)}
              style="--c:{RARITY_META[r].color}"
              aria-pressed={filters.rarities.includes(r)}
              onclick={() => toggleRarity(r)}
              ><i class="dot"></i>{RARITY_META[r].label}</button
            >
          {/each}
          <button
            type="button"
            class="fchip"
            class:on={filters.shinyOnly}
            aria-pressed={filters.shinyOnly}
            onclick={() => (filters.shinyOnly = !filters.shinyOnly)}
            ><Icon name="sparkles" size={13} /> Shiny</button
          >
        </div>
        <div class="frow no-scrollbar">
          {#each STATUSES as st}
            <button
              type="button"
              class="fchip"
              class:on={filters.status === st.id}
              aria-pressed={filters.status === st.id}
              onclick={() => (filters.status = st.id)}>{st.label}</button
            >
          {/each}
        </div>
        <div class="selects">
          <select bind:value={filters.subject} aria-label="Vak">
            <option value={null}>Alle vakken</option>
            {#each subjectNames as sn}<option value={sn}>{sn}</option>{/each}
          </select>
          {#if seasons.length > 1}
            <select bind:value={filters.season} aria-label="Schooljaar">
              <option value={null}>Alle schooljaren</option>
              {#each seasons as sn}<option value={sn}>{seasonLabel(sn)}</option
                >{/each}
            </select>
          {/if}
          <select bind:value={filters.stamp} aria-label="Stempel">
            <option value={null}>Alle stempels</option>
            {#each Object.entries(STAMP_META) as [id, meta]}
              <option value={id as Stamp}>{meta.label}</option>
            {/each}
          </select>
          <select bind:value={filters.sort} aria-label="Sorteren">
            {#each SORTS as so}<option value={so.id}>{so.label}</option>{/each}
          </select>
        </div>
        <div class="fcount">
          <span class="tabular-nums"
            >{catalog.length} van {cards.length} kaarten</span
          >
          {#if filterCount > 0}
            <button type="button" class="reset" onclick={resetFilters}
              >Wis filters ({filterCount})</button
            >
          {/if}
        </div>
        {#if filters.rarities.length > 0 || filters.shinyOnly || filters.stamp}
          <p class="text-label-small text-gray-500">
            Verborgen kaarten tonen we hier niet: open ze eerst.
          </p>
        {/if}
      </div>
      {#if catalog.length === 0}
        <p class="text-body-medium text-gray-500 px-1">
          Geen kaarten met deze filters.
        </p>
      {:else}
        <div class="grid" bind:clientWidth={gridW}>
          {#each catalog as c (c.id)}
            {@const isOpen = openedSet.has(c.id)}
            <button
              type="button"
              class="tile"
              onclick={() => tileTap(c)}
              aria-label={isOpen
                ? `${c.subject} ${c.value}`
                : `Verborgen cijfer ${c.subject}, tik om te openen`}
            >
              <GradeCardView
                card={c}
                scale={tileScale}
                faceDown={!isOpen}
                calm={calm || true}
                {lite}
                animateFlip={false}
              />
              {#if !isOpen}<span class="tap">Tik</span>{/if}
            </button>
          {/each}
        </div>
      {/if}
    {:else}
      <div class="tabs no-scrollbar" role="tablist">
        {#each bySubject as [name, list]}
          {@const done = list.filter((c) => openedSet.has(c.id)).length}
          <button
            type="button"
            role="tab"
            aria-selected={name === activeName}
            class="tab"
            class:on={name === activeName}
            class:complete={list.length >= 3 && done === list.length}
            onclick={() => (selected = name)}
          >
            {name}
            <small>{done}/{list.length}</small>
          </button>
        {/each}
      </div>

      {#key activeName}
        <div class="page" in:pageFlip>
          <div class="pagehead">
            <h4>{activeName}</h4>
            <span class="count">{activeOpened} / {activeCards.length}</span>
            {#if activeComplete}<span class="setbadge">Set compleet ✓</span
              >{/if}
          </div>
          <div class="grid" bind:clientWidth={gridW}>
            {#each activeCards as c (c.id)}
              {@const isOpen = openedSet.has(c.id)}
              <button
                type="button"
                class="tile"
                onclick={() => tileTap(c)}
                aria-label={isOpen
                  ? `${c.subject} ${c.value}`
                  : `Verborgen cijfer ${c.subject}, tik om te openen`}
              >
                <GradeCardView
                  card={c}
                  scale={tileScale}
                  faceDown={!isOpen}
                  calm={calm || true}
                  {lite}
                  animateFlip={false}
                />
                {#if !isOpen}<span class="tap">Tik</span>{/if}
              </button>
            {/each}
          </div>
        </div>
      {/key}
    {/if}
  </section>

  <!-- ======= achievements ======= -->
  <section class="space-y-3">
    <h3 class="text-label-large text-gray-400 px-1">
      Prestaties · {unlockedCount} / {ACHIEVEMENTS.length}
    </h3>
    <div class="achgrid">
      {#each achievementRows as { a, p, at } (a.id)}
        <div class="ach" class:done={p.done}>
          <span class="icon"><Icon name={a.icon} size={22} /></span>
          <div class="min-w-0 flex-1">
            <b class="block truncate">{a.title}</b>
            <small class="block text-gray-400">{a.desc}</small>
            {#if p.done}
              <small class="block text-amber-300/80">
                {at
                  ? new Date(at).toLocaleDateString("nl-NL", {
                      day: "numeric",
                      month: "short",
                    })
                  : "Behaald"}
              </small>
            {:else}
              <div class="mini"><i style="width:{p.pct * 100}%"></i></div>
              <small class="text-gray-500 tabular-nums"
                >{p.value} / {a.target}</small
              >
            {/if}
          </div>
        </div>
      {/each}
    </div>
  </section>
</div>

{#if detail}
  {@const d = detail}
  <div
    class="detail"
    role="dialog"
    aria-modal="true"
    aria-label="Kaart {d.subject} {d.value}"
    transition:fade={{ duration: 200 }}
  >
    <button
      type="button"
      class="backdrop"
      onclick={() => (detail = null)}
      aria-label="Sluiten"
    ></button>
    <div class="sheet" in:fly={{ y: 40, duration: 320 }}>
      <GradeCardView
        card={d}
        scale={Math.min(
          14,
          Math.max(
            9,
            (typeof window !== "undefined" ? window.innerHeight : 700) / 52,
          ),
        )}
        tiltOn
        {calm}
        {lite}
      />
      <div class="info">
        <span
          style="color:{RARITY_META[d.rarity].color}"
          class="font-black tracking-widest uppercase text-label-large"
        >
          {RARITY_META[d.rarity].label}{d.shiny ? " · shiny" : ""}
        </span>
        <span class="text-gray-400 text-label-medium">+{d.xp} XP</span>
      </div>
      {#if d.stamps.length}
        <div class="stamps">
          {#each d.stamps as st}<span
              ><Icon name={STAMP_META[st].icon} size={12} />
              {STAMP_META[st].label}</span
            >{/each}
        </div>
      {/if}
      <div class="actions">
        <button type="button" class="btn" onclick={() => toggleShowcase(d.id)}>
          {$gradeRevealState.showcase.includes(d.id)
            ? "Uit vitrine halen"
            : "Pin in vitrine"}
        </button>
        <button type="button" class="btn ghost" onclick={() => (detail = null)}
          >Sluiten</button
        >
      </div>
    </div>
  </div>
{/if}

<style>
  .glass-ish {
    background: linear-gradient(
      140deg,
      color-mix(
        in srgb,
        var(--color-primary-500) 14%,
        var(--color-surface-900)
      ),
      var(--color-surface-900)
    );
    border: 1px solid rgba(255, 255, 255, 0.07);
  }
  .lvlbadge {
    flex-shrink: 0;
    display: grid;
    place-items: center;
    width: 3.2rem;
    height: 3.2rem;
    border-radius: 1rem;
    font-size: 1.5rem;
    font-weight: 900;
    color: #1b1033;
    background: linear-gradient(135deg, #fde68a, #f0abfc);
    box-shadow: 0 6px 22px -6px rgba(240, 171, 252, 0.7);
  }
  .xpbar {
    height: 10px;
    border-radius: 99px;
    background: rgba(255, 255, 255, 0.09);
    overflow: hidden;
  }
  .xpbar i {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: linear-gradient(90deg, #a78bfa, #f0abfc, #fde68a);
    background-size: 200% 100%;
    animation: slide 4s linear infinite;
    transition: width 0.8s cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.2rem 0.65rem;
    border-radius: 99px;
    font-size: 0.75rem;
    font-weight: 600;
    background: rgba(255, 255, 255, 0.07);
    color: #d1d5db;
  }
  .chip .dot {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    background: var(--c);
    box-shadow: 0 0 8px var(--c);
  }
  .packbtn {
    display: flex;
    align-items: center;
    gap: 0.8rem;
    width: 100%;
    padding: 0.8rem 1rem;
    border-radius: 1.1rem;
    color: #1b1033;
    background: linear-gradient(110deg, #fde68a, #f0abfc 55%, #93c5fd);
    box-shadow: 0 10px 30px -10px rgba(240, 171, 252, 0.7);
    font-size: 0.95rem;
    transition:
      transform 0.15s,
      filter 0.15s;
  }
  .packbtn:active {
    transform: scale(0.98);
  }
  .packbtn:hover {
    filter: brightness(1.05);
  }
  .packicon {
    display: flex;
    color: #7c2d12;
    animation: wiggle 2.4s ease-in-out infinite;
  }
  .slot {
    display: grid;
    place-items: center;
    width: 6.2rem;
    height: 8.7rem;
    border-radius: 0.8rem;
  }
  .slot.empty {
    border: 1.5px dashed rgba(255, 255, 255, 0.16);
    color: #6b7280;
    text-align: center;
    gap: 0.1rem;
    align-content: center;
  }
  .slot.empty span {
    font-size: 1.4rem;
  }
  .slot.empty small {
    font-size: 0.65rem;
  }
  .slot :global(.card) {
    transform: none;
  }
  .tabs {
    display: flex;
    gap: 0.4rem;
    overflow-x: auto;
    padding: 0.1rem 0.1rem 0.3rem;
  }
  .tab {
    flex-shrink: 0;
    display: inline-flex;
    align-items: baseline;
    gap: 0.4rem;
    padding: 0.4rem 0.85rem;
    border-radius: 99px;
    white-space: nowrap;
    font-size: 0.8125rem;
    font-weight: 700;
    color: #9ca3af;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid transparent;
    transition: all 0.2s;
  }
  .tab small {
    font-size: 0.68rem;
    font-weight: 600;
    opacity: 0.75;
    font-variant-numeric: tabular-nums;
  }
  .tab.on {
    color: #fff;
    background: color-mix(in srgb, var(--color-primary-500) 28%, transparent);
    border-color: color-mix(in srgb, var(--color-primary-400) 55%, transparent);
  }
  .tab.complete small::after {
    content: " ✓";
    color: #fde68a;
  }
  .page {
    padding: 1rem;
    border-radius: 1.4rem;
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 0.045), transparent 40%),
      var(--color-surface-900);
    border: 1px solid rgba(255, 255, 255, 0.07);
    box-shadow:
      inset 14px 0 18px -14px rgba(0, 0, 0, 0.6),
      0 12px 30px -16px rgba(0, 0, 0, 0.7);
  }
  .pagehead {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin-bottom: 0.9rem;
    flex-wrap: wrap;
  }
  .pagehead h4 {
    font-size: 1.05rem;
    font-weight: 800;
    color: #fff;
  }
  .count {
    font-size: 0.78rem;
    font-weight: 700;
    color: #9ca3af;
    font-variant-numeric: tabular-nums;
  }
  .setbadge {
    margin-left: auto;
    padding: 0.2rem 0.7rem;
    border-radius: 99px;
    font-size: 0.72rem;
    font-weight: 800;
    color: #1b1033;
    background: linear-gradient(110deg, #fde68a, #f0abfc, #93c5fd, #fde68a);
    background-size: 250% 100%;
    animation: slide 3s linear infinite;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0.75rem;
    justify-items: center;
  }
  .tile {
    position: relative;
    border-radius: 0.8rem;
    transition: transform 0.15s;
  }
  .tile:active {
    transform: scale(0.96);
  }
  .tap {
    position: absolute;
    left: 50%;
    bottom: 0.7rem;
    transform: translateX(-50%);
    padding: 0.1rem 0.6rem;
    border-radius: 99px;
    font-size: 0.65rem;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    background: rgba(0, 0, 0, 0.55);
    color: #e9d5ff;
    animation: pulse 1.8s ease-in-out infinite;
  }
  .achgrid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 0.6rem;
  }
  @media (min-width: 560px) {
    .achgrid {
      grid-template-columns: 1fr 1fr;
    }
  }
  .ach {
    display: flex;
    gap: 0.8rem;
    align-items: center;
    padding: 0.7rem 0.9rem;
    border-radius: 1rem;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.06);
    font-size: 0.85rem;
    color: #e5e7eb;
  }
  .ach small {
    font-size: 0.72rem;
  }
  .ach .icon {
    display: flex;
    color: #9ca3af;
    opacity: 0.45;
  }
  .ach.done {
    border-color: rgba(251, 191, 36, 0.45);
    background: linear-gradient(
      120deg,
      rgba(251, 191, 36, 0.12),
      rgba(255, 255, 255, 0.03)
    );
    box-shadow: 0 0 22px -10px rgba(251, 191, 36, 0.6);
  }
  .ach.done .icon {
    color: #fbbf24;
    opacity: 1;
  }
  .mini {
    height: 4px;
    margin: 0.35rem 0 0.15rem;
    border-radius: 99px;
    background: rgba(255, 255, 255, 0.09);
    overflow: hidden;
  }
  .mini i {
    display: block;
    height: 100%;
    background: #a78bfa;
    border-radius: inherit;
  }

  /* ---------- detail sheet ---------- */
  .detail {
    position: fixed;
    inset: 0;
    z-index: 150;
    display: grid;
    place-items: center;
    padding: 1rem;
  }
  .backdrop {
    position: absolute;
    inset: 0;
    background: rgba(4, 3, 10, 0.88);
    backdrop-filter: blur(8px);
  }
  .sheet {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.9rem;
  }
  .info {
    display: flex;
    gap: 0.8rem;
    align-items: baseline;
  }
  .stamps {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 0.4rem;
    font-size: 0.75rem;
    color: #d1d5db;
  }
  .stamps span {
    padding: 0.15rem 0.6rem;
    border-radius: 99px;
    background: rgba(255, 255, 255, 0.08);
  }
  .actions {
    display: flex;
    gap: 0.6rem;
  }
  .btn {
    height: 2.75rem;
    padding: 0 1.3rem;
    border-radius: 99px;
    font-size: 0.875rem;
    font-weight: 700;
    background: var(--m3-primary, #d8b4fe);
    color: var(--m3-on-primary, #4c1d95);
  }
  .btn.ghost {
    background: rgba(255, 255, 255, 0.09);
    color: #d1d5db;
  }

  @keyframes slide {
    to {
      background-position: -200% 0;
    }
  }
  @keyframes wiggle {
    0%,
    80%,
    100% {
      transform: rotate(0);
    }
    86% {
      transform: rotate(-12deg);
    }
    92% {
      transform: rotate(10deg);
    }
  }
  @keyframes pulse {
    50% {
      opacity: 0.55;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .xpbar i,
    .setbadge,
    .packicon,
    .tap {
      animation: none;
    }
  }

  .seasons {
    display: flex;
    gap: 0.4rem;
    overflow-x: auto;
  }
  .career {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.25rem 0.75rem;
    border-top: 1px solid rgba(255, 255, 255, 0.06);
    padding-top: 0.6rem;
  }
  .seg {
    display: inline-flex;
    border-radius: 99px;
    padding: 0.15rem;
    background: rgba(255, 255, 255, 0.06);
  }
  .seg button {
    padding: 0.3rem 0.8rem;
    border-radius: 99px;
    font-size: 0.78rem;
    font-weight: 700;
    color: #9ca3af;
  }
  .seg button.on {
    color: white;
    background: rgba(255, 255, 255, 0.14);
  }
  .filters {
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
  }
  .frow {
    display: flex;
    gap: 0.4rem;
    overflow-x: auto;
    padding-bottom: 0.1rem;
  }
  .fchip {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.35rem 0.75rem;
    border-radius: 99px;
    font-size: 0.78rem;
    font-weight: 700;
    color: #9ca3af;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid transparent;
    white-space: nowrap;
  }
  .fchip .dot {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 99px;
    background: var(--c, #9ca3af);
  }
  .fchip.on {
    color: white;
    border-color: var(--c, rgba(255, 255, 255, 0.4));
    background: rgba(255, 255, 255, 0.12);
  }
  .selects {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.4rem;
  }
  .selects select {
    min-width: 0;
    padding: 0.45rem 0.6rem;
    border-radius: 0.75rem;
    font-size: 0.8rem;
    color: #e5e7eb;
    background: rgba(255, 255, 255, 0.07);
    border: 1px solid rgba(255, 255, 255, 0.08);
  }
  .fcount {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 0.78rem;
    color: #9ca3af;
  }
  .reset {
    font-size: 0.78rem;
    font-weight: 700;
    color: #c4b5fd;
  }
</style>
