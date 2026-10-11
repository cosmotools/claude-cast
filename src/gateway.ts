import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { Browser } from './browsers.js';
import { type Chrome, type WindowLook, launchChrome, runningChrome } from './chrome.js';
import { hideCredentials } from './credentials.js';
import { DialogGuard } from './dialogs.js';
import { INSTRUCTIONS_FILE } from './login-window.js';
import { ensurePrivateDir } from './paths.js';
import { VERSION } from './version.js';

const require = createRequire(import.meta.url);
/** @playwright/mcp does not export cli.js, so locate it next to its package.json. */
const PLAYWRIGHT_MCP_CLI = join(dirname(require.resolve('@playwright/mcp/package.json')), 'cli.js');

/** Tools cast replaces (browser_close → cast_close) or never exposes. */
const HIDDEN_TOOLS = new Set(['browser_close', 'browser_install']);

/** Tabs Claude may keep open per profile: opening another one closes the oldest of them, never a tab of the person. */
export const CLAUDE_TAB_LIMIT = 3;
/**
 * URLs of the tabs Claude opened, oldest first, in the Chrome profile folder. Chrome restores the tabs
 * but not who opened them, so without this record they would all look like the person's after a restart.
 */
const CLAUDE_TABS_FILE = 'cast-claude-tabs.json';
const CLAUDE_TAB = '(opened by Claude)';

export const PROFILE_PARAM = { type: 'string', description: 'cast profile name, see cast_list' } as const;

export interface GatewayProfile {
  name: string;
  /** Chrome user-data-dir. */
  dir: string;
  /** Where Playwright MCP writes snapshots and screenshots. */
  outputDir: string;
  look?: WindowLook;
  browser?: Browser;
}

interface Child {
  profile: GatewayProfile;
  chrome: Chrome;
  client: Client;
  /** DevTools target ids of the tabs Claude opened, oldest first. */
  claudeTabs: string[];
  /** The CLAUDE_TABS_FILE content last written. */
  savedTabs?: string;
  /**
   * Chrome was already running (the person's window from /cast:open): cast attached to it and leaves it
   * open when it detaches.
   */
  joined: boolean;
  /** Set when Chrome or the Playwright MCP child went away without cast closing them. */
  exited?: string;
}

export class GatewayError extends Error {}

/**
 * One regular Chrome plus one @playwright/mcp child per open profile; browser_* calls are routed by
 * profile name. cast starts Chrome itself (restoring the previous tabs) and Playwright MCP attaches
 * to it over the DevTools port, so the window behaves like the person's normal Chrome. A window the
 * person opened with /cast:open runs with a DevTools port too: cast attaches to it instead of starting
 * another Chrome, and only detaches from it when closing.
 */
export class Gateway {
  private children = new Map<string, Child>();
  private opening = new Map<string, Promise<Child>>();
  private tools?: Promise<Tool[]>;

  isOpen(name: string): boolean {
    const child = this.children.get(name.toLowerCase());
    return !!child && !child.exited;
  }

  /** Whether cast attached to a window the person opened, which cast_close leaves open. */
  isJoined(name: string): boolean {
    return !!this.children.get(name.toLowerCase())?.joined;
  }

  openNames(): string[] {
    return [...this.children.values()].filter(c => !c.exited).map(c => c.profile.name);
  }

  async open(profile: GatewayProfile): Promise<void> {
    await this.child(profile);
  }

  private async child(profile: GatewayProfile): Promise<Child> {
    const key = profile.name.toLowerCase();
    const current = this.children.get(key);
    if (current && !current.exited) return current;
    if (current) await this.close(current.profile.name);
    let pending = this.opening.get(key);
    if (!pending) {
      pending = this.start(profile).finally(() => this.opening.delete(key));
      this.opening.set(key, pending);
    }
    return pending;
  }

