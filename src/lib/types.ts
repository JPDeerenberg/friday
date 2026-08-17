// TypeScript mirrors of the Magister API response shapes.
//
// Source of truth: `src-tauri/src/models/*.rs`. Field names and optionality
// match the JSON the Tauri commands actually serialize back to the frontend —
// i.e. the `#[serde(rename = "...")]` keys (PascalCase for the API models,
// snake_case for the schoolyear model which uses `#[serde(alias)]`).

// === Grades (`src-tauri/src/models/grades.rs`) ===

export interface Grade {
  CijferId: number;
  CijferStr: string | null;
  IsVoldoende: boolean;
  IngevoerdDoor: string | null;
  DatumIngevoerd: string | null;
  Weging: number | null;
  Inhalen: boolean;
  Vrijstelling: boolean;
  TeltMee: boolean;
  CijferKolom: CijferKolom;
  CijferKolomIdEloOpdracht: number | null;
  Docent: string | null;
  VakOntheffing: boolean;
  VakVrijstelling: boolean;
  CijferPeriode: GradePeriod | null;
  Vak: GradeSubject | null;
  // Computed fields merged in by the frontend / backend after fetching.
  description: string | null;
  test_date: string | null;
  extra_weight: number | null;
}

export interface CijferKolom {
  Id: number;
  KolomNaam: string | null;
  KolomNummer: string | null;
  KolomVolgNummer: string | null;
  KolomKop: string | null;
  KolomOmschrijving: string | null;
  KolomSoort: number; // 1 = grade, 2 = average
  IsHerkansingKolom: boolean;
  IsDocentKolom: boolean;
  HeeftOnderliggendeKolommen: boolean;
  IsPTAKolom: boolean;
}

export interface GradePeriod {
  Id: number;
  Naam: string;
  VolgNummer: number;
  Start: string | null;
  Einde: string | null;
}

export interface GradeSubject {
  Id: number;
  Afkorting: string;
  Omschrijving: string;
  Volgnr: number;
}

export interface GradeExtraInfo {
  Weging: number | null;
  WerkInformatieOmschrijving: string | null;
  KolomOmschrijving: string | null;
  WerkinformatieDatumIngevoerd: string | null;
}

// === Schoolyears (`src-tauri/src/models/schoolyears.rs`) ===
// This model uses `#[serde(alias)]` (not rename), so the serialized field
// names are snake_case.

export interface Schoolyear {
  id: number | null;
  studie: SchoolyearGroep;
  groep: SchoolyearGroep | null;
  lesperiode: Lesperiode;
  profielen: SchoolyearGroep[];
  persoonlijke_mentor: PersoonlijkeMentor | null;
  begin: string;
  einde: string;
  is_zitten_blijver: boolean | null;
  indicatie: string | null;
  opleiding_code: OpleidingCode | null;
  is_hoofd_aanmelding: boolean | null;
}

export interface SchoolyearGroep {
  id: number | null;
  code: string;
  omschrijving: string | null;
}

export interface Lesperiode {
  code: string;
}

export interface OpleidingCode {
  code: number;
  omschrijving: string;
}

export interface PersoonlijkeMentor {
  voorletters: string;
  tussenvoegsel: string | null;
  achternaam: string;
}

// === Calendar (`src-tauri/src/models/calendar.rs`) ===

export interface CalendarEvent {
  Id: number;
  Start: string;
  Einde: string;
  LesuurVan: number | null;
  LesuurTotMet: number | null;
  DuurtHeleDag: boolean;
  Omschrijving: string | null;
  Lokatie: string | null;
  Status: number;
  Type: number;
  Subtype: number | null;
  IsOnlineDeelname: boolean | null;
  WeergaveType: number | null;
  Inhoud: string | null;
  InfoType: number;
  Aantekening: string | null;
  Afgerond: boolean;
  HerhaalStatus: number | null;
  Vakken: CalendarVak[] | null;
  Docenten: Docent[] | null;
  Lokalen: Lokaal[] | null;
  OpdrachtId: number | null;
  HeeftBijlagen: boolean;
  Bijlagen: CalendarAttachment[] | null;
  Links: Link[] | null;
  Afwezigheid: Absence | null;
  // Computed fields added by the backend / frontend.
  self_url: string | null;
  merged_absence: Absence | null;
}

export interface CalendarVak {
  Id: number | null;
  Naam: string | null;
}

export interface Docent {
  Id: number | null;
  Naam: string | null;
  Docentcode: string | null;
}

export interface Lokaal {
  Naam: string | null;
}

export interface Link {
  Rel: string;
  Href: string;
}

export interface Absence {
  Id: number;
  Start: string | null;
  Eind: string | null;
  Lesuur: number | null;
  Geoorloofd: boolean;
  AfspraakId: number | null;
  Omschrijving: string | null;
  Verantwoordingtype: number | null;
  Code: string | null;
  Afspraak: CalendarEvent | null;
}

