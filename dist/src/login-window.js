import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import initSqlJs from 'sql.js';
import { launchChrome, runningChrome } from './chrome.js';
import { ensurePrivateDir } from './paths.js';
import { classifyHosts } from './sites.js';
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
export async function startLoginWindow(dir, opts) {
    // Inside the profile, not in /tmp: the session is restored later and the tab must still load.
    ensurePrivateDir(dir);
    const instructions = join(dir, INSTRUCTIONS_FILE);
    writeFileSync(instructions, instructionPage(opts.name, opts.sites ?? []));
    const startedAt = new Date(Date.now() - 1000);
    const urls = [pathToFileURL(instructions).href, ...(opts.sites ?? []).map(siteUrl)];
    const running = await runningChrome(dir);
    if (running?.endpoint) {
        // A site already open in a tab (Teams the person left open) is not opened a second time.
        const open = await openHosts(running.endpoint);
        const missing = urls.filter(url => { const host = httpHost(url); return !host || !open.has(host); });
        // Opening tabs over HTTP creates targets without attaching to any page.
        for (const url of missing)
            await fetch(`${running.endpoint}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
    }
    const chrome = running ?? await launchChrome(dir, {
        restore: true,
        look: opts.look,
        browser: opts.browser,
        detached: true,
        debugPort: true,
        urls,
    });
    try {
        if (opts.onReady)
            await opts.onReady({ endpoint: chrome.endpoint, close: () => { chrome.close().catch(() => { }); } });
    }
    catch (e) {
        await chrome.close();
        throw e;
    }
    return { startedAt, chrome };
}
/** Opens the user window and waits until the human closes it (or the timeout closes it). */
export async function openLoginWindow(dir, opts) {
    const { startedAt, chrome } = await startLoginWindow(dir, opts);
    let timer;
    const timedOut = await Promise.race([
        chrome.exited.then(() => false),
        new Promise(resolve => { timer = setTimeout(() => resolve(true), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS); }),
    ]);
    clearTimeout(timer);
    if (timedOut)
        await chrome.close();
    return { ...await readLogin(dir, startedAt), timedOut };
}
/** Hosts shown in the browser's tabs, read over HTTP without attaching to any page. */
async function openHosts(endpoint) {
    const targets = await (await fetch(`${endpoint}/json/list`)).json();
    return new Set(targets.filter(t => t.type === 'page').map(t => httpHost(t.url)).filter((h) => !!h));
}
/** "https://app.example.com/vendor?code=…#x" → "https://app.example.com/vendor" */
export function pageUrl(url) {
    const u = new URL(url);
    return u.origin + u.pathname;
}
/** "https://Outlook.office.com/mail" → "outlook.office.com"; ports are kept (localhost:3000 matters). */
export function httpHost(url) {
    try {
        const u = new URL(url);
        return u.protocol === 'http:' || u.protocol === 'https:' ? u.host : undefined;
    }
    catch {
        return undefined;
    }
}
/** Accepts a bare host or a URL as typed by a human. */
export function normalizeSite(site) {
    const s = site.trim();
    if (!s)
        return undefined;
    return httpHost(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`);
}
/** Chrome page transition qualifier: the visit ended a redirect chain, i.e. the page was shown. */
const CHAIN_END = 0x20000000;
/**
 * Hosts of pages visited between `since` and `until`, from the profile's History database.
 * Read it after Chrome exits: History is flushed on exit.
 */
export async function readLogin(dir, since, until = new Date()) {
    const file = join(dir, 'Default', 'History');
    if (!existsSync(file))
        return { sites: [], signIn: [], landings: [] };
    const SQL = await initSqlJs();
    const db = new SQL.Database(readFileSync(file));
    try {
        const rows = db.exec('SELECT u.url, u.title, v.transition FROM visits v JOIN urls u ON u.id = v.url WHERE v.visit_time BETWEEN ? AND ? ORDER BY v.visit_time', [chromeTime(since), chromeTime(until)]);
        const hosts = new Set();
        const last = new Map();
        for (const [url, title, transition] of rows[0]?.values ?? []) {
            const host = httpHost(String(url));
            if (!host)
                continue;
            hosts.add(host);
            if (Number(transition) & CHAIN_END)
                last.set(host, { host, url: pageUrl(String(url)), title: String(title ?? '') });
        }
        const { sites, signIn } = classifyHosts([...hosts], new Set(last.keys()));
        return { sites, signIn, landings: sites.map(h => last.get(h)) };
    }
    finally {
        db.close();
    }
}
function chromeTime(d) {
    return d.getTime() * 1000 + CHROME_EPOCH_OFFSET_US;
}
function siteUrl(host) {
    return /^(localhost|127\.|\[::1\])/.test(host) ? `http://${host}` : `https://${host}`;
}
function instructionPage(name, sites) {
    const esc = (s) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
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
