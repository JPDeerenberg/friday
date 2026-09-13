import { invoke } from "@tauri-apps/api/core";
import { sanitizeHtml } from "$lib/sanitize";
import { clearWebSession, loadWebSession, sessionTierA, webBackend, webRequest, webRequestBytes } from "./web-session.ts";
import * as tierB from "./web-tier-b.ts";
import type { SessionTokens } from "./backend.ts";
import type {
  Absence,
  Account,
  Assignment,
  CalendarEvent,
  Contact,
  Grade,
  GradeExtraInfo,
  Link,
  Message,
  MessagesFolder,
  ProfileAddress,
  ProfileCareer,
  ProfileInfo,
  Schoolyear,
} from "$lib/types";

// Sanitize HTML fields at the boundary where remote data enters the frontend.
// Every {@html} call site downstream receives already-safe markup.

/** True outside the Tauri runtime (browser/PWA build). */
export function isWebBuild(): boolean {
  return typeof window !== "undefined" && !(window as any).__TAURI__;
}

/** Stored web session or a Dutch "not logged in" error. */
async function wtokens(): Promise<SessionTokens> {
  const t = await loadWebSession();
  if (!t) throw new Error("Niet ingelogd.");
  return t;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function stripApiPrefix(href: string): string {
  if (href.startsWith("/api/")) return href.slice("/api/".length);
  throw new Error("Unexpected event href shape: " + href);
}

function sanitizeMessage(msg: Message): Message {
  if (msg && typeof msg.inhoud === "string") {
    msg.inhoud = sanitizeHtml(msg.inhoud);
  }
  return msg;
}

function sanitizeAssignment(a: Assignment): Assignment {
  if (a && typeof a.Omschrijving === "string") {
    a.Omschrijving = sanitizeHtml(a.Omschrijving);
  }
  return a;
}

function sanitizeActivity(a: any): any {
  if (a && typeof a.Details === "string") {
    a.Details = sanitizeHtml(a.Details);
  }
  return a;
}

function sanitizeStudiewijzerDetail(detail: any): any {
  if (!detail) return detail;
  if (typeof detail.Omschrijving === "string") {
    detail.Omschrijving = sanitizeHtml(detail.Omschrijving);
  }
  const items = detail.Onderdelen?.Items;
  if (Array.isArray(items)) {
    for (const onderdeel of items) {
      if (onderdeel && typeof onderdeel.Omschrijving === "string") {
        onderdeel.Omschrijving = sanitizeHtml(onderdeel.Omschrijving);
      }
    }
  }
  return detail;
}

function sanitizeCalendarEvent(event: CalendarEvent): CalendarEvent {
  if (event && typeof event.Inhoud === "string") {
    event.Inhoud = sanitizeHtml(event.Inhoud);
  }
  return event;
}

// === Auth ===
export async function getLoginUrl(
  tenant?: string,
  username?: string,
): Promise<string> {
  return invoke("get_login_url", { tenant, username });
}

export async function startLoginFlow(
  tenant?: string,
  username?: string,
): Promise<void> {
  return invoke("start_login_flow", { tenant, username });
}

export async function handleAuthCallback(redirectUrl: string): Promise<Account> {
  return invoke("handle_auth_callback", { redirectUrl });
}

export async function isAuthenticated(): Promise<boolean> {
  if (isWebBuild()) return (await loadWebSession()) !== null;
  return invoke("is_authenticated");
}

export async function getAccount(): Promise<Account> {
  if (isWebBuild()) return (await webRequest("GET", "account?noCache=0")) as unknown as Account;
  return invoke("get_account");
}

export async function getPersonId(): Promise<number> {
  if (isWebBuild()) {
    const pid = (await wtokens()).personId;
    if (pid == null) throw new Error("Geen leerling gevonden bij dit account.");
    return pid;
  }
  return invoke("get_person_id");
}

export async function getProfilePicture(
  personId: number,
): Promise<string | null> {
  if (isWebBuild()) {
    try {
      const pic = await webRequestBytes(`leerlingen/${personId}/foto`);
      return pic ? bytesToBase64(pic) : null;
    } catch {
      return null;
    }
  }
  return invoke("get_profile_picture", { personId });
}

export async function logout(): Promise<void> {
  if (isWebBuild()) {
    const tokens = await loadWebSession();
    if (tokens) {
      try {
        await webBackend().logout(tokens);
      } catch (_) {}
    }
    await clearWebSession();
    return;
  }
  return invoke("logout");
}

export type RestoreSessionStatus = "restored" | "logged_out" | "unavailable";

export async function restoreSession(): Promise<RestoreSessionStatus> {
  const result: any = await invoke("restore_session");
  // Backwardscompat: older backend returned boolean; normalize to 3-way string.
  if (typeof result === "boolean") {
    return result ? "restored" : "logged_out";
  }
  if (typeof result === "string") {
    const s = result.toLowerCase().trim();
    if (s === "restored" || s === "logged_out" || s === "unavailable") return s as RestoreSessionStatus;
    // Handle quoted JSON string edge case
    try {
      const parsed = JSON.parse(result);
      if (typeof parsed === "string") return parsed.toLowerCase() as RestoreSessionStatus;
    } catch {}
    return s as RestoreSessionStatus;
  }
  // Tauri enum could serialize as { Restored: null } / { LoggedOut: ... } depending on serde mode
  if (result && typeof result === "object") {
    const key = Object.keys(result)[0];
    if (key) {
      const s = key.toLowerCase();
      if (s === "restored" || s === "logged_out" || s === "unavailable") return s as RestoreSessionStatus;
    }
    // Already lowercased object with status field?
    if (result.status) return String(result.status).toLowerCase() as RestoreSessionStatus;
  }
  console.warn("Unexpected restore_session result shape", result);
  return "unavailable";
}

export async function getProfileInfo(personId: number): Promise<ProfileInfo> {
  if (isWebBuild()) {
    return (await webRequest("GET", `personen/${personId}/profiel`)) as unknown as ProfileInfo;
  }
  return invoke("get_profile_info", { personId });
}

export async function getProfileAddresses(
  personId: number,
): Promise<ProfileAddress[]> {
  if (isWebBuild()) {
    const data = (await webRequest("GET", `personen/${personId}/adressen`)) as unknown as {
      Items?: ProfileAddress[];
      items?: ProfileAddress[];
    };
    return data.Items ?? data.items ?? [];
  }
  return invoke("get_profile_addresses", { personId });
}

export async function getCareerInfo(personId: number): Promise<ProfileCareer> {
  if (isWebBuild()) {
    return (await webRequest(
      "GET",
      `personen/${personId}/opleidinggegevensprofiel`,
    )) as unknown as ProfileCareer;
  }
  return invoke("get_career_info", { personId });
}

// === Calendar ===
export async function getCalendarEvents(
  personId: number,
  start: string,
  end: string,
): Promise<CalendarEvent[]> {
  if (isWebBuild()) return tierB.webGetCalendarEvents(sessionTierA(), await wtokens(), personId, start, end);
  const events = await invoke("get_calendar_events", { personId, start, end });
  return (events as CalendarEvent[]).map(sanitizeCalendarEvent);
}

export async function getAbsences(
  personId: number,
  van: string,
  tot: string,
): Promise<Absence[]> {
  if (isWebBuild()) return tierB.webGetAbsences(sessionTierA(), await wtokens(), personId, van, tot);
  return invoke("get_absences", { personId, van, tot });
}

export async function getCalendarEvent(
  personId: number,
  eventId: number,
): Promise<CalendarEvent> {
  if (isWebBuild()) return tierB.webGetCalendarEvent(sessionTierA(), await wtokens(), personId, eventId);
  const event = (await invoke("get_calendar_event", {
    personId,
    eventId,
  })) as CalendarEvent;
  return sanitizeCalendarEvent(event);
}

export async function downloadFile(
  url: string,
  filename: string,
  downloadDir?: string,
): Promise<string> {
  if (isWebBuild()) {
    // Browser: save via object URL + anchor click instead of a disk path.
    void downloadDir;
    const blob = await tierB.webDownloadFile(sessionTierA(), await wtokens(), url);
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
    return filename;
  }
  return invoke("download_file", {
    url,
    filename,
    downloadDir: downloadDir || "",
  });
}

export async function createCalendarEvent(params: {
  personId: number;
  start: string;
  einde: string;
  duurtHeleDag: boolean;
  omschrijving: string;
  lokatie?: string;
  inhoud?: string;
  eventType?: number;
}): Promise<void> {
  if (isWebBuild()) {
    return tierB.webCreateCalendarEvent(sessionTierA(), await wtokens(), params.personId, {
      start: params.start,
      einde: params.einde,
      duurtHeleDag: params.duurtHeleDag,
      omschrijving: params.omschrijving,
      lokatie: params.lokatie,
      inhoud: params.inhoud,
      eventType: params.eventType,
    });
  }
  return invoke("create_calendar_event", {
    personId: params.personId,
    start: params.start,
    einde: params.einde,
    duurtHeleDag: params.duurtHeleDag,
    omschrijving: params.omschrijving,
    lokatie: params.lokatie,
    inhoud: params.inhoud,
    eventType: params.eventType,
  });
}

export async function updateCalendarEvent(
  selfUrl: string,
  eventJson: string,
): Promise<void> {
  if (isWebBuild()) return tierB.webUpdateCalendarEvent(sessionTierA(), await wtokens(), selfUrl, eventJson);
  return invoke("update_calendar_event", { selfUrl, eventJson });
}

export async function deleteCalendarEvent(selfUrl: string): Promise<void> {
  if (isWebBuild()) return tierB.webDeleteCalendarEvent(sessionTierA(), await wtokens(), selfUrl);
  return invoke("delete_calendar_event", { selfUrl });
}

export async function toggleCalendarEventDone(event: CalendarEvent): Promise<void> {
  const updatedEvent = { ...event, Afgerond: !event.Afgerond };
  // Ensure we have a selfUrl
  let url = event.self_url;
  if (!url) {
    const href = event.Links?.find((l: Link) => l.Rel === "Self")?.Href;
    if (href) url = stripApiPrefix(href);
  }
  if (!url) throw new Error("No selfUrl found for event");
  return updateCalendarEvent(url, JSON.stringify(updatedEvent));
}

// === Grades ===
export async function getSchoolyears(
  personId: number,
  start?: string,
  end?: string,
): Promise<Schoolyear[]> {
  if (isWebBuild()) return tierB.webGetSchoolyears(sessionTierA(), await wtokens(), personId, start, end);
  return invoke("get_schoolyears", { personId, start, end });
}

export async function getGrades(
  personId: number,
  schoolyearId: number,
  einde: string,
): Promise<Grade[]> {
  if (isWebBuild()) return tierB.webGetGrades(sessionTierA(), await wtokens(), personId, schoolyearId, einde);
  return invoke("get_grades", { personId, schoolyearId, einde });
}

export async function getGradeExtraInfo(
  personId: number,
  schoolyearId: number,
  kolomId: number,
): Promise<GradeExtraInfo> {
  if (isWebBuild())
    return tierB.webGetGradeExtraInfo(sessionTierA(), await wtokens(), personId, schoolyearId, kolomId);
  return await invoke("get_grade_extra_info", {
    personId,
    schoolyearId,
    kolomId,
  });
}

export async function getBulkGradeExtraInfo(
  personId: number,
  schoolyearId: number,
  kolomIds: number[],
): Promise<Record<number, GradeExtraInfo>> {
  if (isWebBuild()) {
    const be = sessionTierA();
    const tokens = await wtokens();
    return tierB.webGetBulkGradeExtraInfo(
      be,
      tokens,
      (id) => tierB.webGetGradeExtraInfo(be, tokens, personId, schoolyearId, id),
      kolomIds,
    );
  }
  return await invoke("get_bulk_grade_extra_info", {
    personId,
    schoolyearId,
    kolomIds,
  });
}

export async function getRecentGrades(
  personId: number,
  top?: number,
): Promise<Grade[]> {
  if (isWebBuild()) return tierB.webGetRecentGrades(sessionTierA(), await wtokens(), personId, top);
  return await invoke("get_recent_grades", { personId, top });
}

// === Messages ===
export async function getMessageFolders(): Promise<MessagesFolder[]> {
  if (isWebBuild()) return tierB.webGetMessageFolders(sessionTierA(), await wtokens());
  return invoke("get_message_folders");
}

export async function getMessages(
  berichtenLink: string,
  top?: number,
  skip?: number,
  query?: string,
): Promise<Message[]> {
  if (isWebBuild()) return tierB.webGetMessages(sessionTierA(), await wtokens(), berichtenLink, top, skip, query);
  const messages = await invoke("get_messages", {
    berichtenLink,
    top,
    skip,
    query,
  });
  return (messages as Message[]).map(sanitizeMessage);
}

export async function getMessageDetail(selfLink: string): Promise<Message> {
  if (isWebBuild()) return tierB.webGetMessageDetail(sessionTierA(), await wtokens(), selfLink);
  const msg = (await invoke("get_message_detail", { selfLink })) as Message;
  return sanitizeMessage(msg);
}

export async function sendMessage(params: {
  recipients: number[];
  copyRecipients: number[];
  blindCopyRecipients: number[];
  subject: string;
  htmlContent: string;
  hasPriority: boolean;
  isConcept: boolean;
  sendOption?: string;
  relatedMessageId?: number;
  attachmentIds: number[];
}): Promise<void> {
  if (isWebBuild()) return tierB.webSendMessage(sessionTierA(), await wtokens(), params);
  return invoke("send_message", params);
}

export async function markMessagesAsRead(
  messageIds: number[],
  read: boolean,
): Promise<void> {
  if (isWebBuild()) return tierB.webMarkMessagesAsRead(sessionTierA(), await wtokens(), messageIds, read);
  return invoke("mark_messages_as_read", { messageIds, read });
}

export async function moveMessagesToFolder(
  messageIds: number[],
  folderId: number,
): Promise<void> {
  if (isWebBuild())
    return tierB.webMoveMessagesToFolder(sessionTierA(), await wtokens(), messageIds, folderId);
  return invoke("move_messages_to_folder", { messageIds, folderId });
}

export async function deleteMessages(
  messageIds: number[],
  areConcepts: boolean,
): Promise<void> {
  if (isWebBuild()) return tierB.webDeleteMessages(sessionTierA(), await wtokens(), messageIds, areConcepts);
  return invoke("delete_messages", { messageIds, areConcepts });
}

export async function searchContacts(
  query: string,
  maxResults?: number,
): Promise<Contact[]> {
  if (isWebBuild()) return tierB.webSearchContacts(sessionTierA(), await wtokens(), query, maxResults);
  return invoke("search_contacts", { query, maxResults });
}

// === Assignments ===
export async function getAssignments(
  personId: number,
  start: string,
  end: string,
): Promise<Assignment[]> {
  if (isWebBuild()) return tierB.webGetAssignments(sessionTierA(), await wtokens(), personId, start, end);
  const assignments = await invoke("get_assignments", {
    personId,
    start,
    end,
  });
  return (assignments as Assignment[]).map(sanitizeAssignment);
}

export async function getAssignmentDetail(selfUrl: string): Promise<Assignment> {
  if (isWebBuild()) return tierB.webGetAssignmentDetail(sessionTierA(), await wtokens(), selfUrl);
  const assignment = (await invoke("get_assignment_detail", {
    selfUrl,
  })) as Assignment;
  return sanitizeAssignment(assignment);
}

export async function handInAssignment(
  selfUrl: string,
  opdrachtId: number,
  versionJson: string,
): Promise<void> {
  if (isWebBuild()) return tierB.webHandInAssignment(sessionTierA(), await wtokens(), selfUrl, opdrachtId, versionJson);
  return invoke("hand_in_assignment", { selfUrl, opdrachtId, versionJson });
}

export async function uploadAssignmentAttachment(
  file: File | string,
): Promise<[number, string]> {
  if (typeof file !== "string") {
    if (!isWebBuild()) throw new Error("Bestandsobjecten worden alleen in de webversie ondersteund.");
    return tierB.webUploadAssignmentAttachment(sessionTierA(), await wtokens(), file);
  }
  if (isWebBuild()) {
    throw new Error("Bestanden uploaden via pad werkt in de webversie niet — kies een bestand.");
  }
  return invoke("upload_assignment_attachment", { filePath: file });
}

// === Leermiddelen ===
export async function getLeermiddelen(personId: number): Promise<any[]> {
  if (isWebBuild()) return tierB.webGetLeermiddelen(sessionTierA(), await wtokens(), personId);
  return invoke("get_leermiddelen", { personId });
}

export async function getLeermiddelLaunchUrl(href: string): Promise<string> {
  if (isWebBuild()) return tierB.webGetLeermiddelLaunchUrl(sessionTierA(), await wtokens(), href);
  return invoke("get_leermiddel_launch_url", { href });
}

// === Activities ===
export async function getActivities(personId: number): Promise<any[]> {
  if (isWebBuild()) return tierB.webGetActivities(sessionTierA(), await wtokens(), personId);
  const activities = await invoke("get_activities", { personId });
  return (activities as any[]).map(sanitizeActivity);
}

export async function getActivityElements(
  personId: number,
  activityId: number,
): Promise<any[]> {
  if (isWebBuild())
    return tierB.webGetActivityElements(sessionTierA(), await wtokens(), personId, activityId);
  const elements = await invoke("get_activity_elements", {
    personId,
    activityId,
  });
  return (elements as any[]).map(sanitizeActivity);
}

// === Bronnen ===
export async function getBronnen(path: string): Promise<any[]> {
  if (isWebBuild()) return tierB.webGetBronnen(sessionTierA(), await wtokens(), path);
  return invoke("get_bronnen", { path });
}

export async function getExternalBronSources(personId: number): Promise<any[]> {
  if (isWebBuild()) return tierB.webGetExternalBronSources(sessionTierA(), await wtokens(), personId);
  return invoke("get_external_bron_sources", { personId });
}

// === Studiewijzers ===
export async function getStudiewijzers(personId: number): Promise<any[]> {
  if (isWebBuild()) return tierB.webGetStudiewijzers(sessionTierA(), await wtokens(), personId);
  return invoke("get_studiewijzers", { personId });
}

export async function getStudiewijzerDetail(
  personId: number,
  id: number,
  isProject: boolean,
): Promise<any> {
  if (isWebBuild())
    return tierB.webGetStudiewijzerDetail(sessionTierA(), await wtokens(), personId, id, isProject);
  const detail = await invoke("get_studiewijzer_detail", {
    personId,
    id,
    isProject,
  });
  return sanitizeStudiewijzerDetail(detail);
}

export async function getStudiewijzerOnderdeelDetail(
  personId: number,
  swId: number,
  onderdeelId: number,
  isProject: boolean,
): Promise<any> {
  if (isWebBuild())
    return tierB.webGetStudiewijzerOnderdeelDetail(
      sessionTierA(),
      await wtokens(),
      personId,
      swId,
      onderdeelId,
      isProject,
    );
  const detail = await invoke("get_studiewijzer_onderdeel_detail", {
    personId,
    swId,
    onderdeelId,
    isProject,
  });
  return sanitizeStudiewijzerDetail(detail);
}

export async function triggerTestNotification(): Promise<void> {
  if (isWebBuild()) return showNotification(NotificationType.Test, "Test", "Meldingen werken in deze browser.");
  return invoke("trigger_test_notification");
}

// Notification types
export enum NotificationType {
  Test = "Test",
  Message = "Message",
  CalendarChange = "CalendarChange",
  NewGrade = "NewGrade",
  AssignmentDeadline = "AssignmentDeadline",
}

export async function showNotification(
  type: NotificationType,
  title: string,
  message: string,
  extra?: string,
): Promise<void> {
  if (isWebBuild()) {
    // Foreground web notifications only (no background sync on iOS PWAs —
    // persistent push is the optional push module, plan v2 §5).
    void type;
    void extra;
    try {
      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        new Notification(title, { body: message });
      }
    } catch (_) {}
    return;
  }
  return invoke("show_notification", {
    notificationType: type,
    title,
    message,
    extra: extra ?? null,
  });
}

