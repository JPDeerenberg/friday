<script lang="ts">
  import { personId, userSettings, resumedAt } from "$lib/stores";
  import { get } from "svelte/store";
  import {
    getAssignments,
    getAssignmentDetail,
    getAssignmentVersion,
    fetchAssignmentVersionRaw,
    getSchoolyears,
    formatDate,
    handInAssignment,
    uploadAssignmentAttachment,
    formatTeacherName,
    downloadFile,
  } from "$lib/api";
  import { cacheGet, cacheRefresh } from "$lib/cache";
  import { pickDownloadHref, describeDownload } from "$lib/attachments";
  import {
    sortSchoolyears,
    currentSchoolyear,
    schoolyearLabel,
  } from "$lib/schoolyears";
  import {
    getAssignmentStatus,
    isOverdue,
    canHandIn,
    filterAssignments,
    vakOptions,
    sortVersions,
    latestVersion,
    selfHref,
    versionHasStudentContent,
    versionHasTeacherContent,
    validateHandIn,
    buildHandInBody,
    attachmentLabel,
    htmlHasContent,
    type StatusFilter,
    type SortMode,
    type HandInFile,
  } from "$lib/assignments";
  import { onMount, untrack } from "svelte";
  import { fade, fly } from "svelte/transition";
  import RichTextEditor from "$lib/components/RichTextEditor.svelte";
  import Button from "$lib/components/Button.svelte";
  import Chip from "$lib/components/Chip.svelte";
  import IconButton from "$lib/components/IconButton.svelte";
  import type {
    Assignment,
    AssignmentAttachment,
    AssignmentVersion,
    Schoolyear,
  } from "$lib/types";

  /** One version of the open assignment: the link item plus its loaded content. */
  type VersionView = {
    nav: AssignmentVersion;
    data: AssignmentVersion | null;
    failed: boolean;
  };

  let assignments = $state<Assignment[]>([]);
  let schoolyears = $state<Schoolyear[]>([]);
  let selectedAssignment = $state<Assignment | null>(null);
  let versions = $state<VersionView[]>([]);
  let loadingList = $state(true);
  let loadingDetail = $state(false);
  let loadingVersions = $state(false);
  let listError = $state<string | null>(null);
  let detailError = $state<string | null>(null);

  // List filters. `yearBegin === null` means "all school years".
  let statusFilter = $state<StatusFilter>("all");
  let vakFilter = $state<string | null>(null);
  let sortMode = $state<SortMode>("deadline-desc");
  let yearBegin = $state<string | null>(null);
  let yearInitialised = false;

  // Hand-in form
  let submissionText = $state("");
  let editorKey = $state(0);
  let attachments = $state<(HandInFile & { id: number })[]>([]);
  let isSubmitting = $state(false);
  let uploadLoading = $state(false);
  let submitError = $state<string | null>(null);
  let submitSuccess = $state<string | null>(null);
  let fileInput = $state<HTMLInputElement | null>(null);

  let downloadingFile = $state<string | null>(null);
  let isMobile = $state(false);
  // Ignore answers of a detail load that was overtaken by a newer click.
  let detailToken = 0;

  onMount(async () => {
    const mq = window.matchMedia("(max-width: 767px)");
    isMobile = mq.matches;
    mq.addEventListener("change", (e) => (isMobile = e.matches));
    await loadAssignments();
  });

  async function loadAssignments(force = false) {
    console.info(
      `[Assignments] loadAssignments triggered: ${force ? "resume/manual" : "mount"}`,
    );
    const pid = get(personId);
    if (!pid) return;
    if (assignments.length === 0) loadingList = true;
    listError = null;
    try {
      const fetcher = async () => {
        const start = "2013-01-01";
        const end = formatDate(new Date(Date.now() + 365 * 86400000));
        const raw = await getAssignments(pid, start, end);
        return raw.sort((a, b) =>
          b.InleverenVoor.localeCompare(a.InleverenVoor),
        );
      };
      assignments = force
        ? await cacheRefresh(`assignments_${pid}`, fetcher, 5 * 60 * 1000)
        : await cacheGet(`assignments_${pid}`, fetcher, 5 * 60 * 1000);
    } catch (e) {
      console.error("Error loading assignments:", e);
      listError = `Opdrachten laden mislukt: ${e instanceof Error ? e.message : e}`;
    } finally {
      loadingList = false;
    }
    void loadSchoolyears(pid);
  }

  // The school-year selector is a convenience: when it cannot load, the list
  // still works (it just shows every year).
  async function loadSchoolyears(pid: number) {
    try {
      const years = await getSchoolyears(
        pid,
        "2013-01-01",
        formatDate(new Date()),
      );
      schoolyears = sortSchoolyears(years);
      if (!yearInitialised && schoolyears.length > 0) {
        yearInitialised = true;
        yearBegin = currentSchoolyear(schoolyears)?.begin ?? null;
      }
    } catch (e) {
      console.warn("Schooljaren laden mislukt:", e);
    }
  }

  // Foreground resume: force-refresh assignments
  let resumedSeen = false;
  $effect(() => {
    const r = $resumedAt;
    if (!resumedSeen) {
      resumedSeen = true;
      return;
    }
    if (get(personId) !== null) untrack(() => loadAssignments(true));
  });

  function getStatusStyle(key: string) {
    if (key === "open")
      return "bg-amber-500/15 text-amber-400 border-amber-500/25";
    if (key === "submitted")
      return "bg-blue-500/15 text-blue-400 border-blue-500/25";
    if (key === "graded")
      return "bg-emerald-500/15 text-emerald-400 border-emerald-500/25";
    if (key === "overdue")
      return "bg-red-500/15 text-red-400 border-red-500/25";
    return "bg-surface-700/60 text-gray-500 border-surface-600/30";
  }

  const selectedYear = $derived(
    yearBegin ? (schoolyears.find((y) => y.begin === yearBegin) ?? null) : null,
  );
  const yearRange = $derived(
    selectedYear ? { begin: selectedYear.begin, einde: selectedYear.einde } : null,
  );
  // Everything except the status chip, so the chip counts match the list.
  const baseList = $derived(
    filterAssignments(assignments, {
      status: "all",
      vak: vakFilter,
      year: yearRange,
      sort: sortMode,
    }),
  );
  const filteredAssignments = $derived(
    statusFilter === "all"
      ? baseList
      : baseList.filter((a) => getAssignmentStatus(a).key === statusFilter),
  );
  const statusCounts = $derived({
    all: baseList.length,
    open: baseList.filter((a) => getAssignmentStatus(a).key === "open").length,
    overdue: baseList.filter((a) => getAssignmentStatus(a).key === "overdue")
      .length,
    submitted: baseList.filter((a) => getAssignmentStatus(a).key === "submitted")
      .length,
    graded: baseList.filter((a) => getAssignmentStatus(a).key === "graded")
      .length,
  });
  const vaks = $derived(
    vakOptions(
      filterAssignments(assignments, {
        status: "all",
        vak: null,
        year: yearRange,
        sort: "title",
      }),
    ),
  );
  // A subject that does not exist in the chosen year would hide everything.
  $effect(() => {
    if (vakFilter !== null && !vaks.includes(vakFilter)) vakFilter = null;
  });

  const timeline = $derived(
    versions.filter(
      (v) =>
        v.failed ||
        (v.data && (versionHasStudentContent(v.data) || versionHasTeacherContent(v.data))),
    ),
  );

  function resetForm() {
    submissionText = "";
    attachments = [];
    submitError = null;
    editorKey += 1;
  }

  async function selectAssignment(assignment: Assignment, force = false) {
    if (!force && selectedAssignment?.Id === assignment.Id) return;
    const token = ++detailToken;
    loadingDetail = true;
    detailError = null;
    submitSuccess = null;
    versions = [];
    loadingVersions = false;
    if (selectedAssignment?.Id !== assignment.Id) resetForm();
    try {
      const selfLink = selfHref(assignment.Links);
      let detail: Assignment = assignment;
      if (selfLink) {
        try {
          detail = await getAssignmentDetail(selfLink);
        } catch (e) {
          console.error(e);
          detailError = `Details laden mislukt: ${e instanceof Error ? e.message : e}`;
        }
      }
      if (token !== detailToken) return;
      selectedAssignment = detail;
      loadingDetail = false;
      await loadVersions(detail, token);
    } finally {
      if (token === detailToken) loadingDetail = false;
    }
  }

  // The assignment only lists its versions as links; fetch each one to get the
  // student's comment/attachments and the teacher's feedback and grade.
  async function loadVersions(detail: Assignment, token: number) {
    const navItems = sortVersions(detail.VersieNavigatieItems);
    loadingVersions = navItems.length > 0;
    const settled = await Promise.all(
      navItems.map(async (nav): Promise<VersionView> => {
        const href = selfHref(nav.Links);
        if (!href) return { nav, data: null, failed: true };
        try {
          return { nav, data: await getAssignmentVersion(href), failed: false };
        } catch (e) {
          console.error(`Versie ${nav.VersieNummer} laden mislukt:`, e);
          return { nav, data: null, failed: true };
        }
      }),
    );
    if (token !== detailToken) return;
    versions = settled;
    loadingVersions = false;
  }

  // ── Attachments ──────────────────────────────────────────────────────────

  async function handleDownload(bijlage: AssignmentAttachment) {
    if (downloadingFile) return;
    const url = pickDownloadHref(bijlage.Links, bijlage.Url);
    if (!url) {
      alert("Deze bijlage heeft geen downloadlink.");
      return;
    }
    downloadingFile = bijlage.Naam;
    try {
      const downloadDir = get(userSettings).downloadDir || "";
      const outcome = await downloadFile(url, bijlage.Naam, downloadDir);
      const note = describeDownload(outcome);
      if (note) alert(note);
    } catch (e) {
      alert(`Download mislukt: ${e instanceof Error ? e.message : e}`);
    } finally {
      downloadingFile = null;
    }
  }

  // One file picker for web, desktop and Android: an <input type="file">.
  // (The native dialog only returns content:// URIs on Android, which the
  // upload could not read — uploads failed there without a word.)
  function handlePickFile() {
    fileInput?.click();
  }

  async function handleFilesPicked() {
    const files = fileInput ? Array.from(fileInput.files ?? []) : [];
    if (files.length === 0) return;
    uploadLoading = true;
    submitError = null;
    const failed: string[] = [];
    for (const file of files) {
      try {
        const [id, storageId] = await uploadAssignmentAttachment(file);
        attachments = [
          ...attachments,
          {
            id,
            storageId,
            name: file.name,
            contentType: file.type || "application/octet-stream",
          },
        ];
      } catch (e) {
        console.error(`Upload failed for ${file.name}:`, e);
        failed.push(`${file.name} (${e instanceof Error ? e.message : e})`);
      }
    }
    uploadLoading = false;
    if (fileInput) fileInput.value = "";
    if (failed.length > 0) {
      submitError = `Uploaden mislukt voor: ${failed.join(", ")}`;
    }
  }

  function removeAttachment(idx: number) {
    attachments = attachments.filter((_, i) => i !== idx);
  }

  // ── Handing in ───────────────────────────────────────────────────────────

  async function handleSubmit() {
    if (!selectedAssignment || isSubmitting || uploadLoading) return;
    submitError = null;
    submitSuccess = null;

    const problem = validateHandIn({
      comment: submissionText,
      files: attachments,
    });
    if (problem) {
      submitError = problem;
      return;
    }

    // Hand in on the newest version (highest number), not "the first in the list".
    const latest = latestVersion(selectedAssignment.VersieNavigatieItems);
    const href = selfHref(latest?.Links);
    if (!latest || !href) {
      submitError = "Geen inlever-link gevonden voor deze opdracht.";
      return;
    }

    isSubmitting = true;
    try {
      // Post back the version as Magister has it right now, with our comment
      // and files filled in (see buildHandInBody).
      const fresh = await fetchAssignmentVersionRaw(href);
      const body = buildHandInBody(fresh, {
        comment: submissionText,
        files: attachments,
      });
      await handInAssignment(
        href,
        selectedAssignment.Id,
        JSON.stringify(body),
      );
      const id = selectedAssignment.Id;
      resetForm();
      await loadAssignments(true);
      const refreshed = assignments.find((a) => a.Id === id);
      if (refreshed) await selectAssignment(refreshed, true);
      // After the re-select: selecting clears any earlier message.
      submitSuccess = "Ingeleverd!";
    } catch (e) {
      console.error(e);
      submitError = `Inleveren mislukt: ${e instanceof Error ? e.message : e}`;
    } finally {
      isSubmitting = false;
    }
  }

  function formatWhen(iso: string | null | undefined) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleDateString("nl-NL", {
      day: "numeric",
      month: "long",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
</script>

{#snippet attachmentList(files: AssignmentAttachment[], tone: "blue" | "emerald")}
  <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
    {#each files as file}
      <button
        onclick={() => handleDownload(file)}
        disabled={downloadingFile != null}
        class="glass p-3 rounded-m3-md flex items-center justify-between hover:bg-surface-800/40 transition-colors group cursor-pointer w-full text-left disabled:opacity-50"
      >
        <div class="flex items-center gap-3 overflow-hidden">
          <div
            class="w-8 h-8 rounded-m3-sm flex items-center justify-center shrink-0 border {tone ===
            'blue'
              ? 'bg-blue-500/15 border-blue-500/20 text-blue-400'
              : 'bg-emerald-500/15 border-emerald-500/20 text-emerald-400'}"
          >
            {#if downloadingFile === file.Naam}
              <div
                class="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin"
              ></div>
            {:else}
              <svg
                class="w-4 h-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                ><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline
                  points="7 10 12 15 17 10"
                /><line x1="12" y1="15" x2="12" y2="3" /></svg
              >
            {/if}
          </div>
          <span class="text-body-small text-gray-200 truncate"
            >{attachmentLabel(file)}</span
          >
        </div>
      </button>
    {/each}
  </div>
{/snippet}

<div class="flex flex-col bg-surface-950 min-h-full">
  <!-- Header row: title + refresh only -->
  <header
    class="sticky top-0 z-20 border-b border-surface-800/50 bg-surface-950/95 backdrop-blur"
  >
    <div class="flex items-center justify-between px-4 py-3 gap-3">
      <div class="flex items-center gap-3 min-w-0">
        {#if selectedAssignment && isMobile}
          <IconButton
            onclick={() => (selectedAssignment = null)}
            aria-label="Terug naar opdrachtenlijst"
          >
            <svg
              class="w-5 h-5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"><path d="m15 18-6-6 6-6" /></svg
            >
          </IconButton>
        {/if}
        <h1 class="text-title-large text-gray-100 truncate">Opdrachten</h1>
      </div>
      <IconButton
        onclick={() => loadAssignments(true)}
        aria-label="Vernieuwen"
        title="Vernieuwen"
        class="hover:rotate-180 duration-700"
      >
        <svg
          class="w-5 h-5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          ><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" /><path
            d="M21 3v5h-5"
          /></svg
        >
      </IconButton>
    </div>

    <!-- Filter rows -->
    <div class="flex items-center gap-2 px-4 pb-2 overflow-x-auto no-scrollbar">
      {#if schoolyears.length > 0}
        <select
          aria-label="Schooljaar"
          value={yearBegin ?? ""}
          onchange={(e) => {
            const v = (e.currentTarget as HTMLSelectElement).value;
            yearBegin = v === "" ? null : v;
          }}
          class="bg-surface-800 border border-white/10 rounded-m3-sm h-8 px-2 text-label-large text-gray-200 focus:outline-none focus:border-primary-500 shrink-0"
        >
          <option value="">Alle schooljaren</option>
          {#each schoolyears as y}
            <option value={y.begin}>{schoolyearLabel(y)}</option>
          {/each}
        </select>
      {/if}
      {#if vaks.length > 0}
        <select
          aria-label="Vak"
          value={vakFilter ?? ""}
          onchange={(e) => {
            const v = (e.currentTarget as HTMLSelectElement).value;
            vakFilter = v === "" ? null : v;
          }}
          class="bg-surface-800 border border-white/10 rounded-m3-sm h-8 px-2 text-label-large text-gray-200 focus:outline-none focus:border-primary-500 shrink-0 max-w-[10rem]"
        >
          <option value="">Alle vakken</option>
          {#each vaks as v}
            <option value={v}>{v}</option>
          {/each}
        </select>
      {/if}
      <select
        aria-label="Sorteren"
        bind:value={sortMode}
        class="bg-surface-800 border border-white/10 rounded-m3-sm h-8 px-2 text-label-large text-gray-200 focus:outline-none focus:border-primary-500 shrink-0"
      >
        <option value="deadline-desc">Deadline (nieuwste)</option>
        <option value="deadline-asc">Deadline (oudste)</option>
        <option value="title">Titel (A-Z)</option>
      </select>
    </div>
    <div
      class="flex items-center gap-1.5 px-4 pb-3 overflow-x-auto no-scrollbar"
    >
      {#each [{ id: "all", label: "Alle", count: statusCounts.all }, { id: "open", label: "Open", count: statusCounts.open }, { id: "overdue", label: "Te laat", count: statusCounts.overdue }, { id: "submitted", label: "Ingeleverd", count: statusCounts.submitted }, { id: "graded", label: "Beoordeeld", count: statusCounts.graded }] as f}
        <Chip
          variant="filter"
          selected={statusFilter === f.id}
          onclick={() => (statusFilter = f.id as StatusFilter)}
        >
          {f.label}
          {#if f.count > 0}
            <span
              class="text-label-small px-1.5 py-0.5 rounded-full bg-surface-700"
              >{f.count}</span
            >
          {/if}
        </Chip>
      {/each}
    </div>
  </header>

  <div class="flex flex-1 min-h-0">
    <!-- List Pane -->
    <aside
      class="{selectedAssignment
        ? 'hidden md:flex'
        : 'flex'} w-full md:w-80 border-r border-surface-800/50 flex-col bg-surface-900/30"
    >
      {#if loadingList}
        <div class="flex-1 overflow-y-auto p-3 space-y-3 custom-scrollbar">
          {#each Array(5) as _}
            <div
              class="p-4 rounded-m3-md bg-surface-800/40 border border-white/5"
            >
              <div class="flex justify-between items-start mb-3 gap-3">
                <div class="h-4 skeleton-shimmer rounded-full w-2/3"></div>
                <div class="h-5 skeleton-shimmer rounded-m3-sm w-16"></div>
              </div>
              <div class="flex items-center justify-between">
                <div class="h-3 skeleton-shimmer rounded-full w-1/4"></div>
                <div class="h-3 skeleton-shimmer rounded-full w-12"></div>
              </div>
            </div>
          {/each}
        </div>
      {:else if listError && assignments.length === 0}
        <div
          class="flex-1 flex flex-col items-center justify-center p-8 text-center gap-3"
        >
          <p class="text-red-400 text-body-medium">{listError}</p>
          <Button variant="tonal" onclick={() => loadAssignments(true)}
            >Opnieuw proberen</Button
          >
        </div>
      {:else if filteredAssignments.length === 0}
        <div
          class="flex-1 flex flex-col items-center justify-center p-8 text-center gap-3"
        >
          <svg
            class="w-10 h-10 text-gray-700"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
            ><path
              d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"
            /><polyline points="14 2 14 8 20 8" /></svg
          >
          <p class="text-gray-600 text-body-medium">Geen opdrachten</p>
          {#if yearBegin !== null && assignments.length > 0}
            <Button variant="text" onclick={() => (yearBegin = null)}
              >Toon alle schooljaren</Button
            >
          {/if}
        </div>
      {:else}
        <div class="flex-1 overflow-y-auto p-3 space-y-2 custom-scrollbar">
          {#each filteredAssignments as assignment, i (assignment.Id)}
            {@const status = getAssignmentStatus(assignment)}
            <button
              onclick={() => selectAssignment(assignment)}
              style="--i: {i}"
              class="stagger-item w-full text-left p-4 rounded-m3-md transition-all border {selectedAssignment?.Id ===
              assignment.Id
                ? 'bg-primary-500/10 border-primary-500/30 shadow-xl shadow-primary-500/5'
                : 'bg-surface-800/40 border-white/5 hover:bg-surface-800/60 hover:border-white/10'}"
            >
              <div class="flex justify-between items-start mb-2 gap-3">
                <p
                  class="text-title-small text-gray-100 truncate flex-1 leading-tight"
                >
                  {assignment.Titel}
                </p>
                <span
                  class="px-2 py-0.5 rounded-m3-sm text-label-small border shrink-0 whitespace-nowrap {getStatusStyle(
                    status.key,
                  )}"
                >
                  {status.label}
                </span>
              </div>
              <div
                class="flex items-center justify-between text-label-small text-gray-500"
              >
                <span class="truncate opacity-70"
                  >{assignment.Vak ?? "Algemeen"}</span
                >
                <span class={isOverdue(assignment) ? "text-red-400" : ""}>
                  {new Date(assignment.InleverenVoor).toLocaleDateString(
                    "nl-NL",
                    { day: "numeric", month: "short", year: "numeric" },
                  )}
                </span>
              </div>
            </button>
          {/each}
        </div>
      {/if}
    </aside>

    <!-- Content Pane -->
    <section
      class="{!selectedAssignment
        ? 'hidden md:block'
        : 'block'} flex-1 overflow-y-auto bg-surface-950 p-4 md:p-8 custom-scrollbar relative"
    >
      {#if loadingDetail}
        <div class="absolute inset-0 z-20 overflow-hidden custom-scrollbar bg-surface-950">
          <div class="p-4 md:p-8 max-w-4xl mx-auto space-y-8">
            <div class="space-y-4">
              <div class="flex items-center gap-2">
                <div class="h-5 skeleton-shimmer rounded-m3-sm w-20"></div>
                <div class="h-5 skeleton-shimmer rounded-m3-sm w-24"></div>
              </div>
              <div class="h-8 skeleton-shimmer rounded-full w-3/4"></div>
              <div class="h-4 skeleton-shimmer rounded-full w-1/3"></div>
              <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {#each Array(4) as _}
                  <div class="glass p-3 rounded-m3-sm">
                    <div
                      class="h-3 skeleton-shimmer rounded-full w-1/2 mb-2"
                    ></div>
                    <div class="h-4 skeleton-shimmer rounded-full w-3/4"></div>
                  </div>
                {/each}
              </div>
            </div>
          </div>
        </div>
      {/if}

      {#if selectedAssignment}
        {@const sel = selectedAssignment}
        {@const status = getAssignmentStatus(sel)}
        <div
          in:fly={{ y: 20, duration: 350 }}
          class="max-w-4xl mx-auto space-y-8 pb-20"
        >
          {#if detailError}
            <p
              class="text-body-small text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-m3-sm px-3 py-2"
            >
              {detailError}
            </p>
          {/if}

          <!-- Title block -->
          <div class="space-y-4">
            <div
              class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4"
            >
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2 mb-2 flex-wrap">
                  <span
                    class="inline-flex items-center gap-1 whitespace-nowrap px-2.5 py-1 rounded-m3-sm text-label-small border {getStatusStyle(
                      status.key,
                    )}"
                  >
                    {status.label}
                  </span>
                  {#if isOverdue(sel) && status.key !== "overdue"}
                    <span
                      class="inline-flex items-center gap-1 whitespace-nowrap px-2.5 py-1 rounded-m3-sm text-label-small bg-red-500/15 text-red-400 border border-red-500/25"
                    >
                      Te laat
                    </span>
                  {/if}
                  {#if sel.OpnieuwInleveren}
                    <span
                      class="inline-flex items-center gap-1 whitespace-nowrap px-2.5 py-1 rounded-m3-sm text-label-small bg-amber-500/15 text-amber-400 border border-amber-500/25"
                    >
                      Opnieuw inleveren gevraagd
                    </span>
                  {/if}
                </div>
                <h2 class="text-headline-medium text-white leading-tight">
                  {sel.Titel}
                </h2>
                <p class="text-gray-400 mt-1 text-body-medium">
                  {sel.Vak ?? "Algemeen"}
                </p>
              </div>
              {#if sel.Beoordeling}
                <div
                  class="glass p-4 rounded-m3-md flex flex-col items-center justify-center min-w-[90px] border-emerald-500/30"
                >
                  <span class="text-label-small text-emerald-400 mb-1"
                    >Beoordeling</span
                  >
                  <span class="text-headline-large text-emerald-400"
                    >{sel.Beoordeling}</span
                  >
                </div>
              {/if}
            </div>

            <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div class="glass p-3 rounded-m3-sm">
                <p class="text-label-small text-gray-500 mb-1">Deadline</p>
                <p class="text-body-small text-gray-200">
                  {formatWhen(sel.InleverenVoor) || "-"}
                </p>
              </div>
              {#if sel.IngeleverdOp}
                <div class="glass p-3 rounded-m3-sm border-blue-500/20">
                  <p class="text-label-small text-blue-400/80 mb-1">
                    Ingeleverd op
                  </p>
                  <p class="text-body-small text-gray-200">
                    {formatWhen(sel.IngeleverdOp)}
                  </p>
                </div>
              {/if}
              {#if sel.BeoordeeldOp}
                <div class="glass p-3 rounded-m3-sm border-emerald-500/20">
                  <p class="text-label-small text-emerald-400/80 mb-1">
                    Beoordeeld op
                  </p>
                  <p class="text-body-small text-gray-200">
                    {formatWhen(sel.BeoordeeldOp)}
                  </p>
                </div>
              {/if}
              <div class="glass p-3 rounded-m3-sm">
                <p class="text-label-small text-gray-500 mb-1">Docent</p>
                <p class="text-body-small text-gray-200 truncate">
                  {sel.Docenten?.map((d) => formatTeacherName(d.Naam)).join(
                    ", ",
                  ) || "N.v.t."}
                </p>
              </div>
            </div>
          </div>

          <!-- Description -->
          {#if sel.Omschrijving}
            <div class="glass rounded-m3-md p-6 bg-surface-900/40">
              <h3
                class="text-title-small text-gray-100 mb-4 flex items-center gap-2"
              >
                <span class="w-1.5 h-4 bg-primary-500 rounded-full"></span>
                Omschrijving
              </h3>
              <div
                class="prose prose-invert prose-sm max-w-none text-gray-300 leading-relaxed"
              >
                {@html sel.Omschrijving}
              </div>
            </div>
          {/if}

          <!-- Teacher attachments -->
          {#if sel.Bijlagen?.length}
            <div class="space-y-3">
              <h3 class="text-title-small text-gray-300">Bijlagen van docent</h3>
              {@render attachmentList(sel.Bijlagen, "blue")}
            </div>
          {/if}

          <!-- Versions: what was handed in, and the teacher's answer -->
          {#if loadingVersions}
            <p class="text-label-small text-gray-500">Inleveringen laden...</p>
          {/if}
          {#if timeline.length > 0}
            <div class="space-y-4">
              <h3 class="text-title-small text-gray-300">Inleveringen</h3>
              {#each timeline as v (v.nav.Id)}
                <div class="space-y-3" in:fade={{ duration: 200 }}>
                  <p class="text-label-small text-gray-500">
                    Versie {v.nav.VersieNummer ?? v.data?.VersieNummer ?? ""}
                  </p>
                  {#if v.failed || !v.data}
                    <p
                      class="text-body-small text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-m3-sm px-3 py-2"
                    >
                      Deze versie kon niet worden geladen.
                    </p>
                  {:else}
                    {#if versionHasStudentContent(v.data)}
                      <div
                        class="glass rounded-m3-md p-4 space-y-3 border-blue-500/20"
                      >
                        <div class="flex items-center justify-between gap-3">
                          <p class="text-label-large text-blue-300">
                            Jouw inlevering
                          </p>
                          <p class="text-label-small text-gray-500">
                            {formatWhen(v.data.IngeleverdOp)}
                          </p>
                        </div>
                        {#if htmlHasContent(v.data.LeerlingOpmerking)}
                          <div
                            class="prose prose-invert prose-sm max-w-none text-gray-300"
                          >
                            {@html v.data.LeerlingOpmerking}
                          </div>
                        {/if}
                        {#if v.data.LeerlingBijlagen?.length}
                          {@render attachmentList(v.data.LeerlingBijlagen, "blue")}
                        {/if}
                      </div>
                    {/if}
                    {#if versionHasTeacherContent(v.data)}
                      <div
                        class="glass rounded-m3-md p-4 space-y-3 border-emerald-500/20"
                      >
                        <div class="flex items-center justify-between gap-3">
                          <p class="text-label-large text-emerald-300">
                            Feedback van docent
                          </p>
                          <p class="text-label-small text-gray-500">
                            {formatWhen(v.data.BeoordeeldOp)}
                          </p>
                        </div>
                        {#if v.data.Beoordeling}
                          <p class="text-title-medium text-emerald-400">
                            Beoordeling: {v.data.Beoordeling}
                          </p>
                        {/if}
                        {#if htmlHasContent(v.data.DocentOpmerking)}
                          <div
                            class="prose prose-invert prose-sm max-w-none text-gray-300"
                          >
                            {@html v.data.DocentOpmerking}
                          </div>
                        {/if}
                        {#if v.data.FeedbackBijlagen?.length}
                          {@render attachmentList(v.data.FeedbackBijlagen, "emerald")}
                        {/if}
                      </div>
                    {/if}
                  {/if}
                </div>
              {/each}
            </div>
          {/if}

          <!-- Hand in -->
          {#if canHandIn(sel)}
            <div class="glass rounded-m3-md overflow-hidden">
              <div class="px-5 py-4 border-b border-surface-800/50">
                <h3 class="text-title-small text-gray-100">
                  {sel.IngeleverdOp ? "Opnieuw inleveren" : "Inleveren"}
                </h3>
              </div>
              <div class="space-y-3">
                {#key editorKey}
                  <RichTextEditor
                    content={submissionText}
                    placeholder="Typ hier je opmerking voor de docent (met opmaak)..."
                    onUpdate={(html) => (submissionText = html)}
                  />
                {/key}

                {#if attachments.length > 0 || uploadLoading}
                  <div
                    class="px-5 py-3 bg-surface-900/50 border-t border-surface-800/50 space-y-2"
                  >
                    {#each attachments as a, idx (a.storageId)}
                      <div
                        class="flex items-center justify-between gap-3 text-body-small text-gray-200"
                      >
                        <span class="truncate">{a.name}</span>
                        <IconButton
                          onclick={() => removeAttachment(idx)}
                          aria-label="Bijlage verwijderen"
                          title="Verwijderen"
                        >
                          <svg
                            class="w-4 h-4"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2.5"
                            stroke-linecap="round"
                            ><line x1="18" y1="6" x2="6" y2="18" /><line
                              x1="6"
                              y1="6"
                              x2="18"
                              y2="18"
                            /></svg
                          >
                        </IconButton>
                      </div>
                    {/each}
                    {#if uploadLoading}
                      <p class="text-label-small text-gray-500">Uploaden...</p>
                    {/if}
                  </div>
                {/if}

                {#if submitError}
                  <p class="px-5 text-body-small text-red-400">{submitError}</p>
                {/if}

                <div
                  class="px-5 pb-4 flex flex-wrap items-center justify-between gap-3"
                >
                  <input
                    bind:this={fileInput}
                    type="file"
                    multiple
                    class="hidden"
                    onchange={handleFilesPicked}
                  />
                  <Button
                    variant="tonal"
                    onclick={handlePickFile}
                    disabled={uploadLoading || isSubmitting}
                  >
                    Bijlage toevoegen
                  </Button>
                  <Button
                    onclick={handleSubmit}
                    disabled={isSubmitting || uploadLoading}
                  >
                    {isSubmitting
                      ? "Bezig met inleveren..."
                      : sel.IngeleverdOp
                        ? "Opnieuw inleveren"
                        : "Inleveren"}
                  </Button>
                </div>
              </div>
            </div>
          {:else if sel.Afgesloten}
            <p class="text-body-small text-gray-500">
              Deze opdracht is afgesloten; inleveren kan niet meer.
            </p>
          {/if}

          {#if submitSuccess}
            <p class="text-body-small text-emerald-400">{submitSuccess}</p>
          {/if}
        </div>
      {:else if !loadingList && !loadingDetail}
        <div
          class="hidden md:flex h-full flex-col items-center justify-center text-center"
        >
          <h3 class="text-headline-small text-white mb-2">
            Selecteer een opdracht
          </h3>
          <p class="text-gray-600 max-w-xs text-body-medium leading-relaxed">
            Kies een opdracht uit de lijst
          </p>
        </div>
      {/if}
    </section>
  </div>
</div>

<style>
  .glass {
    background: rgba(30, 41, 59, 0.5);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border: 1px solid rgba(255, 255, 255, 0.06);
    box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.3);
  }
  .no-scrollbar::-webkit-scrollbar {
    display: none;
  }
  .no-scrollbar {
    -ms-overflow-style: none;
    scrollbar-width: none;
  }
  .custom-scrollbar::-webkit-scrollbar {
    width: 4px;
  }
  .custom-scrollbar::-webkit-scrollbar-track {
    background: transparent;
  }
  .custom-scrollbar::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.08);
    border-radius: 10px;
  }
  :global(.prose h1, .prose h2, .prose h3) {
    color: white !important;
    font-weight: 800 !important;
  }
  :global(.prose a) {
    color: #60a5fa !important;
    text-decoration: underline;
  }
  :global(.prose strong) {
    color: #cbd5e1 !important;
    font-weight: 700;
  }
</style>
