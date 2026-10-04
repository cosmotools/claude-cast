import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium } from 'playwright-core';
import { Gateway } from '../src/gateway.js';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pickBrowser } from '../src/browsers.js';
import { isRunning, launchChrome } from '../src/chrome.js';
import { type LoginWindow, openLoginWindow, readLogin, startLoginWindow } from '../src/login-window.js';
import { outputDir } from '../src/paths.js';
import { addProfile, findProfile, updateProfile } from '../src/registry.js';
import { type Sandbox, type TestSite, quitChrome, sandbox, startSite, text } from './helpers.js';

// CAST_TEST_HEADED=1 shows the windows (checks what headless cannot, e.g. navigator.webdriver).
const headed = process.env.CAST_TEST_HEADED === '1';
if (!headed) process.env.CAST_TEST_HEADLESS = '1';

let sb: Sandbox;
let site: TestSite;
before(async () => {
  sb = sandbox();
  site = await startSite();
});
after(async () => {
  await site.close();
  sb.cleanup();
});

/** What a human does in /cast:add: log in as `user` and close the window. */
async function humanLogin(name: string, user: string) {
  addProfile(sb.paths, name, 'local', {});
  const p = findProfile(sb.paths, name)!;
  const from = site.hits.length;
  return openLoginWindow(p.dir, {
    name,
    // Like SSO: pass through a sign-in host (localhost) that redirects back to the app (127.0.0.1).
    // The app sends the person to a role page, with a token-like query cast must drop.
    onReady: w => visitAndClose(w, p.dir, `${ssoHost()}/hop?to=${encodeURIComponent(`${site.url}/login?user=${user}&to=/${user}/home?code=secret`)}`,
      () => site.hits.slice(from).some(h => h.startsWith(`/${user}/home`))),
  });
}

function ssoHost() {
  return site.url.replace('127.0.0.1', 'localhost');
}

/**
 * Plays the human. Headless: drive the tab over the test-only DevTools port. Headed: the window has no
 * port, so open the URL like a person would (a second `chrome` call hands it to the running window).
 */
async function visitAndClose(w: LoginWindow, dir: string, url: string, done: () => boolean) {
  if (w.endpoint) {
    const browser = await chromium.connectOverCDP(w.endpoint);
    const page = await browser.contexts()[0].newPage();
    await page.goto(url);
    await until(done);
    const cdp = await browser.newBrowserCDPSession();
    await cdp.send('Browser.close').catch(() => {});
    return;
  }
  await new Promise(r => setTimeout(r, 1500));
  spawn(pickBrowser().executable, [`--user-data-dir=${dir}`, '--password-store=basic', url], { stdio: 'ignore' });
  await until(done);
  await new Promise(r => setTimeout(r, 500));
  w.close();
}

async function until(cond: () => boolean, ms = 15_000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 100))) {
    if (cond()) return;
  }
  throw new Error('timed out waiting for the page');
}

function gp(name: string) {
  const p = findProfile(sb.paths, name)!;
  return { name: p.name, dir: p.dir, outputDir: outputDir(sb.paths, p.name) };
}

interface Rect { x: number; y: number; width: number; height: number }
interface Image { width: number; height: number; data: Buffer }
const { PNG } = createRequire(import.meta.url)('playwright-core/lib/utilsBundle') as { PNG: { sync: { read(b: Buffer): Image } } };

/**
 * What the person sees in the profile's current tab, marks included, in CSS pixels, once it has settled:
 * marks are animated in and follow the page a frame later, so two screenshots in a row must match.
 */