// Type-specific notification helpers
export async function notifyNewMessage(
  title: string,
  message: string,
  sender?: string,
): Promise<void> {
  const extra = sender ? JSON.stringify({ sender }) : undefined;
  return showNotification(NotificationType.Message, title, message, extra);
}

export async function notifyCalendarChange(
  title: string,
  message: string,
  eventId?: string,
): Promise<void> {
  const extra = eventId ? JSON.stringify({ eventId }) : undefined;
  return showNotification(
    NotificationType.CalendarChange,
    title,
    message,
    extra,
  );
}

export async function notifyNewGrade(
  title: string,
  message: string,
  gradeId?: string,
): Promise<void> {
  const extra = gradeId ? JSON.stringify({ gradeId }) : undefined;
  return showNotification(NotificationType.NewGrade, title, message, extra);
}

export async function notifyDeadline(
  title: string,
  message: string,
  assignmentId?: string,
): Promise<void> {
  const extra = assignmentId ? JSON.stringify({ assignmentId }) : undefined;
  return showNotification(
    NotificationType.AssignmentDeadline,
    title,
    message,
    extra,
  );
}

export async function triggerSync(): Promise<void> {
  if (isWebBuild()) return; // Web data refreshes via cache + resume; no background sync to trigger.
  return invoke("trigger_sync");
}

