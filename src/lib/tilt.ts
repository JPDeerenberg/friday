/**
 * Svelte action: 3D tilt + holo-foil position for a card.
 * Sets CSS variables on the node:
 *   --rx / --ry   rotation in degrees
 *   --mx / --my   light position in % (drives the foil and glare)
 *   --mxn / --myn the same as unitless numbers (for angle maths in calc())
 * Follows the finger/pointer; falls back to the phone's tilt sensor when the
 * pointer has been idle for a moment. Eases back to rest when released.
 */
export interface TiltOptions {
  enabled?: boolean;
  /** Max rotation in degrees. */
  max?: number;
  /** Use the device orientation sensor (phones). */
  gyro?: boolean;
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

export function tilt(node: HTMLElement, options: TiltOptions = {}) {
  let o = { enabled: true, max: 14, gyro: true, ...options };
  let tx = 0,
    ty = 0,
    cx = 0,
    cy = 0;
  let tmx = 50,
    tmy = 50,
    cmx = 50,
    cmy = 50;
  let raf = 0;
  let pointerActive = false;
  let lastPointer = 0;
  let baseBeta: number | null = null;

  const apply = () => {
    node.style.setProperty("--rx", `${cx.toFixed(2)}deg`);
    node.style.setProperty("--ry", `${cy.toFixed(2)}deg`);
    node.style.setProperty("--mx", `${cmx.toFixed(1)}%`);
    node.style.setProperty("--my", `${cmy.toFixed(1)}%`);
    node.style.setProperty("--mxn", cmx.toFixed(1));
    node.style.setProperty("--myn", cmy.toFixed(1));
  };

  const frame = () => {
    cx += (tx - cx) * 0.16;
    cy += (ty - cy) * 0.16;
    cmx += (tmx - cmx) * 0.16;
    cmy += (tmy - cmy) * 0.16;
    apply();
    const settled =
      Math.abs(tx - cx) < 0.02 &&
      Math.abs(ty - cy) < 0.02 &&
      Math.abs(tmx - cmx) < 0.1 &&
      Math.abs(tmy - cmy) < 0.1;
    raf = settled && !pointerActive ? 0 : requestAnimationFrame(frame);
  };
  const kick = () => {
    if (!raf) raf = requestAnimationFrame(frame);
  };

  const onMove = (e: PointerEvent) => {
    if (!o.enabled) return;
    const r = node.getBoundingClientRect();
    const px = clamp((e.clientX - r.left) / r.width, 0, 1);
    const py = clamp((e.clientY - r.top) / r.height, 0, 1);
    ty = (px - 0.5) * 2 * o.max;
    tx = -(py - 0.5) * 2 * o.max;
    tmx = px * 100;
    tmy = py * 100;
    pointerActive = true;
    lastPointer = performance.now();
    kick();
  };
  const onLeave = () => {
    pointerActive = false;
    lastPointer = performance.now();
    tx = ty = 0;
    tmx = tmy = 50;
    kick();
  };
  const onOrient = (e: DeviceOrientationEvent) => {
    if (!o.enabled || !o.gyro) return;
    if (pointerActive || performance.now() - lastPointer < 1200) return;
    if (e.gamma === null || e.beta === null) return;
    baseBeta ??= e.beta;
    const gx = clamp(e.gamma / 30, -1, 1);
    const gy = clamp((e.beta - baseBeta) / 30, -1, 1);
    ty = gx * o.max;
    tx = -gy * o.max;
    tmx = 50 + gx * 50;
    tmy = 50 + gy * 50;
    kick();
  };

  // Only capture touch while tilt is on, so cards inside a scrolling list
  // (album tiles) never block vertical scrolling.
  const setTouchAction = () => {
    node.style.touchAction = o.enabled ? "none" : "";
  };
  setTouchAction();
  node.addEventListener("pointermove", onMove);
  node.addEventListener("pointerdown", onMove);
  node.addEventListener("pointerup", onLeave);
  node.addEventListener("pointercancel", onLeave);
  node.addEventListener("pointerleave", onLeave);
  if (typeof window !== "undefined" && "DeviceOrientationEvent" in window) {
    window.addEventListener("deviceorientation", onOrient);
  }
  apply();

  return {
    update(next: TiltOptions) {
      o = { ...o, ...next };
      setTouchAction();
      if (!o.enabled) onLeave();
    },
    destroy() {
      cancelAnimationFrame(raf);
      node.removeEventListener("pointermove", onMove);
      node.removeEventListener("pointerdown", onMove);
      node.removeEventListener("pointerup", onLeave);
      node.removeEventListener("pointercancel", onLeave);
      node.removeEventListener("pointerleave", onLeave);
      if (typeof window !== "undefined")
        window.removeEventListener("deviceorientation", onOrient);
    },
  };
}
