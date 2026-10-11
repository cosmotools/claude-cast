#!/usr/bin/env node
import { rmSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { type CallToolResult, CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { type Browser, BrowserError, pickBrowser } from './browsers.js';
import { windowLook } from './format.js';
import { Gateway, type GatewayProfile, PROFILE_PARAM } from './gateway.js';
import { type LoginResult, normalizeSite, startLoginWindow } from './login-window.js';
import { isRunning } from './chrome.js';
import { finishClosedLogins, finishLogin, lastLogin, loginPending } from './logins.js';
import { type CastPaths, type Scope, outputDir, resolvePaths } from './paths.js';
import { VERSION } from './version.js';
import {
  type Profile, RegistryError, addProfile, editProfile, ensureColor, findProfile, loadProfiles, removeProfile, requireReady, slotDescription, updateProfile,
} from './registry.js';

const HUMAN_ONLY = 'Call ONLY when the user explicitly asked for it (/cast:add, /cast:open): the window is for a human (to log in, add sites or work by hand). Never call it on your own because a session expired.';

const CAST_TOOLS: Tool[] = [
  {
    name: 'cast_list',
    description: 'List cast browser profiles (one per person): name, scope, email, description, known sites, whether it is set up on this machine (ready), currently open, and the Chrome profile folder (dir). Never start Chrome on that folder by hand: use /cast:open, which launches it with the right flags.',
    annotations: { title: 'List profiles', readOnlyHint: true, openWorldHint: false },
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'cast_open',
    description: 'Open the visible Chrome of a profile, optionally with a URL in a new tab (the person\'s own tabs stay as they are; at most 3 tabs opened by Claude are kept, the oldest is closed). browser_* tools also open the profile automatically.',
    annotations: { title: 'Open a profile', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: { profile: PROFILE_PARAM, url: { type: 'string', description: 'URL to open in a new tab' } },
      required: ['profile'],
    },
  },
  {
    name: 'cast_close',
    description: 'Close the Chrome of a profile. Logins are kept in the profile. Close profiles when the task is done. A window the user opened with /cast:open stays open: Claude only lets go of it.',
    annotations: { title: 'Close a profile', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: 'object', properties: { profile: PROFILE_PARAM }, required: ['profile'] },
  },
  {
    name: 'cast_add',
    description: `Create a profile and open a clean Chrome for the human to log in. Returns at once; when the user says they are done (the window may stay open), call cast_user_window_result, then Claude can work in the same window. ${HUMAN_ONLY}`,
    annotations: { title: 'Add a profile and open it for login', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Profile name: letters, digits, "-" or "_"' },
        email: { type: 'string' },
        description: { type: 'string', description: 'Required: who this person is in tests, e.g. "sender" or "vendor, Acme org". Only what the user gave. May be left out only for a project slot that already has a description.' },
        scope: { type: 'string', enum: ['local', 'project', 'user'], description: 'local (default): this project only; project: shared team slot in .claude/claude-cast.yaml; user: all projects' },
      },
      required: ['name'],
    },
  },
  {
    name: 'cast_open_for_user',
    description: `Open an existing profile's Chrome for the human, without Claude's control: to log in again, add sites or work by hand. Returns at once; when the user says they are done (the window may stay open), call cast_user_window_result, then Claude can work in the same window. To open a profile for Claude to work in, use cast_open instead. ${HUMAN_ONLY}`,
    annotations: { title: 'Open a profile for the user', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: { type: 'object', properties: { name: PROFILE_PARAM }, required: ['name'] },
  },
  {
    name: 'cast_user_window_result',
    description: 'After /cast:add or /cast:open, once the user says they are done: saves and returns the sites visited in the user window and the last page the user saw on each. The window may stay open; Claude can work in it afterwards. Takes about 10 s while the window is open.',
    annotations: { title: 'Get what the user window saved', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: 'object', properties: { name: PROFILE_PARAM }, required: ['name'] },
  },
  {
    name: 'cast_set_sites',
    description: 'Replace the list of sites (hosts, e.g. "localhost:3000", "outlook.office.com") remembered for a profile.',
    annotations: { title: 'Set profile sites', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: { name: PROFILE_PARAM, sites: { type: 'array', items: { type: 'string' } } },
      required: ['name', 'sites'],
    },
  },
  {
    name: 'cast_update',
    description: 'Change the email or description of a profile without logging in again. The description says who this person is in tests (e.g. "vendor, Acme org"); Claude picks profiles by it. Save only what the user stated or confirmed, never a guess. An empty email clears it; a description cannot be cleared, only replaced (an empty one on a project profile goes back to the team slot\'s).',
    annotations: { title: 'Edit a profile', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: { name: PROFILE_PARAM, email: { type: 'string' }, description: { type: 'string' } },
      required: ['name'],
    },
  },
  {
    name: 'cast_remove',
    description: 'Delete a profile and its Chrome data (logins). Only when the user asked (/cast:remove).',
    annotations: { title: 'Remove a profile', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: 'object', properties: { name: PROFILE_PARAM }, required: ['name'] },
  },
];

type Args = Record<string, unknown>;

export function createServer(paths: CastPaths, gateway: Gateway): Server {
  const server = new Server({ name: 'cast', version: VERSION }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...CAST_TOOLS, ...await gateway.toolDefs()],
  }));

  server.setRequestHandler(CallToolRequestSchema, async req => {
    const { name, arguments: args = {} } = req.params;
    try {
      // User windows may have been closed while nobody waited on them, even in an earlier session.
      await finishClosedLogins(paths);
      if (name.startsWith('cast_')) return await castTool(paths, gateway, name, args);
      const { profile, ...rest } = args;
      if (typeof profile !== 'string') return fail('Missing "profile": pass the cast profile name (see cast_list).');
      return await gateway.call(gatewayProfile(paths, usable(paths, profile)), name, rest);
    } catch (e) {
      return fail((e as Error).message);
    }
  });

  return server;
}

