import { invoke } from '@tauri-apps/api/core';

// === Auth ===
export async function getLoginUrl(tenant?: string, username?: string): Promise<string> {
  return invoke('get_login_url', { tenant, username });
}

export async function startLoginFlow(tenant?: string, username?: string): Promise<void> {
  return invoke('start_login_flow', { tenant, username });
}

export async function handleAuthCallback(redirectUrl: string): Promise<any> {
  return invoke('handle_auth_callback', { redirectUrl });
}

export async function isAuthenticated(): Promise<boolean> {
  return invoke('is_authenticated');
}

export async function getAccount(): Promise<any> {
  return invoke('get_account');
}

export async function getPersonId(): Promise<number> {
  return invoke('get_person_id');
}

export async function getProfilePicture(personId: number): Promise<string | null> {
  return invoke('get_profile_picture', { personId });
}

export async function logout(): Promise<void> {
  return invoke('logout');
}

export async function restoreSession(): Promise<boolean> {
  return invoke('restore_session');
}

export async function getProfileInfo(personId: number): Promise<any> {
  return invoke('get_profile_info', { personId });
}

export async function getProfileAddresses(personId: number): Promise<any[]> {
  return invoke('get_profile_addresses', { personId });
}

export async function getCareerInfo(personId: number): Promise<any> {
  return invoke('get_career_info', { personId });
}

// === Calendar ===
export async function getCalendarEvents(personId: number, start: string, end: string): Promise<any[]> {
  return invoke('get_calendar_events', { personId, start, end });
}

export async function getAbsences(personId: number, van: string, tot: string): Promise<any[]> {
  return invoke('get_absences', { personId, van, tot });
}

export async function getCalendarEvent(personId: number, eventId: number): Promise<any> {
  return invoke('get_calendar_event', { personId, eventId });
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
  return invoke('create_calendar_event', params);
}

export async function updateCalendarEvent(selfUrl: string, eventJson: string): Promise<void> {
  return invoke('update_calendar_event', { selfUrl, eventJson });
}

export async function deleteCalendarEvent(selfUrl: string): Promise<void> {
  return invoke('delete_calendar_event', { selfUrl });
}

// === Grades ===
export async function getSchoolyears(personId: number, start?: string, end?: string): Promise<any[]> {
  return invoke('get_schoolyears', { personId, start, end });
}

export async function getGrades(personId: number, schoolyearId: number, einde: string): Promise<any[]> {
  return invoke('get_grades', { personId, schoolyearId, einde });
}

export async function getGradeExtraInfo(personId: number, schoolyearId: number, kolomId: number): Promise<any> {
    return await invoke('get_grade_extra_info', { personId, schoolyearId, kolomId });
}

export async function getBulkGradeExtraInfo(personId: number, schoolyearId: number, kolomIds: number[]): Promise<Record<number, any>> {
    return await invoke('get_bulk_grade_extra_info', { personId, schoolyearId, kolomIds });
}

export async function getRecentGrades(personId: number, top?: number): Promise<any[]> {
    return await invoke('get_recent_grades', { personId, top });
}

// === Messages ===
export async function getMessageFolders(): Promise<any[]> {
  return invoke('get_message_folders');
}

export async function getMessages(berichtenLink: string, top?: number, skip?: number, query?: string): Promise<any[]> {
  return invoke('get_messages', { berichtenLink, top, skip, query });
}

export async function getMessageDetail(selfLink: string): Promise<any> {
  return invoke('get_message_detail', { selfLink });
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
  return invoke('send_message', params);
}

export async function markMessagesAsRead(messageIds: number[], read: boolean): Promise<void> {
  return invoke('mark_messages_as_read', { messageIds, read });
}

export async function moveMessagesToFolder(messageIds: number[], folderId: number): Promise<void> {
  return invoke('move_messages_to_folder', { messageIds, folderId });
}

export async function deleteMessages(messageIds: number[], areConcepts: boolean): Promise<void> {
  return invoke('delete_messages', { messageIds, areConcepts });
}

export async function searchContacts(query: string, maxResults?: number): Promise<any[]> {
  return invoke('search_contacts', { query, maxResults });
}

// === Assignments ===
export async function getAssignments(personId: number, start: string, end: string): Promise<any[]> {
  return invoke('get_assignments', { personId, start, end });
}

export async function getAssignmentDetail(selfUrl: string): Promise<any> {
  return invoke('get_assignment_detail', { selfUrl });
}

export async function handInAssignment(selfUrl: string, opdrachtId: number, versionJson: string): Promise<void> {
  return invoke('hand_in_assignment', { selfUrl, opdrachtId, versionJson });
}

export async function uploadAssignmentAttachment(filePath: string): Promise<[number, string]> {
  return invoke('upload_assignment_attachment', { filePath });
}

