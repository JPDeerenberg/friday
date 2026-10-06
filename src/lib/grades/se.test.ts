import test from "node:test";
import assert from "node:assert";
import {
  isSchoolexamenGrade,
  seReason,
  seWeightedAverage,
  distinctSeColumns,
  type SeConfig,
} from "./se.ts";
import type { Grade } from "$lib/types";

function mkGrade(overrides: Partial<Grade> = {}): Grade {
  return {
    CijferId: Math.floor(Math.random() * 1e9),
    CijferStr: "7,5",
    IsVoldoende: true,
    IngevoerdDoor: null,
    DatumIngevoerd: "2026-01-01",
    Weging: 1,
    Inhalen: false,
    Vrijstelling: false,
    TeltMee: true,
    CijferKolom: {
      Id: 1,
      KolomNaam: null,
      KolomNummer: null,
      KolomVolgNummer: null,
      KolomKop: null,
      KolomOmschrijving: null,
      KolomSoort: 1,
      IsHerkansingKolom: false,
      IsDocentKolom: false,
      HeeftOnderliggendeKolommen: false,
      IsPTAKolom: false,
    },
    CijferKolomIdEloOpdracht: null,
    Docent: null,
    VakOntheffing: false,
    VakVrijstelling: false,
    CijferPeriode: null,
    Vak: null,
    description: null,
    test_date: null,
    extra_weight: null,
    ...overrides,
  };
}

function withKolom(g: Grade, kolom: Partial<Grade["CijferKolom"]>): Grade {
  return { ...g, CijferKolom: { ...g.CijferKolom, ...kolom } };
}

const AUTO: SeConfig = { seDetection: "auto" };
const MAGISTER: SeConfig = { seDetection: "magister" };
const OFF: SeConfig = { seDetection: "off" };

// 1. flag only: PTA-markering maar geen SE/PTA in de naam -> geen SE in auto,
// wel SE in magister-stand.
test("auto: PTA-vlag zonder tekstsignaal is geen SE", () => {
  const g = withKolom(mkGrade(), {
    IsPTAKolom: true,
    KolomKop: "Proefwerk H3",
  });
  assert.strictEqual(isSchoolexamenGrade(g, AUTO), false);
  assert.strictEqual(isSchoolexamenGrade(g, MAGISTER), true);
});

// 2. name pattern only: SE in de naam maar geen PTA-vlag -> geen SE in auto.
test("auto: SE-naam zonder PTA-vlag is geen SE", () => {
  const g = withKolom(mkGrade(), {
    IsPTAKolom: false,
    KolomKop: "SE1 Engels",
  });
  assert.strictEqual(isSchoolexamenGrade(g, AUTO), false);
});

// 3. both: PTA-vlag + SE/PTA in de naam -> SE in auto.
test("auto: PTA-vlag plus tekstsignaal is SE", () => {
  for (const kop of ["SE1 Wiskunde", "Schoolexamen Duits", "PTA biologie"]) {
    const g = withKolom(mkGrade(), { IsPTAKolom: true, KolomKop: kop });
    assert.strictEqual(isSchoolexamenGrade(g, AUTO), true, kop);
  }
});

// Kleine letters "se" tellen niet (alleen hoofdletters-SE).
test('auto: kleine letters "se" is geen signaal', () => {
  const g = withKolom(mkGrade(), {
    IsPTAKolom: true,
    KolomKop: "Oefentoets presentatie",
  });
  assert.strictEqual(isSchoolexamenGrade(g, AUTO), false);
});

// 4. override true wint altijd (ook zonder vlag en naam).
test("override true forceert SE", () => {
  const g = mkGrade();
  const config: SeConfig = { seDetection: "auto", overrides: { 1: true } };
  assert.strictEqual(isSchoolexamenGrade(g, config), true);
  // Ook in de off-stand wint de override.
  assert.strictEqual(
    isSchoolexamenGrade(g, { seDetection: "off", overrides: { 1: true } }),
    true,
  );
  assert.strictEqual(seReason(g, config), "Handmatig gemarkeerd als SE");
});

// 5. override false wint altijd (ook met vlag + naam).
test("override false sluit SE uit", () => {
  const g = withKolom(mkGrade(), {
    IsPTAKolom: true,
    KolomKop: "SE1 Wiskunde",
  });
  const config: SeConfig = { seDetection: "auto", overrides: { 1: false } };
  assert.strictEqual(isSchoolexamenGrade(g, config), false);
  assert.strictEqual(seReason(g, config), "Handmatig uitgesloten van SE");
});

