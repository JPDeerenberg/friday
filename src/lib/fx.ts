/**
 * Tiny canvas particle engine for the card reveals.
 *
 * - One rAF loop that only runs while something is animating (saves battery).
 * - Particle cap scales with `quality`; an FPS watchdog lowers `quality` if the
 *   device can't keep up, so effects degrade instead of stuttering.
 * - `freeze(ms)` pauses the simulation (the "hit-stop" at the moment of impact).
 */

type Shape = "dot" | "rect" | "star" | "streak";

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  g: number;
  drag: number;
  life: number;
  max: number;
  size: number;
  color: string;
  shape: Shape;
  rot: number;
  vr: number;
  glow: boolean;
  sway: number;
  phase: number;
}

interface Bolt {
  pts: Array<[number, number]>;
  life: number;
  max: number;
  color: string;
}

interface Star {
  x: number;
  y: number;
  z: number;
  tw: number;
}

export type LoopKind =
  "embers" | "goldrain" | "confetti" | "stars" | "lightning";

interface LoopCfg {
  rate: number;
  color: string;
  color2: string;
  acc: number;
  rect?: { x: number; y: number; w: number; h: number };
}

export interface BurstOpts {
  count: number;
  color: string;
  color2?: string;
  speed?: number;
  size?: number;
  gravity?: number;
  shape?: Shape;
  glow?: boolean;
  spread?: number;
  angle?: number;
  life?: number;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);

export class FxEngine {
  private ctx: CanvasRenderingContext2D | null;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private parts: Particle[] = [];
  private bolts: Bolt[] = [];
  private stars: Star[] = [];
  private loops = new Map<LoopKind, LoopCfg>();
  private raf = 0;
  private last = 0;
  private frozenUntil = 0;
  private ema = 16;
  private slow = 0;
  private frames = 0;
  private resizeHandler = () => this.resize();

  quality: number;
  onDegrade?: (quality: number) => void;

  constructor(
    private canvas: HTMLCanvasElement,
    opts: { quality?: number } = {},
  ) {
    this.ctx = canvas.getContext("2d");
    this.quality = opts.quality ?? 1;
    this.resize();
    window.addEventListener("resize", this.resizeHandler);
  }

  resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const r = this.canvas.getBoundingClientRect();
    this.w = Math.max(1, Math.round(r.width));
    this.h = Math.max(1, Math.round(r.height));
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.stars = [];
  }

  private cap() {
    return Math.round(420 * this.quality);
  }

  private push(p: Particle) {
    if (this.parts.length >= this.cap()) this.parts.shift();
    this.parts.push(p);
  }

  /** Radial burst of particles. */
  burst(x: number, y: number, o: BurstOpts) {
    const n = Math.max(1, Math.round(o.count * this.quality));
    const spread = o.spread ?? Math.PI * 2;
    const base = o.angle ?? 0;
    for (let i = 0; i < n; i++) {
      const a = base + (i / n) * spread + rand(-0.15, 0.15);
      const s = (o.speed ?? 320) * rand(0.35, 1);
      this.push({
        x,
        y,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s,
        g: o.gravity ?? 260,
        drag: 0.965,
        life: 0,
        max: (o.life ?? 1.1) * rand(0.7, 1.2),
        size: (o.size ?? 5) * rand(0.6, 1.4),
        color: Math.random() < 0.5 || !o.color2 ? o.color : o.color2,
        shape: o.shape ?? (Math.random() < 0.7 ? "dot" : "star"),
        rot: rand(0, 6.28),
        vr: rand(-8, 8),
        glow: o.glow ?? true,
        sway: 0,
        phase: rand(0, 6.28),
      });
    }
    this.kick();
  }

  /** Falling confetti from the top (or from a point when `y` is given). */
  confetti(count: number, colors: string[], y = -20) {
    const n = Math.round(count * this.quality);
    for (let i = 0; i < n; i++) {
      this.push({
        x: rand(0, this.w),
        y: y + rand(-40, 20),
        vx: rand(-60, 60),
        vy: rand(40, 220),
        g: 220,
        drag: 0.985,
        life: 0,
        max: rand(2.2, 3.6),
        size: rand(5, 10),
        color: colors[Math.floor(Math.random() * colors.length)],
        shape: "rect",
        rot: rand(0, 6.28),
        vr: rand(-9, 9),
        glow: false,
        sway: rand(20, 70),
        phase: rand(0, 6.28),
      });
    }
    this.kick();
  }

  /** A jagged lightning bolt that fades out quickly. */
  bolt(x1: number, y1: number, x2: number, y2: number, color: string) {
    const pts: Array<[number, number]> = [[x1, y1]];
    const segs = 9;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    for (let i = 1; i < segs; i++) {
      const t = i / segs;
      const off = rand(-1, 1) * 16 * Math.sin(Math.PI * t);
      pts.push([x1 + dx * t + nx * off, y1 + dy * t + ny * off]);
    }
    pts.push([x2, y2]);
    this.bolts.push({ pts, life: 0, max: 0.22, color });
    if (this.bolts.length > 14) this.bolts.shift();
    this.kick();
  }

  /** Continuous emitters: embers, gold rain, confetti, star field, lightning. */
  setLoop(
    kind: LoopKind,
    on: boolean,
    cfg: {
      rate?: number;
      color?: string;
      color2?: string;
      rect?: LoopCfg["rect"];
    } = {},
  ) {
    if (!on) {
      this.loops.delete(kind);
      return;
    }
    this.loops.set(kind, {
      rate: cfg.rate ?? 30,
      color: cfg.color ?? "#fff",
      color2: cfg.color2 ?? cfg.color ?? "#fff",
      acc: 0,
      rect: cfg.rect,
    });
    this.kick();
  }

  stopLoops() {
    this.loops.clear();
  }

  /** Hit-stop: simulation holds still for a few frames. */
  freeze(ms: number) {
    this.frozenUntil = performance.now() + ms;
  }

  clear() {
    this.parts = [];
    this.bolts = [];
    this.loops.clear();
    this.ctx?.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    window.removeEventListener("resize", this.resizeHandler);
    this.parts = [];
    this.bolts = [];
    this.loops.clear();
  }

  private kick() {
    if (this.raf) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  private spawnFromLoops(dt: number) {
    for (const [kind, cfg] of this.loops) {
      if (kind === "stars") continue;
      cfg.acc += cfg.rate * this.quality * dt;
      while (cfg.acc >= 1) {
        cfg.acc -= 1;
        if (kind === "embers") {
          const r = cfg.rect;
          this.push({
            x: r ? rand(r.x, r.x + r.w) : rand(0, this.w),
            y: r ? r.y + r.h + rand(0, 30) : this.h + 10,
            vx: rand(-20, 20),
            vy: rand(-170, -60),
            g: -8,
            drag: 0.995,
            life: 0,
            max: rand(1.4, 2.8),
            size: rand(1.5, 4),
            color: Math.random() < 0.5 ? cfg.color : cfg.color2,
            shape: "dot",
            rot: 0,
            vr: 0,
            glow: true,
            sway: rand(10, 40),
            phase: rand(0, 6.28),
          });
        } else if (kind === "goldrain") {
          this.push({
            x: rand(0, this.w),
            y: -12,
            vx: rand(-15, 15),
            vy: rand(120, 300),
            g: 120,
            drag: 0.995,
            life: 0,
            max: rand(2, 3.2),
            size: rand(3, 6),
            color: Math.random() < 0.5 ? cfg.color : cfg.color2,
            shape: "rect",
            rot: rand(0, 6.28),
            vr: rand(-10, 10),
            glow: true,
            sway: rand(8, 30),
            phase: rand(0, 6.28),
          });
        } else if (kind === "confetti") {
          this.confetti(1, [cfg.color, cfg.color2]);
        } else if (kind === "lightning") {
          const r = cfg.rect;
          if (r) {
            const side = Math.random() < 0.5 ? -1 : 1;
            const sx = r.x + r.w / 2 + side * (r.w / 2) * rand(0.85, 1.05);
            const sy = r.y + rand(0, r.h);
            this.bolt(
              sx,
              sy,
              sx + side * rand(40, 120),
              sy + rand(-90, 90),
              Math.random() < 0.5 ? cfg.color : cfg.color2,
            );
          }
        }
      }
    }
  }

  private frame(now: number) {
    const ctx = this.ctx;
    if (!ctx) {
      this.raf = 0;
      return;
    }
    const rawDt = (now - this.last) / 1000;
    this.last = now;
    const dt = Math.min(0.05, Math.max(0, rawDt));

    // FPS watchdog: if frames stay slow, shed particles instead of stuttering.
    this.frames++;
    this.ema = this.ema * 0.92 + rawDt * 1000 * 0.08;
    if (this.frames > 30) {
      this.slow = this.ema > 26 ? this.slow + 1 : Math.max(0, this.slow - 1);
      if (this.slow > 24 && this.quality > 0.3) {
        this.quality = Math.max(0.3, this.quality * 0.65);
        this.slow = 0;
        this.onDegrade?.(this.quality);
      }
    }

    const frozen = now < this.frozenUntil;
    if (!frozen) {
      this.spawnFromLoops(dt);
      for (const p of this.parts) {
        p.life += dt;
        p.vy += p.g * dt;
        const d = Math.pow(p.drag, dt * 60);
        p.vx *= d;
        p.vy *= d;
        p.x +=
          p.vx * dt +
          (p.sway ? Math.sin(p.life * 3 + p.phase) * p.sway * dt : 0);
        p.y += p.vy * dt;
        p.rot += p.vr * dt;
      }
      this.parts = this.parts.filter(
        (p) => p.life < p.max && p.y < this.h + 40 && p.y > -80,
      );
      for (const b of this.bolts) b.life += dt;
      this.bolts = this.bolts.filter((b) => b.life < b.max);
    }

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);

    if (this.loops.has("stars")) this.drawStars(ctx, now);

    for (const p of this.parts) {
      const t = p.life / p.max;
      const alpha = t < 0.12 ? t / 0.12 : Math.max(0, 1 - (t - 0.55) / 0.45);
      if (alpha <= 0) continue;
      ctx.globalAlpha = Math.min(1, alpha);
      ctx.globalCompositeOperation = p.glow ? "lighter" : "source-over";
      ctx.fillStyle = p.color;
      ctx.strokeStyle = p.color;
      if (p.shape === "dot") {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, 6.283);
        ctx.fill();
        if (p.glow) {
          ctx.globalAlpha *= 0.25;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size * 2.6, 0, 6.283);
          ctx.fill();
        }
      } else if (p.shape === "rect") {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        // Flip the rectangle's width to fake a tumbling confetti piece.
        ctx.scale(Math.abs(Math.cos(p.rot * 1.7)) * 0.9 + 0.1, 1);
        ctx.fillRect(-p.size / 2, -p.size, p.size, p.size * 2);
        ctx.restore();
      } else if (p.shape === "star") {
        this.star(ctx, p.x, p.y, p.size * 1.8, p.rot);
      } else {
        ctx.lineWidth = Math.max(1, p.size * 0.5);
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - p.vx * 0.04, p.y - p.vy * 0.04);
        ctx.stroke();
      }
    }

    ctx.globalCompositeOperation = "lighter";
    for (const b of this.bolts) {
      const a = 1 - b.life / b.max;
      ctx.globalAlpha = a;
      ctx.strokeStyle = b.color;
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      b.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
      ctx.globalAlpha = a * 0.35;
      ctx.lineWidth = 7;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";

    const busy =
      this.parts.length > 0 ||
      this.bolts.length > 0 ||
      this.loops.size > 0 ||
      frozen;
    if (busy) {
      this.raf = requestAnimationFrame((t) => this.frame(t));
    } else {
      this.raf = 0;
      this.frames = 0;
      ctx.clearRect(0, 0, this.w, this.h);
    }
  }

  private star(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    r: number,
    rot: number,
  ) {
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const rad = i % 2 ? r * 0.35 : r;
      const a = rot + (i * Math.PI) / 4;
      const px = x + Math.cos(a) * rad;
      const py = y + Math.sin(a) * rad;
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
  }

  /** Parallax star field: bigger stars drift faster. */
  private drawStars(ctx: CanvasRenderingContext2D, now: number) {
    if (this.stars.length === 0) {
      const n = Math.round(80 * this.quality);
      for (let i = 0; i < n; i++) {
        this.stars.push({
          x: rand(0, this.w),
          y: rand(0, this.h),
          z: rand(0.2, 1),
          tw: rand(0, 6.28),
        });
      }
    }
    ctx.globalCompositeOperation = "lighter";
    for (const s of this.stars) {
      s.y += s.z * 0.35;
      if (s.y > this.h + 4) {
        s.y = -4;
        s.x = rand(0, this.w);
      }
      const tw = 0.55 + 0.45 * Math.sin(now / 400 + s.tw);
      ctx.globalAlpha = s.z * tw * 0.9;
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.z * 1.8, 0, 6.283);
      ctx.fill();
    }
  }
}