// === Leermiddelen ===
export async function getLeermiddelen(personId: number): Promise<any[]> {
  return invoke('get_leermiddelen', { personId });
}

export async function getLeermiddelLaunchUrl(href: string): Promise<string> {
  return invoke('get_leermiddel_launch_url', { href });
}

// === Activities ===
export async function getActivities(personId: number): Promise<any[]> {
  return invoke('get_activities', { personId });
}

export async function getActivityElements(personId: number, activityId: number): Promise<any[]> {
  return invoke('get_activity_elements', { personId, activityId });
}

// === Bronnen ===
export async function getBronnen(path: string): Promise<any[]> {
  return invoke('get_bronnen', { path });
}

export async function getExternalBronSources(personId: number): Promise<any[]> {
  return invoke('get_external_bron_sources', { personId });
}

// === Studiewijzers ===
export async function getStudiewijzers(personId: number): Promise<any[]> {
  return invoke('get_studiewijzers', { personId });
}

export async function getStudiewijzerDetail(personId: number, id: number, isProject: boolean): Promise<any> {
  return invoke('get_studiewijzer_detail', { personId, id, isProject });
}

export async function getStudiewijzerOnderdeelDetail(personId: number, swId: number, onderdeelId: number, isProject: boolean): Promise<any> {
    return invoke('get_studiewijzer_onderdeel_detail', { personId, swId, onderdeelId, isProject });
}

export async function triggerTestNotification(): Promise<void> {
    return invoke('trigger_test_notification');
}

// Notification types
export enum NotificationType {
    Test = 0,
    Message = 1,
    CalendarChange = 2,
    NewGrade = 3,
    AssignmentDeadline = 4,
}

export interface NotificationPayload {
    notification_type: NotificationType;
    title: string;
    message: string;
    extra?: string;
}

export async function showNotification(
    type: NotificationType,
    title: string,
    message: string,
    extra?: string
): Promise<void> {
    return invoke('show_notification', { 
        notificationType: type, 
        title, 
        message, 
        extra: extra ?? null 
    });
}

// Type-specific notification helpers
export async function notifyNewMessage(title: string, message: string, sender?: string): Promise<void> {
    const extra = sender ? JSON.stringify({ sender }) : undefined;
    return showNotification(NotificationType.Message, title, message, extra);
}

export async function notifyCalendarChange(title: string, message: string, eventId?: string): Promise<void> {
    const extra = eventId ? JSON.stringify({ eventId }) : undefined;
    return showNotification(NotificationType.CalendarChange, title, message, extra);
}

export async function notifyNewGrade(title: string, message: string, gradeId?: string): Promise<void> {
    const extra = gradeId ? JSON.stringify({ gradeId }) : undefined;
    return showNotification(NotificationType.NewGrade, title, message, extra);
}

export async function notifyDeadline(title: string, message: string, assignmentId?: string): Promise<void> {
    const extra = assignmentId ? JSON.stringify({ assignmentId }) : undefined;
    return showNotification(NotificationType.AssignmentDeadline, title, message, extra);
}

export async function triggerSync(): Promise<void> {
    return invoke('trigger_sync');
}

export async function syncNotificationPreferences(
    notifyMessages: boolean,
    notifyGrades: boolean,
    notifyDeadlines: boolean,
    notifyCalendar: boolean
): Promise<void> {
    return invoke('sync_notification_preferences', {
        notifyMessages,
        notifyGrades,
        notifyDeadlines,
        notifyCalendar
    });
}

// === Helpers ===
export function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
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
    0: 'Geen', 1: 'Huiswerk', 2: 'Proefwerk', 3: 'Tentamen',
    4: 'SO', 5: 'MO', 6: 'Informatie', 7: 'Notitie'
  };
  return names[type] ?? 'Geen';
}

export function infoTypeShort(type: number): string {
  const shorts: Record<number, string> = {
    0: '', 1: 'HW', 2: 'PW', 3: 'TT', 4: 'SO', 5: 'MO', 6: 'Inf', 7: 'Not'
  };
  return shorts[type] ?? '';
}

export function calendarTypeName(type: number): string {
  const names: Record<number, string> = {
    0: 'Geen', 1: 'Persoonlijk', 2: 'Algemeen', 3: 'Schoolbreed',
    4: 'Stage', 5: 'Intake', 6: 'Vrij', 7: 'KWT', 8: 'Standby',
    9: 'Geblokkeerd', 10: 'Anders', 13: 'Les', 16: 'Rooster'
};
  return names[type] ?? 'Onbekend';
}

export function formatTeacherName(name: string | undefined | null): string {
  if (!name) return '';
  return name.replace(/\s*\([^)]+\)/g, '').trim();
}