// 6. off: nooit SE (zonder override).
test("off: nooit SE", () => {
  const g = withKolom(mkGrade(), {
    IsPTAKolom: true,
    KolomKop: "SE1 Wiskunde",
  });
  assert.strictEqual(isSchoolexamenGrade(g, OFF), false);
  assert.strictEqual(seReason(g, OFF), "SE-herkenning staat uit");
});

// 7. CE-kolom: PTA-vlag + SE-tekst maar met CE-signaal -> geen SE.
test("auto: CE-kolom is geen SE", () => {
  for (const kop of ["CE Engels", "Centraal examen wiskunde"]) {
    const g = withKolom(mkGrade(), { IsPTAKolom: true, KolomKop: kop });
    assert.strictEqual(isSchoolexamenGrade(g, AUTO), false, kop);
  }
});

// 8. gewogen gemiddelde sluit niet-SE-cijfers uit.
test("seWeightedAverage weegt alleen SE-cijfers (Weging/TeltMee)", () => {
  const se1 = withKolom(mkGrade({ CijferStr: "8,0", Weging: 2 }), {
    Id: 11,
    IsPTAKolom: true,
    KolomKop: "SE1",
  });
  const se2 = withKolom(mkGrade({ CijferStr: "6,0", Weging: 1 }), {
    Id: 12,
    IsPTAKolom: true,
    KolomKop: "PTA mondeling",
  });
  const regular = withKolom(mkGrade({ CijferStr: "10,0", Weging: 5 }), {
    Id: 13,
    IsPTAKolom: true,
    KolomKop: "Proefwerk H3",
  });
  const ignored = withKolom(mkGrade({ CijferStr: "1,0", Weging: 9 }), {
    Id: 14,
    IsPTAKolom: true,
    KolomKop: "SE2",
  });
  ignored.TeltMee = false;

  const res = seWeightedAverage([se1, se2, regular, ignored], AUTO);
  assert.strictEqual(res.count, 2);
  // (8*2 + 6*1) / (2+1) = 22/3
  assert.ok(Math.abs(res.avg - 22 / 3) < 1e-9);
  assert.strictEqual(res.totalWeight, 3);
  assert.strictEqual(res.totalPoints, 22);
});

// 9. seReason geeft Nederlandse uitleg per tak.
test("seReason beschrijft elke uitkomst in het Nederlands", () => {
  const ptaNoText = withKolom(mkGrade(), {
    IsPTAKolom: true,
    KolomKop: "Proefwerk H3",
  });
  assert.strictEqual(
    seReason(ptaNoText, AUTO),
    "PTA volgens Magister, maar geen SE/PTA in de kolomnaam",
  );
  const noPta = mkGrade();
  assert.strictEqual(seReason(noPta, AUTO), "Geen PTA-markering van Magister");
  const both = withKolom(mkGrade(), {
    IsPTAKolom: true,
    KolomKop: "SE2 Frans",
  });
  assert.ok(seReason(both, AUTO).startsWith("SE herkend"));
  assert.strictEqual(
    seReason(both, MAGISTER),
    "Magister markeert deze kolom als PTA",
  );
  assert.strictEqual(
    seReason(noPta, MAGISTER),
    "Magister markeert deze kolom niet als PTA",
  );
});

// 10. distinctSeColumns groepeert op KolomKop|KolomNaam|KolomOmschrijving|IsPTAKolom|Weging|KolomSoort.
test("distinctSeColumns groepeert dubbele kolommen", () => {
  const a = withKolom(mkGrade({ Weging: 2 }), {
    KolomKop: "SE1",
    IsPTAKolom: true,
  });
  const b = withKolom(mkGrade({ Weging: 2 }), {
    KolomKop: "SE1",
    IsPTAKolom: true,
  });
  const c = withKolom(mkGrade({ Weging: 1 }), {
    KolomKop: "SE1",
    IsPTAKolom: true,
  });
  const rows = distinctSeColumns([a, b, c]);
  assert.strictEqual(rows.length, 2);
  const dup = rows.find((r) => r.Weging === 2);
  assert.strictEqual(dup?.aantal, 2);
  assert.strictEqual(dup?.IsPTAKolom, true);
});