async function still(gateway: Gateway, profile: ReturnType<typeof gp>): Promise<Image> {
  const shot = async () => {
    const r = text(await gateway.call(profile, 'browser_run_code_unsafe', { code: 'async (page) => (await page.screenshot({ scale: "css" })).toString("base64")' }));
    return Buffer.from(JSON.parse(/### Result\n(.+)/.exec(r)![1]) as string, 'base64');
  };
  let last = await shot();
  for (const end = Date.now() + 10_000; Date.now() < end;) {
    await new Promise(r => setTimeout(r, 200));
    const next = await shot();
    if (next.equals(last)) return PNG.sync.read(next);
    last = next;
  }
  throw new Error('the page kept changing');
}

/**
 * Pixels in the marks' red (#e5383b, green and blue alike) inside `r` grown by `pad`. Page content in the
 * tests is never red; the orange and blue fringes of smoothed text have green and blue far apart.
 */
function red(img: Image, r: Rect, pad = 0): number {
  let n = 0;
  for (let y = Math.max(0, Math.floor(r.y - pad)); y < Math.min(img.height, r.y + r.height + pad); y++) {
    for (let x = Math.max(0, Math.floor(r.x - pad)); x < Math.min(img.width, r.x + r.width + pad); x++) {
      const i = (y * img.width + x) * 4;
      const [cr, cg, cb] = [img.data[i], img.data[i + 1], img.data[i + 2]];
      if (cr > 180 && cg < 110 && cb < 110 && Math.abs(cg - cb) < 30) n++;
    }
  }
  return n;
}

/** The box of an element of the current tab in viewport coordinates; `expr` is evaluated in the page. */
async function rect(gateway: Gateway, profile: ReturnType<typeof gp>, expr: string): Promise<Rect> {
  const r = text(await gateway.call(profile, 'browser_evaluate', { function: `() => { const b = ${expr}; return { x: b.x, y: b.y, width: b.width, height: b.height }; }` }));
  return JSON.parse(/### Result\n([\s\S]+?)(?:\n###|$)/.exec(r)![1]) as Rect;
}

/** Retries `check` until it passes: the marks see that the page changed a frame later. */
async function eventually(check: () => Promise<void>, ms = 5000) {
  for (const end = Date.now() + ms; ; await new Promise(r => setTimeout(r, 100))) {
    try {
      return await check();
    } catch (e) {
      if (Date.now() > end) throw e;
    }
  }
}

function assertNoSecrets(output: string) {
  for (const s of site.secrets) assert.ok(!output.includes(s), 'cookie value leaked into output');
}

describe('user window', () => {
  test('suggests the sites the user landed on, not redirect hops, and finishes when the window closes', async () => {
    const result = await humanLogin('Sam', 'sam');
    assert.equal(result.timedOut, false);
    assert.deepEqual(result.sites, [new URL(site.url).host]);
    assert.deepEqual(result.signIn, [new URL(ssoHost()).host]);
    assert.deepEqual(result.landings, [{ host: new URL(site.url).host, url: `${site.url}/sam/home`, title: 'App' }]);
    if (process.platform !== 'win32') assert.equal(statSync(findProfile(sb.paths, 'Sam')!.dir).mode & 0o777, 0o700);
  });

  test('the user window is not flagged as automated', async () => {
    addProfile(sb.paths, 'Plain', 'local', {});
    const dir = findProfile(sb.paths, 'Plain')!.dir;
    const report = () => site.hits.find(h => h.startsWith('/report?'));
    await openLoginWindow(dir, { name: 'Plain', onReady: w => visitAndClose(w, dir, `${site.url}/probe`, () => !!report()) });
    assert.equal(report(), '/report?webdriver=false');
  });

  test('a profile that is already open is reported', async () => {
    addProfile(sb.paths, 'Busy', 'local', {});
    const dir = findProfile(sb.paths, 'Busy')!.dir;
    const first = openLoginWindow(dir, { name: 'Busy', timeoutMs: 8000 });
    await new Promise(r => setTimeout(r, 2500));
    await assert.rejects(openLoginWindow(dir, { name: 'Busy' }), /already open/);
    await first;
  });

  test('a window closed after its Claude session ended is saved at the next session start', async () => {
    addProfile(sb.paths, 'Late', 'local', {});
    const p = findProfile(sb.paths, 'Late')!;
    const from = site.hits.length;
    const { startedAt, chrome } = await startLoginWindow(p.dir, {
      name: 'Late',
      onReady: w => visitAndClose(w, p.dir, `${site.url}/login?user=late&to=/late/home`, () => site.hits.slice(from).some(h => h.startsWith('/late/home'))),
    });
    updateProfile(sb.paths, 'Late', { loginStartedAt: startedAt.toISOString() });
    await chrome.exited;
    assert.deepEqual(findProfile(sb.paths, 'Late')!.sites, []);
    execFileSync(process.execPath, ['dist/src/cli.js', 'list', '--brief'], { env: sb.env });
    const saved = findProfile(sb.paths, 'Late')!;
    assert.deepEqual(saved.sites, [new URL(site.url).host]);
    assert.ok(saved.lastLoginAt! >= saved.loginStartedAt!);
  });

  test('times out and closes the window', async () => {
    addProfile(sb.paths, 'Idle', 'local', {});
    const result = await openLoginWindow(findProfile(sb.paths, 'Idle')!.dir, { name: 'Idle', timeoutMs: 1500 });
    assert.equal(result.timedOut, true);
    assert.deepEqual(result.sites, []);
  });
});

describe('gateway', () => {
  const gateway = new Gateway();
  after(() => gateway.closeAll());

  test('tool definitions come from Playwright MCP with a required profile', async () => {
    const tools = await gateway.toolDefs();
    const names = tools.map(t => t.name);
    assert.ok(names.includes('browser_navigate'));
    assert.ok(names.includes('browser_handle_dialog'));
    assert.ok(!names.includes('browser_close'));
    assert.match(tools.find(t => t.name === 'browser_navigate')?.description ?? '', /replaces it\. .*browser_tabs "new"/);
    for (const t of tools) {
      assert.equal(t.inputSchema.required?.[0], 'profile');
      assert.ok(t.inputSchema.properties?.profile);
    }
  });

  test('two profiles are open at the same time, each with its own user', async () => {
    await humanLogin('Elon', 'elon');
    const [nav] = await Promise.all([
      gateway.call(gp('Sam'), 'browser_navigate', { url: site.url }),
      gateway.call(gp('Elon'), 'browser_navigate', { url: site.url }),
    ]);
    // Action tools link the snapshot file; the link is absolute and inside cast's output dir.
    const link = /\[Snapshot\]\(([^)]+)\)/.exec(text(nav))?.[1];
    assert.ok(link?.startsWith(outputDir(sb.paths, 'Sam') + sep), text(nav));
    assert.match(readFileSync(link!, 'utf8'), /Hello sam/);

    const [sam, elon] = await Promise.all([
      gateway.call(gp('Sam'), 'browser_snapshot', {}),
      gateway.call(gp('Elon'), 'browser_snapshot', {}),
    ]);
    assert.match(text(sam), /Hello sam/);
    assert.match(text(elon), /Hello elon/);
    assert.deepEqual(gateway.openNames().sort(), ['Elon', 'Sam']);
    assertNoSecrets(text(sam) + text(elon));
  });

  test("Claude's window reports navigator.webdriver = false, like Playwright MCP's default", async () => {
    const r = await gateway.call(gp('Sam'), 'browser_evaluate', { function: '() => navigator.webdriver' });
    assert.match(text(r), /### Result\s+false/);
  });

  test('confirm() is handled with browser_handle_dialog', async () => {
    const click = await gateway.call(gp('Sam'), 'browser_click', { target: 'button', element: 'Delete button' });
    assert.match(text(click), /confirm/i);
    const handled = await gateway.call(gp('Sam'), 'browser_handle_dialog', { accept: true });
    assert.ok(!handled.isError, text(handled));
    const snap = await gateway.call(gp('Sam'), 'browser_snapshot', {});
    assert.match(text(snap), /confirmed/);
  });

  test('login survives close and reopen', async () => {
    assert.equal(await gateway.close('sam'), true);
    assert.equal(gateway.isOpen('Sam'), false);
    await gateway.call(gp('Sam'), 'browser_navigate', { url: site.url });
    const again = await gateway.call(gp('Sam'), 'browser_snapshot', {});
    assert.match(text(again), /Hello sam/);
  });

  test('tabs from the previous session come back', async () => {
    await gateway.call(gp('Sam'), 'browser_navigate', { url: `${site.url}/?tab=kept` });
    await gateway.close('Sam');
    const tabs = await gateway.call(gp('Sam'), 'browser_tabs', { action: 'list' });
    assert.match(text(tabs), /\?tab=kept/);
  });

  test('tabs come back and are saved again after Chrome crashed', async () => {
    const prefs = join(gp('Sam').dir, 'Default', 'Preferences');
    const crash = () => {
      const p = JSON.parse(readFileSync(prefs, 'utf8'));
      writeFileSync(prefs, JSON.stringify({ ...p, profile: { ...p.profile, exit_type: 'Crashed' } }));
    };
    await gateway.call(gp('Sam'), 'browser_tabs', { action: 'new', url: `${site.url}/?tab=before-crash` });
    await gateway.close('Sam');
    crash();
    let tabs = text(await gateway.call(gp('Sam'), 'browser_tabs', { action: 'list' }));
    assert.match(tabs, /\?tab=before-crash\)$/m, tabs);
    await gateway.call(gp('Sam'), 'browser_tabs', { action: 'new', url: `${site.url}/?tab=after-crash` });
    await gateway.close('Sam');
    tabs = text(await gateway.call(gp('Sam'), 'browser_tabs', { action: 'list' }));
    assert.match(tabs, /\?tab=after-crash\)$/m, tabs);
    for (const tab of ['before-crash', 'after-crash']) {
      const index = Number(new RegExp(`^- (\\d+):.*\\?tab=${tab}\\)$`, 'm').exec(tabs)?.[1]);
      await gateway.call(gp('Sam'), 'browser_tabs', { action: 'close', index });
      tabs = text(await gateway.call(gp('Sam'), 'browser_tabs', { action: 'list' }));
    }
  });

  test('the tab in front comes back in front, whatever number Playwright gives it', async () => {
    await gateway.call(gp('Sam'), 'browser_tabs', { action: 'new', url: `${site.url}/?tab=front` });
    await gateway.call(gp('Sam'), 'browser_tabs', { action: 'new', url: `${site.url}/?tab=last` });
    for (let i = 0; i < 2; i++) {
      const list = text(await gateway.call(gp('Sam'), 'browser_tabs', { action: 'list' }));
      const index = Number(/^- (\d+):.*\?tab=front\)$/m.exec(list)?.[1]);
      await gateway.call(gp('Sam'), 'browser_tabs', { action: 'select', index });
      await gateway.close('Sam');
      const tabs = text(await gateway.call(gp('Sam'), 'browser_tabs', { action: 'list' }));
      assert.match(tabs, /\(current\) .*\?tab=front\)$/m, tabs);
    }
  });

  test('closing a profile with a dialog open keeps its tabs', async () => {
    const opened = await gateway.call(gp('Sam'), 'browser_tabs', { action: 'new', url: `${site.url}/alert` });
    assert.match(text(opened), /alert/i);
    await gateway.close('Sam');
    const tabs = text(await gateway.call(gp('Sam'), 'browser_tabs', { action: 'list' }));
    assert.match(tabs, /\/alert\)$/m, tabs);
    const index = Number(/^- (\d+):.*\/alert\)$/m.exec(tabs)?.[1]);
    await gateway.call(gp('Sam'), 'browser_tabs', { action: 'close', index });
  });

  test('a restored tab showing a dialog does not keep the profile from opening', async () => {
    // As a person would: close the dialog, then the window. (Closing Chrome with the dialog open fails
    // on Windows and loses the session.) The page shows the dialog again when it is restored.
    const opened = await gateway.call(gp('Sam'), 'browser_tabs', { action: 'new', url: `${site.url}/alert` });
    assert.match(text(opened), /alert/i);
    await gateway.call(gp('Sam'), 'browser_handle_dialog', { accept: true });
    await gateway.close('Sam');
    const started = Date.now();
    const tabs = text(await gateway.call(gp('Sam'), 'browser_tabs', { action: 'list' }));
    assert.ok(Date.now() - started < 15_000, `opened in ${Date.now() - started} ms`);
    // The dialog is closed, so the page answers (the reload may still be loading it).
    const index = Number(/^- (\d+):.*\/alert\)$/m.exec(tabs)?.[1]);
    await gateway.call(gp('Sam'), 'browser_tabs', { action: 'select', index });
    let page = '';
    for (let i = 0; i < 50 && !page.includes('alert|'); i++) {
      if (i) await new Promise(r => setTimeout(r, 200));
      page = text(await gateway.call(gp('Sam'), 'browser_evaluate', { function: '() => document.title + "|" + location.href' }));
    }
    assert.match(page, /alert\|http/, `${tabs}\n${page}`);
    await gateway.call(gp('Sam'), 'browser_tabs', { action: 'close', index });
  });

  test('a window closed by the human is reopened on the next call', async () => {
    await gateway.call(gp('Elon'), 'browser_navigate', { url: site.url });
    await quitChrome(findProfile(sb.paths, 'Elon')!.dir);
    for (let i = 0; i < 100 && gateway.isOpen('Elon'); i++) await new Promise(r => setTimeout(r, 100));
    assert.equal(gateway.isOpen('Elon'), false);
    await gateway.call(gp('Elon'), 'browser_navigate', { url: site.url });
    const snap = await gateway.call(gp('Elon'), 'browser_snapshot', {});
    assert.match(text(snap), /Hello elon/);
  });

  test('browser_close is not proxied', async () => {
    await assert.rejects(gateway.call(gp('Sam'), 'browser_close', {}), /cast_close/);
  });

  test('marks are drawn out of the page\'s reach and erased by the person or before Claude\'s input', async () => {
    const sam = gp('Sam');
    await gateway.call(sam, 'browser_navigate', { url: `${site.url}/marks` });
    const ref = /button "Pay now" \[ref=(\w+)\]/.exec(text(await gateway.call(sam, 'browser_snapshot', {})))?.[1];
    assert.ok(ref);
    await assert.rejects(gateway.draw(sam, [{ target: '#missing' }]), /not on the page/);
    assert.equal(await gateway.draw(sam, [{ target: ref, note: 'Нажмите здесь' }, { target: '#total', shape: 'underline' }]), undefined);
    // The page sees one empty element, not what is drawn in it; the snapshot does not show it either.
    const seen = await gateway.call(sam, 'browser_evaluate', {
      function: '() => { const e = document.documentElement.lastElementChild; return [e.tagName, e.shadowRoot, e.childNodes.length, e.textContent].join("|"); }',
    });
    assert.match(text(seen), /### Result\s+"DIV\|\|0\|"/);
    assert.doesNotMatch(text(await gateway.call(sam, 'browser_snapshot', {})), /Clear marks/);
    // The person clicks the page: the next call says so.
    await gateway.call(sam, 'browser_run_code_unsafe', { code: 'async (page) => { await page.mouse.click(5, 5); }' });
    assert.match(text(await gateway.call(sam, 'browser_snapshot', {})), /erased your marks by clicking the page/);
    assert.equal(await gateway.erase('Sam'), false);
    // The person presses "Clear marks" in the bottom right corner.
    await gateway.draw(sam, [{ target: '#total' }]);
    await gateway.call(sam, 'browser_run_code_unsafe', {
      code: 'async (page) => { const [w, h] = await page.evaluate(() => [innerWidth, innerHeight]); await page.mouse.click(w - 40, h - 30); }',
    });
    assert.match(text(await gateway.call(sam, 'browser_snapshot', {})), /erased your marks with the "Clear marks" button/);
    // Claude's own click erases them first, and nothing is reported.
    await gateway.draw(sam, [{ target: ref, shape: 'box' }]);
    await gateway.call(sam, 'browser_click', { target: ref });
    assert.doesNotMatch(text(await gateway.call(sam, 'browser_snapshot', {})), /erased your marks|marks are gone/);
    await gateway.draw(sam, [{ target: ref, shape: 'arrow' }]);
    assert.equal(await gateway.erase('Sam'), true);
  });

  test('marks are drawn around their elements with notes off the text, and stay above a page dialog until Esc', async () => {
    const sam = gp('Sam');
    await gateway.call(sam, 'browser_navigate', { url: `${site.url}/marks-scene` });
    const total = await rect(gateway, sam, 'document.getElementById("total").getBoundingClientRect()');
    const words = await rect(gateway, sam, 'document.getElementById("text").getBoundingClientRect()');
    const corner = await rect(gateway, sam, '({ x: innerWidth - 160, y: innerHeight - 60, width: 160, height: 60 })');
    await gateway.draw(sam, [{ target: '#total', note: 'Should be $42' }]);
    let img = await still(gateway, sam);
    assert.ok(red(img, total, 25) > 100, 'the circle is around the total');
    assert.ok(red(img, corner) > 0, 'the "Clear marks" button is shown');
    const all = red(img, { x: 0, y: 0, width: img.width, height: img.height });
    assert.ok(all - red(img, total, 25) - red(img, corner) > 100, 'the note is written');
    assert.equal(red(img, words, 6), 0, 'the note keeps clear of the text beside the total');
    // A page dialog opened later goes to the top layer; the marks come back above its backdrop, without the button.
    await gateway.call(sam, 'browser_evaluate', { function: '() => document.getElementById("dialog").showModal()' });
    img = await still(gateway, sam);
    assert.ok(red(img, total, 25) > 100, 'the marks are above the backdrop');
    assert.equal(red(img, corner), 0, 'the button is hidden while the dialog is open');
    // Drawn while the dialog is open, the note still keeps clear of the text the backdrop dims.
    await gateway.draw(sam, [{ target: '#total', note: 'Should be $42' }]);
    img = await still(gateway, sam);
    assert.ok(red(img, { x: 0, y: 0, width: img.width, height: img.height }) - red(img, total, 25) > 100, 'the note is written');
    assert.equal(red(img, words, 6), 0, 'the note keeps clear of the text under the backdrop');
    // Esc closes the dialog, not the marks; the next Esc erases them.
    await gateway.call(sam, 'browser_run_code_unsafe', { code: 'async (page) => { await page.keyboard.press("Escape"); }' });
    assert.match(text(await gateway.call(sam, 'browser_evaluate', { function: '() => document.getElementById("dialog").open' })), /### Result\s+false/);
    assert.doesNotMatch(text(await gateway.call(sam, 'browser_snapshot', {})), /erased your marks|marks are gone/);
    assert.ok(red(await still(gateway, sam), corner) > 0, 'the button is back');
    await gateway.call(sam, 'browser_run_code_unsafe', { code: 'async (page) => { await page.keyboard.press("Escape"); }' });
    assert.match(text(await gateway.call(sam, 'browser_snapshot', {})), /erased your marks with Esc/);
    assert.equal(red(await still(gateway, sam), total, 25), 0);
  });

  test('marks follow their element as the page scrolls, and inside an iframe', async () => {
    const sam = gp('Sam');
    await gateway.call(sam, 'browser_navigate', { url: `${site.url}/marks-scene` });
    const far = 'document.getElementById("far").getBoundingClientRect()';
    // The element below the fold is scrolled into view first.
    await gateway.draw(sam, [{ target: '#far', shape: 'box' }]);
    const before = await rect(gateway, sam, far);
    assert.ok(before.y > 0 && before.y < 1000, `scrolled into view: ${before.y}`);
    assert.ok(red(await still(gateway, sam), before, 20) > 100);
    await gateway.call(sam, 'browser_evaluate', { function: '() => scrollBy(0, -100)' });
    const after = await rect(gateway, sam, far);
    assert.equal(Math.round(after.y - before.y), 100);
    const img = await still(gateway, sam);
    assert.ok(red(img, after, 20) > 100, 'the box moved with the element');
    assert.equal(red(img, { ...before, height: 1 }), 0, 'and is gone from where it was');
    // A ref inside an iframe: the mark is drawn in the main frame around where the button is shown.
    await gateway.call(sam, 'browser_evaluate', { function: '() => scrollTo(0, 0)' });
    const approve = /button "Approve" \[ref=(f\d+e\d+)\]/.exec(text(await gateway.call(sam, 'browser_snapshot', {})))?.[1];
    assert.ok(approve);
    await gateway.draw(sam, [{ target: approve, shape: 'box' }]);
    const button = await rect(gateway, sam, '(() => { const f = document.querySelector("iframe").getBoundingClientRect(), b = document.querySelector("iframe").contentDocument.querySelector("button").getBoundingClientRect(); return { x: f.x + b.x, y: f.y + b.y, width: b.width, height: b.height }; })()');
    assert.ok(red(await still(gateway, sam), button, 20) > 100);
    assert.equal(await gateway.erase('Sam'), true);
  });

  test('Claude learns that the marks are gone when the page changes under them', async () => {
    const sam = gp('Sam');
    await gateway.call(sam, 'browser_navigate', { url: `${site.url}/marks-scene` });
    await gateway.draw(sam, [{ target: '#gone' }]);
    await gateway.call(sam, 'browser_evaluate', { function: '() => document.getElementById("gone").remove()' });
    await eventually(async () => assert.match(text(await gateway.call(sam, 'browser_tabs', { action: 'list' })), /marks are gone: the page changed/));
    // A reload by the page itself (not Claude's navigation, which erases first).
    await gateway.draw(sam, [{ target: '#total' }]);
    await gateway.call(sam, 'browser_run_code_unsafe', { code: 'async (page) => { await page.reload(); }' });
    assert.match(text(await gateway.call(sam, 'browser_tabs', { action: 'list' })), /marks are gone: the page changed/);
    assert.equal(await gateway.erase('Sam'), false);
  });
});