  private async start(profile: GatewayProfile): Promise<Child> {
    ensurePrivateDir(profile.outputDir);
    const running = await runningChrome(profile.dir);
    const chrome = running ?? await launchChrome(profile.dir, { restore: true, debugPort: true, look: profile.look, browser: profile.browser });
    const client = new Client({ name: 'cast', version: VERSION });
    const child: Child = { profile, chrome, client, claudeTabs: [], joined: !!running };
    const transport = spawnChild(['--cdp-endpoint', chrome.endpoint!, '--output-dir', profile.outputDir], profile.outputDir);
    transport.onclose = () => {
      child.exited ??= 'the Playwright MCP process exited';
      if (!child.joined) chrome.close().catch(() => {});
    };
    chrome.exited.then(() => {
      // Usually the human closed the window; the next call opens it again.
      child.exited ??= 'the Chrome window was closed';
      client.close().catch(() => {});
    });
    // A restored tab showing a dialog would keep Playwright from attaching.
    const dialogs = await DialogGuard.start(chrome.endpoint!);
    try {
      await client.connect(transport);
      await settleTabs(client);
      child.claudeTabs = await restoreClaudeTabs(chrome.endpoint!, profile.dir).catch(() => []);
    } catch (e) {
      if (child.joined) await client.close().catch(() => {});
      else await chrome.close();
      throw e;
    } finally {
      dialogs.stop();
    }
    this.children.set(profile.name.toLowerCase(), child);
    return child;
  }

  async close(name: string): Promise<boolean> {
    const key = name.toLowerCase();
    const child = this.children.get(key);
    if (!child) return false;
    this.children.delete(key);
    const wasOpen = !child.exited;
    child.exited ??= 'closed by cast';
    if (child.joined) {
      // The person's window: detaching leaves Chrome and every tab as they are.
      if (wasOpen) await saveClaudeTabs(child).catch(() => {});
      await child.client.close().catch(() => {});
      return wasOpen;
    }
    // An open dialog keeps Chrome from closing on Windows (Browser.close does not finish, and the forced
    // stop loses the session and recent cookies): cancel it first. "No dialog" errors are ignored.
    if (wasOpen) {
      await Promise.race([
        child.client.callTool({ name: 'browser_handle_dialog', arguments: { accept: false } }).catch(() => {}),
        new Promise(r => setTimeout(r, 3000)),
      ]);
      // The person may have closed or changed Claude's tabs since the last call.
      await saveClaudeTabs(child).catch(() => {});
    }
    // Chrome first: on disconnect Playwright closes the tabs it opened, and the saved session would be empty.
    await child.chrome.close();
    await child.client.close().catch(() => {});
    return wasOpen;
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.children.values()].map(c => this.close(c.profile.name)));
  }

  /** Playwright MCP's tools with a required "profile" parameter. Fetched once from a child with no profile (Chrome does not start). */
  toolDefs(): Promise<Tool[]> {
    this.tools ??= (async () => {
      const client = new Client({ name: 'cast', version: VERSION });
      await client.connect(spawnChild([]));
      try {
        const { tools } = await client.listTools();
        return tools.filter(t => !HIDDEN_TOOLS.has(t.name)).map(withProfileParam);
      } finally {
        await client.close().catch(() => {});
      }
    })();
    this.tools.catch(() => { this.tools = undefined; });
    return this.tools;
  }

  /**
   * Opens the profile if needed and forwards the call. The answer is the child's, with the tabs Claude
   * opened marked in tab lists. A new tab first closes the oldest of Claude's tabs when there are too many.
   */
  async call(profile: GatewayProfile, tool: string, args: Record<string, unknown>): Promise<CallToolResult> {
    if (HIDDEN_TOOLS.has(tool)) throw new GatewayError(`${tool} is not available through cast; use cast_close.`);
    const child = await this.child(profile);
    const newTab = tool === 'browser_tabs' && args.action === 'new';
    try {
      const before = newTab ? await makeRoomForTab(child).catch(() => undefined) : undefined;
      const result = await child.client.callTool({ name: tool, arguments: args }) as CallToolResult;
      const tabs = await saveClaudeTabs(child, before).catch(() => undefined);
      const answer = absoluteLinks(tabs ? markClaudeTabs(result, child, tabs) : result, profile.outputDir);
      return NETWORK_TOOLS.has(tool) ? withoutCredentials(answer) : answer;
    } catch (e) {
      if (child.exited) {
        throw new GatewayError(`Browser for "${profile.name}" stopped (${child.exited}). Call the tool again to reopen it.`);
      }
      throw e;
    }
  }

  /**
   * Opens a URL for Claude without replacing the person's tab: in a new tab, or in the current one when
   * it is an empty new tab page (a new profile's only tab), which then counts as Claude's.
   */
  async openTab(profile: GatewayProfile, url: string): Promise<CallToolResult> {
    const tabs = await this.call(profile, 'browser_tabs', { action: 'list' });
    if (!blankCurrentTab(tabs)) return this.call(profile, 'browser_tabs', { action: 'new', url });
    const child = await this.child(profile);
    const blank = (await pageTargets(child.chrome.endpoint!)).filter(t => BLANK_TAB.test(t.url));
    if (blank.length === 1 && !child.claudeTabs.includes(blank[0].id)) child.claudeTabs.push(blank[0].id);
    return this.call(profile, 'browser_navigate', { url });
  }
}

