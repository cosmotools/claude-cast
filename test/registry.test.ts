import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { applyColor, clearCrashedExit, launchChrome, nameSessionWindows } from '../src/chrome.js';
import { briefList, windowLook } from '../src/format.js';
import { normalizeSite, pageUrl } from '../src/login-window.js';
import { type MacWindow, windowsClosed } from '../src/mac-windows.js';
import { classifyHosts, isSignInHost } from '../src/sites.js';
import { accountIdFor, ensurePrivateDir, listFile, profileDir, projectIdFor, resolvePaths } from '../src/paths.js';
import {
  PROFILE_COLORS, RegistryError, addProfile, editProfile, ensureColor, findProfile, loadProfiles, removeProfile, slotDescription, updateProfile, validateName,
} from '../src/registry.js';
import { type Sandbox, sandbox } from './helpers.js';

let sb: Sandbox;
beforeEach(() => { sb = sandbox(); });
afterEach(() => sb.cleanup());

describe('paths', () => {
  test('project id is stable and readable', () => {
    assert.equal(projectIdFor('/home/me/my app'), projectIdFor('/home/me/my app'));
    assert.match(projectIdFor('/home/me/my app'), /^my_app-[0-9a-f]{8}$/);
    assert.notEqual(projectIdFor('/a/app'), projectIdFor('/b/app'));
  });

  test('project dir: CAST_PROJECT_DIR, then CLAUDE_PROJECT_DIR, then cwd', () => {
    assert.equal(resolvePaths({ CLAUDE_PLUGIN_DATA: '/pd', CAST_PROJECT_DIR: '/x', CLAUDE_PROJECT_DIR: '/y' }).projectDir, resolve('/x'));
    assert.equal(resolvePaths({ CLAUDE_PLUGIN_DATA: '/pd', CLAUDE_PROJECT_DIR: '/y' }).projectDir, resolve('/y'));
    assert.equal(resolvePaths({ CLAUDE_PLUGIN_DATA: '/pd', CAST_PROJECT_DIR: '${CLAUDE_PROJECT_DIR}', CLAUDE_PROJECT_DIR: '/y' }).projectDir, resolve('/y'));
  });

  test('config and data live in the plugin data folder', () => {
    const data = join('/home', 'me', '.claude-cast', 'plugins', 'data', 'cast-cosmotools');
    const p = resolvePaths({ CLAUDE_PLUGIN_DATA: data });
    assert.equal(p.configDir, join(data, 'config'));
    assert.equal(p.dataDir, join(data, 'data'));
    assert.equal(p.snapAccount, 'claude-cast');
    assert.equal(accountIdFor(join('/home', 'me', '.claude', 'plugins', 'data', 'cast-claude-plugins-official')), 'claude');
  });

  test('CAST_CONFIG_DIR and CAST_DATA_DIR override the plugin data folder', () => {
    const p = resolvePaths({ CLAUDE_PLUGIN_DATA: '/pd', CAST_CONFIG_DIR: '/c', CAST_DATA_DIR: '/d' });
    assert.equal(p.configDir, '/c');
    assert.equal(p.dataDir, '/d');
    assert.equal(p.snapAccount, '');
  });

  test('without CLAUDE_PLUGIN_DATA or CAST_* dirs cast refuses to guess', () => {
    assert.throws(() => resolvePaths({}), /CLAUDE_PLUGIN_DATA is not set/);
    assert.throws(() => resolvePaths({ CLAUDE_PLUGIN_DATA: '${CLAUDE_PLUGIN_DATA}' }), /CLAUDE_PLUGIN_DATA is not set/);
    assert.throws(() => resolvePaths({ CAST_CONFIG_DIR: '/c' }), /CLAUDE_PLUGIN_DATA is not set/);
  });

  test('a snap browser keeps profiles in ~/snap/<snap>/common/claude-cast/<account>', () => {
    const p = resolvePaths({ CAST_PROJECT_DIR: '/w/app', CLAUDE_PLUGIN_DATA: '/home/me/.claude/plugins/data/cast-x' });
    assert.equal(p.snapDir, join(homedir(), 'snap'));
    assert.equal(profileDir(p, 'user', 'Sam', 'snap:chromium'), join(p.snapDir, 'chromium', 'common', 'claude-cast', p.snapAccount, 'user', 'sam'));
    assert.equal(profileDir(p, 'local', 'Sam', 'brave'), join(p.dataDir, 'projects', p.projectId, 'sam'));
    assert.equal(resolvePaths({ CAST_CONFIG_DIR: '/c', CAST_DATA_DIR: '/d' }).snapDir, join('/d', 'snap'));
  });

  test('profile dirs are private (0700)', { skip: process.platform === 'win32' && 'no file modes on Windows' }, () => {
    const dir = join(sb.root, 'p');
    mkdirSync(dir, { mode: 0o755 });
    ensurePrivateDir(dir);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    const nested = ensurePrivateDir(join(sb.root, 'a', 'b'));
    assert.equal(statSync(nested).mode & 0o777, 0o700);
  });
});

