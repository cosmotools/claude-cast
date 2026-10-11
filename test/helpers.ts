import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readlinkSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pickBrowser } from '../src/browsers.js';
import { type CastPaths, resolvePaths } from '../src/paths.js';

export interface Sandbox {
  root: string;
  env: NodeJS.ProcessEnv;
  paths: CastPaths;
  cleanup(): void;
}

/** Isolated project, config and data dirs. */
export function sandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'cast-test-'));
  const env = {
    ...process.env,
    CAST_PROJECT_DIR: join(root, 'project'),
    CAST_CONFIG_DIR: join(root, 'config'),
    CAST_DATA_DIR: join(root, 'data'),
  };
  return { root, env, paths: resolvePaths(env), cleanup: () => removeSandbox(root) };
}

/**
 * A leftover temp folder is not a test failure: if a Chrome still writes to it (ENOTEMPTY on macOS)
 * after the retries, warn and leave it.
 */
function removeSandbox(root: string): void {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (e) {
    console.warn(`could not remove ${root}: ${(e as Error).message}`);
  }
}

export interface TestSite {
  url: string;
  /** Session token values that must never show up in cast output. */
  secrets: string[];
  /** Request paths with query, in order. */
  hits: string[];
  close(): Promise<void>;
}

/** /login?user=X[&to=path] sets a persistent session cookie; other pages greet the user and have a confirm() button. */
export async function startSite(): Promise<TestSite> {
  const secrets: string[] = [];
  const hits: string[] = [];
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    hits.push(url.pathname + url.search);
    if (url.pathname === '/hop') {
      // An SSO-like redirect through another host.
      res.writeHead(302, { Location: url.searchParams.get('to') ?? '/' });
      res.end();
      return;
    }
    if (url.pathname === '/token-app') {
      // Like an OAuth app: an access token in localStorage, sent to the app's API, which answers with a new one.
      const token = `tok${randomBytes(12).toString('hex')}`;
      secrets.push(token);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<title>Token app</title><script>localStorage.setItem('access_token', '${token}');
fetch('/api/me', { method: 'POST', headers: { Authorization: 'Bearer ${token}', 'X-Api-Key': '${token}', 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: '${token}', note: 'kept' }) })</script>`);
      return;
    }
    if (url.pathname === '/api/me') {
      const token = `tok${randomBytes(12).toString('hex')}`;
      secrets.push(token);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `session=${token}; Path=/` });
      res.end(JSON.stringify({ user: 'sam', access_token: token, refresh_token: token }));
      return;
    }
    if (url.pathname === '/alert') {
      // A page that opens a dialog as it loads, so evaluating in it waits for the dialog.
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<title>alert</title><script>alert("hi")</script>');
      return;
    }
    if (url.pathname === '/probe') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<script>fetch("/report?webdriver=" + navigator.webdriver)</script>');
      return;
    }
    if (url.pathname === '/login') {
      const user = url.searchParams.get('user') ?? 'anon';
      const token = `tok${randomBytes(12).toString('hex')}`;
      secrets.push(token);
      res.writeHead(302, {
        'Set-Cookie': [`user=${user}; Max-Age=3600; Path=/`, `session=${token}; Max-Age=3600; Path=/; HttpOnly`],
        Location: url.searchParams.get('to') ?? '/',
      });
      res.end();
      return;
    }
    const user = /(?:^|;\s*)user=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(user
      ? `<title>App</title><h1>Hello ${user}</h1>
<button onclick="document.getElementById('r').textContent = confirm('Sure?') ? 'confirmed' : 'cancelled'">Delete</button>
<p id="r"></p>`
      : '<title>Sign in</title><h1>Please sign in</h1>');
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    secrets,
    hits,
    close: () => new Promise(r => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

export function text(result: object): string {
  return (((result as { content?: unknown }).content ?? []) as { type: string; text?: string }[]).map(c => c.text ?? '').join('\n');
}

/**
 * Quits the Chrome running on a profile folder the way closing its window does. On Windows a headless
 * Chrome has no window to close (taskkill without /F may still report success), so it is stopped by
 * force (its History may be lost).
 */
export async function quitChrome(dir: string): Promise<void> {
  const pid = signalChrome(dir);
  // Chrome removes SingletonLock early in its shutdown and keeps writing to the profile until it exits.
  for (const end = Date.now() + 30_000; alive(pid); ) {
    if (Date.now() > end) throw new Error(`Chrome ${pid} on ${dir} did not exit`);
    await new Promise(r => setTimeout(r, 100));
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function signalChrome(dir: string): number {
  if (process.platform !== 'win32') {
    const pid = Number(readlinkSync(join(dir, 'SingletonLock')).split('-').pop());
    process.kill(pid, 'SIGINT');
    return pid;
  }
  // The browser process: started from the browser's executable on this folder, not a renderer (--type=…).
  // Matching the command line alone would also find this PowerShell query.
  const exe = pickBrowser().executable;
  const query = `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '${exe}' -and $_.CommandLine -like '*--user-data-dir=${dir}*' -and $_.CommandLine -notlike '*--type=*' } | ForEach-Object { $_.ProcessId }`;
  const pid = spawnSync('powershell', ['-NoProfile', '-Command', query], { encoding: 'utf8' }).stdout.trim().split(/\s+/)[0];
  if (!pid) throw new Error(`no Chrome runs on ${dir}`);
  const headless = process.env.CAST_TEST_HEADLESS === '1';
  if (headless || spawnSync('taskkill', ['/PID', pid]).status !== 0) spawnSync('taskkill', ['/F', '/T', '/PID', pid]);
  return Number(pid);
}

const WebSocket = (createRequire(import.meta.url)('playwright-core/lib/utilsBundle') as {
  ws: new (url: string) => { on(e: 'message', l: (d: Buffer) => void): void; once(e: 'open' | 'error', l: (a?: unknown) => void): void; send(d: string): void; close(): void };
}).ws;

/**
 * The pages of a Chrome and whether a DevTools client (Playwright) is attached to each, asked of the
 * browser target, which attaches to no page itself.
 */
export async function pageTargets(endpoint: string): Promise<{ url: string; attached: boolean }[]> {
  const { webSocketDebuggerUrl } = await (await fetch(`${endpoint}/json/version`)).json() as { webSocketDebuggerUrl: string };
  const socket = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  try {
    const reply = new Promise<{ targetInfos: { type: string; url: string; attached: boolean }[] }>(resolve =>
      socket.on('message', d => { const m = JSON.parse(d.toString()); if (m.id === 1) resolve(m.result); }));
    socket.send(JSON.stringify({ id: 1, method: 'Target.getTargets' }));
    return (await reply).targetInfos.filter(t => t.type === 'page').map(({ url, attached }) => ({ url, attached }));
  } finally {
    socket.close();
  }
}

/** The DevTools endpoint of the Chrome running on a profile folder. */
export function endpointOf(dir: string): string {
  return `http://127.0.0.1:${readFileSync(join(dir, 'DevToolsActivePort'), 'utf8').split('\n')[0]}`;
}

/** What a person does in the user window, without attaching to its pages: open a page in a new tab. */
export async function visit(dir: string, url: string): Promise<void> {
  await fetch(`${endpointOf(dir)}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
}