export async function getDebugInfo(): Promise<string> {
  if (isWebBuild()) return "Webversie — geen native debug-info beschikbaar.";
  return invoke("get_debug_info");
}

export async function getSyncStateDebug(): Promise<string> {
  if (isWebBuild()) return "Webversie — synchronisatie loopt via de browsercache.";
  return invoke("get_sync_state_debug");
}

export async function clearSyncState(): Promise<string> {
  if (isWebBuild()) {
    const { cacheClearAll } = await import("./cache");
    await cacheClearAll();
    return "Browsercache gewist.";
  }
  return invoke("clear_sync_state");
}

export async function getSyncInterval(): Promise<number> {
  if (isWebBuild()) return 900; // Web has no background scheduler; 15 min floor kept for parity.
  return invoke("get_sync_interval");
}

export async function setSyncInterval(seconds: number): Promise<string> {
  if (isWebBuild()) {
    void seconds;
    return "Achtergrondsynchronisatie is niet beschikbaar in de webversie.";
  }
  return invoke("set_sync_interval", { seconds });
}

// === AI Relevance Scoring ===

export async function getNightSleepConfig(): Promise<any> {
  if (isWebBuild()) return { enabled: false, startHour: 23, endHour: 7 };
  return invoke("get_night_sleep_config");
}

