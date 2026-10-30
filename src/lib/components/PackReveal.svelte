<script lang="ts">
  /**
   * The pack ceremony.
   *
   * Cards come out worst → best. Each card is opened with one of three gestures
   * (decided per card, see cards.ts): tear the foil, scratch it off, or hold to
   * charge. Episch and up get a full walkout cinematic. Everything scales with
   * `intensity` ("uit" = plain tap-and-flip, "normaal" = lighter effects,
   * "vol" = everything) and the system's reduced-motion setting forces "uit".
   * An FPS watchdog in the particle engine sheds effects on slow phones.
   */
  import { onDestroy, onMount, tick, untrack } from "svelte";
  import { fade, fly } from "svelte/transition";
  import { get } from "svelte/store";
  import GradeCardView from "$lib/components/GradeCardView.svelte";
  import {
    ACHIEVEMENTS,
    RARITY_META,
    compareForPack,
    countCompleteSets,
    levelInfo,
    type CardData,
  } from "$lib/cards";
  import { gradeRevealState, recordOpen } from "$lib/grade-reveal";
  import { FxEngine } from "$lib/fx";
  import { buzz, haptic, setSoundEnabled, sfx } from "$lib/card-feedback";

  let {
    queue,
    collection = [],
    preview = false,
    intensity = "vol",
    sound = false,
    onrevealed,
    onclose,
  }: {
    queue: CardData[];
    /** Every card of the current grade list (for "set complete" achievements). */
    collection?: CardData[];
    /** Demo mode: nothing is recorded. */
    preview?: boolean;
    intensity?: "uit" | "normaal" | "vol";
    sound?: boolean;
    onrevealed?: (card: CardData) => void;
    onclose: () => void;
  } = $props();

  type Phase = "intro" | "await" | "charge" | "impact" | "shown" | "summary";
  type Mode = "tear" | "scratch" | "hold" | "tap";

  const cards = untrack(() => [...queue].sort(compareForPack));
  const total = cards.length;
  const reduced =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const level = $derived<"uit" | "normaal" | "vol">(
    reduced ? "uit" : intensity,
  );
  const full = $derived(level === "vol");
  const plain = $derived(level === "uit");

  const NEUTRAL = "#a78bfa";
  const NEUTRAL2 = "#6d28d9";

  // ---------------------------------------------------------------- state
  let index = $state(0);
  let phase = $state<Phase>("intro");
  let progress = $state(0);
  let faceDown = $state(true);
  let cinematic = $state(false);
  let beamsOn = $state(false);
  let auroraOn = $state(false);
  let showRarity = $state(false);
  let pushin = $state(false);
  let flash = $state(false);
  let frozen = $state(false);
  let shakeLvl = $state(0);
  let ringKey = $state(0);
  let stampText = $state<string | null>(null);
  let xpGain = $state(0);
  let levelUpTitle = $state<string | null>(null);
  let torn = $state(false);
  let packGone = $state(false);
  let releasing = $state(false);
  let scratchDone = $state(false);
  let holding = $state(false);
  let lite = $state(false);
  let currentToast = $state<string | null>(null);
  let toastQueue: string[] = [];
  let packXp = $state(0);
  let shownXp = $state(0);
  let packAchievements = $state<string[]>([]);
  let viewW = $state(typeof window !== "undefined" ? window.innerWidth : 390);
  let viewH = $state(typeof window !== "undefined" ? window.innerHeight : 780);

  const card = $derived(cards[index]);
  const meta = $derived(RARITY_META[card.rarity]);
  const tier = $derived(meta.tier);
  const effMode = $derived<Mode>(plain ? "tap" : card.mode);
  const rc = $derived(showRarity ? meta.color : NEUTRAL);
  const rc2 = $derived(showRarity ? meta.color2 : NEUTRAL2);
  const cardScale = $derived(
    Math.max(8, Math.min(15, (viewH - 330) / 22.4, (viewW - 56) / 16)),
  );
  const isLast = $derived(index >= total - 1);
  const levelNow = $derived(levelInfo($gradeRevealState.tally.xp));

  // ---------------------------------------------------------------- plumbing
  let backCanvas: HTMLCanvasElement | undefined = $state();
  let frontCanvas: HTMLCanvasElement | undefined = $state();
  let cardEl: HTMLDivElement | undefined = $state();
  let back: FxEngine | undefined;
  let front: FxEngine | undefined;
  let timers: number[] = [];
  let destroyed = false;
  let holdRaf = 0;
  let autoRaf = 0;
  let autoRun = false;
  let lastBuzz = 0;
  let countRaf = 0;

  function later(fn: () => void, ms: number) {
    const id = window.setTimeout(() => {
      if (!destroyed) fn();
    }, ms);
    timers.push(id);
  }
  function clearTimers() {
    timers.forEach(clearTimeout);
    timers = [];
    cancelAnimationFrame(holdRaf);
    cancelAnimationFrame(autoRaf);
    holdRaf = autoRaf = 0;
  }

  onMount(() => {
    setSoundEnabled(sound && !plain);
    const q =
      Math.min(1, (navigator.hardwareConcurrency ?? 8) <= 4 ? 0.7 : 1) *
      (level === "normaal" ? 0.6 : 1);
    if (backCanvas) back = new FxEngine(backCanvas, { quality: q });
    if (frontCanvas) front = new FxEngine(frontCanvas, { quality: q });
    const degrade = () => (lite = true);
    if (back) back.onDegrade = degrade;
    if (front) front.onDegrade = degrade;
    const onResize = () => {
      viewW = window.innerWidth;
      viewH = window.innerHeight;
    };
    window.addEventListener("resize", onResize);
    startCard();
    return () => window.removeEventListener("resize", onResize);
  });

  onDestroy(() => {
    destroyed = true;
    clearTimers();
    cancelAnimationFrame(countRaf);
    back?.destroy();
    front?.destroy();
    buzz(0);
  });

  function center(): { x: number; y: number } {
    const r = cardEl?.getBoundingClientRect();
    const c = frontCanvas?.getBoundingClientRect();
    if (!r || !c) return { x: viewW / 2, y: viewH / 2 };
    return {
      x: r.left + r.width / 2 - c.left,
      y: r.top + r.height / 2 - c.top,
    };
  }

  // ---------------------------------------------------------------- per-card flow
  function startCard() {
    clearTimers();
    back?.clear();
    front?.clear();
    autoRun = false;
    holding = false;
    phase = "intro";
    progress = 0;
    faceDown = !(effMode === "scratch");
    cinematic = false;
    beamsOn = false;
    auroraOn = false;
    showRarity = false;
    pushin = false;
    flash = false;
    frozen = false;
    shakeLvl = 0;
    stampText = null;
    xpGain = 0;
    levelUpTitle = null;
    torn = false;
    packGone = false;
    releasing = false;
    scratchDone = false;
    later(() => (phase = "await"), plain ? 0 : 420);
  }

  /** The gesture (or the "Direct openen" button) finished. */
  function complete() {
    if (phase !== "await") return;
    phase = "charge";
    cancelAnimationFrame(holdRaf);
    holding = false;
    if (plain) {
      impact();
    } else if (tier >= 4 && effMode !== "scratch") {
      walkout();
    } else {
      showRarity = true;
      impact();
    }
  }

  /** Lights out → beams → slow push-in → impact (Episch and up). */
  function walkout() {
    const base = tier >= 6 ? 3000 : tier >= 5 ? 2200 : 1500;
    const dur = base * (full ? 1 : 0.6);
    cinematic = true;
    pushin = true;
    beamsOn = true;
    sfx.riser(dur / 1000, tier);
    // Rarity colour takes over for the last stretch.
    later(() => (showRarity = true), dur * 0.62);
    if (full) {
      later(() => {
        const r = cardEl?.getBoundingClientRect();
        const c = frontCanvas?.getBoundingClientRect();
        if (!r || !c) return;
        const rect = {
          x: r.left - c.left,
          y: r.top - c.top,
          w: r.width,
          h: r.height,
        };
        if (tier === 4)
          front?.setLoop("lightning", true, {
            rate: 5,
            color: meta.color,
            color2: "#fff",
            rect,
          });
        if (tier >= 5)
          back?.setLoop("embers", true, {
            rate: 26,
            color: meta.color,
            color2: "#fff7d6",
            rect,
          });
        if (tier >= 6) {
          auroraOn = true;
          back?.setLoop("stars", true);
        }
      }, dur * 0.3);
    }
    // Rising haptics.
    const steps = 8;
    for (let i = 1; i <= steps; i++)
      later(() => haptic.charge(i / steps), (dur / steps) * i);
    later(() => impact(), dur);
  }

  function fxCounts() {
    return plain ? 0 : full ? 1 : 0.5;
  }

  /** The moment of truth: hit-stop → flash, shockwave, flip, particles, stamp. */
  function impact(noFlip = false) {
    if (phase === "impact" || phase === "shown") return;
    phase = "impact";
    const stop = !plain && tier >= 3 ? (full ? 130 : 70) : 0;
    if (stop) {
      frozen = true;
      front?.freeze(stop);
      back?.freeze(stop);
    }
    later(() => {
      frozen = false;
      const k = fxCounts();
      showRarity = true;
      if (k > 0) {
        flash = true;
        later(() => (flash = false), 520);
        ringKey++;
        shakeLvl = full
          ? tier >= 5
            ? 3
            : tier >= 3
              ? 2
              : 1
          : tier >= 4
            ? 1
            : 0;
        later(() => (shakeLvl = 0), 800);
        particles(k);
        sfx.hit(tier);
        if (card.rarity === "glitch") sfx.glitch();
        else sfx.chime(tier);
        haptic.impact(tier);
        if (tier >= 4 && full) stampText = meta.label.toUpperCase();
        else if (tier >= 4) stampText = meta.label.toUpperCase();
        if (stampText) later(() => (stampText = null), 1700);
      }
      if (!noFlip) faceDown = false;
      record(card);
      later(
        () => {
          phase = "shown";
          cinematic = false;
          pushin = false;
          beamsOn = tier >= 5 && full ? beamsOn : false;
          if (tier < 5) back?.stopLoops();
          front?.setLoop("lightning", false);
        },
        plain ? 450 : noFlip ? 700 : 950,
      );
    }, stop);
  }

  function particles(k: number) {
    const { x, y } = center();
    const f = front;
    if (!f) return;
    const c1 = meta.color;
    const c2 = meta.color2;
    switch (card.rarity) {
      case "gewoon":
        f.burst(x, y, { count: 28 * k, color: c1, size: 3.5, speed: 280 });
        break;
      case "speciaal":
        f.burst(x, y, { count: 40 * k, color: c1, color2: "#fff", speed: 320 });
        break;
      case "glitch":
        f.burst(x, y, {
          count: 46 * k,
          color: c1,
          color2: c2,
          shape: "rect",
          glow: false,
          size: 5,
          speed: 380,
          gravity: 520,
        });
        break;
      case "zeldzaam":
        f.burst(x, y, {
          count: 60 * k,
          color: c1,
          color2: "#e0f2fe",
          speed: 340,
        });
        f.confetti(18 * k, [c1, c2, "#fff"]);
        break;
      case "episch":
        f.burst(x, y, {
          count: 100 * k,
          color: c1,
          color2: c2,
          speed: 420,
          size: 5,
        });
        f.confetti(46 * k, [c1, c2, "#f5d0fe"]);
        if (full)
          for (let i = 0; i < 6; i++)
            later(
              () =>
                f.bolt(
                  x + (Math.random() - 0.5) * 60,
                  y - 120,
                  x + (Math.random() - 0.5) * 300,
                  y + (Math.random() - 0.5) * 300,
                  c1,
                ),
              i * 70,
            );
        break;
      case "legendarisch":
        f.burst(x, y, {
          count: 150 * k,
          color: c1,
          color2: "#fff7d6",
          speed: 480,
          size: 5.5,
        });
        f.confetti(90 * k, [c1, c2, "#fff7d6"]);
        if (full) {
          back?.setLoop("goldrain", true, {
            rate: 40,
            color: c1,
            color2: "#fff7d6",
          });
          later(() => back?.setLoop("goldrain", false), 3200);
        }
        break;
      case "mythisch":
        f.burst(x, y, {
          count: 120 * k,
          color: "#f0abfc",
          color2: "#22d3ee",
          speed: 520,
          size: 5.5,
        });
        f.burst(x, y, {
          count: 90 * k,
          color: "#fde68a",
          color2: "#a7f3d0",
          speed: 380,
          size: 5,
        });
        f.confetti(130 * k, [
          "#ff5f6d",
          "#ffc371",
          "#fff275",
          "#7dff9b",
          "#5ee7ff",
          "#f093fb",
        ]);
        if (full) {
          back?.setLoop("goldrain", true, {
            rate: 50,
            color: "#fde68a",
            color2: "#f0abfc",
          });
          later(() => back?.setLoop("goldrain", false), 3600);
        }
        break;
    }
  }

  /** Achievement toasts play one after another so they never pile up. */
  function pushToasts(ids: string[]) {
    // Cap the backlog; everything is listed in the pack summary anyway.
    toastQueue.push(...ids);
    toastQueue = toastQueue.slice(0, 3);
    if (!currentToast) nextToast();
  }
  function nextToast() {
    const id = toastQueue.shift();
    if (!id) {
      currentToast = null;
      return;
    }
    currentToast = id;
    sfx.tick();
    later(() => {
      currentToast = null;
      later(nextToast, 220);
    }, 2400);
  }

  function record(c: CardData) {
    const beforeXp = get(gradeRevealState).tally.xp;
    if (!preview) {
      const opened = new Set(get(gradeRevealState).opened);
      opened.add(c.id);
      const res = recordOpen(c, {
        completeSets: countCompleteSets(collection, opened),
      });
      if (res.newlyUnlocked.length) {
        packAchievements = [...packAchievements, ...res.newlyUnlocked];
        pushToasts(res.newlyUnlocked);
      }
      onrevealed?.(c);
    }
    xpGain = c.xp;
    packXp += c.xp;
    if (!preview) {
      const afterXp = get(gradeRevealState).tally.xp;
      if (levelInfo(afterXp).level > levelInfo(beforeXp).level) {
        levelUpTitle = levelInfo(afterXp).title;
        later(() => sfx.levelUp(), 500);
        later(() => (levelUpTitle = null), 3000);
      }
    }
  }

  function next() {
    if (phase !== "shown") return;
    if (isLast) {
      if (total > 1) openSummary();
      else onclose();
      return;
    }
    index += 1;
    startCard();
  }

  function openSummary() {
    phase = "summary";
    toastQueue = [];
    currentToast = null;
    back?.stopLoops();
    shownXp = 0;
    const t0 = performance.now();
    const dur = 1100;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / dur);
      shownXp = Math.round(packXp * (1 - Math.pow(1 - k, 3)));
      if (k < 1) countRaf = requestAnimationFrame(step);
    };
    countRaf = requestAnimationFrame(step);
    if (!plain) {
      front?.confetti(70 * fxCounts(), [
        "#a78bfa",
        "#38bdf8",
        "#fbbf24",
        "#f472b6",
      ]);
      buzz([20, 30, 20]);
    }
  }

  /** Skip the gesture (button / Enter): animate the progress and finish. */
  function autoOpen() {
    if (phase !== "await" || autoRun) return;
    autoRun = true;
    cancelAnimationFrame(holdRaf);
    holding = false;
    const t0 = performance.now();
    const dur = plain || reduced ? 120 : 850;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / dur);
      progress = Math.max(progress, k);
      if (k < 1) autoRaf = requestAnimationFrame(step);
      else {
        if (effMode === "scratch") scratchDone = true;
        if (effMode === "tear") torn = true;
        complete();
      }
    };
    autoRaf = requestAnimationFrame(step);
  }

  /** Reveal everything that is left without the show, then close. */
  function revealAllNow() {
    clearTimers();
    for (let i = index; i < total; i++) {
      const c = cards[i];
      if (preview) continue;
      const opened = new Set(get(gradeRevealState).opened);
      if (opened.has(c.id)) continue;
      opened.add(c.id);
      recordOpen(c, { completeSets: countCompleteSets(collection, opened) });
      onrevealed?.(c);
    }
    onclose();
  }

  // ---------------------------------------------------------------- gestures
  // hold
  function holdStart(e: PointerEvent) {
    if (phase !== "await" || effMode !== "hold" || autoRun) return;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    holding = true;
    sfx.riser(1.4, 2);
    cancelAnimationFrame(holdRaf);
    let last = performance.now();
    const loop = (t: number) => {
      const dt = Math.min(0.05, (t - last) / 1000);
      last = t;
      progress = Math.max(
        0,
        Math.min(1, progress + (holding ? dt / 1.45 : -dt / 0.8)),
      );
      if (holding && t - lastBuzz > 330 - 250 * progress) {
        lastBuzz = t;
        haptic.charge(progress);
      }
      if (progress >= 1) {
        complete();
        return;
      }
      if (holding || progress > 0) holdRaf = requestAnimationFrame(loop);
    };
    holdRaf = requestAnimationFrame(loop);
  }
  function holdEnd() {
    holding = false;
  }

  // tear
  let tearStartX = 0;
  let tearing = false;
  let lastTearSfx = 0;
  let lastTearTick = 0;
  function tearStart(e: PointerEvent) {
    if (phase !== "await" || effMode !== "tear" || autoRun) return;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    tearing = true;
    releasing = false;
    tearStartX = e.clientX;
  }
  function tearMove(e: PointerEvent) {
    if (!tearing || phase !== "await") return;
    const k = Math.min(
      1,
      Math.abs(e.clientX - tearStartX) / (16 * cardScale * 0.5),
    );
    if (k > progress) {
      const now = performance.now();
      if (now - lastTearSfx > 70) {
        lastTearSfx = now;
        sfx.tear(1 + k);
      }
      if (now - lastTearTick > 110) {
        lastTearTick = now;
        haptic.tick();
      }
    }
    progress = k;
    if (k >= 0.9) {
      tearing = false;
      torn = true;
      progress = 1;
      buzz([25, 20, 50]);
      later(() => (packGone = true), 650);
      complete();
    }
  }
  function tearEnd() {
    if (!tearing) return;
    tearing = false;
    releasing = true;
    progress = 0;
  }

  // scratch
  function drawFoil(g: CanvasRenderingContext2D, W: number, H: number) {
    const r = cardScale * 1.1;
    g.save();
    g.beginPath();
    g.moveTo(r, 0);
    g.arcTo(W, 0, W, H, r);
    g.arcTo(W, H, 0, H, r);
    g.arcTo(0, H, 0, 0, r);
    g.arcTo(0, 0, W, 0, r);
    g.closePath();
    g.clip();
    const grad = g.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, "#d6dde8");
    grad.addColorStop(0.3, "#8fa0bb");
    grad.addColorStop(0.5, "#eef2f8");
    grad.addColorStop(0.7, "#7a8aa6");
    grad.addColorStop(1, "#cdd6e4");
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H);
    const holo = g.createLinearGradient(0, H, W, 0);
    holo.addColorStop(0, "rgba(255,120,200,0.22)");
    holo.addColorStop(0.5, "rgba(120,220,255,0.22)");
    holo.addColorStop(1, "rgba(255,230,120,0.22)");
    g.fillStyle = holo;
    g.fillRect(0, 0, W, H);
    g.strokeStyle = "rgba(255,255,255,0.22)";
    g.lineWidth = 1;
    for (let x = -H; x < W; x += 9) {
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x + H, H);
      g.stroke();
    }
    g.translate(W / 2, H / 2);
    g.rotate(-0.38);
    g.font = `900 ${W * 0.26}px system-ui, sans-serif`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillStyle = "rgba(255,255,255,0.34)";
    for (let row = -3; row <= 3; row++) g.fillText("KRAS", 0, row * W * 0.3);
    g.restore();
    g.strokeStyle = "rgba(255,255,255,0.7)";
    g.lineWidth = 3;
    g.stroke();
  }

  /** Action: sets up the scratch-off foil and its gesture handling. */
  function foil(node: HTMLCanvasElement) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = Math.round(16 * cardScale);
    const H = Math.round(22.4 * cardScale);
    node.width = W * dpr;
    node.height = H * dpr;
    node.style.width = `${W}px`;
    node.style.height = `${H}px`;
    const g = node.getContext("2d")!;
    g.scale(dpr, dpr);
    drawFoil(g, W, H);
    const MW = 20;
    const MH = 28;
    const mask = document.createElement("canvas");
    mask.width = MW;
    mask.height = MH;
    const m = mask.getContext("2d", { willReadFrequently: true })!;
    m.fillStyle = "#000";
    m.fillRect(0, 0, MW, MH);
    let last: { x: number; y: number } | null = null;
    let lastCheck = 0;
    let lastSfx = 0;
    let lastTick = 0;

    const pos = (e: PointerEvent) => {
      const r = node.getBoundingClientRect();
      return {
        x: ((e.clientX - r.left) * W) / r.width,
        y: ((e.clientY - r.top) * H) / r.height,
      };
    };
    const stroke = (
      a: { x: number; y: number },
      b: { x: number; y: number },
    ) => {
      g.globalCompositeOperation = "destination-out";
      g.lineCap = "round";
      g.lineJoin = "round";
      g.lineWidth = W * 0.17;
      g.beginPath();
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, b.y);
      g.stroke();
      m.globalCompositeOperation = "destination-out";
      m.lineCap = "round";
      m.lineWidth = MW * 0.17;
      m.beginPath();
      m.moveTo((a.x * MW) / W, (a.y * MH) / H);
      m.lineTo((b.x * MW) / W, (b.y * MH) / H);
      m.stroke();
    };
    const coverage = () => {
      const d = m.getImageData(0, 0, MW, MH).data;
      let clear = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] < 128) clear++;
      return clear / (MW * MH);
    };
    const finish = () => {
      last = null;
      scratchDone = true;
      progress = 1;
      buzz([20, 20, 40]);
      const { x, y } = center();
      front?.burst(x, y, {
        count: 30 * fxCounts(),
        color: "#e2e8f0",
        color2: "#fff",
        speed: 300,
        size: 3,
        glow: true,
      });
      complete();
    };
    const down = (e: PointerEvent) => {
      if (phase !== "await" || scratchDone) return;
      node.setPointerCapture?.(e.pointerId);
      last = pos(e);
      stroke(last, last);
    };
    const move = (e: PointerEvent) => {
      if (!last || phase !== "await") return;
      const p = pos(e);
      const speed = Math.hypot(p.x - last.x, p.y - last.y);
      stroke(last, p);
      last = p;
      const now = performance.now();
      if (now - lastSfx > 60) {
        lastSfx = now;
        sfx.scratch(speed / 30);
      }
      if (now - lastTick > 95) {
        lastTick = now;
        haptic.tick();
      }
      if (now - lastCheck > 80) {
        lastCheck = now;
        const cov = coverage();
        progress = Math.min(1, cov / 0.5);
        if (cov >= 0.5) finish();
      }
    };
    const up = () => (last = null);
    node.addEventListener("pointerdown", down);
    node.addEventListener("pointermove", move);
    node.addEventListener("pointerup", up);
    node.addEventListener("pointercancel", up);
    return {
      destroy() {
        node.removeEventListener("pointerdown", down);
        node.removeEventListener("pointermove", move);
        node.removeEventListener("pointerup", up);
        node.removeEventListener("pointercancel", up);
      },
    };
  }

  // ---------------------------------------------------------------- keys
  function primary() {
    if (phase === "await") autoOpen();
    else if (phase === "shown") next();
    else if (phase === "summary") onclose();
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onclose();
    } else if (
      e.key === "Enter" ||
      (e.key === " " && !(e.target instanceof HTMLButtonElement))
    ) {
      e.preventDefault();
      primary();
    }
  }

  $effect(() => {
    void phase;
    tick().then(() =>
      document.getElementById("pack-primary")?.focus({ preventScroll: true }),
    );
  });

  const MODE_TEXT: Record<Mode, string> = {
    tear: "Veeg over het pakje om het open te scheuren",
    scratch: "Kras de folie weg met je vinger",
    hold: "Houd de kaart ingedrukt",
    tap: "Tik om te openen",
  };
  const MODE_ICON: Record<Mode, string> = {
    tear: "✂️",
    scratch: "🪙",
    hold: "⚡",
    tap: "👆",
  };

  const best = $derived(cards[cards.length - 1]);
  const li = $derived(levelNow);
