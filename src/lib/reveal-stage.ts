/**
 * GPU stage for the card reveal.
 *
 * One full-screen fragment shader paints the whole room: a slow nebula, light
 * rays from behind the card, a star field that warps during the walkout, and a
 * ripple that fires at the moment of impact. It replaces a stack of expensive
 * full-screen CSS blurs with a single draw call that scales with the device.
 *
 * WebGL2 is available in Chromium/WKWebView and in modern WebKitGTK; when it is
 * not (or the context is lost), `supported` stays false and PackReveal keeps its
 * CSS light rig as the fallback. Nothing here throws into the component.
 */

const VERT = `#version 300 es
layout(location = 0) in vec2 a_pos;
void main() {
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;

out vec4 fragColor;

uniform vec2 uRes;
uniform float uTime;
uniform vec3 uA;
uniform vec3 uB;
uniform float uTier;
uniform float uPulse;
uniform float uPulseAge;
uniform float uWarp;
uniform float uProgress;
uniform float uGlow;
uniform float uQuality;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float amp = 0.5;
  mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 4; i++) {
    v += amp * vnoise(p);
    p = rot * p * 2.03 + 11.7;
    amp *= 0.5;
  }
  return v;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  float t = uTime;
  float r = length(uv);
  float ang = atan(uv.y, uv.x);

  // The impact ring: expands, bends the nebula and adds a bright halo.
  float ring = smoothstep(0.075, 0.0, abs(r - uPulseAge * 1.9)) * uPulse;

  vec2 q = uv * 1.5;
  q *= 1.0 - ring * 0.09;
  q += vec2(t * 0.028, -t * 0.019);

  float n1 = fbm(q + fbm(q * 1.8 + t * 0.05));
  float n2 = fbm(q * 2.4 - n1 + vec2(-t * 0.04, t * 0.02));

  vec3 col = vec3(0.008, 0.006, 0.018);
  vec3 neb = mix(uA, uB, smoothstep(0.18, 0.82, n2));
  col += neb * pow(n1, 2.15) * (0.32 + uGlow * 0.46) * (0.62 + uProgress * 0.65);

  // Rotating god rays from behind the card.
  float rayNoise = fbm(vec2(ang * 1.4, t * 0.07));
  float rays = pow(0.5 + 0.5 * sin(ang * 14.0 + rayNoise * 6.0 + t * 0.28), 4.0);
  rays *= smoothstep(1.15, 0.04, r);
  col += mix(uA, uB, 0.5) * rays * (0.08 + uGlow * 0.2);

  // Star field. Warp stretches the stars into hyperspace lines.
  vec2 sp = uv * vec2(26.0, 18.0);
  sp.y += t * (0.1 + uWarp * 3.2);
  vec2 cell = floor(sp);
  vec2 f = fract(sp) - 0.5;
  float h = hash21(cell);
  vec2 off = (vec2(hash21(cell + 7.1), hash21(cell + 3.7)) - 0.5) * 0.7;
  float star = smoothstep(0.06, 0.0, length(f - off)) * step(0.82, h);
  star *= 0.6 + 0.4 * sin(t * 2.0 + h * 40.0);
  if (uQuality < 0.75) star *= 0.55;
  col += vec3(0.76, 0.86, 1.0) * star * (0.45 + uWarp * 1.5);

  float streak = smoothstep(0.014, 0.0, abs(f.x - off.x)) * step(0.9, h) * uWarp;
  streak *= smoothstep(0.5, 0.0, abs(f.y));
  col += mix(uA, vec3(1.0), 0.55) * streak * 0.55;

  // Light pooled behind the hero card.
  float core = exp(-r * r * 3.1);
  col += mix(uA, uB, 0.35) * core * (0.12 + uGlow * 0.24 + uTier * 0.012);

  // Impact glow.
  col += (uA + uB) * 0.5 * ring * 0.55;
  col += mix(uA, vec3(1.0), 0.6) * exp(-r * r * 8.0) * uPulse * 0.32;

  // Vignette + a whisper of grain.
  float vig = smoothstep(1.28, 0.22, r);
  col *= mix(0.36, 1.0, vig);
  col += (hash21(gl_FragCoord.xy + fract(t) * 100.0) - 0.5) * 0.017;

  fragColor = vec4(col, 1.0);
}`;

type Vec3 = [number, number, number];

function clamp(n: number, a: number, b: number) {
  return Math.min(b, Math.max(a, n));
}

