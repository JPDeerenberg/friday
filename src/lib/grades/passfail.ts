// Slaag-zakregeling checker (HAVO/VWO).
//
// Implemented against the current official rules (checked 2026-08-18 against
// examenoverzicht.nl "Wanneer ben je geslaagd?" 2027 update, which mirrors the
// Rijksoverheid exameneisen; rule thresholds confirmed against examenblad.nl
// kernvakkenregel-havo-vwo):
//
//  1. Het gemiddelde van alle cijfers op het centraal examen is 5,5 of hoger.
//  2. Kernvakkenregel: in het rijtje Nederlands, Engels en wiskunde komt ten
//     hoogste één 5 voor (dus een 5 en verder 6 of hoger, of alle drie 6+).
//     Voor C&M zonder wiskunde geldt dit alleen voor Nederlands en Engels.
//  3. Het gemiddelde van alle eindcijfers is 6 of hoger, met uitzonderingen:
//     - één 5, rest 6 of hoger
//     - één 4, rest 6 of hoger én gemiddelde ≥ 6,0
//     - twee 5-en of één 5 + één 4, rest 6 of hoger én gemiddelde ≥ 6,0
//     - nooit een eindcijfer (afgerond) lager dan 4.
//  4. Lichamelijke opvoeding beoordeeld met 'voldoende' of 'goed'.
//
// Eindcijfer = (SE + CE) / 2 afgerond op een geheel cijfer (0,5 en hoger naar
// boven). Het app-kennisstandpunt gebruikt de huidige gewogen gemiddelden als
// schatting van het eindcijfer; CE-cijfers en LO zijn optioneel in te vullen.

export interface PassFailSubject {
  name: string;
  /** Current weighted average; proxy for the eindcijfer. */
  avg: number;
  /** Optional centraal-examencijfer (1-10). */
  ceGrade?: number | null;
}

export interface PassFailInput {
  subjects: PassFailSubject[];
  /** Explicit kernvak names; defaults to any subject named NL/EN/WI. */
  kernvakken?: string[];
  /** null = unknown / not filled in. */
  loVoldoende?: boolean | null;
}

export type CheckStatus = 'ok' | 'fail' | 'unknown';

export interface PassFailCheck {
  id: string;
  label: string;
  detail: string;
  status: CheckStatus;
}

export interface PassFailResult {
  overall: CheckStatus;
  checks: PassFailCheck[];
}

const DEFAULT_KERNVAKKEN = ['nederlands', 'engels', 'wiskunde'];

/** Eindcijfer afronding: 0,5 en hoger naar boven. */
export function roundEindcijfer(avg: number): number {
  return Math.round(avg);
}