describe('registry', () => {
  test('records the browser a profile is made with; older profiles have none', () => {
    addProfile(sb.paths, 'Sam', 'local', { browser: 'snap:chromium' });
    addProfile(sb.paths, 'Old', 'local', {});
    const sam = findProfile(sb.paths, 'Sam')!;
    assert.equal(sam.browser, 'snap:chromium');
    assert.equal(sam.dir, profileDir(sb.paths, 'local', 'Sam', 'snap:chromium'));
    assert.equal(findProfile(sb.paths, 'Old')!.browser, undefined);
    assert.equal(updateProfile(sb.paths, 'Old', { browser: 'chrome' }).browser, 'chrome');
  });

  test('validates names', () => {
    for (const ok of ['Sam', 'elon_2', 'a-b']) assert.equal(validateName(ok), ok);
    for (const bad of ['', '-x', 'a b', 'x/y', 'a'.repeat(41)]) assert.throws(() => validateName(bad), RegistryError);
  });

  test('adds a local profile by default and finds it case-insensitively', () => {
    addProfile(sb.paths, 'Sam', 'local', { email: 'sam@email.com', description: 'sender' });
    const p = findProfile(sb.paths, 'sam')!;
    assert.equal(p.name, 'Sam');
    assert.equal(p.scope, 'local');
    assert.equal(p.email, 'sam@email.com');
    assert.equal(p.ready, true);
    assert.ok(p.dir.includes(sb.paths.projectId));
  });

  test('refuses duplicates regardless of case', () => {
    addProfile(sb.paths, 'Sam', 'local', {});
    assert.throws(() => addProfile(sb.paths, 'SAM', 'user', {}), /already exists/);
  });

  test('precedence: local > project > user', () => {
    addProfile(sb.paths, 'Sam', 'user', { description: 'from user' });
    writeProjectSlots({ sam: { description: 'from project' } });
    assert.equal(findProfile(sb.paths, 'Sam')!.scope, 'project');
    assert.equal(findProfile(sb.paths, 'Sam')!.ready, false);

    mkdirSync(join(sb.paths.configDir, 'projects'), { recursive: true });
    writeFileSync(listFile(sb.paths, 'local'), 'profiles:\n  SAM:\n    description: mine\n');
    const p = findProfile(sb.paths, 'Sam')!;
    // A local entry with the slot's name fills the project slot.
    assert.equal(p.scope, 'project');
    assert.equal(p.ready, true);
    assert.equal(p.description, 'mine');
    assert.equal(loadProfiles(sb.paths).length, 1);
  });

  test('user profiles are shared across projects', () => {
    addProfile(sb.paths, 'Elon', 'user', {});
    const other = resolvePaths({ ...sb.env, CAST_PROJECT_DIR: join(sb.root, 'other') });
    assert.equal(findProfile(other, 'Elon')?.scope, 'user');
    assert.equal(findProfile(other, 'Elon')?.dir, findProfile(sb.paths, 'Elon')?.dir);
  });

  test('project slot: committed file has no personal data, developer fills it locally', () => {
    writeProjectSlots({ sender: { description: 'writes messages' } });
    const slot = findProfile(sb.paths, 'Sender')!;
    assert.equal(slot.ready, false);
    assert.match(briefList(loadProfiles(sb.paths)), /NOT set up on this machine: ask the user to run \/cast:add sender/);

    // /cast:add fills the slot even when the default scope is asked for.
    const p = addProfile(sb.paths, 'Sender', 'local', { email: 'me@corp.com' });
    assert.equal(p.scope, 'project');
    assert.equal(p.ready, true);
    assert.equal(p.name, 'sender');
    assert.equal(p.description, 'writes messages');
    assert.doesNotMatch(readFileSync(listFile(sb.paths, 'project'), 'utf8'), /me@corp\.com/);
    assert.match(readFileSync(listFile(sb.paths, 'local'), 'utf8'), /me@corp\.com/);

    updateProfile(sb.paths, 'SENDER', { sites: ['localhost:3000'] });
    assert.deepEqual(findProfile(sb.paths, 'sender')!.sites, ['localhost:3000']);

    removeProfile(sb.paths, 'sender');
    assert.equal(findProfile(sb.paths, 'sender')!.ready, false, 'the team slot stays');
  });

  test('new project slot writes .claude/claude-cast.yaml', () => {
    addProfile(sb.paths, 'Admin', 'project', { email: 'a@b.c', description: 'admin user' });
    const committed = readFileSync(listFile(sb.paths, 'project'), 'utf8');
    assert.match(committed, /Admin/);
    assert.match(committed, /admin user/);
    assert.doesNotMatch(committed, /a@b\.c/);
  });

  test('update and remove act on the right scope', () => {
    addProfile(sb.paths, 'Elon', 'user', {});
    updateProfile(sb.paths, 'elon', { sites: ['outlook.office.com'], email: 'e@x.com' });
    assert.deepEqual(findProfile(sb.paths, 'Elon')!.sites, ['outlook.office.com']);
    removeProfile(sb.paths, 'ELON');
    assert.equal(findProfile(sb.paths, 'Elon'), undefined);
    assert.throws(() => removeProfile(sb.paths, 'Elon'), /No profile/);
  });

  test('edit sets and clears email and description, keeping the rest', () => {
    addProfile(sb.paths, 'Alex', 'local', { email: 'a@x.com' });
    updateProfile(sb.paths, 'Alex', { sites: ['app.example.com'] });
    const p = editProfile(sb.paths, 'alex', { description: '  vendor, Acme org ' });
    assert.equal(p.description, 'vendor, Acme org');
    assert.equal(p.email, 'a@x.com');
    assert.deepEqual(p.sites, ['app.example.com']);
    assert.equal(editProfile(sb.paths, 'Alex', { email: '' }).email, undefined);
    assert.throws(() => editProfile(sb.paths, 'Nobody', { description: 'x' }), /No profile/);
  });

  test('edit of a project profile keeps the team slot unchanged', () => {
    writeProjectSlots({ sender: { description: 'writes messages' } });
    addProfile(sb.paths, 'sender', 'local', {});
    assert.equal(editProfile(sb.paths, 'sender', { description: 'writes in Teams' }).description, 'writes in Teams');
    assert.match(readFileSync(listFile(sb.paths, 'project'), 'utf8'), /description: writes messages/);
    assert.equal(editProfile(sb.paths, 'sender', { description: '' }).description, 'writes messages');
  });

  test('slotDescription reads the team slot only', () => {
    writeProjectSlots({ sender: { description: 'writes messages' } });
    assert.equal(slotDescription(sb.paths, 'SENDER'), 'writes messages');
    assert.equal(slotDescription(sb.paths, 'nobody'), undefined);
    addProfile(sb.paths, 'Solo', 'local', { description: 'admin' });
    assert.equal(slotDescription(sb.paths, 'Solo'), undefined);
  });

  test('each new profile gets a color no other profile uses', () => {
    const colors = ['A', 'B', 'C'].map(n => addProfile(sb.paths, n, 'local', {}).color);
    assert.deepEqual(colors, PROFILE_COLORS.slice(0, 3));
    removeProfile(sb.paths, 'B');
    assert.equal(addProfile(sb.paths, 'D', 'user', {}).color, PROFILE_COLORS[1]);
  });

  test('an old profile without a color gets one once', () => {
    addProfile(sb.paths, 'A', 'local', {});
    updateProfile(sb.paths, 'A', { color: undefined });
    const file = listFile(sb.paths, 'local');
    writeFileSync(file, readFileSync(file, 'utf8').replace(/\n\s*color: .*/, ''));
    assert.equal(findProfile(sb.paths, 'A')!.color, undefined);
    const color = ensureColor(sb.paths, 'A').color;
    assert.equal(color, PROFILE_COLORS[0]);
    assert.equal(ensureColor(sb.paths, 'A').color, color);
  });

  test('reports broken yaml as RegistryError', () => {
    mkdirSync(join(sb.paths.configDir), { recursive: true });
    writeFileSync(listFile(sb.paths, 'user'), 'profiles: [1, 2');
    assert.throws(() => loadProfiles(sb.paths), RegistryError);
  });
});