describe('macOS', { skip: !(process.platform === 'darwin' && headed) && 'macOS with CAST_TEST_HEADED=1' }, () => {
  test('closing the last window quits Chrome, as on Linux, and keeps History', async () => {
    const dir = join(sb.root, 'mac-close');
    const since = new Date(Date.now() - 1000);
    const from = site.hits.length;
    const chrome = await launchChrome(dir, { debugPort: true, urls: [`${site.url}/login?user=mac`] });
    await until(() => site.hits.slice(from).some(h => h === '/'));
    // Let the watcher see the window on screen, then close its only tab as the human would.
    await new Promise(r => setTimeout(r, 2000));
    const pages = (await (await fetch(`${chrome.endpoint}/json/list`)).json() as { id: string; type: string }[]).filter(t => t.type === 'page');
    for (const page of pages) await fetch(`${chrome.endpoint}/json/close/${page.id}`);
    const quit = await Promise.race([chrome.exited.then(() => true), new Promise(r => setTimeout(() => r(false), 10_000))]);
    if (!quit) await chrome.close();
    assert.equal(quit, true, 'Chrome kept running without windows');
    assert.ok((await readLogin(dir, since)).sites.includes(new URL(site.url).host));
  });
});

describe('cast MCP server', () => {
  let client: Client;
  before(async () => {
    client = new Client({ name: 'test', version: '0' });
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: ['dist/src/mcp.js'],
      env: sb.env as Record<string, string>,
      stderr: 'ignore',
    }));
  });
  after(() => client.close());

  test('lists cast and proxied tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map(t => t.name);
    for (const n of ['cast_list', 'cast_open', 'cast_close', 'cast_add', 'cast_open_for_user', 'cast_user_window_result', 'cast_set_sites', 'cast_update', 'cast_remove', 'cast_draw', 'cast_erase', 'browser_click']) {
      assert.ok(names.includes(n), n);
    }
    // The Anthropic directory requires a title and read-only/destructive hints on every tool.
    for (const t of tools) {
      assert.ok(t.annotations?.title, `${t.name} has a title`);
      assert.equal(typeof t.annotations?.readOnlyHint, 'boolean', `${t.name} has readOnlyHint`);
      if (!t.annotations?.readOnlyHint) assert.equal(typeof t.annotations?.destructiveHint, 'boolean', `${t.name} has destructiveHint`);
    }
  });

  test('cast_list, browser_* and cast_set_sites work without leaking cookies', async () => {
    const nav = await client.callTool({ name: 'cast_open', arguments: { profile: 'elon', url: site.url } });
    assert.match(text(nav), /Profile "Elon" is open/);
    const snap = await client.callTool({ name: 'browser_snapshot', arguments: { profile: 'elon' } });
    assert.match(text(snap), /Hello elon/);
    await client.callTool({ name: 'cast_open', arguments: { profile: 'elon', url: `${site.url}/inbox` } });
    const tabs = text(await client.callTool({ name: 'browser_tabs', arguments: { profile: 'elon', action: 'list' } }));
    assert.match(tabs, new RegExp(`\\(${site.url}/\\)`), 'the earlier tab is kept');
    assert.match(tabs, new RegExp(`\\(current\\) .*\\(${site.url}/inbox\\)`), 'the URL opens in a new current tab');

    const sites = await client.callTool({ name: 'cast_set_sites', arguments: { name: 'Elon', sites: [`${site.url}/inbox`, 'outlook.office.com'] } });
    assert.ok(!sites.isError, text(sites));

    const list = JSON.parse(text(await client.callTool({ name: 'cast_list', arguments: {} })));
    const elon = list.find((p: { name: string }) => p.name === 'Elon');
    assert.equal(elon.open, true);
    assert.deepEqual(elon.sites, [new URL(site.url).host, 'outlook.office.com']);

    const net = await client.callTool({ name: 'browser_network_requests', arguments: { profile: 'Elon' } });
    assertNoSecrets(text(nav) + text(snap) + JSON.stringify(list) + text(net));

    const closed = await client.callTool({ name: 'cast_close', arguments: { profile: 'Elon' } });
    assert.match(text(closed), /Closed/);
  });

  test("cast_open opens its url in a new profile's empty tab, not next to it", async () => {
    addProfile(sb.paths, 'Bea', 'local', {});
    await client.callTool({ name: 'cast_open', arguments: { profile: 'Bea', url: `${site.url}/inbox` } });
    const tabs = text(await client.callTool({ name: 'browser_tabs', arguments: { profile: 'Bea', action: 'list' } }));
    const lines = tabs.split('\n').filter(l => /^- \d+:/.test(l));
    assert.equal(lines.length, 1, tabs);
    assert.ok(lines[0].startsWith('- 0: (current) ') && lines[0].endsWith(`(${site.url}/inbox)`), tabs);
    await client.callTool({ name: 'cast_close', arguments: { profile: 'Bea' } });
  });

  test('cast_add requires a description', async () => {
    const res = await client.callTool({ name: 'cast_add', arguments: { name: 'Nodesc', description: '  ' } });
    assert.equal(res.isError, true);
    assert.match(text(res), /description is required/);
    assert.equal(findProfile(sb.paths, 'Nodesc'), undefined);
  });

  test('cast_add returns at once; the profile waits until the user window is closed', async () => {
    const started = Date.now();
    const opened = await client.callTool({ name: 'cast_add', arguments: { name: 'Ann', description: 'reviewer' } });
    assert.match(text(opened), /user window for "Ann" is open/);
    assert.ok(Date.now() - started < 20_000);
    const dir = findProfile(sb.paths, 'Ann')!.dir;
    assert.ok(isRunning(dir));

    assert.match(text(await client.callTool({ name: 'cast_user_window_result', arguments: { name: 'ann' } })), /still open/);
    const busy = await client.callTool({ name: 'browser_snapshot', arguments: { profile: 'Ann' } });
    assert.equal(busy.isError, true);
    assert.match(text(busy), /user window for "Ann" is still open/);

    // The human closes the window.
    await quitChrome(dir);
    await until(() => !isRunning(dir));
    const result = await client.callTool({ name: 'cast_user_window_result', arguments: { name: 'Ann' } });
    assert.match(text(result), /user window for "Ann" is closed/);
    assert.ok(findProfile(sb.paths, 'Ann')!.lastLoginAt);
  });

  test('cast_update changes email and description without a login', async () => {
    const updated = await client.callTool({ name: 'cast_update', arguments: { name: 'elon', description: 'vendor', email: 'e@x.com' } });
    assert.ok(!updated.isError, text(updated));
    assert.equal(findProfile(sb.paths, 'Elon')!.description, 'vendor');
    await client.callTool({ name: 'cast_update', arguments: { name: 'Elon', email: '' } });
    assert.equal(findProfile(sb.paths, 'Elon')!.email, undefined);
    assert.equal(findProfile(sb.paths, 'Elon')!.description, 'vendor');
    const empty = await client.callTool({ name: 'cast_update', arguments: { name: 'Elon' } });
    assert.equal(empty.isError, true);
    const cleared = await client.callTool({ name: 'cast_update', arguments: { name: 'Elon', description: ' ' } });
    assert.equal(cleared.isError, true);
    assert.match(text(cleared), /cannot be cleared/);
    assert.equal(findProfile(sb.paths, 'Elon')!.description, 'vendor');
  });

  test('errors are reported as tool errors', async () => {
    const missing = await client.callTool({ name: 'browser_snapshot', arguments: { profile: 'Nobody' } });
    assert.equal(missing.isError, true);
    assert.match(text(missing), /cast:add Nobody/);
    const noProfile = await client.callTool({ name: 'browser_snapshot', arguments: {} });
    assert.equal(noProfile.isError, true);
  });

  test('cast_draw checks its marks and reports them; cast_erase says whether there were any', async () => {
    const draw = (marks: unknown) => client.callTool({ name: 'cast_draw', arguments: { profile: 'elon', marks } });
    for (const [marks, error] of [
      [[], /non-empty array/],
      [Array.from({ length: 9 }, () => ({ target: 'h1' })), /At most 8 marks/],
      [[{ target: 'h1', note: 'x'.repeat(121) }], /at most 120 characters/],
      [[{ target: 'h1', shape: 'star' }], /shape/],
      [[{ target: '#missing' }], /not on the page/],
      [[{ target: 'h1, button' }], /matches 2 elements/],
    ] as const) {
      const r = await draw(marks);
      assert.equal(r.isError, true, JSON.stringify(marks).slice(0, 80));
      assert.match(text(r), error);
    }
    const drawn = await draw([{ target: 'h1', shape: 'underline', note: 'Здесь' }]);
    assert.ok(!drawn.isError, text(drawn));
    assert.match(text(drawn), /Drew 1 mark in "Elon"\. Tell the user to look at that window\./);
    assert.match(text(await client.callTool({ name: 'cast_erase', arguments: { profile: 'elon' } })), /Erased the marks in "elon"/);
    assert.match(text(await client.callTool({ name: 'cast_erase', arguments: { profile: 'elon' } })), /No marks are shown in "elon"/);
  });

  test('cast_remove deletes the entry and the Chrome data', async () => {
    const dir = findProfile(sb.paths, 'Idle')!.dir;
    const removed = await client.callTool({ name: 'cast_remove', arguments: { name: 'idle' } });
    assert.ok(!removed.isError, text(removed));
    assert.equal(findProfile(sb.paths, 'Idle'), undefined);
    assert.equal(existsSync(dir), false);
  });
});
