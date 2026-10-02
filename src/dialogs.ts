import { Cdp, type CdpEvent } from './cdp.js';

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
  private cdp?: Cdp;
  private readonly sessions = new Set<string>();
  /** Targets attached once; Target.setDiscoverTargets also reports the existing ones. */
  private readonly targets = new Set<string>();

  static async start(endpoint: string): Promise<DialogGuard> {
    const guard = new DialogGuard();
    try {
      await guard.connect(endpoint);
    } catch {
      guard.stop();
    }
    return guard;
  }

  private async connect(endpoint: string): Promise<void> {
    this.cdp = await Cdp.connect(endpoint, e => this.onEvent(e));
    // Tabs that Chrome is still restoring are attached as they appear.
    await this.send('Target.setDiscoverTargets', { discover: true });
    const { targetInfos } = await this.send('Target.getTargets') as { targetInfos: { targetId: string; type: string }[] };
    await Promise.all(targetInfos.filter(t => t.type === 'page').map(t => this.watch(t.targetId)));
  }

  stop(): void {
    this.cdp?.close();
  }

  private async watch(targetId: string): Promise<void> {
    if (this.targets.has(targetId)) return;
    this.targets.add(targetId);
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true }) as { sessionId: string };
    this.sessions.add(sessionId);
    // Page.enable reports dialogs that open from now on; a page already blocked answers nothing.
    this.send('Page.enable', {}, sessionId).catch(() => {});
    if (await this.responds(sessionId)) return;
    await this.send('Page.reload', {}, sessionId);
  }

  private async responds(sessionId: string): Promise<boolean> {
    const probe = this.send('Runtime.evaluate', { expression: '0' }, sessionId).then(() => true, () => true);
    return Promise.race([probe, new Promise<boolean>(r => setTimeout(() => r(false), PROBE_MS))]);
  }

  private onEvent(e: CdpEvent): void {
    if (e.method === 'Target.targetCreated') {
      const info = e.params.targetInfo as { targetId: string; type: string };
      if (info.type === 'page') this.watch(info.targetId).catch(() => {});
    } else if (e.method === 'Page.javascriptDialogOpening' && e.sessionId && this.sessions.has(e.sessionId)) {
      this.send('Page.handleJavaScriptDialog', { accept: e.params.type === 'alert' }, e.sessionId).catch(() => {});
    }
  }

  private send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    return this.cdp ? this.cdp.send(method, params, sessionId) : Promise.reject(new Error('not connected'));
  }
}
