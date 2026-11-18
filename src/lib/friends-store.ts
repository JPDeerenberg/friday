/**
 * Persisted friends list (browser/app storage only — nothing is uploaded) and the
 * "a friend's link arrived" hand-over between the link handlers and the Friends page.
 */
import { writable } from "svelte/store";
import {
  emptyState, importFriend, markShared, removeFriend, renameFriend, sanitizeState, setEnabled, setMyName,
  type FriendsState, type ImportStatus,
} from "./friends-state.ts";
import { extractPayload, newSenderId, type ScheduleSnapshot, type SharedLesson } from "./friends-share.ts";

const KEY = "friday_friends_v1";

function load(): FriendsState {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(KEY) : null;
    const state = raw ? sanitizeState(JSON.parse(raw)) : null;
    if (state) return state;
  } catch {
    // unreadable storage: start fresh
  }
  return emptyState(newSenderId());
}

export const friends = writable<FriendsState>(load());

friends.subscribe((state) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // storage full or blocked: the in-memory list still works
  }
});

/** A pasted/opened friend link that waits for the student to confirm it. */
export const pendingFriendLink = writable<string | null>(null);

export const friendsActions = {
  /** Adds or updates a friend; returns what happened. */
  add(snapshot: ScheduleSnapshot): ImportStatus {
    let status: ImportStatus = "added";
    friends.update((s) => {
      const r = importFriend(s, snapshot);
      status = r.status;
      return r.state;
    });
    return status;
  },
  remove: (id: string) => friends.update((s) => removeFriend(s, id)),
  setEnabled: (id: string, on: boolean) => friends.update((s) => setEnabled(s, id, on)),
  rename: (id: string, nickname: string) => friends.update((s) => renameFriend(s, id, nickname)),
  setMyName: (name: string) => friends.update((s) => setMyName(s, name)),
  markShared: (snapshot: { windowStart: string; lessons: SharedLesson[] }, signature: string) =>
    friends.update((s) => markShared(s, snapshot, signature)),
};

/**
 * Called with any URL or text the app was opened with: when it carries a friend
 * link, hands it to the Friends page. Returns true when it did.
 */
export function offerFriendLink(text: string | null | undefined): boolean {
  if (!text || !extractPayload(text)) return false;
  pendingFriendLink.set(text);
  return true;
}
