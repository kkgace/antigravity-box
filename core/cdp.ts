// Ported from Enzoo404/gravitybox (MIT License) v1.1.2 — https://github.com/Enzoo404/gravitybox
// Windows adaptation: AntigravityBox project.
import { EventEmitter } from 'node:events';
import { bt } from './i18n.js';

export function assertLoopback(raw: string, protocols: string[] = ['ws:']): URL {
  const url = new URL(raw);
  if (!protocols.includes(url.protocol) || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) {
    throw new Error(bt('cdp.loopback_only'));
  }
  return url;
}

export class CDP extends EventEmitter {
  private socket?: WebSocket;
  private sequence = 0;
  private pending = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  constructor(readonly url: string) { super(); assertLoopback(url); }
  async connect(): Promise<void> {
    const socket = this.socket = new WebSocket(this.url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error(bt('cdp.connect_timeout'))); }, 4000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error(bt('cdp.connect_failed'))); }, { once: true });
    });
    socket.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(String(event.data));
        if (typeof message.id === 'number') {
          const waiter = this.pending.get(message.id);
          if (!waiter) return;
          this.pending.delete(message.id); clearTimeout(waiter.timer);
          if (message.error) waiter.reject(new Error(bt('cdp.request_failed', { code: message.error.code })));
          else waiter.resolve(message.result ?? {});
        } else if (message.method) this.emit(message.method, message.params ?? {});
      } catch { this.emit('protocolWarning'); }
    });
    socket.addEventListener('close', () => {
      this.rejectAll(); this.emit('disconnected');
    });
    socket.addEventListener('error', () => this.emit('transportWarning'));
  }
  send(method: string, params: object = {}): Promise<any> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error(bt('cdp.connection_closed')));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(bt('cdp.request_timeout'))); }, 6000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket!.send(JSON.stringify({ id, method, params })); }
      catch { this.pending.delete(id); clearTimeout(timer); reject(new Error(bt('cdp.send_failed'))); }
    });
  }
  async evaluate(expression: string, contextId?: number): Promise<any> {
    const params: Record<string, unknown> = { expression, returnByValue: true, awaitPromise: true };
    if (contextId !== undefined) params.contextId = contextId;
    const result = await this.send('Runtime.evaluate', params);
    if (result.exceptionDetails) throw new Error(bt('cdp.eval_failed'));
    return result.result?.value;
  }
  private rejectAll() {
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error(bt('cdp.connection_closed'))); }
    this.pending.clear();
  }
  close() { this.rejectAll(); this.socket?.close(); this.removeAllListeners(); }
}