</script>

<svelte:window onkeydown={onKey} />

<div
  class="root"
  class:cine={cinematic}
  class:freeze={frozen}
  class:lite
  class:plain
  role="dialog"
  aria-modal="true"
  aria-label="Kaarten openen"
  style="--rc:{rc}; --rc2:{rc2};"
  transition:fade|global={{ duration: 220 }}
>
  <div class="bg"></div>
  <div class="aurora" class:on={auroraOn}></div>
  <div class="beams" class:on={beamsOn}></div>
  <canvas bind:this={backCanvas} class="fx"></canvas>

  <button type="button" class="close" onclick={onclose} aria-label="Sluiten">
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2.5"
      stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg
    >
  </button>

  {#if phase !== "summary"}
    <div class="stage shake-{shakeLvl}">
      <p class="count" class:hide={cinematic}>
        {#if preview}Voorbeeldpakket ·
        {/if}Kaart {index + 1} van {total}
        <span class="modechip">{MODE_ICON[effMode]}</span>
      </p>

      {#key index}
        <div
          class="scene"
          style="--card-w:{16 * cardScale}px; --card-h:{22.4 *
            cardScale}px; --p:{progress}"
        >
          {#if effMode === "hold" && (phase === "await" || phase === "charge")}
            <div class="ring" class:full={progress > 0.97}></div>
          {/if}
          <div
            class="aura"
            class:charged={showRarity}
            class:on={(phase !== "intro" && phase !== "await") || progress > 0}
          ></div>

          <div
            class="mover"
            class:float={phase === "await" && progress === 0 && !plain}
            class:jitter={(effMode === "hold" &&
              progress > 0.02 &&
              phase === "await") ||
              phase === "charge"}
            class:pushin
            class:intro={phase === "intro"}
            style="--amp:{phase === 'charge' ? 5 : progress * 7}"
          >
            <div
              class="cardhost"
              class:clip={effMode === "scratch" && !scratchDone}
              bind:this={cardEl}
              onpointerdown={holdStart}
              onpointerup={holdEnd}
              onpointercancel={holdEnd}
              onclick={() =>
                effMode === "tap" && phase === "await" && autoOpen()}
              role="presentation"
            >
              <GradeCardView
                {card}
                scale={cardScale}
                {faceDown}
                tiltOn={phase === "shown"}
                calm={plain ||
                  (phase !== "shown" &&
                    phase !== "impact" &&
                    effMode === "scratch" &&
                    !scratchDone)}
                {lite}
              />

              {#if effMode === "scratch" && !scratchDone}
                <canvas class="foil" use:foil></canvas>
              {:else if effMode === "scratch" && phase !== "shown"}
                <canvas class="foil fade-out" use:foil></canvas>
              {/if}

              {#if effMode === "tear" && !packGone}
                <div
                  class="pack"
                  class:torn
                  class:releasing
                  style="--p:{progress}"
                  onpointerdown={tearStart}
                  onpointermove={tearMove}
                  onpointerup={tearEnd}
                  onpointercancel={tearEnd}
                  role="presentation"
                >
                  <div class="seam"></div>
                  <div class="half left">
                    <span class="logo">FRIDAY</span><span class="shine"></span>
                  </div>
                  <div class="half right">
                    <span class="logo">FRIDAY</span><span class="shine"></span>
                  </div>
                </div>
              {/if}
            </div>
          </div>

          {#if ringKey > 0}
            {#key ringKey}
              <div class="shock s1"></div>
              <div class="shock s2"></div>
              <div class="shock s3"></div>
            {/key}
          {/if}
        </div>
      {/key}

      <div class="below" class:hide={cinematic}>
        {#if phase === "await" || phase === "intro" || phase === "charge"}
          <p class="prompt">{MODE_TEXT[effMode]}</p>
          <div class="progressbar" class:hidden={effMode === "tap"}>
            <i style="width:{progress * 100}%"></i>
          </div>
          <button
            type="button"
            id="pack-primary"
            class="btn ghost"
            onclick={autoOpen}
            disabled={phase !== "await"}
          >
            Direct openen
          </button>
          {#if total > 1 && !preview}
            <button type="button" class="link" onclick={revealAllNow}
              >Alles direct tonen</button
            >
          {/if}
        {:else if phase === "shown"}
          <div class="xpline" in:fly={{ y: 14, duration: 350 }}>
            <span class="xp">+{xpGain} XP</span>
            <span class="rarity" style="color:{meta.color}">{meta.label}</span>
          </div>
          <button type="button" id="pack-primary" class="btn" onclick={next}>
            {isLast
              ? total > 1
                ? "Bekijk pakket"
                : "Klaar"
              : "Volgende kaart"}
          </button>
        {/if}
      </div>
    </div>
  {:else}
    <div class="summary" in:fade={{ duration: 300 }}>
      <h2>Pakket geopend!</h2>
      <div class="bestwrap">
        <GradeCardView
          card={best}
          scale={Math.min(10, cardScale * 0.72)}
          tiltOn
          calm={plain}
          {lite}
        />
        <p class="bestlabel">
          Beste trekking · {RARITY_META[best.rarity].label}
        </p>
      </div>
      <div class="grid">
        {#each cards as c, i (c.id)}
          <div class="mini" style="animation-delay:{i * 70}ms">
            <GradeCardView card={c} scale={4.4} calm />
          </div>
        {/each}
      </div>
      <div class="totals">
        <div class="totalxp">+{shownXp} XP</div>
        {#if !preview}
          <div class="lvl">
            <span>Level {li.level} · {li.title}</span>
            <div class="xpbar"><i style="width:{li.pct * 100}%"></i></div>
            <small>{li.into} / {li.need} XP</small>
          </div>
        {/if}
      </div>
      {#if packAchievements.length}
        <div class="achs">
          {#each packAchievements as id (id)}
            {@const a = ACHIEVEMENTS.find((x) => x.id === id)}
            {#if a}<div class="ach">
                <span>{a.icon}</span>
                <div><b>{a.title}</b><small>{a.desc}</small></div>
              </div>{/if}
          {/each}
        </div>
      {/if}
      <button type="button" id="pack-primary" class="btn" onclick={onclose}
        >Klaar</button
      >
    </div>
  {/if}

  <canvas bind:this={frontCanvas} class="fx front"></canvas>

  <div class="lbox top" class:on={cinematic}></div>
  <div class="lbox bottom" class:on={cinematic}></div>
  <div class="flash" class:on={flash}></div>
  {#if stampText}
    <div
      class="stamp"
      style="--rc:{meta.color}; --rc2:{meta.color2}"
      aria-hidden="true"
    >
      {stampText}
    </div>
  {/if}

  {#if levelUpTitle}
    <div class="levelup" in:fly={{ y: -30, duration: 400 }} out:fade>
      <span>LEVEL UP</span> <b>{levelUpTitle}</b>
    </div>
  {/if}

  <div class="toasts" aria-live="polite">
    {#if currentToast}
      {#key currentToast}
        {@const a = ACHIEVEMENTS.find((x) => x.id === currentToast)}
        {#if a}
          <div
            class="toast"
            in:fly={{ y: -24, duration: 320 }}
            out:fade={{ duration: 180 }}
          >
            <span class="ti">{a.icon}</span>
            <div><b>{a.title}</b><small>{a.desc}</small></div>
          </div>
        {/if}
      {/key}
    {/if}
  </div>

  <span class="sr-only" aria-live="polite">
    {phase === "shown" ? `${card.subject}: ${card.value}, ${meta.label}` : ""}
  </span>
</div>

<style>
  .root {
    position: fixed;
    inset: 0;
    z-index: 200;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    color: #fff;
    touch-action: none;
    user-select: none;
    -webkit-user-select: none;
  }
  .root.freeze *,
  .root.freeze {
    animation-play-state: paused !important;
  }
  .bg {
    position: absolute;
    inset: 0;
    background:
      radial-gradient(
        70% 50% at 50% 44%,
        color-mix(in srgb, var(--rc) 24%, transparent),
        transparent 70%
      ),
      rgba(5, 4, 12, 0.94);
    backdrop-filter: blur(10px);
    transition: background 0.6s;
  }
  .root.cine .bg {
    background:
      radial-gradient(
        60% 42% at 50% 44%,
        color-mix(in srgb, var(--rc) 22%, transparent),
        transparent 70%
      ),
      #000;
  }
  .fx {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
  }
  .fx.front {
    z-index: 30;
  }
  .close {
    position: absolute;
    z-index: 40;
    top: calc(env(safe-area-inset-top, 0px) + 12px);
    right: 14px;
    width: 40px;
    height: 40px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    color: #9ca3af;
    transition:
      background 0.15s,
      opacity 0.3s;
  }
  .close svg {
    width: 20px;
    height: 20px;
  }
  .close:hover {
    background: rgba(255, 255, 255, 0.1);
    color: #fff;
  }
  .root.cine .close {
    opacity: 0;
    pointer-events: none;
  }

  /* ---------- stage ---------- */
  .stage {
    position: relative;
    z-index: 10;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1.1rem;
    width: 100%;
  }
  .count {
    font-size: 0.8125rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    color: #9ca3af;
    font-variant-numeric: tabular-nums;
    transition: opacity 0.4s;
  }
  .modechip {
    margin-left: 0.4rem;
    padding: 0.1rem 0.45rem;
    border-radius: 99px;
    background: rgba(255, 255, 255, 0.08);
  }
  .hide {
    opacity: 0;
    pointer-events: none;
  }
  .scene {
    position: relative;
    width: var(--card-w);
    height: var(--card-h);
    display: grid;
    place-items: center;
  }
  .mover {
    position: relative;
    width: 100%;
    height: 100%;
    z-index: 3;
  }
  .mover.intro {
    animation: card-in 0.5s cubic-bezier(0.2, 0.9, 0.3, 1.2) both;
  }
  .mover.float {
    animation: float 3.2s ease-in-out infinite;
  }
  .mover.jitter {
    animation: jitter 0.09s linear infinite;
  }
  .mover.pushin {
    animation: pushin 3s cubic-bezier(0.5, 0, 0.9, 0.7) forwards;
  }
  .cardhost {
    position: relative;
    width: 100%;
    height: 100%;
    touch-action: none;
  }
  .cardhost.clip {
    overflow: hidden;
    border-radius: 1.6rem;
  }

  /* ---------- hold ring / aura ---------- */
  .ring {
    position: absolute;
    z-index: 2;
    width: calc(var(--card-w) * 1.5);
    height: calc(var(--card-w) * 1.5);
    border-radius: 50%;
    background: conic-gradient(
      var(--rc) calc(var(--p) * 360deg),
      rgba(255, 255, 255, 0.08) 0
    );
    -webkit-mask: radial-gradient(
      circle,
      transparent 62%,
      #000 63%,
      #000 68%,
      transparent 69%
    );
    mask: radial-gradient(
      circle,
      transparent 62%,
      #000 63%,
      #000 68%,
      transparent 69%
    );
    filter: drop-shadow(0 0 10px var(--rc));
  }
  .ring.full {
    animation: ring-pop 0.25s ease-out;
  }
  .aura {
    position: absolute;
    z-index: 1;
    width: calc(var(--card-w) * 1.9);
    height: calc(var(--card-w) * 1.9);
    border-radius: 50%;
    background: radial-gradient(
      circle,
      color-mix(in srgb, var(--rc) 55%, transparent),
      transparent 66%
    );
    opacity: 0.25;
    transform: scale(calc(0.7 + var(--p) * 0.5));
    transition:
      opacity 0.5s,
      background 0.4s;
    pointer-events: none;
  }
  .aura.on {
    opacity: calc(0.45 + var(--p) * 0.5);
  }
  .aura.charged {
    animation: aura-pulse 0.9s ease-in-out infinite alternate;
  }

  /* ---------- tear pack ---------- */
  .pack {
    position: absolute;
    inset: 0;
    z-index: 5;
    touch-action: none;
    cursor: grab;
  }
  .half {
    position: absolute;
    inset: 0;
    border-radius: 1.6rem;
    background: linear-gradient(
      135deg,
      #4b5a75 0%,
      #9fb0cb 28%,
      #e9eff8 48%,
      #7c8da8 70%,
      #3f4c66 100%
    );
    box-shadow:
      inset 0 0 0 2px rgba(255, 255, 255, 0.35),
      0 8px 24px rgba(0, 0, 0, 0.5);
    overflow: hidden;
    display: grid;
    place-items: center;
    will-change: transform;
  }
  .half .logo {
    font-size: calc(var(--card-w) * 0.2);
    font-weight: 900;
    letter-spacing: 0.12em;
    color: rgba(255, 255, 255, 0.55);
    text-shadow: 0 2px 6px rgba(0, 0, 0, 0.4);
    transform: rotate(-90deg);
  }
  .half .shine {
    position: absolute;
    inset: -50%;
    background: linear-gradient(
      115deg,
      transparent 42%,
      rgba(255, 255, 255, 0.4) 50%,
      transparent 58%
    );
    animation: sweep 2.8s ease-in-out infinite;
  }
  .half.left {
    clip-path: polygon(
      0 0,
      50% 0,
      46% 5%,
      54% 10%,
      47% 15%,
      55% 21%,
      46% 27%,
      54% 33%,
      47% 40%,
      55% 47%,
      46% 54%,
      54% 60%,
      47% 67%,
      55% 74%,
      46% 81%,
      54% 88%,
      48% 94%,
      50% 100%,
      0 100%
    );
    transform-origin: 0 100%;
    transform: translateX(calc(var(--p) * -58%)) rotate(calc(var(--p) * -11deg));
  }
  .half.right {
    clip-path: polygon(
      50% 0,
      100% 0,
      100% 100%,
      50% 100%,
      48% 94%,
      54% 88%,
      46% 81%,
      55% 74%,
      47% 67%,
      54% 60%,
      46% 54%,
      55% 47%,
      47% 40%,
      54% 33%,
      46% 27%,
      55% 21%,
      47% 15%,
      54% 10%,
      46% 5%
    );
    transform-origin: 100% 100%;
    transform: translateX(calc(var(--p) * 58%)) rotate(calc(var(--p) * 11deg));
  }
  .pack.releasing .half {
    transition: transform 0.38s cubic-bezier(0.3, 1.4, 0.5, 1);
  }
  .pack.torn .half.left {
    transition:
      transform 0.6s cubic-bezier(0.5, 0, 0.9, 0.5),
      opacity 0.6s;
    transform: translate(-130%, 40%) rotate(-38deg);
    opacity: 0;
  }
  .pack.torn .half.right {
    transition:
      transform 0.6s cubic-bezier(0.5, 0, 0.9, 0.5),
      opacity 0.6s;
    transform: translate(130%, 40%) rotate(38deg);
    opacity: 0;
  }
  .seam {
    position: absolute;
    z-index: -1;
    top: -2%;
    bottom: -2%;
    left: 50%;
    width: calc(6% + var(--p) * 34%);
    transform: translateX(-50%);
    background: linear-gradient(90deg, transparent, #fff, transparent);
    opacity: calc(var(--p) * 1.2);
    filter: blur(6px);
  }

  /* ---------- scratch foil ---------- */
  .foil {
    position: absolute;
    inset: 0;
    z-index: 5;
    border-radius: 1.6rem;
    touch-action: none;
    cursor: crosshair;
  }
  .foil.fade-out {
    pointer-events: none;
    animation: fade-away 0.4s ease-out forwards;
  }

  /* ---------- shock rings ---------- */
  .shock {
    position: absolute;
    z-index: 2;
    width: calc(var(--card-w) * 0.6);
    height: calc(var(--card-w) * 0.6);
    border-radius: 50%;
    border: 3px solid #fff;
    opacity: 0;
    pointer-events: none;
    animation: shock 0.9s cubic-bezier(0.1, 0.7, 0.3, 1) forwards;
  }
  .shock.s1 {
    border-color: #22d3ee;
    translate: -5px 0;
    mix-blend-mode: screen;
  }
  .shock.s2 {
    border-color: #ff3b6b;
    translate: 5px 0;
    mix-blend-mode: screen;
    animation-delay: 0.02s;
  }
  .shock.s3 {
    border-color: var(--rc);
    animation-delay: 0.08s;
    box-shadow: 0 0 40px var(--rc);
  }

  /* ---------- text under the card ---------- */
  .below {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.7rem;
    min-height: 7.5rem;
    transition: opacity 0.4s;
  }
  .prompt {
    font-size: 0.95rem;
    font-weight: 600;
    color: #e5e7eb;
    text-align: center;
    max-width: 18rem;
  }
  .progressbar {
    width: 9rem;
    height: 4px;
    border-radius: 99px;
    background: rgba(255, 255, 255, 0.1);
    overflow: hidden;
  }
  .progressbar.hidden {
    visibility: hidden;
  }
  .progressbar i {
    display: block;
    height: 100%;
    background: linear-gradient(90deg, var(--rc), var(--rc2));
    border-radius: inherit;
  }
  .btn {
    height: 3rem;
    min-width: 12rem;
    padding: 0 2rem;
    border-radius: 9999px;
    font-size: 0.9375rem;
    font-weight: 700;
    background: var(--m3-primary, #d8b4fe);
    color: var(--m3-on-primary, #4c1d95);
    box-shadow: 0 8px 28px -8px
      color-mix(in srgb, var(--color-primary-500) 70%, transparent);
    transition:
      filter 0.15s,
      transform 0.15s,
      opacity 0.15s;
  }
  .btn:hover:not(:disabled) {
    filter: brightness(1.08);
  }
  .btn:active:not(:disabled) {
    transform: scale(0.96);
  }
  .btn:disabled {
    opacity: 0.4;
  }
  .btn:focus-visible {
    outline: 2px solid #fff;
    outline-offset: 3px;
  }
  .btn.ghost {
    height: 2.5rem;
    min-width: 0;
    padding: 0 1.2rem;
    font-size: 0.8125rem;
    background: rgba(255, 255, 255, 0.08);
    color: #d1d5db;
    box-shadow: none;
  }
  .link {
    font-size: 0.75rem;
    color: #6b7280;
    text-decoration: underline;
    text-underline-offset: 4px;
  }
  .link:hover {
    color: #d1d5db;
  }
  .xpline {
    display: flex;
    align-items: baseline;
    gap: 0.8rem;
  }
  .xp {
    font-size: 1.4rem;
    font-weight: 900;
    color: #fde68a;
    text-shadow: 0 0 18px rgba(253, 230, 138, 0.6);
    animation: xp-pop 0.6s cubic-bezier(0.2, 1.5, 0.4, 1) both;
  }
  .rarity {
    font-size: 0.8125rem;
    font-weight: 800;
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }

  /* ---------- cinematic layers ---------- */
  .beams {
    position: absolute;
    inset: -30%;
    opacity: 0;
    transition: opacity 1s;
    background: repeating-conic-gradient(
      from 0deg at 50% 46%,
      color-mix(in srgb, var(--rc) 38%, transparent) 0 5deg,
      transparent 5deg 22deg
    );
    -webkit-mask: radial-gradient(circle at 50% 46%, #000 0, transparent 58%);
    mask: radial-gradient(circle at 50% 46%, #000 0, transparent 58%);
    animation: spin 16s linear infinite;
    pointer-events: none;
    mix-blend-mode: screen;
  }
  .beams.on {
    opacity: 1;
  }
  .aurora {
    position: absolute;
    inset: -20%;
    opacity: 0;
    transition: opacity 1.2s;
    background:
      radial-gradient(
        40% 30% at 25% 30%,
        rgba(34, 211, 238, 0.5),
        transparent 70%
      ),
      radial-gradient(
        45% 30% at 75% 40%,
        rgba(240, 171, 252, 0.5),
        transparent 70%
      ),
      radial-gradient(
        50% 30% at 50% 80%,
        rgba(250, 204, 21, 0.35),
        transparent 70%
      );
    filter: blur(24px);
    animation: aurora 6s ease-in-out infinite alternate;
    pointer-events: none;
  }
  .aurora.on {
    opacity: 1;
  }
  .root.lite .aurora,
  .root.lite .beams {
    filter: none;
    mix-blend-mode: normal;
    animation: none;
  }
  .lbox {
    position: absolute;
    z-index: 35;
    left: 0;
    right: 0;
    height: calc(env(safe-area-inset-top, 0px) + 11vh);
    background: #000;
    transition: transform 0.55s cubic-bezier(0.5, 0, 0.2, 1);
    pointer-events: none;
  }
  .lbox.top {
    top: 0;
    transform: translateY(-101%);
  }
  .lbox.bottom {
    bottom: 0;
    transform: translateY(101%);
  }
  .lbox.on {
    transform: none;
  }
  .flash {
    position: absolute;
    inset: 0;
    z-index: 32;
    pointer-events: none;
    opacity: 0;
    background: radial-gradient(
      circle at 50% 46%,
      #fff,
      color-mix(in srgb, var(--rc) 60%, transparent) 40%,
      transparent 75%
    );
  }
  .flash.on {
    animation: flash 0.52s ease-out;
  }
  .stamp {
    position: absolute;
    z-index: 36;
    left: 50%;
    top: 40%;
    font-size: clamp(1.9rem, 10vw, 3.2rem);
    font-weight: 900;
    letter-spacing: 0.1em;
    white-space: nowrap;
    color: transparent;
    background: linear-gradient(180deg, #fff, var(--rc) 55%, var(--rc2));
    -webkit-background-clip: text;
    background-clip: text;
    filter: drop-shadow(0 0 18px var(--rc))
      drop-shadow(0 6px 0 rgba(0, 0, 0, 0.5));
    animation: slam 1.7s cubic-bezier(0.2, 0.9, 0.2, 1) forwards;
    pointer-events: none;
  }
  .shake-1 {
    animation: shake1 0.5s;
  }
  .shake-2 {
    animation: shake2 0.7s;
  }
  .shake-3 {
    animation: shake3 0.9s;
  }

  /* ---------- summary ---------- */
  .summary {
    position: relative;
    z-index: 10;
    width: 100%;
    max-width: 26rem;
    max-height: 100%;
    overflow-y: auto;
    padding: calc(env(safe-area-inset-top, 0px) + 2.5rem) 1.25rem 2rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
    touch-action: pan-y;
  }
  .summary h2 {
    font-size: 1.6rem;
    font-weight: 900;
    letter-spacing: -0.02em;
    background: linear-gradient(90deg, #fde68a, #f0abfc, #67e8f9);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
  }
  .bestwrap {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.6rem;
  }
  .bestlabel {
    font-size: 0.75rem;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: #9ca3af;
  }
  .grid {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 0.5rem;
  }
  .mini {
    animation: mini-pop 0.5s cubic-bezier(0.2, 1.4, 0.4, 1) both;
  }
  .totals {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.6rem;
    width: 100%;
  }
  .totalxp {
    font-size: 1.9rem;
    font-weight: 900;
    color: #fde68a;
    text-shadow: 0 0 20px rgba(253, 230, 138, 0.5);
    font-variant-numeric: tabular-nums;
  }
  .lvl {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    align-items: center;
    font-weight: 700;
    font-size: 0.9rem;
  }
  .lvl small {
    color: #9ca3af;
    font-weight: 500;
    font-size: 0.72rem;
  }
  .lvl .xpbar {
    width: 100%;
    height: 8px;
    border-radius: 99px;
    background: rgba(255, 255, 255, 0.1);
    overflow: hidden;
  }
  .lvl .xpbar i {
    display: block;
    height: 100%;
    background: linear-gradient(90deg, #a78bfa, #f0abfc);
    border-radius: inherit;
    transition: width 1s cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  .achs {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    width: 100%;
  }
  .ach,
  .toast {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.6rem 0.9rem;
    border-radius: 1rem;
    background: rgba(255, 255, 255, 0.07);
    border: 1px solid rgba(255, 255, 255, 0.1);
    text-align: left;
  }
  .ach span,
  .ti {
    font-size: 1.5rem;
  }
  .ach b,
  .toast b {
    display: block;
    font-size: 0.875rem;
  }
  .ach small,
  .toast small {
    display: block;
    color: #9ca3af;
    font-size: 0.72rem;
  }
  .toasts {
    position: absolute;
    z-index: 38;
    left: 0;
    right: 0;
    top: calc(env(safe-area-inset-top, 0px) + 3.9rem);
    display: flex;
    justify-content: center;
    pointer-events: none;
  }
  .toast {
    background: rgba(24, 20, 42, 0.92);
    border-color: rgba(251, 191, 36, 0.5);
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.5);
  }
  .levelup {
    position: absolute;
    z-index: 37;
    top: calc(env(safe-area-inset-top, 0px) + 0.9rem);
    display: flex;
    gap: 0.6rem;
    align-items: baseline;
    padding: 0.5rem 1.1rem;
    border-radius: 99px;
    background: linear-gradient(90deg, #7c3aed, #db2777);
    box-shadow: 0 0 30px rgba(168, 85, 247, 0.6);
    font-size: 0.9rem;
  }
  .levelup span {
    font-weight: 900;
    letter-spacing: 0.14em;
  }

  /* ---------- plain (Uit / reduced motion) ---------- */
  .plain *,
  .plain {
    animation-duration: 0.001s !important;
    animation-iteration-count: 1 !important;
  }
  .plain .beams,
  .plain .aurora,
  .plain .fx {
    display: none;
  }

  /* ---------- keyframes ---------- */
  @keyframes card-in {
    from {
      transform: translateY(40px) scale(0.85) rotate(-4deg);
      opacity: 0;
    }
    to {
      transform: none;
      opacity: 1;
    }
  }
  @keyframes float {
    0%,
    100% {
      transform: translateY(0) rotate(-0.8deg);
    }
    50% {
      transform: translateY(-9px) rotate(0.8deg);
    }
  }
  @keyframes jitter {
    0% {
      transform: translate(calc(var(--amp) * -1px), calc(var(--amp) * 0.4px))
        rotate(-0.4deg);
    }
    25% {
      transform: translate(calc(var(--amp) * 0.8px), calc(var(--amp) * -0.6px))
        rotate(0.5deg);
    }
    50% {
      transform: translate(calc(var(--amp) * -0.6px), calc(var(--amp) * -0.8px))
        rotate(-0.3deg);
    }
    75% {
      transform: translate(calc(var(--amp) * 0.9px), calc(var(--amp) * 0.5px))
        rotate(0.4deg);
    }
    100% {
      transform: translate(calc(var(--amp) * -1px), calc(var(--amp) * 0.4px))
        rotate(-0.4deg);
    }
  }
  @keyframes pushin {
    0% {
      transform: scale(1);
    }
    100% {
      transform: scale(1.22);
    }
  }
  @keyframes ring-pop {
    50% {
      transform: scale(1.08);
    }
  }
  @keyframes aura-pulse {
    to {
      transform: scale(1.25);
      opacity: 1;
    }
  }
  @keyframes sweep {
    0%,
    30% {
      transform: translateX(-60%);
    }
    70%,
    100% {
      transform: translateX(60%);
    }
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @keyframes aurora {
    0% {
      transform: translate(-5%, -3%) scale(1);
    }
    100% {
      transform: translate(5%, 4%) scale(1.15);
    }
  }
  @keyframes flash {
    0% {
      opacity: 1;
    }
    100% {
      opacity: 0;
    }
  }
  @keyframes shock {
    0% {
      opacity: 0.95;
      transform: scale(0.3);
    }
    100% {
      opacity: 0;
      transform: scale(4.2);
    }
  }
  @keyframes slam {
    0% {
      transform: translate(-50%, -50%) scale(4) rotate(-8deg);
      opacity: 0;
    }
    14% {
      transform: translate(-50%, -50%) scale(0.92) rotate(-4deg);
      opacity: 1;
    }
    22% {
      transform: translate(-50%, -50%) scale(1.04) rotate(-4deg);
    }
    30%,
    80% {
      transform: translate(-50%, -50%) scale(1) rotate(-4deg);
      opacity: 1;
    }
    100% {
      transform: translate(-50%, -62%) scale(1.06) rotate(-4deg);
      opacity: 0;
    }
  }
  @keyframes xp-pop {
    0% {
      transform: scale(0.3);
      opacity: 0;
    }
    100% {
      transform: scale(1);
      opacity: 1;
    }
  }
  @keyframes fade-away {
    to {
      opacity: 0;
      transform: scale(1.04);
    }
  }
  @keyframes mini-pop {
    0% {
      transform: scale(0.2) rotate(-12deg);
      opacity: 0;
    }
    100% {
      transform: none;
      opacity: 1;
    }
  }
  @keyframes shake1 {
    0%,
    100% {
      transform: none;
    }
    25% {
      transform: translate(-3px, 2px);
    }
    50% {
      transform: translate(3px, -2px);
    }
    75% {
      transform: translate(-2px, -1px);
    }
  }
  @keyframes shake2 {
    0%,
    100% {
      transform: none;
    }
    15% {
      transform: translate(-8px, 4px) rotate(-0.6deg);
    }
    30% {
      transform: translate(7px, -5px) rotate(0.6deg);
    }
    45% {
      transform: translate(-6px, -3px);
    }
    60% {
      transform: translate(5px, 4px);
    }
    80% {
      transform: translate(-2px, 2px);
    }
  }
  @keyframes shake3 {
    0%,
    100% {
      transform: none;
    }
    10% {
      transform: translate(-14px, 7px) rotate(-1deg);
    }
    22% {
      transform: translate(12px, -9px) rotate(1deg);
    }
    34% {
      transform: translate(-11px, -6px) rotate(-0.8deg);
    }
    46% {
      transform: translate(9px, 8px) rotate(0.8deg);
    }
    60% {
      transform: translate(-6px, 4px);
    }
    78% {
      transform: translate(3px, -3px);
    }
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
</style>
