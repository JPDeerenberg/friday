<script lang="ts">
  /**
   * One collectible grade card.
   *
   * Everything is sized in `em`, so `scale` (px per em) is the only size knob:
   * the card is 16em × 22.4em. Front and back are real 3D faces, so flipping is
   * a transition on `faceDown`. Tilt/foil are driven by CSS variables set by the
   * `tilt` action (--rx/--ry/--mx/--my).
   */
  import {
    RARITY_META,
    STAMP_META,
    artShapes,
    mulberry32,
    polyPoints,
    type CardData,
  } from "$lib/cards";
  import { tilt } from "$lib/tilt";

  let {
    card,
    scale = 10.5,
    faceDown = false,
    tiltOn = false,
    calm = false,
    lite = false,
    animateFlip = true,
    class: className = "",
  }: {
    card: CardData;
    /** Pixels per em (card width = 16 × scale). */
    scale?: number;
    faceDown?: boolean;
    /** Follow finger / phone tilt with the foil. */
    tiltOn?: boolean;
    /** No ambient animation (reduced motion, "Uit" intensity, mini cards). */
    calm?: boolean;
    /** Skip the expensive blend/filter layers (low-end phones). */
    lite?: boolean;
    animateFlip?: boolean;
    class?: string;
  } = $props();

  const meta = $derived(RARITY_META[card.rarity]);
  const shapes = $derived(artShapes(card.seed, card.rarity));
  const mini = $derived(scale < 8);

  // Deterministic decoration that only depends on the seed.
  const sparkles = $derived.by(() => {
    const rnd = mulberry32(card.seed ^ 0x9e3779b9);
    return Array.from({ length: 9 }, () => ({
      x: Math.round(rnd() * 100),
      y: Math.round(rnd() * 100),
      s: 0.6 + rnd() * 1.1,
      d: Math.round(rnd() * 2400),
    }));
  });
  const bolts = $derived.by(() => {
    const rnd = mulberry32(card.seed ^ 0x51ed270b);
    return [0, 1].map((n) => {
      let x = 20 + n * 120 + rnd() * 30;
      let y = 0;
      const pts = [`${x},${y}`];
      while (y < 280) {
        y += 22 + rnd() * 26;
        x += (rnd() - 0.5) * 46;
        pts.push(`${x.toFixed(0)},${y.toFixed(0)}`);
      }
      return pts.join(" ");
    });
  });
  const cracks = $derived.by(() => {
    const rnd = mulberry32(card.seed ^ 0x2545f491);
    return [0, 1, 2].map(() => {
      let x = 40 + rnd() * 120;
      let y = 30 + rnd() * 60;
      const pts = [`${x.toFixed(0)},${y.toFixed(0)}`];
      for (let i = 0; i < 6; i++) {
        x += (rnd() - 0.5) * 60;
        y += 18 + rnd() * 30;
        pts.push(`${x.toFixed(0)},${y.toFixed(0)}`);
      }
      return pts.join(" ");
    });
  });

  const dateLabel = $derived(
    card.date
      ? new Date(card.date).toLocaleDateString("nl-NL", {
          day: "numeric",
          month: "short",
        })
      : "",
  );
  const label = $derived(
    faceDown
      ? `Verborgen cijfer, ${card.subject}`
      : `${card.subject}: ${card.value}, ${meta.label}`,
  );
</script>

<div
  class="card r-{card.rarity} {className}"
  class:calm={calm || mini}
  class:lite
  class:shiny={card.shiny}
  class:down={faceDown}
  class:flip-anim={animateFlip}
  style="font-size:{scale}px; --h:{card.hue}; --c1:{meta.color}; --c2:{meta.color2};"
  use:tilt={{ enabled: tiltOn && !calm }}
  role="img"
  aria-label={label}
