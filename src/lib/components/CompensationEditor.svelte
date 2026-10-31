<script lang="ts">
  import { userSettings } from "$lib/stores";
  import {
    sanitizeCompensation,
    DEFAULT_COMPENSATION,
    type CompensationConfig,
  } from "$lib/grades/compensation";
  import Button from "$lib/components/Button.svelte";

  const cfg = $derived($userSettings.compensation as CompensationConfig);

  function update(patch: Partial<CompensationConfig>) {
    userSettings.update((s) => ({
      ...s,
      compensation: sanitizeCompensation({ ...s.compensation, ...patch }),
    }));
  }

  function setPoints(grade: number, raw: string) {
    const n = Number(raw.replace(",", "."));
    if (!Number.isFinite(n)) return;
    update({ points: { ...cfg.points, [String(grade)]: n } });
  }

  function reset() {
    update({
      ...DEFAULT_COMPENSATION,
      points: { ...DEFAULT_COMPENSATION.points },
    });
  }

  const fieldClass =
    "px-2 py-1.5 rounded-m3-xs bg-surface-950 border border-surface-700 text-label-large text-gray-100 text-center focus:outline-none focus:border-primary-500";
</script>

<div class="w-full space-y-3">
  <p class="text-label-small text-gray-500 leading-relaxed">
    Punten per afgerond eindcijfer. De standaardwaarden zijn een veelgebruikt
    startpunt; elke school heeft eigen regels, dus pas ze aan.
  </p>
  <div class="grid grid-cols-5 sm:grid-cols-10 gap-2">
    {#each [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as g}
      <label class="flex flex-col items-center gap-1">
        <span class="text-label-small text-gray-400">{g}</span>
        <input
          class="{fieldClass} w-full"
          inputmode="numeric"
          value={cfg.points[String(g)]}
          onchange={(e) => setPoints(g, e.currentTarget.value)}
        />
      </label>
    {/each}
  </div>
  <div class="flex flex-wrap gap-3 items-end">
    <label class="flex flex-col gap-1 text-label-small text-gray-400">
      Minimaal totaal
      <input
        class="{fieldClass} w-24"
        inputmode="numeric"
        value={cfg.minTotal}
        onchange={(e) =>
          update({ minTotal: Number(e.currentTarget.value.replace(",", ".")) })}
      />
    </label>
    <label class="flex flex-col gap-1 text-label-small text-gray-400">
      Max. onvoldoendes
      <input
        class="{fieldClass} w-24"
        inputmode="numeric"
        placeholder="geen"
        value={cfg.maxInsufficient ?? ""}
        onchange={(e) => {
          const t = e.currentTarget.value.trim();
          update({ maxInsufficient: t === "" ? null : Number(t) });
        }}
      />
    </label>
    <label class="flex flex-col gap-1 text-label-small text-gray-400">
      Voldoende vanaf
      <input
        class="{fieldClass} w-24"
        inputmode="numeric"
        value={cfg.passGrade}
        onchange={(e) => update({ passGrade: Number(e.currentTarget.value) })}
      />
    </label>
    <Button variant="tonal" onclick={reset}>Standaard</Button>
  </div>
</div>
