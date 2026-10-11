import { isRunning } from './chrome.js';
import { type LoginResult, readLogin } from './login-window.js';
import type { CastPaths } from './paths.js';
import { type Profile, findProfile, loadProfiles, updateProfile } from './registry.js';

/**
 * A login runs from /cast:add or /cast:open until cast has read what the human visited: when the window
 * is closed, or when the person says they are done (cast_user_window_result). The window may outlive the
 * Claude session, so any later cast call (or the next session start) finishes a closed one.
 */
export function loginPending(p: Profile): boolean {
  return !!p.loginStartedAt && !(p.lastLoginAt && p.lastLoginAt >= p.loginStartedAt);
}

/** Chrome writes visits to History in batches every 10 s. */
const HISTORY_COMMIT_MS = 11_000;

/**
 * Saves the sites visited in a finished user window (without asking: /cast:edit changes them).
 * Returns undefined while the window is still open, unless `open` is set: the person said they are done
 * and keeps the window; cast then waits for Chrome to write the last visits to History.
 */
export async function finishLogin(paths: CastPaths, name: string, open = false): Promise<Profile | undefined> {
  const p = findProfile(paths, name);
  if (!p?.ready || !loginPending(p)) return p;
  if (isRunning(p.dir)) {
    if (!open) return undefined;
    await new Promise(r => setTimeout(r, HISTORY_COMMIT_MS));
  }
  const r = await readLogin(p.dir, new Date(p.loginStartedAt!));
  const added = r.sites.filter(s => !p.sites.includes(s));
  return updateProfile(paths, p.name, { sites: [...p.sites, ...added], lastLoginAt: new Date().toISOString() });
}

/** Finishes the logins whose windows were closed, e.g. after the Claude session that opened them ended. */
export async function finishClosedLogins(paths: CastPaths): Promise<void> {
  for (const p of loadProfiles(paths)) {
    if (p.ready && loginPending(p) && !isRunning(p.dir)) await finishLogin(paths, p.name).catch(() => {});
  }
}

/** What the human visited in the last finished user window. */
export function lastLogin(p: Profile): Promise<LoginResult> {
  return readLogin(p.dir, new Date(p.loginStartedAt!), new Date(p.lastLoginAt!));
}