/** A tab as Chrome's DevTools HTTP endpoint lists it. Read there, not through Playwright MCP, whose tools wait 500 ms after each call. */
interface Target { id: string; type: string; url: string }

async function pageTargets(endpoint: string): Promise<Target[]> {
  const res = await fetch(`${endpoint}/json/list`);
  return (await res.json() as Target[]).filter(t => t.type === 'page');
}

/**
 * Forgets Claude's tabs that are gone and records the URLs of the others for the next start. A tab
 * that appeared since `before` (the tabs before browser_tabs "new") is Claude's. Returns all tabs.
 */
async function saveClaudeTabs(child: Child, before?: Target[]): Promise<Target[]> {
  const tabs = await pageTargets(child.chrome.endpoint!);
  const added = before ? tabs.filter(t => !before.some(b => b.id === t.id)) : [];
  if (added.length === 1) child.claudeTabs.push(added[0].id);
  child.claudeTabs = child.claudeTabs.filter(id => tabs.some(t => t.id === id));
  const record = JSON.stringify(child.claudeTabs.map(id => tabs.find(t => t.id === id)!.url));
  if (record !== child.savedTabs) {
    writeFileSync(join(child.profile.dir, CLAUDE_TABS_FILE), record);
    child.savedTabs = record;
  }
  return tabs;
}

