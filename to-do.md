# 📋 Friday — To-Do Lijst

---

## 🐛 Bugs

- [ ] **Bronnen** — fixen, nu staat er niks
- [ ] **Notificaties** — robuust maken, werkt nu niet betrouwbaar
      🔎 Root cause gevonden: `SyncService` (elke 5 min) en `SyncWorker`/WorkManager (elke 15 min)
      draaiden onafhankelijk van elkaar en race'ten op hetzelfde `sync_state.json` bestand
      zonder locking → gemiste/dubbele notificaties, en 2-3x zoveel netwerk-/CPU-gebruik dan nodig.
      Fix-plan staat in `friday-notification-bug-diagnosis.md` (naar Deepseek voor implementatie):
      `SyncService` weg, alleen `WorkManager` (15 min minimum), locking om `SyncStateManager`,
      Tokio-runtime hergebruiken i.p.v. per sync-call aanmaken. Zie ook debug-instellingen-menu
      wijzigingen die daarbij horen (sync-interval slider/presets, 15 min floor).
- [ ] **Rate limiting** — zorg dat je niet gerate-limited wordt
      ↳ Volgt automatisch uit de notificatie-fix hierboven: één sync-engine i.p.v. twee, en een
      15-minuten minimum interval i.p.v. tot 1 minuut instelbaar, scheelt flink in requests naar Magister.
- [ ] **'Te laat'-filter** — werkend krijgen bij opdrachten filters
- [ ] **Do not disturb** — werkend krijgen
- [ ] **Exporteren** — JSON-bestanden exporteren werkend krijgen voor alles (lessen, cijfers, etc.)
- [ ] **Bestanden Downloaden** — bij huiswerk of opdrachten kunnen er bestanden bij zitten, nu werkt het niet
- [ ] **AI features verbeteren** — nu kan de AI bijna niks, betere chat en functies nodig

## ✨ Features

- [ ] **HTML-parser (omgekeerd)** — bij huiswerk, zodat je met opmaak huiswerk kan invoeren (GUI voor huiswerk om HTML tekst te schrijven)
- [x] **Animaties** — voor mooiere overgangen en meer 'pop'

## 🔧 Verbeteringen

- [x] **Profiel** — fixen zodat alle info erop staat (zoals waar je woont)
- [x] **Cijferlijst filters** — aanhouden bij app afsluiten (in cache opslaan)
- [ ] **Caching** — alles in cache, stil op de achtergrond verversen zodat je niet elke keer 2 seconden hoeft te wachten
- [ ] **Absenties** — klassenselector fixen (per klassenjaar)
- [x] **Repo info** — Repo data (Github) onderaan bij instellingen toevoegen (https://github.com/JPDeerenberg/friday)

---

## ✅ Voltooid

- [x] Zonder school-login (helemaal weg)
- [x] Cijfers fixen zodat de berekeningen kloppen
- [x] Opdrachtenpagina zijkant telefoon fixen
- [x] Indicator voor uitgevallen lessen, zodat je weet dat er iets mist
- [x] Knop voor privéles toevoegen fixen
- [x] Dag in de maand kunnen selecteren
- [x] Ondersteuning voor null-null lessen (verborgen i.p.v. tonen)
- [x] Automatisch volledige week inladen bij agenda voor soepel swipen
- [x] Klaar huiswerk verbeteren
- [x] Tijden duidelijker maken
- [x] Meer cijfercalculators en grafieken per vak
- [x] Homepage fixen zodat deze er goed uitziet op de telefoon
- [x] Tekst 'Blijf strijden' → 'Investeer in jezelf!'
- [x] To-pack-for-tomorrow schema op home (lessen morgen vóór 1e pauze + niet-afgevinkt huiswerk)
- [x] Cijfer calculator — ook omgekeerd cijfers rekenen voor meer variatie
- [x] Verwijderknop snapshots — zichtbaar maken, nu is het verborgen
- [x] **Cijfers op home** — bij resultaten fixen, nu staat er niks (alleen vakken waar je cijfers van hebt)
- [x] **Voortgang jaren** — fixen, nu staat er niks
- [x] **Uitlogknop** — bij desktop versie
- [x] **Agenda verkleinen** — alles wat kleiner maken zodat het overzichtelijker is; kleuren verbeteren (o.a. bij afgevinkt huiswerk)
- [x] **Absenties** — datum weghalen en klassenselector fixen
- [x] **Repo info** — Github repo info onderaan instellingen
- [x] **Caching systeem** — gecentraliseerde cache met background refresh

## Bij updaten:

- Commit altijd de nieuwe update, ook moet de versie altijd naar boven zodat Github alles goed compileert.