describe('window look', () => {
  test('title names the person and the window', () => {
    addProfile(sb.paths, 'Sam', 'local', { description: 'sends messages' });
    const p = findProfile(sb.paths, 'Sam')!;
    assert.deepEqual(windowLook(p), { title: 'Sam (sends messages) · cast', color: PROFILE_COLORS[0] });
    assert.equal(windowLook(p, 'your window').title, 'Sam (sends messages) · your window · cast');
    assert.equal(windowLook({ ...p, description: 'x'.repeat(60) }).title, `Sam (${'x'.repeat(39)}…) · cast`);
  });

  test('the color goes into Chrome preferences, keeping the rest', () => {
    const dir = join(sb.root, 'chrome');
    applyColor(dir, '#1e88e5');
    const file = join(dir, 'Default', 'Preferences');
    const fresh = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(fresh.browser.theme.user_color2, 0xff1e88e5 | 0);
    assert.equal(fresh.browser.theme.color_variant2, 3);
    assert.equal(fresh.browser.custom_chrome_frame, false);
    assert.equal(fresh.extensions.theme.system_theme, 0);

    writeFileSync(file, JSON.stringify({ browser: { theme: { color_scheme2: 2 }, has_seen_welcome_page: true }, profile: { name: 'x' } }));
    applyColor(dir, '#e53935');
    const kept = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(kept.browser.theme.color_scheme2, 2);
    assert.equal(kept.browser.has_seen_welcome_page, true);
    assert.equal(kept.profile.name, 'x');
    assert.equal(kept.browser.theme.user_color2, 0xffe53935 | 0);

    writeFileSync(file, '{broken');
    applyColor(dir, '#43a047');
    assert.equal(readFileSync(file, 'utf8'), '{broken', 'a file Chrome may still repair is left alone');
  });

  test('a crashed exit is marked normal, keeping the rest', () => {
    const dir = join(sb.root, 'crashed');
    const file = join(dir, 'Default', 'Preferences');
    mkdirSync(join(dir, 'Default'), { recursive: true });
    writeFileSync(file, JSON.stringify({ profile: { exit_type: 'Crashed', name: 'x' }, browser: { a: 1 } }));
    clearCrashedExit(dir);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { profile: { exit_type: 'Normal', name: 'x' }, browser: { a: 1 } });

    writeFileSync(file, '{broken');
    clearCrashedExit(dir);
    assert.equal(readFileSync(file, 'utf8'), '{broken');
    clearCrashedExit(join(sb.root, 'none'));
  });
});

