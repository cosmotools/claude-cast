import { Cdp } from './cdp.js';
/** How long a page may take to answer before it counts as blocked by a dialog. */
const PROBE_MS = 1000;
/**
 * Closes JavaScript dialogs in Chrome's tabs while Playwright MCP attaches. A restored tab whose page
 * opens alert() or confirm() as it loads blocks its renderer, and Playwright waits for every page
 * when it attaches, so the profile never opened. Such a dialog opened before any debugger listened and
 * cannot be closed through CDP ("No dialog is showing"); reloading the tab from the browser closes it,
 * and the dialog the reload brings is reported to this session and answered: an alert is accepted,
 * confirm() and prompt() are cancelled. Dialogs that open until `stop()` are answered the same way.
 * Best effort: any failure leaves the tabs as they are.
 */
export class DialogGuard {
    cdp;
    sessions = new Set();
    /** Targets attached once; Target.setDiscoverTargets also reports the existing ones. */
    targets = new Set();
    static async start(endpoint) {
        const guard = new DialogGuard();
        try {
            await guard.connect(endpoint);
        }
        catch {
            guard.stop();
        }
        return guard;
    }
    async connect(endpoint) {
        this.cdp = await Cdp.connect(endpoint, e => this.onEvent(e));
        // Tabs that Chrome is still restoring are attached as they appear.
        await this.send('Target.setDiscoverTargets', { discover: true });
        const { targetInfos } = await this.send('Target.getTargets');
        await Promise.all(targetInfos.filter(t => t.type === 'page').map(t => this.watch(t.targetId)));
    }
    stop() {
        this.cdp?.close();
    }
    async watch(targetId) {
        if (this.targets.has(targetId))
            return;
        this.targets.add(targetId);
        const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
        this.sessions.add(sessionId);
        // Page.enable reports dialogs that open from now on; a page already blocked answers nothing.
        this.send('Page.enable', {}, sessionId).catch(() => { });
        if (await this.responds(sessionId))
            return;
        await this.send('Page.reload', {}, sessionId);
    }
    async responds(sessionId) {
        const probe = this.send('Runtime.evaluate', { expression: '0' }, sessionId).then(() => true, () => true);
        return Promise.race([probe, new Promise(r => setTimeout(() => r(false), PROBE_MS))]);
    }
    onEvent(e) {
        if (e.method === 'Target.targetCreated') {
            const info = e.params.targetInfo;
            if (info.type === 'page')
                this.watch(info.targetId).catch(() => { });
        }
        else if (e.method === 'Page.javascriptDialogOpening' && e.sessionId && this.sessions.has(e.sessionId)) {
            this.send('Page.handleJavaScriptDialog', { accept: e.params.type === 'alert' }, e.sessionId).catch(() => { });
        }
    }
    send(method, params = {}, sessionId) {
        return this.cdp ? this.cdp.send(method, params, sessionId) : Promise.reject(new Error('not connected'));
    }
}