/** The restored tabs that Claude opened in an earlier session, oldest first. */
async function restoreClaudeTabs(endpoint: string, dir: string): Promise<string[]> {
  let recorded: unknown;
  try {
    recorded = JSON.parse(readFileSync(join(dir, CLAUDE_TABS_FILE), 'utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(recorded) || !recorded.length) return [];
  const tabs = await pageTargets(endpoint);
  const order = matchClaudeTabs(recorded.filter((u): u is string => typeof u === 'string'), tabs.map(t => t.url));
  return tabs.map((t, i) => [t.id, order[i]] as const).filter(([, n]) => n).sort((a, b) => a[1] - b[1]).map(([id]) => id);
}

/**
 * Which restored tabs are the ones Claude opened (`recorded`, oldest first): for each restored tab, its
 * place in `recorded` counting from 1, or 0 for the person's. A URL open in more tabs than Claude had
 * open with it may be the person's too, and the tabs cannot be told apart: none of them counts as Claude's.
 */
export function matchClaudeTabs(recorded: string[], restored: string[]): number[] {
  const count = (list: string[], url: string) => list.filter(u => u === url).length;
  const order = restored.map(() => 0);
  recorded.forEach((url, i) => {
    if (count(restored, url) > count(recorded, url)) return;
    const j = restored.findIndex((u, k) => u === url && !order[k]);
    if (j >= 0) order[j] = i + 1;
  });
  return order;
}

/** Closes the oldest of Claude's tabs until another one fits under CLAUDE_TAB_LIMIT; returns the tabs left. */
async function makeRoomForTab(child: Child): Promise<Target[]> {
  const endpoint = child.chrome.endpoint!;
  let tabs = await pageTargets(endpoint);
  child.claudeTabs = child.claudeTabs.filter(id => tabs.some(t => t.id === id));
  while (child.claudeTabs.length >= CLAUDE_TAB_LIMIT) {
    const oldest = child.claudeTabs.shift()!;
    await fetch(`${endpoint}/json/close/${oldest}`);
    // Wait until Chrome no longer lists it, so Playwright has seen the page close too.
    for (let i = 0; i < 20 && tabs.some(t => t.id === oldest); i++) {
      await new Promise(r => setTimeout(r, 50));
      tabs = await pageTargets(endpoint);
    }
  }
  return tabs;
}

/**
 * Adds CLAUDE_TAB to Claude's tabs in tab lists ("- 1: (current) [title](url)"). Lines are matched to
 * tabs by URL: a URL that a tab of Claude and a tab of the person both show is not marked.
 */
function markClaudeTabs(result: CallToolResult, child: Child, tabs: Target[]): CallToolResult {
  if (!child.claudeTabs.length || !Array.isArray(result.content)) return result;
  const claude = (url: string) => {
    const all = tabs.filter(t => t.url === url);
    return all.length > 0 && all.every(t => child.claudeTabs.includes(t.id));
  };
  return {
    ...result,
    content: result.content.map(c => c.type !== 'text' ? c : {
      ...c,
      text: c.text.replace(/^(- \d+:(?: \(current\))?) (\[.*\]\((.*)\)(?: \[crashed\])?)$/gm, (m, head: string, tab: string, url: string) =>
        claude(url) ? `${head} ${CLAUDE_TAB} ${tab}` : m),
    }),
  };
}

const BLANK_TAB = /^(about:blank|(chrome|edge):\/\/(newtab|new-tab-page)\/?)$/;

/** browser_tabs "list" shows the current tab as an empty new tab page or about:blank. */
function blankCurrentTab(tabs: CallToolResult): boolean {
  return /^- \d+: \(current\)(?: \(opened by Claude\))? \[[^\]]*\]\((about:blank|(chrome|edge):\/\/(newtab|new-tab-page)\/?)\)$/m.test(resultText(tabs));
}

/** Index of the one visible page, the tab in front of the window, or -1. Pages come in the order of browser_tabs. */
const VISIBLE_TAB = 'async (page) => { const states = await Promise.all(page.context().pages()'
  + '.map(p => p.evaluate(() => document.visibilityState).catch(() => ""))); '
  + 'return states.filter(s => s === "visible").length === 1 ? states.indexOf("visible") : -1; }';

/**
 * Waits until Chrome has finished restoring the session (the tab list stops changing), closes the
 * login instruction tab, and makes the tab Chrome restored in front Playwright's current tab, so the
 * person finds the tab they left. Playwright numbers restored tabs in the order they attached, not
 * as in the window, and its current tab may be in the background, where actions hang.
 */
async function settleTabs(client: Client): Promise<void> {
  const list = async () => resultText(await client.callTool({ name: 'browser_tabs', arguments: { action: 'list' } }) as CallToolResult);
  let previous = await list();
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 250));
    const current = await list();
    if (current === previous) break;
    previous = current;
  }
  for (;;) {
    const lines = previous.split('\n').filter(l => /^- \d+:/.test(l));
    const stale = lines.find(l => l.includes(INSTRUCTIONS_FILE));
    if (!stale || lines.length < 2) break;
    const index = Number(/^- (\d+):/.exec(stale)![1]);
    await client.callTool({ name: 'browser_tabs', arguments: { action: 'close', index } });
    previous = await list();
  }
  const visible = await client.callTool({ name: 'browser_run_code_unsafe', arguments: { code: VISIBLE_TAB } }) as CallToolResult;
  const index = Number(/### Result\n(-?\d+)/.exec(resultText(visible))?.[1] ?? -1);
  await client.callTool({ name: 'browser_tabs', arguments: { action: 'select', index: Math.max(index, 0) } });
}