describe('restored window names', () => {
  /** An SNSS record: uint16 size, command id, payload. */
  const record = (id: number, payload: Buffer) => {
    const head = Buffer.alloc(3);
    head.writeUInt16LE(payload.length + 1, 0);
    head[2] = id;
    return Buffer.concat([head, payload]);
  };
  const ints = (...n: number[]) => Buffer.from(new Int32Array(n).buffer);
  /** The last title set for each window, as Chrome reads the file. */
  const titles = (b: Buffer) => {
    const out = new Map<number, string>();
    for (let i = 8; i < b.length; i += 2 + b.readUInt16LE(i)) {
      if (b[i + 2] === 31) out.set(b.readInt32LE(i + 7), b.toString('utf8', i + 15, i + 15 + b.readInt32LE(i + 11)));
    }
    return out;
  };

  test('each window of a saved session gets the new title', () => {
    const sessions = join(sb.root, 'p', 'Default', 'Sessions');
    mkdirSync(sessions, { recursive: true });
    const file = join(sessions, 'Session_1');
    writeFileSync(file, Buffer.concat([
      Buffer.from('SNSS'), ints(3),
      record(0, ints(7, 1)), record(0, ints(9, 2)),
      record(31, Buffer.concat([ints(12, 7, 3), Buffer.from('old\0')])),
    ]));
    writeFileSync(join(sessions, 'Session_2'), 'not a session');

    nameSessionWindows(join(sb.root, 'p'), 'Ann (approves…) · cast');
    assert.deepEqual(titles(readFileSync(file)), new Map([[7, 'Ann (approves…) · cast'], [9, 'Ann (approves…) · cast']]));
    assert.equal(readFileSync(join(sessions, 'Session_2'), 'utf8'), 'not a session');
  });
});

