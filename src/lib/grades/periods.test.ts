import test from 'node:test';
import assert from 'node:assert';
import { getPeriods, filterGradesByPeriod, isPtaGrade } from './periods.ts';
import type { Grade, GradePeriod } from '$lib/types';

function mkGrade(overrides: Partial<Grade>): Grade {
  return {
    CijferId: Math.random(),
    CijferStr: '7,5',
    IsVoldoende: true,
    IngevoerdDoor: null,
    DatumIngevoerd: '2026-01-01',
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

function mkPeriod(id: number, naam: string, volg: number): GradePeriod {
  return { Id: id, Naam: naam, VolgNummer: volg, Start: null, Einde: null };
}

test('getPeriods returns distinct periods ordered by VolgNummer', () => {
  const grades = [
    mkGrade({ CijferPeriode: mkPeriod(2, 'Periode 2', 2) }),
    mkGrade({ CijferPeriode: mkPeriod(1, 'Periode 1', 1) }),
    mkGrade({ CijferPeriode: mkPeriod(2, 'Periode 2', 2) }),
    mkGrade({ CijferPeriode: null }),
  ];
  const periods = getPeriods(grades);
  assert.strictEqual(periods.length, 2);
  assert.strictEqual(periods[0].Id, 1);
  assert.strictEqual(periods[1].Id, 2);
});

test('getPeriods returns empty for grades without periods', () => {
  assert.deepStrictEqual(getPeriods([mkGrade({}), mkGrade({})]), []);
});

test('filterGradesByPeriod only keeps grades of the given period', () => {
  const grades = [
    mkGrade({ CijferPeriode: mkPeriod(1, 'P1', 1) }),
    mkGrade({ CijferPeriode: mkPeriod(2, 'P2', 2) }),
    mkGrade({ CijferPeriode: null }),
  ];
  const filtered = filterGradesByPeriod(grades, 1);
  assert.strictEqual(filtered.length, 1);
  assert.strictEqual(filtered[0].CijferPeriode?.Id, 1);
});

test('isPtaGrade marks PTA/schoolexamen columns', () => {
  const pta = mkGrade({ CijferKolom: { ...mkGrade({}).CijferKolom, IsPTAKolom: true } });
  const regular = mkGrade({});
  assert.strictEqual(isPtaGrade(pta), true);
  assert.strictEqual(isPtaGrade(regular), false);
});