// The Rust model stores calendar attachments as opaque `serde_json::Value`;
// this captures the fields the frontend actually consumes.
export interface CalendarAttachment {
  Id: number;
  Naam: string;
  ContentType: string | null;
  Grootte: number | null;
  Links: Link[] | null;
}

// === Assignments (`src-tauri/src/models/assignments.rs`) ===

export interface Assignment {
  Id: number;
  Links: AssignmentLink[];
  Titel: string;
  Vak: string | null;
  InleverenVoor: string;
  IngeleverdOp: string | null;
  StatusLaatsteOpdrachtVersie: number;
  LaatsteOpdrachtVersienummer: number;
  Docenten: Docent[] | null;
  Omschrijving: string | null;
  Beoordeling: string | null;
  BeoordeeldOp: string | null;
  OpnieuwInleveren: boolean;
  Afgesloten: boolean;
  IsTeLaat: boolean | null;
  MagInleveren: boolean;
  Bijlagen: AssignmentAttachment[] | null;
  VersieNavigatieItems: AssignmentVersion[] | null;
}

export interface AssignmentLink {
  Rel: string;
  Href: string;
}

export interface AssignmentVersion {
  Id: number;
  Vak: string | null;
  Status: number | null;
  OpdrachtId: number | null;
  LeerlingOpmerking: string | null;
  DocentOpmerking: string | null;
  InleverenVoor: string | null;
  IngeleverdOp: string | null;
  GestartOp: string | null;
  Beoordeling: string | null;
  BeoordeeldOp: string | null;
  VersieNummer: number | null;
  IsTeLaat: boolean | null;
  Omschrijving: string | null;
  Links: AssignmentLink[] | null;
  LeerlingBijlagen: AssignmentAttachment[] | null;
  FeedbackBijlagen: AssignmentAttachment[] | null;
}

export interface AssignmentAttachment {
  Id: number;
  Naam: string;
  ContentType: string;
  Datum: string | null;
  Grootte: number;
  Url: string | null;
  UniqueId: string | null;
  BronSoort: number;
  Links: AssignmentLink[] | null;
}

// === Messages (`src-tauri/src/models/messages.rs`) ===
// The message model uses camelCase keys (no PascalCase rename).

export interface Message {
  id: number;
  onderwerp: string | null;
  mapId: number | null;
  afzender: Afzender | null;
  heeftPrioriteit: boolean;
  heeftBijlagen: boolean;
  isGelezen: boolean | null;
  verzondenOp: string | null;
  doorgestuurdOp: string | null;
  beantwoordOp: string | null;
  links: BerichtLinks | null;
  inhoud: string | null;
  ontvangers: Ontvanger[] | null;
  kopieOntvangers: Ontvanger[] | null;
  blindeKopieOntvangers: Ontvanger[] | null;
}

export interface Afzender {
  id: number;
  naam: string;
}

export interface BerichtLinks {
  self: LinkHref | null;
  map: LinkHref | null;
  bijlagen: LinkHref | null;
}

export interface LinkHref {
  href: string;
}

export interface Ontvanger {
  id: number;
  weergavenaam: string | null;
  type: string | null;
  mailGroep: string | null;
}

export interface MessagesFolder {
  aantalOngelezen: number;
  id: number;
  bovenliggendeId: number;
  naam: string;
  links: FolderLinks | null;
}

export interface FolderLinks {
  berichten: LinkHref | null;
}

export interface Contact {
  id: number;
  voorletters: string | null;
  roepnaam: string | null;
  tussenvoegsel: string | null;
  achternaam: string;
  code: string | null;
  klas: string | null;
  type: string | null;
}

// === Account (`src-tauri/src/models/account.rs`) ===

export interface Account {
  UuId: string;
  Persoon: AccountPerson;
  Groep: AccountGroup[];
}

export interface AccountPerson {
  Id: number;
  Roepnaam: string | null;
  Tussenvoegsel: string | null;
  Achternaam: string;
  OfficieleVoornamen: string | null;
  Voorletters: string;
  OfficieleTussenvoegsels: string | null;
  OfficieleAchternaam: string | null;
  Geboortedatum: string;
  GeboorteAchternaam: string | null;
  GeboortenaamTussenvoegsel: string | null;
  GebruikGeboortenaam: boolean;
}

export interface AccountGroup {
  Naam: string;
  Privileges: Permission[];
  Links: unknown | null;
}

export interface Permission {
  Naam: string;
  AccessType: string[];
}

export interface ProfileInfo {
  Id: number | null;
  EmailAdres: string | null;
  Mobiel: string | null;
}

export interface ProfileAddress {
  Id: number;
  Straat: string;
  Huisnummer: string;
  Toevoeging: string | null;
  Postcode: string;
  Woonplaats: string;
  Land: string | null;
  Type: number;
}

export interface ProfileCareer {
  Id: number | null;
  StamNr: string | null;
  Studie: string | null;
  Klas: string | null;
}