describe('macOS window watcher', () => {
  const win = (id: number, onscreen: boolean, width = 1200, height = 900): MacWindow => ({ id, onscreen, width, height });
  // Chrome's hidden helpers: a 500x500 window, menu bar strips, omnibox popups. None of them is ever on screen.
  const helpers = [win(1, false, 500, 500), win(2, false, 1680, 24), win(3, false, 866, 138)];

  test('waits for a window to show before deciding anything', () => {
    assert.equal(windowsClosed(new Set(), helpers), false);
  });

  test('a minimized window or one on another Space keeps Chrome running', () => {
    const seen = new Set<number>();
    assert.equal(windowsClosed(seen, [...helpers, win(10, true)]), false);
    assert.equal(windowsClosed(seen, [...helpers, win(10, false)]), false);
  });

  test('closing the last window quits, a popup on screen is not a window', () => {
    const seen = new Set<number>();
    windowsClosed(seen, [...helpers, win(10, true), win(11, true, 866, 138)]);
    assert.equal(windowsClosed(seen, [...helpers, win(10, false), win(12, true)]), false, 'a new window opened');
    assert.equal(windowsClosed(seen, [...helpers, win(12, false)]), false, 'the new one is minimized');
    assert.equal(windowsClosed(seen, helpers), true);
  });
});

describe('chrome start errors', () => {
  /** The fake Chrome is a shell script; Windows runs .cmd files only through a shell. */
  const noScripts = process.platform === 'win32' && 'no shell scripts on Windows';

  /** Runs `fn` with these environment variables (undefined unsets one), then restores them. */
  async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<unknown>) {
    const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
    const set = (v: Record<string, string | undefined>) => {
      for (const [k, x] of Object.entries(v)) if (x === undefined) delete process.env[k]; else process.env[k] = x;
    };
    set(vars);
    try { await fn(); } finally { set(saved); }
  }

  /** A fake Chrome that prints `output` and exits. */
  function fakeChrome(output: string): string {
    const file = join(sb.root, 'fake-chrome.sh');
    writeFileSync(file, `#!/bin/sh\necho '${output}' >&2\nexit 1\n`);
    chmodSync(file, 0o755);
    return file;
  }

  const dir = () => join(sb.root, 'profile');

  test('Chrome not installed', () => withEnv({ CAST_TEST_HEADLESS: '1', CAST_CHROME: join(sb.root, 'nope') }, () =>
    assert.rejects(launchChrome(dir()), /cannot be started .*nope not found.*CAST_CHROME/)));

  test('no display', { skip: process.platform !== 'linux' && 'Linux only' }, () => withEnv({ CAST_TEST_HEADLESS: undefined, DISPLAY: undefined, WAYLAND_DISPLAY: undefined }, () =>
    assert.rejects(launchChrome(dir()), /No display .*not over plain SSH/)));

  test('display not reachable', { skip: noScripts }, () => withEnv({ CAST_TEST_HEADLESS: '1', CAST_CHROME: fakeChrome('[1:1:0930/1:ERROR:ozone_platform_x11.cc:257] Missing X server or $DISPLAY') }, () =>
    assert.rejects(launchChrome(dir()), /display is not reachable/)));

  test('any other exit shows what Chrome said', { skip: noScripts }, async () => {
    await withEnv({ CAST_TEST_HEADLESS: '1', CAST_CHROME: fakeChrome('[1:1:0930/1:FATAL:x.cc:1] Something broke') }, async () => {
      await assert.rejects(launchChrome(dir()), /exited right after starting: Something broke\. Its output is in .*cast-chrome\.log/);
      await assert.rejects(launchChrome(dir(), { debugPort: true }), /exited right after starting: Something broke/);
    });
  });
});