async function castTool(paths: CastPaths, gateway: Gateway, tool: string, args: Args): Promise<CallToolResult> {
  switch (tool) {
    case 'cast_list': {
      const open = new Set(gateway.openNames().map(n => n.toLowerCase()));
      const profiles = loadProfiles(paths).map(p => ({
        name: p.name, scope: p.scope, email: p.email, description: p.description, sites: p.sites,
        ready: p.ready, open: open.has(p.name.toLowerCase()), dir: p.dir, browser: p.browser,
        ...(p.ready ? {} : { note: `Not set up on this machine: ask the user to run /cast:add ${p.name}` }),
      }));
      return ok(profiles.length ? JSON.stringify(profiles, null, 2) : 'No cast profiles yet. The user can create one with /cast:add <name>.');
    }
    case 'cast_open': {
      const p = usable(paths, str(args, 'profile'));
      const gp = gatewayProfile(paths, p);
      // Playwright MCP starts Chrome lazily, so make a call that shows the window. A URL goes to a
      // new tab (or an empty one): the current one is a tab the person left open.
      const url = optStr(args, 'url');
      const result = url ? await gateway.openTab(gp, url) : await gateway.call(gp, 'browser_tabs', { action: 'list' });
      return { ...result, content: [{ type: 'text', text: `Profile "${p.name}" is open.` }, ...result.content] };
    }
    case 'cast_close': {
      const name = str(args, 'profile');
      if (gateway.isJoined(name)) {
        await gateway.close(name);
        return ok(`Let go of "${name}": the window was opened by the user and stays open for them. Logins are kept.`);
      }
      return ok(await gateway.close(name) ? `Closed "${name}".` : `"${name}" was not open.`);
    }
    case 'cast_add': {
      const name = str(args, 'name');
      const scope = (optStr(args, 'scope') ?? 'local') as Scope;
      if (!['local', 'project', 'user'].includes(scope)) throw new RegistryError(`Unknown scope "${scope}".`);
      const before = findProfile(paths, name);
      const description = optStr(args, 'description');
      if (!description && !before?.ready && !before?.description) {
        throw new RegistryError(`A description is required: Claude picks profiles by it. Ask the user who "${name}" is in the tests (e.g. "sender", "vendor, Acme org"), then call cast_add again with it.`);
      }
      // Fails before anything is saved when no browser fits.
      const browser = pickBrowser();
      const p = addProfile(paths, name, scope, {
        email: optStr(args, 'email'), description, browser: browser.id === 'custom' ? undefined : browser.id,
      });
      try {
        await loginWindow(paths, gateway, p);
      } catch (e) {
        if (!before) removeProfile(paths, p.name);
        throw e;
      }
      return ok(loginOpened(p));
    }
    case 'cast_open_for_user': {
      const p = ensureColor(paths, str(args, 'name'));
      await loginWindow(paths, gateway, p);
      return ok(loginOpened(p));
    }
    case 'cast_user_window_result': {
      const name = requireReady(paths, str(args, 'name')).name;
      const p = (await finishLogin(paths, name, true))!;
      if (!p.lastLoginAt || !p.loginStartedAt) return ok(`No user window was opened for "${p.name}". The user can run /cast:open ${p.name}.`);
      return ok(loginReport(p, await lastLogin(p), isRunning(p.dir)));
    }
    case 'cast_set_sites': {
      const raw = args.sites;
      if (!Array.isArray(raw) || raw.some(s => typeof s !== 'string')) throw new RegistryError('"sites" must be an array of strings.');
      const sites = [...new Set(raw.map(s => normalizeSite(s as string)).filter((s): s is string => !!s))];
      const p = updateProfile(paths, str(args, 'name'), { sites });
      return ok(`Sites of "${p.name}": ${p.sites.join(', ') || '(none)'}`);
    }
    case 'cast_update': {
      const fields = { email: rawStr(args, 'email'), description: rawStr(args, 'description') };
      if (fields.email === undefined && fields.description === undefined) throw new RegistryError('Pass "email" or "description" to change.');
      if (fields.description !== undefined && !fields.description.trim()) {
        const current = requireReady(paths, str(args, 'name'));
        if (current.scope !== 'project' || !slotDescription(paths, current.name)) {
          throw new RegistryError(`A description cannot be cleared: Claude picks profiles by it. Pass the new description of "${current.name}".`);
        }
      }
      const p = editProfile(paths, str(args, 'name'), fields);
      const slot = p.scope === 'project' && fields.description !== undefined
        ? ' The description is kept for you only; the team slot in .claude/claude-cast.yaml is unchanged.' : '';
      return ok(`Profile "${p.name}": email ${p.email ?? '(none)'}, description ${p.description ?? '(none)'}.${slot}`);
    }
    case 'cast_remove': {
      const name = str(args, 'name');
      await gateway.close(name);
      const p = removeProfile(paths, name);
      rmSync(p.dir, { recursive: true, force: true });
      rmSync(outputDir(paths, p.name), { recursive: true, force: true });
      const slot = p.scope === 'project' ? ' The team slot stays in .claude/claude-cast.yaml.' : '';
      return ok(`Removed profile "${p.name}" (${p.scope}) and its browser data.${slot}`);
    }
    default:
      return fail(`Unknown tool ${tool}.`);
  }
}

