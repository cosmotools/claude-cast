import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import initSqlJs from 'sql.js';
import type { Browser } from './browsers.js';
import { type Chrome, type WindowLook, hasSession, launchChrome, runningChrome } from './chrome.js';
import { ensurePrivateDir } from './paths.js';
import { classifyHosts } from './sites.js';

export interface LoginWindow {
  /** DevTools endpoint; tests (CAST_TEST_HEADLESS=1) play the human over it. */
  endpoint?: string;
  /** Closes Chrome gracefully, like closing the window. */
  close(): void;
}

export interface LoginWindowOptions {
  /** Profile name shown on the instruction page. */
  name: string;
  /** Sites the profile already knows; opened as extra tabs for /cast:open. */
  sites?: string[];
  look?: WindowLook;
  browser?: Browser;
  timeoutMs?: number;
  /** Tests only: called once Chrome runs, to browse and close the window instead of a human. */
  onReady?: (window: LoginWindow) => void | Promise<void>;
}

export interface Landing {
  host: string;
  /** Origin and path of the last page shown on that host; query and fragment are dropped (they may carry tokens). */
  url: string;
  title: string;
}

export interface LoginResult {
  /** Hosts (with port) where the person landed while the window was open, in first-visit order. */
  sites: string[];
  /** Sign-in pages and redirect-only hops visited meanwhile. */
  signIn: string[];
  /** For each of `sites`: the page the person ended up on. It often tells the person's role (/vendor, /admin). */
  landings: Landing[];
}

export interface StartedLogin {
  /** Visits from this moment on belong to the login. */
  startedAt: Date;
  chrome: Chrome;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
/** The instruction page, kept in the profile folder; the gateway closes its tab when Claude opens the profile. */
export const INSTRUCTIONS_FILE = 'cast-login.html';
/** Chrome stores times as microseconds since 1601-01-01. */
const CHROME_EPOCH_OFFSET_US = 11_644_473_600_000_000;

/**
 * Opens the profile's Chrome for the human and returns at once. Chrome runs detached, so the window
 * outlives cast and the Claude session; what was visited is read later with readLogin. When the
 * profile's Chrome already runs with a DevTools port (the person's window, or one Claude attached to and
 * detached from), the instruction page and sites open as new tabs there.
 *
 * Nothing attaches to its pages while the person signs in: SSO bot checks (GoDaddy-federated Microsoft
 * 365) refuse a browser that Playwright is attached to, even with navigator.webdriver = false. The window
 * has the same DevTools port and flags as Claude's window, so Claude can attach to it once the person is
 * done. The previous session's tabs come back.
 */
export async function startLoginWindow(dir: string, opts: LoginWindowOptions): Promise<StartedLogin> {
  // Inside the profile, not in /tmp: the session is restored later and the tab must still load.
  ensurePrivateDir(dir);
  const instructions = join(dir, INSTRUCTIONS_FILE);
  writeFileSync(instructions, instructionPage(opts.name, opts.sites ?? []));
  const startedAt = new Date(Date.now() - 1000);
  const instructionsUrl = pathToFileURL(instructions).href;
  const sites = (opts.sites ?? []).map(siteUrl);

  const running = await runningChrome(dir);
  // A restored session already holds the tabs the person had: they are added to, not opened again.
  const restoring = !running && hasSession(dir);
  const chrome = running ?? await launchChrome(dir, {
    restore: true,
    look: opts.look,
    browser: opts.browser,
    detached: true,
    debugPort: true,
    urls: restoring ? [] : [instructionsUrl, ...sites],
  });
  if ((running || restoring) && chrome.endpoint) await addTabs(chrome.endpoint, instructionsUrl, sites, restoring);
  try {
    if (opts.onReady) await opts.onReady({ endpoint: chrome.endpoint, close: () => { chrome.close().catch(() => {}); } });
  } catch (e) {
    await chrome.close();
    throw e;
  }
  return { startedAt, chrome };
}

/** Opens the user window and waits until the human closes it (or the timeout closes it). */
export async function openLoginWindow(dir: string, opts: LoginWindowOptions): Promise<LoginResult & { timedOut: boolean }> {
  const { startedAt, chrome } = await startLoginWindow(dir, opts);
  let timer: NodeJS.Timeout | undefined;
  const timedOut = await Promise.race([
    chrome.exited.then(() => false),
    new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(true), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS); }),
  ]);
  clearTimeout(timer);
  if (timedOut) await chrome.close();
  return { ...await readLogin(dir, startedAt), timedOut };
}

interface Tab { id: string; url: string }

/** The browser's tabs, read over HTTP without attaching to any page. */
async function pageTabs(endpoint: string): Promise<Tab[]> {
  const targets = await (await fetch(`${endpoint}/json/list`)).json() as (Tab & { type: string })[];
  return targets.filter(t => t.type === 'page');
}

/** The tabs once Chrome has restored the session: the list is not empty and stops changing (up to 5 s). */
async function restoredTabs(endpoint: string): Promise<Tab[]> {
  const deadline = Date.now() + 5000;
  let last = '';
  for (;;) {
    const tabs = await pageTabs(endpoint);
    const ids = tabs.map(t => t.id).join();
    if ((tabs.length && ids === last) || Date.now() > deadline) return tabs;
    last = ids;
    await new Promise(r => setTimeout(r, 250));
  }
}