>
  <div class="tiltwrap" class:tilting={tiltOn && !calm}>
    <div class="inner">
      <!-- ============ FRONT ============ -->
      <div class="face front">
        <svg
          class="art"
          viewBox="0 0 200 280"
          preserveAspectRatio="xMidYMid slice"
          aria-hidden="true"
        >
          {#each shapes as s, i (i)}
            {#if s.kind === "circle"}
              <circle
                cx={s.x}
                cy={s.y}
                r={s.r}
                fill="var(--p{s.c})"
                opacity={s.o}
              />
            {:else if s.kind === "ring"}
              <circle
                cx={s.x}
                cy={s.y}
                r={s.r}
                fill="none"
                stroke="var(--p{s.c})"
                stroke-width="3"
                opacity={s.o + 0.15}
              />
            {:else if s.kind === "poly"}
              <polygon
                points={polyPoints(s.x, s.y, s.r, s.sides, s.rot)}
                fill="var(--p{s.c})"
                opacity={s.o}
              />
            {:else if s.kind === "rect"}
              <rect
                x={s.x - s.r}
                y={s.y - s.r / 2}
                width={s.r * 2}
                height={s.r}
                fill="var(--p{s.c})"
                opacity={s.o}
                transform="rotate({s.rot} {s.x} {s.y})"
              />
            {:else}
              <line
                x1={s.x - s.r * 1.6}
                y1={s.y}
                x2={s.x + s.r * 1.6}
                y2={s.y}
                stroke="var(--p{s.c})"
                stroke-width="2.5"
                opacity={s.o + 0.2}
                transform="rotate({s.rot} {s.x} {s.y})"
              />
            {/if}
          {/each}
          {#if card.rarity === "episch"}
            {#each bolts as pts}
              <polyline
                class="bolt"
                points={pts}
                fill="none"
                stroke="var(--c1)"
                stroke-width="2.2"
                stroke-linejoin="round"
              />
            {/each}
          {/if}
          {#if card.rarity === "glitch"}
            {#each cracks as pts}
              <polyline
                points={pts}
                fill="none"
                stroke="#fff"
                stroke-opacity="0.38"
                stroke-width="1.4"
                stroke-linejoin="bevel"
              />
            {/each}
          {/if}
        </svg>

        <div class="tex"></div>
        <div class="foil"></div>

        <div class="shade"></div>

        <div class="head">
          <span class="subject">{card.subject}</span>
          <span class="emoji" aria-hidden="true">{card.emoji}</span>
        </div>

        <div class="center">
          <div class="value" data-text={card.value}>{card.value}</div>
          <div class="ribbon">{meta.label}{card.shiny ? " ✦ Shiny" : ""}</div>
        </div>

        <div class="foot">
          {#if card.stamps.length > 0 && !mini}
            <div class="stamps">
              {#each card.stamps as st}
                <span class="stamp"
                  ><span aria-hidden="true">{STAMP_META[st].icon}</span>
                  {STAMP_META[st].label}</span
                >
              {/each}
            </div>
          {/if}
          <div class="title">{card.title}</div>
          <div class="meta">
            {#if card.weight}<span>×{card.weight}</span>{/if}
            {#if dateLabel}<span>{dateLabel}</span>{/if}
          </div>
        </div>

        {#if card.shiny}
          <div class="sparkles" aria-hidden="true">
            {#each sparkles as sp, i (i)}
              <i
                style="left:{sp.x}%;top:{sp.y}%;--s:{sp.s}em;animation-delay:{sp.d}ms"
              ></i>
            {/each}
          </div>
        {/if}
        <div class="glare"></div>
        <div class="frame"></div>
      </div>

      <!-- ============ BACK ============ -->
      <div class="face back">
        <div class="back-pattern"></div>
        <div class="back-emoji" aria-hidden="true">{card.emoji}</div>
        <div class="back-q">?</div>
        <div class="back-label">{card.subject}</div>
        <div class="shineback"></div>
        <div class="backframe"></div>
      </div>
    </div>
  </div>
</div>

<style>
  .card {
    --p0: hsl(var(--h) 85% 62%);
    --p1: hsl(calc(var(--h) + 45) 80% 58%);
    --p2: hsl(calc(var(--h) - 45) 75% 66%);
    --p3: hsl(var(--h) 45% 92%);
    position: relative;
    width: 16em;
    height: 22.4em;
    perspective: 70em;
    -webkit-tap-highlight-color: transparent;
    user-select: none;
  }
  .tiltwrap {
    position: absolute;
    inset: 0;
    transform-style: preserve-3d;
    transform: rotateX(var(--rx, 0deg)) rotateY(var(--ry, 0deg));
  }
  .tiltwrap.tilting {
    will-change: transform;
  }
  .inner {
    position: absolute;
    inset: 0;
    transform-style: preserve-3d;
  }
  .flip-anim .inner {
    transition: transform 0.85s cubic-bezier(0.2, 0.9, 0.25, 1.1);
  }
  .down .inner {
    transform: rotateY(180deg);
  }

  .face {
    position: absolute;
    inset: 0;
    overflow: hidden;
    border-radius: 1.1em;
    backface-visibility: hidden;
    -webkit-backface-visibility: hidden;
    isolation: isolate;
    /*
     * WebKitGTK (the Linux desktop webview) ignores `backface-visibility` here:
     * because the flip lives in a flattened 3D context, the back face keeps
     * painting on top of the front and every card stays face-down. So the
     * faces also drive themselves with opacity — where backface culling does
     * work (Chromium/Android, WKWebView) this is invisible, since the culled
     * face is never painted during the flip anyway.
     */
    transition: opacity 0.3s ease;
  }
  .face.back {
    opacity: 0;
  }
  .down .face.back {
    opacity: 1;
  }
  .down .face.front {
    opacity: 0;
  }

  /* ---------- front ---------- */
  .front {
    background:
      radial-gradient(
        120% 70% at 50% 0%,
        hsl(var(--h) 60% 30%),
        transparent 70%
      ),
      linear-gradient(
        165deg,
        hsl(var(--h) 50% 20%),
        hsl(calc(var(--h) + 35) 55% 9%)
      );
    color: #fff;
    box-shadow:
      0 0.9em 2.4em -0.8em color-mix(in srgb, var(--c1) 55%, transparent),
      0 0 0 0.06em color-mix(in srgb, var(--c1) 40%, transparent);
  }
  .art {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    z-index: 0;
  }
  .bolt {
    stroke-dasharray: 6 4;
    filter: drop-shadow(0 0 3px var(--c1));
    animation: bolt 1.3s steps(2, end) infinite;
  }
  .tex,
  .foil,
  .glare,
  .frame {
    position: absolute;
    inset: 0;
    pointer-events: none;
    border-radius: inherit;
  }
  .tex {
    z-index: 1;
  }
  .foil {
    z-index: 4;
    opacity: 0;
  }
  .shade {
    position: absolute;
    inset: 0;
    z-index: 2;
    pointer-events: none;
    background: radial-gradient(
      62% 34% at 50% 37%,
      rgba(0, 0, 0, 0.4),
      transparent 78%
    );
  }
  .r-mythisch .shade {
    background: radial-gradient(
      66% 36% at 50% 37%,
      rgba(8, 4, 24, 0.7),
      transparent 80%
    );
  }
  .glare {
    z-index: 5;
    background: radial-gradient(
      circle at var(--mx, 50%) var(--my, 30%),
      rgba(255, 255, 255, 0.3),
      transparent 55%
    );
    mix-blend-mode: soft-light;
    opacity: 0.55;
  }
  .frame {
    z-index: 6;
    padding: 0.32em;
    background: linear-gradient(135deg, var(--c1), var(--c2) 55%, var(--c1));
    background-size: 200% 200%;
    -webkit-mask:
      linear-gradient(#000 0 0) content-box,
      linear-gradient(#000 0 0);
    -webkit-mask-composite: xor;
    mask:
      linear-gradient(#000 0 0) content-box exclude,
      linear-gradient(#000 0 0);
    mask-composite: exclude;
  }

  .head {
    position: absolute;
    z-index: 3;
    top: 0.95em;
    left: 1em;
    right: 1em;
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.5em;
  }
  .subject {
    font-size: 0.95em;
    font-weight: 800;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    line-height: 1.15;
    max-width: 68%;
    text-shadow: 0 0.08em 0.4em rgba(0, 0, 0, 0.6);
    overflow-wrap: anywhere;
  }
  .emoji {
    display: grid;
    place-items: center;
    width: 2.5em;
    height: 2.5em;
    border-radius: 50%;
    font-size: 1.05em;
    background: rgba(0, 0, 0, 0.35);
    box-shadow:
      inset 0 0 0 0.09em color-mix(in srgb, var(--c1) 70%, transparent),
      0 0.2em 0.8em rgba(0, 0, 0, 0.4);
  }
  .center {
    position: absolute;
    z-index: 3;
    left: 0;
    right: 0;
    top: 5.6em;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.6em;
  }
  .value {
    position: relative;
    font-size: 6.4em;
    font-weight: 900;
    line-height: 1;
    letter-spacing: -0.04em;
    font-variant-numeric: tabular-nums;
    text-shadow:
      0 0 0.35em color-mix(in srgb, var(--c1) 80%, transparent),
      0 0.05em 0.1em rgba(0, 0, 0, 0.5);
  }
  .ribbon {
    padding: 0.28em 1.1em;
    border-radius: 99em;
    font-size: 0.78em;
    font-weight: 800;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: #0b0b12;
    background: linear-gradient(90deg, var(--c1), var(--c2));
    box-shadow: 0 0.3em 1em -0.2em
      color-mix(in srgb, var(--c1) 70%, transparent);
  }
  .foot {
    position: absolute;
    z-index: 3;
    left: 1em;
    right: 1em;
    bottom: 0.95em;
    display: flex;
    flex-direction: column;
    gap: 0.35em;
    text-shadow: 0 0.08em 0.4em rgba(0, 0, 0, 0.7);
  }
  .stamps {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3em;
  }
  .stamp {
    padding: 0.18em 0.6em;
    border-radius: 99em;
    font-size: 0.68em;
    font-weight: 800;
    background: rgba(0, 0, 0, 0.5);
    box-shadow: inset 0 0 0 0.1em color-mix(in srgb, var(--c1) 60%, transparent);
    white-space: nowrap;
  }
  .title {
    font-size: 1.05em;
    font-weight: 700;
    line-height: 1.2;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .meta {
    display: flex;
    gap: 0.9em;
    font-size: 0.78em;
    opacity: 0.75;
    font-weight: 600;
  }

  /* ---------- back ---------- */
  .back {
    transform: rotateY(180deg);
    background:
      radial-gradient(
        90% 60% at 50% 38%,
        hsl(var(--h) 55% 28%),
        transparent 75%
      ),
      linear-gradient(
        160deg,
        hsl(var(--h) 40% 15%),
        hsl(calc(var(--h) + 30) 45% 7%)
      );
    display: grid;
    place-items: center;
    box-shadow: 0 0.9em 2.4em -0.8em hsl(var(--h) 80% 50% / 0.5);
  }
  .back-pattern {
    position: absolute;
    inset: 0;
    background: repeating-linear-gradient(
      45deg,
      rgba(255, 255, 255, 0.045) 0 0.45em,
      transparent 0.45em 1.1em
    );
  }
  .back-emoji {
    position: absolute;
    top: 1.2em;
    right: 1.3em;
    font-size: 2.4em;
    opacity: 0.35;
    filter: saturate(0.6);
  }
  .back-q {
    position: relative;
    font-size: 8em;
    font-weight: 900;
    line-height: 1;
    color: hsl(var(--h) 90% 78%);
    text-shadow: 0 0 0.4em hsl(var(--h) 90% 60% / 0.7);
  }
  .back-label {
    position: absolute;
    left: 1em;
    right: 1em;
    bottom: 1.1em;
    text-align: center;
    font-size: 0.95em;
    font-weight: 800;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: hsl(var(--h) 60% 85%);
    opacity: 0.85;
    overflow-wrap: anywhere;
  }
  .backframe {
    position: absolute;
    inset: 0;
    border-radius: inherit;
    box-shadow:
      inset 0 0 0 0.2em hsl(var(--h) 70% 65% / 0.6),
      inset 0 0 0 0.45em rgba(0, 0, 0, 0.35);
  }
  .shineback {
    position: absolute;
    inset: -50%;
    background: linear-gradient(
      115deg,
      transparent 42%,
      rgba(255, 255, 255, 0.16) 50%,
      transparent 58%
    );
    animation: sweep 3.2s ease-in-out infinite;
  }

  /* ---------- shared foil sheen ---------- */
  .r-zeldzaam .foil,
  .r-episch .foil,
  .r-legendarisch .foil,
  .r-speciaal .foil {
    opacity: 1;
    mix-blend-mode: overlay;
    background: linear-gradient(
      115deg,
      transparent 22%,
      rgba(255, 255, 255, 0.5) 40%,
      rgba(255, 255, 255, 0.08) 52%,
      transparent 64%
    );
    background-size: 260% 260%;
    background-position: var(--mx, 50%) var(--my, 50%);
  }

  /* ---------- rarities ---------- */
  .r-gewoon .frame {
    background: linear-gradient(135deg, #e2e8f0, #64748b);
  }
  .r-speciaal .tex {
    background: radial-gradient(
      circle at 20% 20%,
      color-mix(in srgb, var(--c1) 30%, transparent),
      transparent 55%
    );
  }
  .r-zeldzaam .tex {
    background: radial-gradient(
      circle at 80% 15%,
      color-mix(in srgb, var(--c1) 38%, transparent),
      transparent 50%
    );
  }
  .r-episch .frame,
  .r-legendarisch .frame {
    animation: frame-shift 4s linear infinite;
  }
  .r-episch .tex {
    background:
      radial-gradient(
        circle at 50% 38%,
        color-mix(in srgb, var(--c1) 40%, transparent),
        transparent 60%
      ),
      repeating-linear-gradient(
        0deg,
        transparent 0 0.6em,
        color-mix(in srgb, var(--c1) 10%, transparent) 0.6em 0.68em
      );
  }
  .r-legendarisch .tex {
    background:
      repeating-conic-gradient(
        from 0deg at 50% 36%,
        rgba(251, 191, 36, 0.28) 0 5deg,
        transparent 5deg 15deg
      ),
      radial-gradient(
        circle at 50% 36%,
        rgba(251, 191, 36, 0.4),
        transparent 62%
      );
    animation: spin-rays 22s linear infinite;
    transform-origin: 50% 36%;
    mix-blend-mode: screen;
  }
  .r-mythisch .tex {
    background:
      radial-gradient(
        60% 40% at 20% 20%,
        rgba(34, 211, 238, 0.55),
        transparent 70%
      ),
      radial-gradient(
        60% 40% at 85% 40%,
        rgba(240, 171, 252, 0.55),
        transparent 70%
      ),
      radial-gradient(
        70% 40% at 40% 90%,
        rgba(250, 204, 21, 0.4),
        transparent 70%
      );
    animation: aurora 7s ease-in-out infinite alternate;
    mix-blend-mode: screen;
    opacity: 0.8;
  }
  .r-mythisch .foil {
    opacity: 0.55;
    mix-blend-mode: color-dodge;
    background:
      conic-gradient(
        from calc(var(--mxn, 50) * 3.6deg) at var(--mx, 50%) var(--my, 50%),
        #ff5f6d,
        #ffc371,
        #fff275,
        #7dff9b,
        #5ee7ff,
        #8f94fb,
        #f093fb,
        #ff5f6d
      ),
      repeating-linear-gradient(
        115deg,
        rgba(255, 255, 255, 0.2) 0 0.2em,
        transparent 0.2em 0.9em
      );
    background-blend-mode: overlay;
  }
  .r-mythisch .frame {
    background: conic-gradient(
      from 0deg,
      #ff5f6d,
      #ffc371,
      #7dff9b,
      #5ee7ff,
      #f093fb,
      #ff5f6d
    );
    animation: hue-spin 6s linear infinite;
  }
  .r-glitch .tex {
    background: repeating-linear-gradient(
      0deg,
      rgba(0, 0, 0, 0) 0 0.22em,
      rgba(0, 0, 0, 0.28) 0.22em 0.32em
    );
  }
  .r-glitch .frame {
    background: linear-gradient(90deg, #fb7185, #22d3ee);
  }
  .r-glitch .value {
    text-shadow:
      0.06em 0 0 rgba(251, 113, 133, 0.9),
      -0.06em 0 0 rgba(34, 211, 238, 0.9);
    animation: glitch-jitter 2.6s steps(1, end) infinite;
  }
  .r-glitch .art {
    animation: glitch-art 3.4s steps(1, end) infinite;
  }

  /* shiny: rainbow sparkle layer + a holo edge */
  .shiny .frame {
    background: conic-gradient(
      from 0deg,
      var(--c1),
      #fff,
      var(--c2),
      #fff,
      var(--c1)
    );
    animation: hue-spin 5s linear infinite;
  }
  .sparkles {
    position: absolute;
    inset: 0;
    z-index: 7;
    pointer-events: none;
  }
  .sparkles i {
    position: absolute;
    width: var(--s);
    height: var(--s);
    background: #fff;
    clip-path: polygon(
      50% 0%,
      62% 38%,
      100% 50%,
      62% 62%,
      50% 100%,
      38% 62%,
      0% 50%,
      38% 38%
    );
    filter: drop-shadow(0 0 0.3em #fff);
    animation: twinkle 2.4s ease-in-out infinite;
  }

  /* ---------- calm / lite ---------- */
  .calm *,
  .calm {
    animation: none !important;
  }
  .calm .shineback {
    display: none;
  }
  .lite .foil,
  .lite .tex,
  .lite .glare {
    mix-blend-mode: normal;
  }
  .lite.r-mythisch .foil {
    opacity: 0.35;
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
  @keyframes bolt {
    0% {
      stroke-dashoffset: 0;
      opacity: 1;
    }
    50% {
      stroke-dashoffset: 10;
      opacity: 0.35;
    }
    100% {
      stroke-dashoffset: 20;
      opacity: 1;
    }
  }
  @keyframes frame-shift {
    to {
      background-position: 200% 200%;
    }
  }
  @keyframes spin-rays {
    to {
      transform: rotate(360deg);
    }
  }
  @keyframes aurora {
    0% {
      transform: translate(-6%, -4%) scale(1);
    }
    100% {
      transform: translate(6%, 5%) scale(1.15);
    }
  }
  @keyframes hue-spin {
    to {
      filter: hue-rotate(360deg);
    }
  }
  @keyframes twinkle {
    0%,
    100% {
      transform: scale(0.2) rotate(0deg);
      opacity: 0;
    }
    50% {
      transform: scale(1) rotate(45deg);
      opacity: 1;
    }
  }
  @keyframes glitch-jitter {
    0%,
    88%,
    100% {
      transform: translate(0, 0);
    }
    90% {
      transform: translate(-0.06em, 0.03em) skewX(-6deg);
    }
    94% {
      transform: translate(0.08em, -0.02em) skewX(5deg);
    }
  }
  @keyframes glitch-art {
    0%,
    90%,
    100% {
      transform: none;
    }
    92% {
      transform: translateX(-2%) scaleY(1.02);
    }
    96% {
      transform: translateX(2%);
    }
  }
</style>
