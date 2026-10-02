import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { launchChrome } from './chrome.js';
import { DialogGuard } from './dialogs.js';
import { Ink } from './ink.js';
import { INSTRUCTIONS_FILE } from './login-window.js';
import { ensurePrivateDir } from './paths.js';
import { VERSION } from './version.js';
const require = createRequire(import.meta.url);
/** @playwright/mcp does not export cli.js, so locate it next to its package.json. */
const PLAYWRIGHT_MCP_CLI = join(dirname(require.resolve('@playwright/mcp/package.json')), 'cli.js');
/** Tools cast replaces (browser_close → cast_close) or never exposes. */
const HIDDEN_TOOLS = new Set(['browser_close', 'browser_install']);
export const PROFILE_PARAM = { type: 'string', description: 'cast profile name, see cast_list' };
export class GatewayError extends Error {
}
/**
 * One regular Chrome plus one @playwright/mcp child per open profile; browser_* calls are routed by
 * profile name. cast starts Chrome itself (restoring the previous tabs) and Playwright MCP attaches
 * to it over the DevTools port, so the window behaves like the person's normal Chrome.
 */
export class Gateway {
    children = new Map();
    opening = new Map();
    tools;
    isOpen(name) {
        const child = this.children.get(name.toLowerCase());
        return !!child && !child.exited;
    }
    openNames() {
        return [...this.children.values()].filter(c => !c.exited).map(c => c.profile.name);
    }
    async open(profile) {
        await this.child(profile);
    }
    async child(profile) {
        const key = profile.name.toLowerCase();
        const current = this.children.get(key);
        if (current && !current.exited)
            return current;
        if (current)
            await this.close(current.profile.name);
        let pending = this.opening.get(key);
        if (!pending) {
            pending = this.start(profile).finally(() => this.opening.delete(key));
            this.opening.set(key, pending);
        }
        return pending;
    }
    async start(profile) {
        ensurePrivateDir(profile.outputDir);
        const chrome = await launchChrome(profile.dir, { restore: true, debugPort: true, look: profile.look, browser: profile.browser });
        const client = new Client({ name: 'cast', version: VERSION });
        const child = { profile, chrome, client, ink: new Ink(chrome.endpoint) };
        const transport = spawnChild(['--cdp-endpoint', chrome.endpoint, '--output-dir', profile.outputDir], profile.outputDir);
        transport.onclose = () => {
            child.exited ??= 'the Playwright MCP process exited';
            chrome.close().catch(() => { });
        };
        chrome.exited.then(() => {
            // Usually the human closed the window; the next call opens it again.
            child.exited ??= 'the Chrome window was closed';
            client.close().catch(() => { });
        });
        // A restored tab showing a dialog would keep Playwright from attaching.
        const dialogs = await DialogGuard.start(chrome.endpoint);
        try {
            await client.connect(transport);
            await settleTabs(client);
        }
        catch (e) {
            await chrome.close();
            throw e;
        }
        finally {
            dialogs.stop();
        }
        this.children.set(profile.name.toLowerCase(), child);
        return child;
    }
    async close(name) {
        const key = name.toLowerCase();
        const child = this.children.get(key);
        if (!child)
            return false;
        this.children.delete(key);
        const wasOpen = !child.exited;
        child.exited ??= 'closed by cast';
        // An open dialog keeps Chrome from closing on Windows (Browser.close does not finish, and the forced
        // stop loses the session and recent cookies): cancel it first. "No dialog" errors are ignored.
        if (wasOpen) {
            await Promise.race([
                child.client.callTool({ name: 'browser_handle_dialog', arguments: { accept: false } }).catch(() => { }),
                new Promise(r => setTimeout(r, 3000)),
            ]);
        }
        // Chrome first: on disconnect Playwright closes the tabs it opened, and the saved session would be empty.
        child.ink.close();
        await child.chrome.close();
        await child.client.close().catch(() => { });
        return wasOpen;
    }
    async closeAll() {
        await Promise.all([...this.children.values()].map(c => this.close(c.profile.name)));
    }
    /** Playwright MCP's tools with a required "profile" parameter. Fetched once from a child with no profile (Chrome does not start). */
    toolDefs() {
        this.tools ??= (async () => {
            const client = new Client({ name: 'cast', version: VERSION });
            await client.connect(spawnChild([]));
            try {
                const { tools } = await client.listTools();
                return tools.filter(t => !HIDDEN_TOOLS.has(t.name)).map(withProfileParam);
            }
            finally {
                await client.close().catch(() => { });
            }
        })();
        this.tools.catch(() => { this.tools = undefined; });
        return this.tools;
    }
    /** Opens the profile if needed and forwards the call; the child's answer is returned as is. */
    async call(profile, tool, args) {
        if (HIDDEN_TOOLS.has(tool))
            throw new GatewayError(`${tool} is not available through cast; use cast_close.`);
        const child = await this.child(profile);
        try {
            const notice = await child.ink.before(tool).catch(() => undefined);
            const result = absoluteLinks(await child.client.callTool({ name: tool, arguments: args }), profile.outputDir);
            return notice ? { ...result, content: [{ type: 'text', text: notice }, ...result.content] } : result;
        }
        catch (e) {
            if (child.exited) {
                throw new GatewayError(`Browser for "${profile.name}" stopped (${child.exited}). Call the tool again to reopen it.`);
            }
            throw e;
        }
    }
    /**
     * Draws marks over the elements in the profile's current tab and brings it to the front. Targets are
     * resolved like browser_click's (snapshot refs, iframes included); the first one is scrolled into view.
     * Returns what happened to marks drawn before, if the person erased them.
     */
    async draw(profile, marks) {
        const child = await this.child(profile);
        const notice = await child.ink.before('cast_draw').catch(() => undefined);
        const located = await child.client.callTool({
            name: 'browser_run_code_unsafe',
            arguments: { code: LOCATE.replace('TARGETS', JSON.stringify(marks.map(m => m.target))) },
        });
        const text = resultText(located);
        const json = /### Result\n(.+)/.exec(text)?.[1];
        if (located.isError || !json)
            throw new GatewayError(/### Error\n([^\n]+)/.exec(text)?.[1] ?? text.slice(0, 300));
        const { targetId, boxes } = JSON.parse(json);
        await child.ink.draw(targetId, marks.map((m, i) => ({ box: boxes[i], shape: m.shape ?? 'circle', ...(m.note ? { note: m.note } : {}) })));
        return notice;
    }
    /** Erases the marks of an open profile; false when there were none. */
    async erase(name) {
        const child = this.children.get(name.toLowerCase());
        return !!child && !child.exited && child.ink.erase();
    }
}
/**
 * Runs in Playwright MCP: boxes of the targets in main-frame viewport coordinates, and the tab's DevTools
 * target id so cast can draw into it. Refs ("e12", "f1e3") resolve as in browser_click; anything else is a selector.
 */
const LOCATE = `async (page) => {
  const targets = TARGETS;
  const locate = t => page.locator(/^(f\\d+)?e\\d+$/.test(t) ? 'aria-ref=' + t : t);
  for (const t of targets) {
    const n = await locate(t).count().catch(() => 0);
    if (n !== 1) throw new Error(n ? '"' + t + '" matches ' + n + ' elements; use a ref from browser_snapshot.' : '"' + t + '" is not on the page; take a new browser_snapshot and use its refs.');
  }
  // The first target in the middle of the window, unless it is already in view.
  const first = locate(targets[0]);
  const [width, height] = await page.evaluate(() => [innerWidth, innerHeight]);
  const box = await first.boundingBox({ timeout: 3000 }).catch(() => null);
  if (!box || box.y < 0 || box.x < 0 || box.y + box.height > height || box.x + box.width > width) {
    await first.evaluate(e => e.scrollIntoView({ block: 'center', inline: 'nearest' })).catch(() => first.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {}));
  }
  const boxes = [];
  for (const t of targets) {
    const box = await locate(t).boundingBox({ timeout: 3000 });
    if (!box) throw new Error('"' + t + '" is not visible.');
    // A block of text is often much wider than its text: mark the text. Measured in the element's frame,
    // shifted by where that frame's box is in the main frame.
    const text = await locate(t).evaluate(e => {
      const style = getComputedStyle(e);
      if (style.display.startsWith('inline') || e.matches('button, input, select, textarea, img, svg, video, canvas, iframe')) return null;
      const r = e.getBoundingClientRect(), range = document.createRange();
      range.selectNodeContents(e);
      const c = range.getBoundingClientRect();
      if (!c.width || !c.height) return null;
      return { x: Math.max(c.x, r.x) - r.x, y: Math.max(c.y, r.y) - r.y, width: Math.min(c.width, r.width), height: Math.min(c.height, r.height) };
    }).catch(() => null);
    boxes.push(text ? { x: box.x + text.x, y: box.y + text.y, width: text.width, height: text.height } : box);
  }
  const cdp = await page.context().newCDPSession(page);
  const { targetInfo } = await cdp.send('Target.getTargetInfo');
  await cdp.detach();
  return { targetId: targetInfo.targetId, boxes };
}`;
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
async function settleTabs(client) {
    const list = async () => resultText(await client.callTool({ name: 'browser_tabs', arguments: { action: 'list' } }));
    let previous = await list();
    for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 250));
        const current = await list();
        if (current === previous)
            break;
        previous = current;
    }
    for (;;) {
        const lines = previous.split('\n').filter(l => /^- \d+:/.test(l));
        const stale = lines.find(l => l.includes(INSTRUCTIONS_FILE));
        if (!stale || lines.length < 2)
            break;
        const index = Number(/^- (\d+):/.exec(stale)[1]);
        await client.callTool({ name: 'browser_tabs', arguments: { action: 'close', index } });
        previous = await list();
    }
    const visible = await client.callTool({ name: 'browser_run_code_unsafe', arguments: { code: VISIBLE_TAB } });
    const index = Number(/### Result\n(-?\d+)/.exec(resultText(visible))?.[1] ?? -1);
    await client.callTool({ name: 'browser_tabs', arguments: { action: 'select', index: Math.max(index, 0) } });
}
function resultText(result) {
    return result.content.map(c => (c.type === 'text' ? c.text : '')).join('\n');
}
function spawnChild(extraArgs, cwd) {
    const args = [PLAYWRIGHT_MCP_CLI, '--browser', 'chrome', ...extraArgs];
    // The SDK's default env is reduced; pass everything through (DISPLAY, proxies…).
    return new StdioClientTransport({ command: process.execPath, args, env: { ...process.env }, cwd, stderr: 'ignore' });
}
/** The current tab is usually one the person left open: Chrome restores their tabs. */
const NAVIGATE_NOTE = ' In cast the current tab is usually one of the person\'s own tabs, and this replaces it. '
    + 'To open a site, select a tab that already shows it (browser_tabs "select") or open a new one (browser_tabs "new" with url); '
    + 'navigate only in a tab you opened or selected for this task.';
function withProfileParam(tool) {
    const schema = tool.inputSchema;
    const required = (schema.required ?? []).filter(r => r !== 'profile');
    return {
        ...tool,
        ...(tool.name === 'browser_navigate' ? { description: (tool.description ?? '') + NAVIGATE_NOTE } : {}),
        inputSchema: {
            ...schema,
            properties: { profile: PROFILE_PARAM, ...(schema.properties ?? {}) },
            required: ['profile', ...required],
        },
    };
}
/**
 * Action tools answer with "[Snapshot](page-….yml)" relative to the child's cwd; make such links
 * absolute so Claude can read the file whatever its own cwd is.
 */
function absoluteLinks(result, cwd) {
    if (!Array.isArray(result.content))
        return result;
    return {
        ...result,
        content: result.content.map(c => c.type !== 'text' ? c : {
            ...c,
            text: c.text.replace(/\]\(([^)\s]+)\)/g, (m, link) => /^[a-z][a-z0-9+.-]*:/i.test(link) || isAbsolute(link) ? m : `](${resolve(cwd, link)})`),
        }),
    };
}