/**
 * Opens the instruction page and the sites not open yet (Teams the person left open is not opened a second
 * time) in a window that has tabs already. Earlier instruction pages are closed after the new one opens, so
 * the window is never left without a tab. Over HTTP: no page is attached while the person signs in.
 */
async function addTabs(endpoint: string, instructionsUrl: string, sites: string[], restoring: boolean): Promise<void> {
  const tabs = restoring ? await restoredTabs(endpoint) : await pageTabs(endpoint);
  const open = new Set(tabs.map(t => httpHost(t.url)).filter(h => h));
  // The instruction page last: the newest tab is the one in front.
  for (const url of [...sites.filter(url => !open.has(httpHost(url))), instructionsUrl]) {
    await fetch(`${endpoint}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  }
  // Compared by name: Chrome may spell the file URL differently (drive letter, escapes).
  const earlier = tabs.filter(t => t.url.startsWith('file:') && t.url.endsWith(`/${INSTRUCTIONS_FILE}`));
  for (const tab of earlier) await fetch(`${endpoint}/json/close/${tab.id}`);
  // Closing finishes after the reply; wait (up to 5 s) so the next call sees the window as it is.
  const closing = new Set(earlier.map(t => t.id));
  for (const end = Date.now() + 5000; closing.size && Date.now() < end; await new Promise(r => setTimeout(r, 100))) {
    if (!(await pageTabs(endpoint)).some(t => closing.has(t.id))) break;
  }
}

/** "https://app.example.com/vendor?code=…#x" → "https://app.example.com/vendor" */
export function pageUrl(url: string): string {
  const u = new URL(url);
  return u.origin + u.pathname;
}

/** "https://Outlook.office.com/mail" → "outlook.office.com"; ports are kept (localhost:3000 matters). */
export function httpHost(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.host : undefined;
  } catch {
    return undefined;
  }
}

/** Accepts a bare host or a URL as typed by a human. */
export function normalizeSite(site: string): string | undefined {
  const s = site.trim();
  if (!s) return undefined;
  return httpHost(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`);
}

/** Chrome page transition qualifier: the visit ended a redirect chain, i.e. the page was shown. */
const CHAIN_END = 0x20000000;

/**
 * Hosts of pages visited between `since` and `until`, from the profile's History database.
 * Read it after Chrome exits: History is flushed on exit.
 */
export async function readLogin(dir: string, since: Date, until = new Date()): Promise<LoginResult> {
  const file = join(dir, 'Default', 'History');
  if (!existsSync(file)) return { sites: [], signIn: [], landings: [] };
  const SQL = await initSqlJs();
  const db = new SQL.Database(readFileSync(file));
  try {
    const rows = db.exec(
      'SELECT u.url, u.title, v.transition FROM visits v JOIN urls u ON u.id = v.url WHERE v.visit_time BETWEEN ? AND ? ORDER BY v.visit_time',
      [chromeTime(since), chromeTime(until)],
    );
    const hosts = new Set<string>();
    const last = new Map<string, Landing>();
    for (const [url, title, transition] of rows[0]?.values ?? []) {
      const host = httpHost(String(url));
      if (!host) continue;
      hosts.add(host);
      if (Number(transition) & CHAIN_END) last.set(host, { host, url: pageUrl(String(url)), title: String(title ?? '') });
    }
    const { sites, signIn } = classifyHosts([...hosts], new Set(last.keys()));
    return { sites, signIn, landings: sites.map(h => last.get(h)!) };
  } finally {
    db.close();
  }
}

function chromeTime(d: Date): number {
  return d.getTime() * 1000 + CHROME_EPOCH_OFFSET_US;
}

function siteUrl(host: string): string {
  return /^(localhost|127\.|\[::1\])/.test(host) ? `http://${host}` : `https://${host}`;
}

function instructionPage(name: string, sites: string[]): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const known = sites.length
    ? `<p>Known sites for this profile are opened in the other tabs: ${sites.map(esc).join(', ')}.</p>`
    : '';
  return `<!doctype html><meta charset="utf-8"><title>cast: ${esc(name)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;color:#222}
h1{font-size:1.6rem}li{margin:.4rem 0}</style>
<h1>Browser profile “${esc(name)}”</h1>
<p>This Chrome window belongs to the cast profile <b>${esc(name)}</b>. Claude will reuse it later, already logged in.</p>
<ol>
<li>Open a new tab and log in everywhere ${esc(name)} needs: your app, email, SSO, chat…</li>
<li>When asked about MFA or “Stay signed in”, choose to stay signed in.</li>
<li>When you are done, <b>tell Claude</b>. You can keep this window: Claude then works in it. Or close it.</li>
</ol>
${known}
<p>This is a regular Chrome: nothing is automated while you log in, and Claude does not act here until you say you are done. cast never stores or types passwords; it only notes which sites you visited and the last page on each (no cookies).</p>
<p>You can leave Claude Code meanwhile: cast reads the visited sites once the window is closed.</p>`;
}
