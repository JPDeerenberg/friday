import { writable } from 'svelte/store';

export const isLoggedIn = writable(false);
export const personId = writable<number | null>(null);
export const accountInfo = writable<any>(null);
export const profilePicture = writable<string | null>(null);
export const currentPage = writable<string>('dashboard');
export const navigationStack = writable<string[]>([]);

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
const DEFAULT_SETTINGS = {
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
};

const savedSettings = typeof window !== 'undefined' ? localStorage.getItem('user_settings') : null;
export const userSettings = writable(savedSettings ? { ...DEFAULT_SETTINGS, ...JSON.parse(savedSettings) } : DEFAULT_SETTINGS);

if (typeof window !== 'undefined') {
  userSettings.subscribe(val => {
    localStorage.setItem('user_settings', JSON.stringify(val));
  });
}
