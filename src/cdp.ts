import { createRequire } from 'node:module';

/** The `ws` client Playwright bundles (Node 20 has no WebSocket without a flag). */
interface Socket {
  on(event: 'message', listener: (data: Buffer) => void): void;
  once(event: 'open' | 'error' | 'close', listener: (arg?: unknown) => void): void;
  send(data: string): void;
  close(): void;
}
const WebSocket = (createRequire(import.meta.url)('playwright-core/lib/utilsBundle') as { ws: new (url: string) => Socket }).ws;

export interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

interface Message {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message: string };
  sessionId?: string;
}

/** How long one command may take. */
const STEP_MS = 5000;

/** A browser-level DevTools connection of cast's own, next to Playwright's. Sessions are flat (`flatten: true`). */
export class Cdp {
  private socket?: Socket;
  private nextId = 0;
  private readonly pending = new Map<number, (m: Message) => void>();

  private constructor(private readonly onEvent: (e: CdpEvent) => void) {}

  static async connect(endpoint: string, onEvent: (e: CdpEvent) => void = () => {}): Promise<Cdp> {
    const cdp = new Cdp(onEvent);
    const version = await (await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(STEP_MS) })).json() as { webSocketDebuggerUrl: string };
    const socket = new WebSocket(version.webSocketDebuggerUrl);
    cdp.socket = socket;
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve());
        socket.once('error', e => reject(e));
      });
    } catch (e) {
      cdp.close();
      throw e;
    }
    socket.once('close', () => cdp.close());
    socket.on('message', data => cdp.onMessage(JSON.parse(data.toString()) as Message));
    return cdp;
  }

  get connected(): boolean {
    return !!this.socket;
  }

  close(): void {
    this.socket?.close();
    this.socket = undefined;
    for (const resolve of this.pending.values()) resolve({ error: { message: 'disconnected' } });
    this.pending.clear();
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    const socket = this.socket;
    if (!socket) return Promise.reject(new Error('not connected'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, STEP_MS);
      this.pending.set(id, m => {
        clearTimeout(timer);
        if (m.error) reject(new Error(m.error.message));
        else resolve(m.result ?? {});
      });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  private onMessage(m: Message): void {
    if (m.id !== undefined) {
      this.pending.get(m.id)?.(m);
      this.pending.delete(m.id);
    } else if (m.method) {
      this.onEvent({ method: m.method, params: m.params ?? {}, sessionId: m.sessionId });
    }
  }
}
