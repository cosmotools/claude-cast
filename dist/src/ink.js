import { readFileSync } from 'node:fs';
import { Cdp } from './cdp.js';
import { inkPage } from './ink-page.js';
/** The isolated world the marks live in; Chrome gives the same world to every request with this name. */
const WORLD = 'cast-ink';
const COLOR = '#e5383b';
const BUTTON = 'Clear marks ✕';
/** How long to wait for a tab brought to the front to be shown. */
const VISIBLE_MS = 2000;
/** Tools that act on the page as the person would: the marks are erased first, so any click on them is the person's. */
const INPUT_TOOLS = new Set([
    'browser_click', 'browser_drag', 'browser_drop', 'browser_type', 'browser_press_key', 'browser_select_option',
    'browser_fill_form', 'browser_file_upload', 'browser_navigate', 'browser_navigate_back', 'browser_handle_dialog',
]);
const ERASED = {
    button: 'The person erased your marks with the "Clear marks" button.',
    click: 'The person erased your marks by clicking the page.',
    escape: 'The person erased your marks with Esc.',
    page: 'Your marks are gone: the page changed (the marked elements are no longer there).',
};
let handwriting;
/** Outlines of only the characters in the notes. */
function fontFor(marks) {
    handwriting ??= JSON.parse(readFileSync(new URL('../../assets/handwriting.json', import.meta.url), 'utf8'));
    const glyphs = {};
    for (const ch of marks.map(m => m.note ?? '').join('')) {
        const g = handwriting.glyphs[ch];
        if (g)
            glyphs[ch] = g;
    }
    return { em: handwriting.em, glyphs };
}
/**
 * Marks Claude draws over a tab of a profile's Chrome to show the person where to look. Drawn by a
 * script in cast's own isolated world (src/ink-page.ts), on a canvas in a closed shadow root: the page
 * sees one empty element while marks are shown and none of cast's code. One set of marks per profile.
 */
export class Ink {
    endpoint;
    cdp;
    /** The tab with marks and cast's session in it. */
    shown;
    constructor(endpoint) {
        this.endpoint = endpoint;
    }
    async draw(targetId, marks) {
        if (this.shown && this.shown.targetId !== targetId)
            await this.erase();
        const cdp = await this.connect();
        const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
        if (this.shown && this.shown.sessionId !== sessionId)
            await cdp.send('Target.detachFromTarget', { sessionId: this.shown.sessionId }).catch(() => { });
        this.shown = { targetId, sessionId };
        // Claude's tab may be behind another one (e.g. after its current tab was closed). Shown first: a hidden
        // tab's renderer runs at background priority on macOS and may not run the script in time.
        await this.front(targetId, sessionId);
        const options = { color: COLOR, button: BUTTON };
        try {
            await this.evaluate(`(${inkPage.toString()})(), window.__castInk.show(${JSON.stringify(marks)}, ${JSON.stringify(fontFor(marks))}, ${JSON.stringify(options)})`);
        }
        catch (e) {
            // E.g. the tab was closed, or a JavaScript dialog keeps the page from running scripts.
            await this.release();
            throw new Error(`Cannot draw on this page: ${e.message.split('\n')[0]}`);
        }
    }
    /** Before a call to the profile: what the person did with the marks, if Claude should know. Erases them before input tools. */
    async before(tool) {
        if (!this.shown)
            return undefined;
        let state;
        try {
            state = await this.evaluate('window.__castInk?.state() ?? null');
        }
        catch {
            state = null;
        }
        if (!state || !state.shown) {
            await this.release();
            return ERASED[state?.erasedBy ?? 'page'];
        }
        if (INPUT_TOOLS.has(tool))
            await this.erase();
        return undefined;
    }
    async erase() {
        if (!this.shown)
            return false;
        const state = await this.evaluate('window.__castInk ? (window.__castInk.erase(), true) : false').catch(() => false);
        await this.release();
        return state === true;
    }
    close() {
        this.cdp?.close();
        this.cdp = undefined;
        this.shown = undefined;
    }
    async release() {
        const shown = this.shown;
        this.shown = undefined;
        if (shown)
            await this.cdp?.send('Target.detachFromTarget', { sessionId: shown.sessionId }).catch(() => { });
    }
    async connect() {
        if (this.cdp?.connected)
            return this.cdp;
        this.cdp = await Cdp.connect(this.endpoint, (e) => {
            if (e.method === 'Target.detachedFromTarget' && e.params.sessionId === this.shown?.sessionId)
                this.shown = undefined;
        });
        return this.cdp;
    }
    /** Evaluates in cast's world of the marked tab's main frame (the frame id of a tab is its target id). */
    async evaluate(expression) {
        const shown = this.shown;
        if (!shown || !this.cdp)
            throw new Error('no marks');
        const { executionContextId } = await this.cdp.send('Page.createIsolatedWorld', { frameId: shown.targetId, worldName: WORLD }, shown.sessionId);
        const r = await this.cdp.send('Runtime.evaluate', { expression, contextId: executionContextId, returnByValue: true }, shown.sessionId);
        if (r.exceptionDetails)
            throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'failed');
        return r.result.value;
    }
    /** The tab in front of its window and the window restored if minimized, so the person sees the marks; waits until the tab is shown. */
    async front(targetId, sessionId) {
        const cdp = this.cdp;
        try {
            const { windowId, bounds } = await cdp.send('Browser.getWindowForTarget', { targetId });
            if (bounds.windowState === 'minimized')
                await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
        }
        catch {
            // Headless Chrome has no windows.
        }
        await cdp.send('Page.bringToFront', {}, sessionId).catch(() => { });
        // Chrome shows the tab a moment later. A window covered or on another Space may stay hidden: draw anyway.
        // A page that does not answer (a dialog) is not waited for longer.
        for (const end = Date.now() + VISIBLE_MS; Date.now() < end; await new Promise(r => setTimeout(r, 50))) {
            const state = await Promise.race([
                this.evaluate('document.visibilityState').catch(() => undefined),
                new Promise(r => setTimeout(() => r(undefined), Math.max(0, end - Date.now())).unref()),
            ]);
            if (state !== 'hidden')
                break;
        }
    }
}
