import { writable } from 'svelte/store';

export const isLoggedIn = writable(false);
export const personId = writable<number | null>(null);
export const accountInfo = writable<any>(null);
export const profilePicture = writable<string | null>(null);
export const currentPage = writable<string>('dashboard');
export const navigationStack = writable<string[]>([]);

// Sync status
export const lastSyncTime = writable<Date | null>(null);
export const syncInProgress = writable(false);

export function navigate(pageId: string) {
  currentPage.update(current => {
    if (current !== pageId) {
      navigationStack.update(stack => [...stack, current]);
    }
    return pageId;
  });
}

export function goBack() {
  let canExit = false;
  navigationStack.update(stack => {
    if (stack.length > 0) {
      const prev = stack[stack.length - 1];
      currentPage.set(prev);
      return stack.slice(0, -1);
    }
    canExit = true;
    return stack;
  });
  return canExit;
}

// Persistent Settings
export const DEFAULT_SETTINGS = {
  roundedGraphs: true,
  showSummary: true,
  decimalPoints: 1,
  highlightFailing: true,
  compactView: false,
  insufficientThreshold: 5.5,
  zoomGraph: false,
  showWeekend: true,
  themeColor: 'violet',
  backgroundMode: 'normal',
  // Notification toggles
  notifyMessages: true,
  notifyGrades: true,
  notifyDeadlines: true,
  notifyCalendar: true,
  notifyAutoDnd: false,
  hideCancelled: false,
  combineLessons: false,
  showBreakSeparator: false,
};

// Load settings from localStorage
export function loadSettings() {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS;
  
  const savedSettings = localStorage.getItem('user_settings');
  if (savedSettings) {
    try {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(savedSettings) };
    } catch (e) {
      return DEFAULT_SETTINGS;
    }
  }
  return DEFAULT_SETTINGS;
}

export const userSettings = writable(loadSettings());

if (typeof window !== 'undefined') {
  userSettings.subscribe(val => {
    localStorage.setItem('user_settings', JSON.stringify(val));
    
    // Sync notification preferences to Android
    if (val.notifyMessages !== undefined || val.notifyGrades !== undefined || 
        val.notifyDeadlines !== undefined || val.notifyCalendar !== undefined ||
        val.notifyAutoDnd !== undefined) {
      syncPreferencesToAndroid(val);
    }
  });
}

// Sync preferences to Android via Tauri bridge
function syncPreferencesToAndroid(settings: any) {
  // Store in localStorage for Android to read
  localStorage.setItem('friday_notification_prefs', JSON.stringify({
    notifyMessages: settings.notifyMessages ?? true,
    notifyGrades: settings.notifyGrades ?? true,
    notifyDeadlines: settings.notifyDeadlines ?? true,
    notifyCalendar: settings.notifyCalendar ?? true,
    notifyAutoDnd: settings.notifyAutoDnd ?? false,
  }));
  
  // Also sync via Tauri command
  if (typeof window !== 'undefined' && (window as any).__TAURI__) {
    import('./api').then(api => {
      api.syncNotificationPreferences(
        settings.notifyMessages ?? true,
        settings.notifyGrades ?? true,
        settings.notifyDeadlines ?? true,
        settings.notifyCalendar ?? true,
        settings.notifyAutoDnd ?? false
      ).catch(() => {
        // Ignore errors - preferences will still be read from localStorage by Android
      });
    });
  }
}
