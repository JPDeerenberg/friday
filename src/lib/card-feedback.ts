/**
 * Haptics + synthesized sound for card reveals. No audio files: everything is
 * generated with WebAudio. Sound is off unless the user turns it on in Settings
 * (`setSoundEnabled`). Every call is a safe no-op when unsupported.
 */

let enabled = false;
let ctx: AudioContext | null = null;
let noise: AudioBuffer | null = null;

export function setSoundEnabled(on: boolean): void {
  enabled = on;
}

function audio(): AudioContext | null {
  if (!enabled || typeof window === "undefined") return null;
  try {
    const AC =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AC) return null;
    ctx ??= new AC();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function noiseBuffer(c: AudioContext): AudioBuffer {
  if (noise && noise.sampleRate === c.sampleRate) return noise;
  const length = c.sampleRate;
  noise = c.createBuffer(1, length, c.sampleRate);
  const data = noise.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  return noise;
}

function envGain(
  c: AudioContext,
  t: number,
  peak: number,
  attack: number,
  decay: number,
): GainNode {
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  g.connect(c.destination);
  return g;
}

function noiseBurst(
  c: AudioContext,
  t: number,
  dur: number,
  peak: number,
  filterType: BiquadFilterType,
  freq: number,
  freqEnd?: number,
) {
  const src = c.createBufferSource();
  src.buffer = noiseBuffer(c);
  const f = c.createBiquadFilter();
  f.type = filterType;
  f.frequency.setValueAtTime(freq, t);
  if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
  const g = envGain(c, t, peak, Math.min(0.02, dur / 3), dur);
  src.connect(f).connect(g);
  src.start(t, Math.random() * 0.5, dur + 0.05);
}

const NOTES = [523.25, 659.25, 783.99, 1046.5, 1318.51, 1567.98, 2093];

export const sfx = {
  /** Rising tension while a card charges. */
  riser(seconds: number, tier: number) {
    const c = audio();
    if (!c) return;
    const t = c.currentTime;
    const osc = c.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(90, t);
    osc.frequency.exponentialRampToValueAtTime(500 + tier * 160, t + seconds);
    const lp = c.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(300, t);
    lp.frequency.exponentialRampToValueAtTime(3200, t + seconds);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.1 + tier * 0.012, t + seconds * 0.95);
    g.gain.exponentialRampToValueAtTime(0.0001, t + seconds + 0.05);
    g.connect(c.destination);
    osc.connect(lp).connect(g);
    osc.start(t);
    osc.stop(t + seconds + 0.1);
    noiseBurst(c, t, seconds, 0.05, "highpass", 600, 5000);
  },
  /** The impact when the card lands. */
  hit(tier: number) {
    const c = audio();
    if (!c) return;
    const t = c.currentTime;
    const osc = c.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(170, t);
    osc.frequency.exponentialRampToValueAtTime(38, t + 0.4);
    osc.connect(envGain(c, t, 0.45 + tier * 0.04, 0.005, 0.45));
    osc.start(t);
    osc.stop(t + 0.55);
    noiseBurst(c, t, 0.3, 0.3, "lowpass", 4000, 200);
  },
  /** A sparkly arpeggio — longer and higher for rarer cards. */
  chime(tier: number) {
    const c = audio();
    if (!c) return;
    const t = c.currentTime + 0.05;
    const count = 2 + tier;
    for (let i = 0; i < count; i++) {
      const osc = c.createOscillator();
      osc.type = i % 2 ? "sine" : "triangle";
      osc.frequency.value = NOTES[Math.min(i, NOTES.length - 1)];
      osc.connect(envGain(c, t + i * 0.085, 0.12, 0.01, 0.5));
      osc.start(t + i * 0.085);
      osc.stop(t + i * 0.085 + 0.6);
    }
  },
  tear(strength = 1) {
    const c = audio();
    if (!c) return;
    noiseBurst(
      c,
      c.currentTime,
      0.09,
      0.18 * Math.min(1.5, strength),
      "bandpass",
      2500,
      4500,
    );
  },
  scratch(speed = 1) {
    const c = audio();
    if (!c) return;
    noiseBurst(
      c,
      c.currentTime,
      0.05,
      0.05 + 0.06 * Math.min(1, speed),
      "highpass",
      3000,
    );
  },
  tick() {
    const c = audio();
    if (!c) return;
    const t = c.currentTime;
    const osc = c.createOscillator();
    osc.type = "square";
    osc.frequency.value = 900;
    osc.connect(envGain(c, t, 0.03, 0.002, 0.04));
    osc.start(t);
    osc.stop(t + 0.06);
  },
  glitch() {
    const c = audio();
    if (!c) return;
    const t = c.currentTime;
    for (let i = 0; i < 5; i++) {
      const osc = c.createOscillator();
      osc.type = "square";
      osc.frequency.value = 120 + Math.random() * 1400;
      osc.connect(envGain(c, t + i * 0.045, 0.06, 0.002, 0.04));
      osc.start(t + i * 0.045);
      osc.stop(t + i * 0.045 + 0.06);
    }
  },
  levelUp() {
    const c = audio();
    if (!c) return;
    const t = c.currentTime;
    [0, 4, 7, 12].forEach((semi, i) => {
      const osc = c.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = 392 * Math.pow(2, semi / 12);
      osc.connect(envGain(c, t + i * 0.1, 0.14, 0.01, 0.45));
      osc.start(t + i * 0.1);
      osc.stop(t + i * 0.1 + 0.55);
    });
  },
};

// ---------------------------------------------------------------- haptics

export function buzz(pattern: number | number[]): void {
  try {
    if (typeof navigator !== "undefined") navigator.vibrate?.(pattern);
  } catch {
    /* haptics are optional */
  }
}

const RARITY_PATTERNS: number[][] = [
  [18],
  [18],
  [10, 30, 10, 30, 25],
  [30],
  [40, 40, 70],
  [50, 40, 50, 40, 140],
  [60, 40, 60, 40, 60, 40, 220],
];

export const haptic = {
  /** Impact buzz, stronger for rarer cards. */
  impact(tier: number) {
    buzz(RARITY_PATTERNS[Math.max(0, Math.min(6, tier))]);
  },
  /** Charging buzz, `progress` 0..1. */
  charge(progress: number) {
    buzz(8 + Math.round(progress * 32));
  },
  tick() {
    buzz(6);
  },
};