export async function setNightSleepConfig(
  enabled: boolean,
  startHour: number,
  endHour: number,
): Promise<string> {
  if (isWebBuild()) {
    void enabled;
    void startHour;
    void endHour;
    return "Niet beschikbaar in de webversie.";
  }
  return invoke("set_night_sleep_config", { enabled, startHour, endHour });
}

export async function getDisableAllNotifications(): Promise<boolean> {
  if (isWebBuild()) return false;
  return invoke("get_disable_all_notifications");
}

export async function getDndAccessStatus(): Promise<boolean> {
  if (isWebBuild()) return false;
  return invoke("get_dnd_access_status");
}

export async function triggerDndTest(): Promise<void> {
  if (isWebBuild()) return;
  return invoke("trigger_dnd_test");
}

export async function setDisableAllNotifications(
  enabled: boolean,
): Promise<string> {
  if (isWebBuild()) {
    void enabled;
    return "Niet beschikbaar in de webversie.";
  }
  return invoke("set_disable_all_notifications", { enabled });
}

export async function syncNotificationPreferences(
  notifyMessages: boolean,
  notifyGrades: boolean,
  notifyDeadlines: boolean,
  notifyCalendar: boolean,
  notifyAutoDnd: boolean,
): Promise<void> {
  if (isWebBuild()) return;
  return invoke("sync_notification_preferences", {
    notifyMessages,
    notifyGrades,
    notifyDeadlines,
    notifyCalendar,
    notifyAutoDnd,
  });
}

