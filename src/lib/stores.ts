import { writable } from 'svelte/store';

export const isLoggedIn = writable(false);
export const personId = writable<number | null>(null);
export const accountInfo = writable<any>(null);
export const profilePicture = writable<string | null>(null);
export const currentPage = writable('dashboard');

// Persistent Settings
const DEFAULT_SETTINGS = {
  roundedGraphs: true,
  showSummary: true,
  decimalPoints: 1,
  highlightFailing: true,
  compactView: false,
  insufficientThreshold: 5.5,
  zoomGraph: false,
  showWeekend: true,
};

const savedSettings = typeof window !== 'undefined' ? localStorage.getItem('user_settings') : null;
export const userSettings = writable(savedSettings ? { ...DEFAULT_SETTINGS, ...JSON.parse(savedSettings) } : DEFAULT_SETTINGS);

if (typeof window !== 'undefined') {
  userSettings.subscribe(val => {
    localStorage.setItem('user_settings', JSON.stringify(val));
  });
}