export function checkPassFail(input: PassFailInput): PassFailResult {
  const kernvakken = input.kernvakken?.length
    ? input.kernvakken
    : input.subjects
        .filter((s) => DEFAULT_KERNVAKKEN.some((k) => s.name.toLowerCase().includes(k)))
        .map((s) => s.name);

  const valid = input.subjects.filter((s) => s.avg > 0 && !isNaN(s.avg));
  const finals = valid.map((s) => ({ subject: s, fg: roundEindcijfer(s.avg) }));
  const fgValues = finals.map((f) => f.fg);

  const checks: PassFailCheck[] = [];

  // 1. Kernvakkenregel
  const kernvakFinals = finals.filter((f) => kernvakken.includes(f.subject.name)).map((f) => f.fg);
  if (kernvakFinals.length < 2) {
    checks.push({
      id: 'kernvakken',
      label: 'Kernvakkenregel',
      detail: 'Te weinig kernvakcijfers (Nederlands, Engels, wiskunde) om te beoordelen.',
      status: 'unknown',
    });
  } else {
    const belowFive = kernvakFinals.filter((v) => v < 5).length;
    const belowSix = kernvakFinals.filter((v) => v < 6).length;
    const ok = belowFive === 0 && belowSix <= 1;
    checks.push({
      id: 'kernvakken',
      label: 'Kernvakkenregel',
      detail: `Kernvakken: ${kernvakFinals.join(' · ')} — ${
        ok
          ? 'maximaal één 5, geen cijfer onder de 5.'
          : 'meer dan één onvoldoende of een cijfer lager dan 5 in de kernvakken.'
      }`,
      status: ok ? 'ok' : 'fail',
    });
  }

  // 2. Geen eindcijfer lager dan 4
  const belowFour = finals.filter((f) => f.fg < 4);
  checks.push({
    id: 'geen-onder-4',
    label: 'Geen eindcijfer onder de 4',
    detail: belowFour.length
      ? `${belowFour.map((f) => `${f.subject.name}: ${f.fg}`).join(', ')} — eindcijfer(s) lager dan 4.`
      : fgValues.length
        ? 'Alle eindcijfers zijn 4 of hoger.'
        : 'Geen cijfers beschikbaar.',
    status: belowFour.length ? 'fail' : fgValues.length ? 'ok' : 'unknown',
  });

  // 3. Compensatieregel eindcijfers
  let compStatus: CheckStatus = 'unknown';
  let compDetail = 'Geen cijfers beschikbaar.';
  if (fgValues.length > 0) {
    const avg = fgValues.reduce((a, b) => a + b, 0) / fgValues.length;
    const belowSix = fgValues.filter((v) => v < 6).sort((a, b) => a - b);
    let ok = false;
    if (belowSix.length === 0) {
      ok = true;
      compDetail = `Alle eindcijfers zijn 6 of hoger (gem. ${avg.toFixed(2)}).`;
    } else if (belowSix.length === 1 && belowSix[0] === 5) {
      ok = true;
      compDetail = `Eén 5, de rest 6 of hoger (gem. ${avg.toFixed(2)}).`;
    } else if (belowSix.length === 1 && belowSix[0] === 4 && avg >= 6.0) {
      ok = true;
      compDetail = `Eén 4, de rest 6 of hoger én gemiddelde ≥ 6,0 (gem. ${avg.toFixed(2)}).`;
    } else if (belowSix.length === 2 && belowSix.every((v) => v === 5) && avg >= 6.0) {
      ok = true;
      compDetail = `Twee 5-en, de rest 6 of hoger én gemiddelde ≥ 6,0 (gem. ${avg.toFixed(2)}).`;
    } else if (
      belowSix.length === 2 &&
      belowSix.includes(5) &&
      belowSix.includes(4) &&
      avg >= 6.0
    ) {
      ok = true;
      compDetail = `Eén 5 en één 4, de rest 6 of hoger én gemiddelde ≥ 6,0 (gem. ${avg.toFixed(2)}).`;
    } else {
      compDetail = `${belowSix.length} onvoldoende${belowSix.length !== 1 ? 's' : ''} (${belowSix.join(
        ', '
      )}) — niet toegestaan met het huidige gemiddelde.`;
    }
    compStatus = ok ? 'ok' : 'fail';
  }
  checks.push({
    id: 'compensatie',
    label: 'Compensatieregel eindcijfers',
    detail: compDetail,
    status: compStatus,
  });

  // 4. Gemiddelde eindcijfers ≥ 6,0
  if (fgValues.length > 0) {
    const avg = fgValues.reduce((a, b) => a + b, 0) / fgValues.length;
    checks.push({
      id: 'gemiddelde',
      label: 'Gemiddelde eindcijfers ≥ 6,0',
      detail: `Gemiddelde: ${avg.toFixed(2)}.`,
      status: avg >= 6.0 ? 'ok' : 'fail',
    });
  } else {
    checks.push({
      id: 'gemiddelde',
      label: 'Gemiddelde eindcijfers ≥ 6,0',
      detail: 'Geen cijfers beschikbaar.',
      status: 'unknown',
    });
  }

  // 5. CE-gemiddelde ≥ 5,5 (alleen controleerbaar als CE-cijfers zijn ingevuld)
  const ceGrades = valid
    .map((s) => s.ceGrade)
    .filter((g): g is number => typeof g === 'number' && !isNaN(g) && g > 0);
  if (ceGrades.length > 0) {
    const ceAvg = ceGrades.reduce((a, b) => a + b, 0) / ceGrades.length;
    checks.push({
      id: 'ce-gemiddelde',
      label: 'Gemiddelde centraal examen ≥ 5,5',
      detail: `Gemiddelde: ${ceAvg.toFixed(2)} (${ceGrades.length} vak${
        ceGrades.length !== 1 ? 'ken' : ''
      }).`,
      status: ceAvg >= 5.5 ? 'ok' : 'fail',
    });
  } else {
    checks.push({
      id: 'ce-gemiddelde',
      label: 'Gemiddelde centraal examen ≥ 5,5',
      detail: 'Vul centraal-examencijfers in om dit te controleren.',
      status: 'unknown',
    });
  }

  // 6. Lichamelijke opvoeding (optioneel)
  if (input.loVoldoende == null) {
    checks.push({
      id: 'lo',
      label: 'Lichamelijke opvoeding voldoende/goed',
      detail: 'Niet ingevuld.',
      status: 'unknown',
    });
  } else {
    checks.push({
      id: 'lo',
      label: 'Lichamelijke opvoeding voldoende/goed',
      detail: input.loVoldoende ? 'Voldoende of goed.' : 'Niet voldoende/goed.',
      status: input.loVoldoende ? 'ok' : 'fail',
    });
  }

  const overall: CheckStatus = checks.some((c) => c.status === 'fail') ? 'fail' : 'ok';
  return { overall, checks };
}