// === Export ===
export interface ExportResult {
  success: boolean;
  files: string[];
  error: string | null;
}

export async function exportAllData(): Promise<ExportResult> {
  if (isWebBuild()) {
    // Browsers can't write a folder of files: same 9 categories as one JSON
    // download instead (see webExportAllData, mirrors export.rs).
    const tokens = await wtokens();
    const pid = tokens.personId;
    if (pid == null) throw new Error("Geen leerling gevonden bij dit account.");
    const result = await tierB.webExportAllData(sessionTierA(), tokens, pid);
    const blob = new Blob([result.json], { type: "application/json" });
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = result.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
    return {
      success: true,
      files: [result.filename],
      error: result.warnings.length > 0 ? `Waarschuwingen bij: ${result.warnings.join("; ")}` : null,
    };
  }
  return invoke("export_all_data");
}

// === Helpers ===
export function formatDate(date: Date | string): string {
  if (!date) return "";
  if (typeof date === "string") {
    // If it's already a YYYY-MM-DD string, return as is
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
    // If it's a longer ISO string, take the first 10 characters
    if (date.length >= 10 && /^\d{4}-\d{2}-\d{2}/.test(date))
      return date.substring(0, 10);
    // Otherwise try to parse it
    const parsed = new Date(date);
    if (!isNaN(parsed.getTime())) {
      return parsed.toISOString().split("T")[0];
    }
    return date;
  }
  return date.toISOString().split("T")[0];
}

