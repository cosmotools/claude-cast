#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * On macOS closing Chrome's last window leaves Chrome running, so a user window the human closed
 * would look open forever and History would not be flushed. A small watcher, started detached next to
 * each visible cast Chrome, quits that Chrome with SIGINT once its windows are gone, as on Linux.
 */
export function watchWindows(pid: number, executable: string): void {
  let path = executable;
  try { path = realpathSync(executable); } catch { /* compared as given */ }
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), String(pid), path], { stdio: 'ignore', detached: true });
  child.unref();
}

export interface MacWindow {
  /** CGWindowNumber, stable while the window exists (also when minimized or on another Space). */
  id: number;
  onscreen: boolean;
  width: number;
  height: number;
}

/**
 * The process's windows from CoreGraphics; needs no Screen Recording or Accessibility permission (titles stay
 * hidden). null when `pid` is no longer a running `executable`, so a reused pid is never signalled;
 * undefined when the query failed.
 */
export function listWindows(pid: number, executable: string): MacWindow[] | null | undefined {
  const r = spawnSync('osascript', ['-l', 'JavaScript', '-e', LIST_WINDOWS, String(pid), executable], { encoding: 'utf8', timeout: 10_000 });
  if (r.status !== 0) return undefined;
  try { return JSON.parse(r.stdout); } catch { return undefined; }
}

const LIST_WINDOWS = `ObjC.import('AppKit'); ObjC.import('CoreGraphics');
function run(argv) {
  const pid = Number(argv[0]);
  const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
  if (!app || app.isNil() || app.terminated || ObjC.unwrap(app.executableURL.path) !== argv[1]) return 'null';
  const all = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll, 0)));
  return JSON.stringify(all.filter(w => w.kCGWindowOwnerPID === pid && w.kCGWindowLayer === 0).map(w => ({
    id: w.kCGWindowNumber, onscreen: !!w.kCGWindowIsOnscreen, width: w.kCGWindowBounds.Width, height: w.kCGWindowBounds.Height,
  })));
}`;

/**
 * Browser windows are at least 500x375; popups (omnibox, bubbles) are smaller. Chrome also keeps hidden
 * helper windows that look like a minimized one, so a window counts only once it has been seen on screen.
 */
export function isBrowserWindow(w: MacWindow): boolean {
  return w.onscreen && w.width >= 400 && w.height >= 300;
}

/** Tracks the browser windows seen so far; true once all of them are closed and none is on screen. */
export function windowsClosed(seen: Set<number>, windows: MacWindow[]): boolean {
  for (const w of windows) if (isBrowserWindow(w)) seen.add(w.id);
  return seen.size > 0 && !windows.some(w => seen.has(w.id) || isBrowserWindow(w));
}

/** How the watcher looks at Chrome; replaced in tests. */
export interface WatchSteps {
  list(): MacWindow[] | null | undefined;
  alive(): boolean;
  quit(): void;
  wait(): Promise<void>;
}

/** Polls a minute for a Chrome that macOS does not list as an application yet, then gives up. */
export const START_POLLS = 60;

/**
 * Quits Chrome once its windows are closed. macOS lists a new process as an application a little after it
 * starts (about 40 ms after spawn), so a Chrome not listed yet is waited for, not taken for one that exited.
 */
export async function watch(steps: WatchSteps): Promise<void> {
  const seen = new Set<number>();
  let listed = false;
  for (let polls = 0; ; polls++) {
    const windows = steps.list();
    if (windows === null && (listed || polls >= START_POLLS || !steps.alive())) return;
    if (windows) listed = true;
    if (windows === undefined && !steps.alive()) return;
    if (windows && windowsClosed(seen, windows)) {
      // The same clean shutdown as closing the last window on Linux: cookies and History are flushed.
      steps.quit();
      return;
    }
    await steps.wait();
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function main(pid: number, executable: string): Promise<void> {
  await watch({
    list: () => listWindows(pid, executable),
    alive: () => alive(pid),
    quit: () => { try { process.kill(pid, 'SIGINT'); } catch { /* already gone */ } },
    wait: () => new Promise(r => setTimeout(r, 1000)),
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main(Number(process.argv[2]), process.argv[3]);