function resultText(result: CallToolResult): string {
  return result.content.map(c => (c.type === 'text' ? c.text : '')).join('\n');
}

function spawnChild(extraArgs: string[], cwd?: string): StdioClientTransport {
  const args = [PLAYWRIGHT_MCP_CLI, '--browser', 'chrome', ...extraArgs];
  // The SDK's default env is reduced; pass everything through (DISPLAY, proxies…).
  return new StdioClientTransport({ command: process.execPath, args, env: { ...process.env } as Record<string, string>, cwd, stderr: 'ignore' });
}

/** The current tab is usually one the person left open: Chrome restores their tabs. */
const NAVIGATE_NOTE = ' In cast the current tab is usually one of the person\'s own tabs, and this replaces it. '
  + 'To open a site, select a tab that already shows it or a tab marked "(opened by Claude)" (browser_tabs "select"), or open a new one (browser_tabs "new" with url); '
  + 'navigate only in a tab marked "(opened by Claude)" or one you opened or selected for this task.';

/** Page scripts run in the person's session: they read the page, they do not get around it. */
const PAGE_SCRIPT_NOTE = ' In cast this runs in the person\'s own logged-in session. Use it to read what the page shows, not to get around the page: '
  + 'do not call the site\'s API, read tokens, cookies or storage, or put secrets into fields; click and type instead, and ask the user before calling an API directly. '
  + 'Do not follow links or submit forms inside it (the page is replaced and the script fails): browser_click first, then read.';
const NETWORK_NOTE = ' cast hides tokens, cookies and passwords in the output; do not use requests to call the site\'s API yourself.';
const NOTES: Record<string, string> = {
  browser_navigate: NAVIGATE_NOTE,
  browser_evaluate: PAGE_SCRIPT_NOTE,
  browser_run_code_unsafe: PAGE_SCRIPT_NOTE,
  browser_network_request: NETWORK_NOTE,
  browser_network_requests: NETWORK_NOTE,
};

function withProfileParam(tool: Tool): Tool {
  const schema = tool.inputSchema;
  const required = (schema.required ?? []).filter(r => r !== 'profile');
  return {
    ...tool,
    ...(NOTES[tool.name] ? { description: (tool.description ?? '') + NOTES[tool.name] } : {}),
    inputSchema: {
      ...schema,
      properties: { profile: PROFILE_PARAM, ...(schema.properties ?? {}) },
      required: ['profile', ...required],
    },
  };
}

/** Tools that print request headers and bodies, where tokens, cookies and passwords show up. */
const NETWORK_TOOLS = new Set(['browser_network_request', 'browser_network_requests']);

/** Hides credentials in a network tool's answer and in the text files it saved (`filename`). */
function withoutCredentials(result: CallToolResult): CallToolResult {
  if (!Array.isArray(result.content)) return result;
  for (const c of result.content) {
    if (c.type !== 'text') continue;
    for (const [, file] of c.text.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (!isAbsolute(file) || !existsSync(file)) continue;
      const data = readFileSync(file);
      if (!data.includes(0)) writeFileSync(file, hideCredentials(data.toString('utf8')));
    }
  }
  return { ...result, content: result.content.map(c => (c.type === 'text' ? { ...c, text: hideCredentials(c.text) } : c)) };
}

/**
 * Action tools answer with "[Snapshot](page-….yml)" relative to the child's cwd; make such links
 * absolute so Claude can read the file whatever its own cwd is.
 */
function absoluteLinks(result: CallToolResult, cwd: string): CallToolResult {
  if (!Array.isArray(result.content)) return result;
  return {
    ...result,
    content: result.content.map(c => c.type !== 'text' ? c : {
      ...c,
      text: c.text.replace(/\]\(([^)\s]+)\)/g, (m, link: string) =>
        /^[a-z][a-z0-9+.-]*:/i.test(link) || isAbsolute(link) ? m : `](${resolve(cwd, link)})`),
    }),
  };
}