export function getWeekRange(date: Date): { start: string; end: string } {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(d.setDate(diff));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return {
    start: formatDate(monday),
    end: formatDate(sunday),
  };
}

export function infoTypeName(type: number): string {
  const names: Record<number, string> = {
    0: "Geen",
    1: "Huiswerk",
    2: "Proefwerk",
    3: "Tentamen",
    4: "SO",
    5: "MO",
    6: "Informatie",
    7: "Notitie",
  };
  return names[type] ?? "Geen";
}

export function infoTypeShort(type: number): string {
  const shorts: Record<number, string> = {
    0: "",
    1: "HW",
    2: "PW",
    3: "TT",
    4: "SO",
    5: "MO",
    6: "Inf",
    7: "Not",
  };
  return shorts[type] ?? "";
}

export function calendarTypeName(type: number): string {
  const names: Record<number, string> = {
    0: "Geen",
    1: "Persoonlijk",
    2: "Algemeen",
    3: "Schoolbreed",
    4: "Stage",
    5: "Intake",
    6: "Vrij",
    7: "KWT",
    8: "Standby",
    9: "Geblokkeerd",
    10: "Anders",
    13: "Les",
    16: "Rooster",
  };
  return names[type] ?? "Onbekend";
}

export function formatTeacherName(name: string | undefined | null): string {
  if (!name) return "";
  return name.replace(/\s*\([^)]+\)/g, "").trim();
}