function hexToRgb(hex: string): Vec3 {
  const h = hex.trim().replace(/^#/, "");
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h.padEnd(6, "0").slice(0, 6);
  const n = Number.parseInt(full, 16);
  if (!Number.isFinite(n)) return [0.65, 0.55, 0.98];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export interface RevealStageOptions {
  quality?: number;
  onUnsupported?: () => void;
}

export class RevealStage {
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private buffer: WebGLBuffer | null = null;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private raf = 0;
  private last = 0;
  private time = 0;
  private frozenUntil = 0;
  private pulseAt = -1e9;
  private pulseStrength = 0;
  private colors: [Vec3, Vec3] = [
    [0.65, 0.55, 0.98],
    [0.43, 0.16, 0.85],
  ];
  private tier = 0;
  private warp = 0;
  private warpTarget = 0;
  private glow = 0.35;
  private progress = 0;

  quality: number;
  private onUnsupported?: () => void;
  private lostHandler: (e: Event) => void;
  private resizeHandler = () => this.resize();

  constructor(
    private canvas: HTMLCanvasElement,
    opts: RevealStageOptions = {},
  ) {
    this.quality = clamp(opts.quality ?? 1, 0.2, 1);
    this.onUnsupported = opts.onUnsupported;

    this.lostHandler = (e: Event) => {
      e.preventDefault();
      this.stop();
      this.gl = null;
      this.onUnsupported?.();
    };

    try {
      const gl = canvas.getContext("webgl2", {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        powerPreference: "high-performance",
      });
      if (!gl) {
        this.onUnsupported?.();
        return;
      }
      this.gl = gl;
      this.build();
      canvas.addEventListener("webglcontextlost", this.lostHandler);
      window.addEventListener("resize", this.resizeHandler);
      this.resize();
      this.start();
    } catch {
      this.gl = null;
      this.onUnsupported?.();
    }
  }

  get supported(): boolean {
    return this.gl !== null;
  }

  private build() {
    const gl = this.gl;
    if (!gl) return;
    const vs = this.shader(gl.VERTEX_SHADER, VERT);
    const fs = this.shader(gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) {
      this.gl = null;
      this.onUnsupported?.();
      return;
    }
    const program = gl.createProgram();
    if (!program) return;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.warn(
        "RevealStage: shader link failed",
        gl.getProgramInfoLog(program),
      );
      gl.deleteProgram(program);
      this.gl = null;
      this.onUnsupported?.();
      return;
    }
    this.program = program;
    gl.useProgram(program);

    for (const name of [
      "uRes",
      "uTime",
      "uA",
      "uB",
      "uTier",
      "uPulse",
      "uPulseAge",
      "uWarp",
      "uProgress",
      "uGlow",
      "uQuality",
    ]) {
      this.u[name] = gl.getUniformLocation(program, name);
    }

    const vao = gl.createVertexArray();
    const buffer = gl.createBuffer();
    if (!vao || !buffer) return;
    this.vao = vao;
    this.buffer = buffer;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  private shader(type: number, source: string): WebGLShader | null {
    const gl = this.gl;
    if (!gl) return null;
    const sh = gl.createShader(type);
    if (!sh) return null;
    gl.shaderSource(sh, source);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.warn(
        "RevealStage: shader compile failed",
        gl.getShaderInfoLog(sh),
      );
      gl.deleteShader(sh);
      return null;
    }
    return sh;
  }

  resize() {
    const gl = this.gl;
    if (!gl) return;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    const dpr = Math.min(
      typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1,
      1.5,
    );
    // The shader is soft by nature; rendering below device resolution is free
    // quality for the GPU and nobody can see the difference after the bloom.
    const scale = 0.45 + this.quality * 0.35;
    const w = Math.max(2, Math.round(rect.width * dpr * scale));
    const h = Math.max(2, Math.round(rect.height * dpr * scale));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
  }

  setQuality(q: number) {
    this.quality = clamp(q, 0.2, 1);
    this.resize();
  }

  setColors(main: string, secondary: string) {
    this.colors = [hexToRgb(main), hexToRgb(secondary)];
  }

  setTier(tier: number) {
    this.tier = clamp(tier, 0, 6);
  }

  setGlow(v: number) {
    this.glow = clamp(v, 0, 1.5);
  }

  setProgress(p: number) {
    this.progress = clamp(p, 0, 1);
  }

  setWarp(on: boolean, strength = 1) {
    this.warpTarget = on ? clamp(strength, 0, 1.5) : 0;
  }

  /** Kick the impact ripple. */
  pulse(strength = 1) {
    this.pulseAt = this.time;
    this.pulseStrength = clamp(strength, 0, 2);
  }

  /** Hit-stop: keep the clock (and therefore the room) still for a moment. */
  freeze(ms: number) {
    this.frozenUntil = performance.now() + ms;
  }

  start() {
    if (!this.gl || this.raf) return;
    this.last = performance.now();
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this.frame();
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private frame() {
    const gl = this.gl;
    const program = this.program;
    if (!gl || !program || !this.vao) return;
    if (typeof document !== "undefined" && document.hidden) return;

    const now = performance.now();
    const raw = this.last ? Math.min(0.05, (now - this.last) / 1000) : 0;
    this.last = now;
    if (now >= this.frozenUntil) this.time += raw;

    this.warp += (this.warpTarget - this.warp) * 0.055;
    const age = Math.max(0, this.time - this.pulseAt);
    const pulse = this.pulseStrength * Math.exp(-age * 2.7);

    gl.useProgram(program);
    gl.bindVertexArray(this.vao);
    gl.uniform2f(this.u.uRes, this.canvas.width, this.canvas.height);
    gl.uniform1f(this.u.uTime, this.time);
    gl.uniform3f(this.u.uA, ...this.colors[0]);
    gl.uniform3f(this.u.uB, ...this.colors[1]);
    gl.uniform1f(this.u.uTier, this.tier);
    gl.uniform1f(this.u.uPulse, pulse);
    gl.uniform1f(this.u.uPulseAge, age);
    gl.uniform1f(this.u.uWarp, this.warp);
    gl.uniform1f(this.u.uProgress, this.progress);
    gl.uniform1f(this.u.uGlow, this.glow);
    gl.uniform1f(this.u.uQuality, this.quality);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  destroy() {
    this.stop();
    if (typeof window !== "undefined") {
      window.removeEventListener("resize", this.resizeHandler);
    }
    this.canvas.removeEventListener("webglcontextlost", this.lostHandler);
    const gl = this.gl;
    if (gl) {
      if (this.program) gl.deleteProgram(this.program);
      if (this.vao) gl.deleteVertexArray(this.vao);
      if (this.buffer) gl.deleteBuffer(this.buffer);
    }
    this.program = null;
    this.vao = null;
    this.buffer = null;
    this.gl = null;
  }
}
