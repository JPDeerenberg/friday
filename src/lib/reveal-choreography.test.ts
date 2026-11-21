import assert from "node:assert/strict";
import test from "node:test";
import type { CardData } from "./cards.ts";
import {
  impactCues,
  revealProfile,
  signatureFor,
  signatureFx,
  walkoutCues,
} from "./reveal-choreography.ts";

function card(rarity: CardData["rarity"]): CardData {
  return {
    id: 1,
    subject: "Wiskunde",
    title: "Toets",
    value: "8,0",
    valueNum: 8,
    passed: true,
    rarity,
    shiny: false,
    mode: "tear",
    seed: 1,
    hue: 215,
    icon: "ruler",
    weight: 1,
    date: "2026-01-01",
    stamps: [],
    xp: 10,
  };
}

test("every rarity maps to its own signature", () => {
  assert.equal(signatureFor("gewoon"), "none");
  assert.equal(signatureFor("speciaal"), "prism");
  assert.equal(signatureFor("glitch"), "glitch");
  assert.equal(signatureFor("zeldzaam"), "frost");
  assert.equal(signatureFor("episch"), "storm");
  assert.equal(signatureFor("legendarisch"), "gold");
  assert.equal(signatureFor("mythisch"), "cosmic");
});

test("uit and reduced motion remove the show", () => {
  const off = revealProfile(card("mythisch"), "uit");
  assert.equal(off.k, 0);
  assert.equal(off.walkoutMs, 0);
  assert.equal(off.stopMs, 0);
  assert.equal(off.shake, 0);
  assert.equal(off.ambient, false);

  const reduced = revealProfile(card("mythisch"), "vol", true);
  assert.equal(reduced.k, 0);
  assert.equal(reduced.revealMs, off.revealMs);
});

test("normal mode is shorter and lighter than vol", () => {
  const vol = revealProfile(card("legendarisch"), "vol");
  const normal = revealProfile(card("legendarisch"), "normaal");
  assert.ok(normal.k < vol.k);
  assert.ok(normal.walkoutMs < vol.walkoutMs);
  assert.ok(normal.flashMs < vol.flashMs);
  assert.ok(normal.stopMs <= vol.stopMs);
});

test("only episch and up get a walkout", () => {
  assert.equal(revealProfile(card("zeldzaam"), "vol").walkoutMs, 0);
  assert.ok(revealProfile(card("episch"), "vol").walkoutMs > 0);
  assert.ok(
    revealProfile(card("mythisch"), "vol").walkoutMs >
      revealProfile(card("episch"), "vol").walkoutMs,
  );
});

test("impact cues are ordered and end on shown", () => {
  const p = revealProfile(card("episch"), "vol");
  const cues = impactCues(p, { stamp: true, glitch: false });
  assert.ok(cues.length > 3);
  for (let i = 1; i < cues.length; i++) {
    assert.ok(cues[i].at >= cues[i - 1].at, "cues must be sorted");
  }
  assert.equal(cues.at(-1)?.kind, "shown");
  assert.ok(cues.some((c) => c.kind === "flash"));
  assert.ok(cues.some((c) => c.kind === "shake"));
  assert.ok(cues.some((c) => c.kind === "stamp"));
});

test("plain mode only emits the settle cue", () => {
  const p = revealProfile(card("mythisch"), "uit");
  const cues = impactCues(p, { stamp: true, glitch: true });
  assert.deepEqual(
    cues.map((c) => c.kind),
    ["shown"],
  );
});

test("walkout cues end on the impact", () => {
  const p = revealProfile(card("legendarisch"), "vol");
  const cues = walkoutCues(p);
  assert.equal(cues.at(-1)?.kind, "impact");
  assert.equal(cues.at(-1)?.at, p.walkoutMs);
  assert.ok(cues.some((c) => c.kind === "rarity"));
  assert.ok(cues.some((c) => c.kind === "ambient"));
});

test("signature loops follow the rarity", () => {
  assert.equal(
    signatureFx(revealProfile(card("legendarisch"), "vol")).goldrain,
    true,
  );
  assert.equal(signatureFx(revealProfile(card("mythisch"), "vol")).stars, true);
  assert.equal(signatureFx(revealProfile(card("zeldzaam"), "vol")).snow, true);
  assert.equal(
    signatureFx(revealProfile(card("speciaal"), "vol")).bubbles,
    true,
  );
  assert.equal(signatureFx(revealProfile(card("glitch"), "vol")).glitch, true);
  assert.equal(
    signatureFx(revealProfile(card("gewoon"), "vol")).goldrain,
    false,
  );
});