/**
 * A browser_* or cast_open target: ready, and not in the middle of a login. Claude must not attach while
 * the person signs in: SSO bot checks refuse a browser Playwright is attached to.
 */
function usable(paths: CastPaths, name: string): Profile {
  const p = ensureColor(paths, name);
  if (loginPending(p)) {
    throw new RegistryError(`The user window for "${p.name}" is open, and the user may be signing in there: Claude does not act in it until they are done, `
      + `because sign-in pages refuse a browser Claude controls. Ask the user whether they have finished; when they say so, `
      + `call cast_user_window_result {name: "${p.name}"} and continue in the same window. They do not need to close it.`);
  }
  return p;
}

/** Opens the window and returns at once: the human may take long, and the window outlives this session. */
async function loginWindow(paths: CastPaths, gateway: Gateway, p: Profile): Promise<void> {
  // Nothing may be attached while the person signs in. cast's own Chrome is stopped, so the user window
  // runs detached and outlives this session; a window the person opened before keeps running.
  await gateway.close(p.name);
  const browser = profileBrowser(paths, p);
  const { startedAt, chrome } = await startLoginWindow(p.dir, { name: p.name, sites: p.sites, look: windowLook(p, 'your window'), browser });
  updateProfile(paths, p.name, { loginStartedAt: startedAt.toISOString() });
  // Save the sites as soon as the window closes, if this session is still running then.
  chrome.exited.then(() => finishLogin(paths, p.name)).catch(() => {});
}

