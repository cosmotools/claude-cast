import { createRequire } from 'node:module';
const WebSocket = createRequire(import.meta.url)('playwright-core/lib/utilsBundle').ws;
/** How long one command may take. */
const STEP_MS = 5000;
/** A browser-level DevTools connection of cast's own, next to Playwright's. Sessions are flat (`flatten: true`). */
export class Cdp {
    onEvent;
    socket;
    nextId = 0;
    pending = new Map();
    constructor(onEvent) {
        this.onEvent = onEvent;
    }
    static async connect(endpoint, onEvent = () => { }) {
        const cdp = new Cdp(onEvent);
        const version = await (await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(STEP_MS) })).json();
        const socket = new WebSocket(version.webSocketDebuggerUrl);
        cdp.socket = socket;
        try {
            await new Promise((resolve, reject) => {
                socket.once('open', () => resolve());
                socket.once('error', e => reject(e));
            });
        }
        catch (e) {
            cdp.close();
            throw e;
        }
        socket.once('close', () => cdp.close());
        socket.on('message', data => cdp.onMessage(JSON.parse(data.toString())));
        return cdp;
    }
    get connected() {
        return !!this.socket;
    }
    close() {
        this.socket?.close();
        this.socket = undefined;
        for (const resolve of this.pending.values())
            resolve({ error: { message: 'disconnected' } });
        this.pending.clear();
    }
    send(method, params = {}, sessionId) {
        const socket = this.socket;
        if (!socket)
            return Promise.reject(new Error('not connected'));
        const id = ++this.nextId;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`${method} timed out`));
            }, STEP_MS);
            this.pending.set(id, m => {
                clearTimeout(timer);
                if (m.error)
                    reject(new Error(m.error.message));
                else
                    resolve(m.result ?? {});
            });
            socket.send(JSON.stringify({ id, method, params, sessionId }));
        });
    }
    onMessage(m) {
        if (m.id !== undefined) {
            this.pending.get(m.id)?.(m);
            this.pending.delete(m.id);
        }
        else if (m.method) {
            this.onEvent({ method: m.method, params: m.params ?? {}, sessionId: m.sessionId });
        }
    }
}