describe('format', () => {
  test('brief list matches the hook format', () => {
    addProfile(sb.paths, 'Sam', 'local', { email: 'sam@email.com', description: 'sender' });
    updateProfile(sb.paths, 'Sam', { sites: ['localhost:3000', 'outlook.office.com'] });
    assert.equal(
      briefList(loadProfiles(sb.paths)),
      'cast: browser users available (open with cast_open / browser_* tools with profile=<name>):\n'
      + '- Sam (local) sam@email.com — sender. Sites: localhost:3000, outlook.office.com\n'
      + 'Each window reopens the person\'s own tabs. To open a site there, select a tab that already shows it or open a new tab '
      + '(browser_tabs "new" with url); browser_navigate replaces the current tab, which is theirs.',
    );
    assert.match(briefList([]), /no browser users yet.*\/cast:add <name>/);
    addProfile(sb.paths, 'Ali', 'local', {});
    assert.match(briefList(loadProfiles(sb.paths)), /- Ali \(local\) — role unknown \(no description\)\./);
    addProfile(sb.paths, 'Bo', 'local', { description: 'admin', browser: 'snap:chromium' });
    assert.match(briefList(loadProfiles(sb.paths)), /- Bo \(local\) — admin\. Browser: Chromium \(snap\)\./);
  });

  test('sign-in hosts are told apart from sites', () => {
    for (const h of ['login.microsoftonline.com', 'sso.godaddy.com', 'accounts.google.com', 'acme.okta.com', 'login.live.com']) {
      assert.equal(isSignInHost(h), true, h);
    }
    for (const h of ['teams.microsoft.com', 'outlook.office.com', 'localhost:3000', 'app.example.com']) {
      assert.equal(isSignInHost(h), false, h);
    }
    assert.deepEqual(
      classifyHosts(['sso.godaddy.com', 'hop.example.com', 'app.example.com'], new Set(['sso.godaddy.com', 'app.example.com'])),
      { sites: ['app.example.com'], signIn: ['sso.godaddy.com', 'hop.example.com'] },
    );
  });

  test('sites are normalized to host[:port]', () => {
    assert.equal(normalizeSite('https://Outlook.Office.com/mail/'), 'outlook.office.com');
    assert.equal(normalizeSite('localhost:3000'), 'localhost:3000');
    assert.equal(normalizeSite('  '), undefined);
    assert.equal(pageUrl('https://App.example.com:8443/vendor/home?code=abc#x'), 'https://app.example.com:8443/vendor/home');
  });
});

function writeProjectSlots(slots: Record<string, { description?: string }>): void {
  const file = listFile(sb.paths, 'project');
  mkdirSync(join(sb.paths.projectDir, '.claude'), { recursive: true });
  const body = Object.entries(slots).map(([n, s]) => `  ${n}:\n    description: ${s.description}\n`).join('');
  writeFileSync(file, `version: 1\nprofiles:\n${body}`);
}