function loginOpened(p: Profile): string {
  return [
    `The user window for "${p.name}" is open. This call does not wait for it.`,
    'Tell the user: log in everywhere this person needs, choose "Stay signed in" on MFA prompts, and say so here when done; '
      + 'they can keep the window open (you then work in it) or close it. '
      + 'They may also leave this Claude Code session: cast saves the visited sites when the window closes.',
    `When the user says they are done, call cast_user_window_result {name: "${p.name}"}. Until then do not act in this profile.`,
  ].join('\n');
}

function loginReport(p: Profile, r: LoginResult, open: boolean): string {
  const lines = [
    open
      ? `The user is done in the window for "${p.name}"; it stays open and Claude can work in it now (browser_* tools). cast saved the sites the user landed on.`
      : `The user window for "${p.name}" is closed. cast saved the sites the user landed on.`,
    `Sites from this login: ${r.sites.join(', ') || '(none)'}`,
    `Saved sites now: ${p.sites.join(', ') || '(none)'}`,
    `Sign-in pages and redirects (left out; Claude never logs in itself): ${r.signIn.join(', ') || '(none)'}`,
    p.sites.length
      ? `Do not ask about the sites: tell the user in one line which ones were saved and that /cast:edit ${p.name} changes them.`
      : 'No sites were saved (only sign-in pages were visited): ask the user for the address of the app they logged in to, then call cast_set_sites.',
  ];
  if (r.landings.length) {
    lines.push('Last page the user saw on each site (the path and title often tell the role):');
    for (const l of r.landings) lines.push(`- ${l.url}${l.title ? ` — "${l.title}"` : ''}`);
  }
  lines.push(p.description
    ? `Saved description: "${p.description}".`
    : 'The profile has no description, so Claude cannot tell who this person is. In the same message, ask who this person is in the tests, '
      + 'suggesting a short description from the pages above if they show a role (e.g. "vendor on app.example.com (/vendor)"). '
      + 'Call cast_update only with what the user answered or confirmed; if they decline, save nothing.');
  return lines.join('\n');
}

export function gatewayProfile(paths: CastPaths, p: Profile): GatewayProfile {
  return { name: p.name, dir: p.dir, outputDir: outputDir(paths, p.name), look: windowLook(p), browser: profileBrowser(paths, p) };
}

/**
 * The browser a profile opens in. A profile made before cast recorded browsers was made with Google Chrome:
 * record that now. A snap browser keeps its profiles in another folder, so it opens only profiles made with it.
 */
function profileBrowser(paths: CastPaths, p: Profile): Browser {
  const browser = pickBrowser({ pinned: p.browser, legacy: !p.browser });
  if (browser.snap && p.browser !== browser.id) {
    throw new BrowserError(`Profile "${p.name}" was made with another browser, and ${browser.name} (CAST_CHROME) keeps its profiles in its own folder. Unset CAST_CHROME, or start over with /cast:remove and /cast:add.`);
  }
  if (!p.browser && browser.id !== 'custom') updateProfile(paths, p.name, { browser: browser.id });
  return browser;
}

function str(args: Args, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !v) throw new RegistryError(`Missing "${key}".`);
  return v;
}

/** A string argument as given, including "" (which clears a field); undefined when absent. */
function rawStr(args: Args, key: string): string | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw new RegistryError(`"${key}" must be a string.`);
  return v;
}

function optStr(args: Args, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function ok(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

function fail(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

async function main(): Promise<void> {
  const gateway = new Gateway();
  const server = createServer(resolvePaths(), gateway);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await gateway.closeAll().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.stdin.on('end', stop);
  server.onclose = stop;
  await server.connect(new StdioServerTransport());
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
