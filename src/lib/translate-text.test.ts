import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  htmlToText,
  shouldOfferTranslation,
  buildTranslationPrompt,
  cleanTranslation,
  translationKey,
} from "./translate-text.ts";

describe("htmlToText", () => {
  it("keeps line breaks and list items and decodes entities", () => {
    assert.equal(
      htmlToText("<p>Lire&nbsp;le texte</p><ul><li>exercice 1</li><li>exercice 2</li></ul>A &amp; B<br>fin"),
      "Lire le texte\n• exercice 1\n• exercice 2\nA & B\nfin",
    );
  });
  it("copes with empty input", () => {
    assert.equal(htmlToText(null), "");
    assert.equal(htmlToText(undefined), "");
    assert.equal(htmlToText(""), "");
  });
});

describe("shouldOfferTranslation", () => {
  it("offers a translation for French, English, German and Spanish homework", () => {
    assert.equal(shouldOfferTranslation("Lire le chapitre 3 et faire les exercices 4 à 6"), true);
    assert.equal(shouldOfferTranslation("Read pages 10-15 and write a summary"), true);
    assert.equal(shouldOfferTranslation("Lies Kapitel 2 und mach die Aufgaben"), true);
    assert.equal(shouldOfferTranslation("Leer el capítulo 4 y hacer los ejercicios"), true);
  });
  it("does not offer it for Dutch homework", () => {
    assert.equal(shouldOfferTranslation("Maak opdracht 3 en leer paragraaf 2"), false);
    assert.equal(shouldOfferTranslation("Leer woordjes unit 3, maak de toets"), false);
  });
  it("does not offer it when there is nothing to recognise", () => {
    assert.equal(shouldOfferTranslation("p. 45 ex. 3"), false);
    assert.equal(shouldOfferTranslation(""), false);
  });
  it("leaves mixed text with as many Dutch as foreign words alone", () => {
    assert.equal(shouldOfferTranslation("Maak opdracht 2 of the boek"), false);
  });
});

describe("buildTranslationPrompt", () => {
  it("wraps the text and asks for the translation only", () => {
    const p = buildTranslationPrompt("Bonjour");
    assert.match(p, /<tekst>\nBonjour\n<\/tekst>/);
    assert.match(p, /ALLEEN de vertaling/);
  });
  it("cuts very long text", () => {
    const p = buildTranslationPrompt("a".repeat(10000));
    assert.ok(p.length < 4700);
  });
});

describe("cleanTranslation", () => {
  it("removes fences, labels and wrapping quotes", () => {
    assert.equal(cleanTranslation("```\nLees hoofdstuk 3\n```"), "Lees hoofdstuk 3");
    assert.equal(cleanTranslation("Vertaling: Lees hoofdstuk 3"), "Lees hoofdstuk 3");
    assert.equal(cleanTranslation('"Lees hoofdstuk 3"'), "Lees hoofdstuk 3");
    assert.equal(cleanTranslation("<tekst>\nLees hoofdstuk 3\n</tekst>"), "Lees hoofdstuk 3");
    assert.equal(cleanTranslation("  Lees hoofdstuk 3  "), "Lees hoofdstuk 3");
  });
  it("keeps quotes that belong to the text", () => {
    assert.equal(cleanTranslation('Lees "Max en Moritz" en "De Vos"'), 'Lees "Max en Moritz" en "De Vos"');
  });
});

describe("translationKey", () => {
  it("is stable and differs per text", () => {
    assert.equal(translationKey("abc"), translationKey("abc"));
    assert.notEqual(translationKey("abc"), translationKey("abd"));
  });
});
