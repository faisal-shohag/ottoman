// Minimal Chrome DevTools Protocol client over one browser-level WebSocket, using flat sessions per tab.
type Handler = (params: any, sessionId?: string) => void;

export interface Socket {
  send(text: string): void;
  close(): void;
}
/** Opens a text WebSocket. Swappable because Chrome rejects sockets that carry a browser page's Origin header. */
export type OpenSocket = (url: string, onMessage: (text: string) => void, onClose: () => void) => Promise<Socket>;

/** The standard WebSocket; fine in Node and for Chrome started with --remote-allow-origins. */
export const nativeSocket: OpenSocket = (url, onMessage, onClose) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error(`Cannot connect to Chrome at ${url}`));
    ws.onmessage = (e) => onMessage(e.data);
    ws.onclose = onClose;
  });

export class CDP {
  private ws!: Socket;
  private id = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; method: string }>();
  private handlers = new Map<string, Set<Handler>>();
  onclose?: () => void;

  constructor(private open: OpenSocket = nativeSocket) {}

  async connect(url: string) {
    this.ws = await this.open(
      url,
      (text) => {
        const msg = JSON.parse(text);
        if (msg.id !== undefined) {
          const p = this.pending.get(msg.id);
          if (!p) return;
          this.pending.delete(msg.id);
          msg.error ? p.reject(new Error(`${p.method}: ${msg.error.message}`)) : p.resolve(msg.result);
        } else {
          this.handlers.get(msg.method)?.forEach((h) => h(msg.params, msg.sessionId));
        }
      },
      () => {
        for (const p of this.pending.values()) p.reject(new Error('Chrome connection closed'));
        this.pending.clear();
        this.onclose?.();
      },
    );
  }

  send<T = any>(method: string, params: object = {}, sessionId?: string, timeoutMs = 30000): Promise<T> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  close() {
    this.ws?.close();
  }

  on(method: string, handler: Handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, new Set());
    this.handlers.get(method)!.add(handler);
    return () => this.handlers.get(method)!.delete(handler);
  }
}

export interface Tab {
  targetId: string;
  title: string;
  url: string;
}

export interface Dialog {
  type: string;
  message: string;
}

/** Opens `about:blank#ottoman-<nonce>` as a new tab; the Browser then finds it by that URL. */
export type OpenTab = (nonce: string) => Promise<void>;

/**
 * Tracks the user's Chrome tabs and the one the agent is working in. Tabs the agent opened (or was told to use)
 * are its own; the user's other tabs are only listed until the agent switches to one.
 */
export class Browser {
  cdp: CDP;
  private openTab: OpenTab;
  /**
   * @param openTab how to open a tab. The app launches chrome.exe with the profile so the tab lands in that
   *   profile's existing window (CDP cannot choose a window); the default uses CDP, for tests.
   */
  constructor(open?: OpenSocket, openTab?: OpenTab) {
    this.cdp = new CDP(open);
    this.openTab = openTab ?? (async (nonce) => void (await this.cdp.send('Target.createTarget', { url: `about:blank#ottoman-${nonce}` })));
  }
  sessionId = '';
  targetId = '';
  dialog: Dialog | null = null;
  private own = new Set<string>();
  private sessions = new Map<string, string>(); // targetId -> sessionId
  private dialogWaiters = new Set<(d: Dialog) => void>();
  private loadWaiters = new Set<() => void>();
  private chooserWaiters = new Set<(backendNodeId: number) => void>();
  /** Set when a link opened a new tab and the agent was moved to it. */
  notice = '';

  /** @param nonce set when the agent's first tab was already opened at `about:blank#ottoman-<nonce>`. */
  async connect(wsUrl: string, nonce?: string) {
    await this.cdp.connect(wsUrl);
    this.cdp.on('Page.javascriptDialogOpening', (p, sid) => {
      if (sid !== this.sessionId) return;
      this.dialog = { type: p.type, message: p.message };
      this.dialogWaiters.forEach((w) => w(this.dialog!));
    });
    this.cdp.on('Page.javascriptDialogClosed', (_p, sid) => sid === this.sessionId && (this.dialog = null));
    this.cdp.on('Page.loadEventFired', (_p, sid) => sid === this.sessionId && this.loadWaiters.forEach((w) => w()));
    this.cdp.on('Target.targetDestroyed', (p) => {
      this.sessions.delete(p.targetId);
      this.own.delete(p.targetId);
    });
    // Follow tabs opened by the page we are driving (target=_blank, window.open).
    this.cdp.on('Target.targetCreated', async ({ targetInfo: t }) => {
      if (t.type === 'page' && t.openerId && t.openerId === this.targetId) {
        this.own.add(t.targetId);
        await this.use(t.targetId);
        this.notice = `A new tab opened (${t.url}) and is now the active tab.`;
      }
    });
    this.cdp.on('Page.fileChooserOpened', (p, sid) => sid === this.sessionId && this.chooserWaiters.forEach((w) => w(p.backendNodeId)));
    // Debugging can be cancelled from Chrome's banner; forget the session so the next command re-attaches.
    this.cdp.on('Target.detachedFromTarget', (p) => {
      for (const [targetId, sid] of this.sessions) if (sid === p.sessionId) this.sessions.delete(targetId);
    });
    // Chrome may first ask the user to Allow this connection, so give the first command time.
    await this.cdp.send('Target.setDiscoverTargets', { discover: true }, undefined, 90000);
    if (nonce) await this.adopt(await this.waitForNonce(nonce));
    else await this.ensureWindow();
  }

  private async waitForNonce(nonce: string) {
    const start = Date.now();
    while (Date.now() - start < 10000) {
      const { targetInfos } = await this.cdp.send('Target.getTargets');
      const t = targetInfos.find((t: any) => t.type === 'page' && t.url.includes(`#ottoman-${nonce}`));
      if (t) return t.targetId as string;
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error('Chrome did not open the new tab.');
  }

  private async openOwnTab() {
    const nonce = Math.random().toString(36).slice(2);
    await this.openTab(nonce);
    await this.adopt(await this.waitForNonce(nonce));
  }

  /** Makes a tab the agent's own (including one the user opened earlier) and switches to it. */
  async adopt(targetId: string) {
    this.own.add(targetId);
    await this.use(targetId);
  }

  /** Opens a new agent tab if the user closed all of the agent's tabs. */
  async ensureWindow() {
    if ((await this.tabs()).length) return;
    await this.openOwnTab();
  }

  /** Opens a new agent tab, in the profile's existing window, and loads `url` in it. */
  async newTab(url: string) {
    await this.openOwnTab();
    const loaded = this.waitForLoad(10000);
    await this.send('Page.navigate', { url });
    await loaded;
  }

  /** The agent's own tabs. */
  async tabs(): Promise<Tab[]> {
    return (await this.allTabs()).filter((t) => t.own);
  }

  /** Every normal tab in Chrome, the user's included. */
  async allTabs(): Promise<(Tab & { own: boolean })[]> {
    const { targetInfos } = await this.cdp.send('Target.getTargets');
    return targetInfos
      .filter((t: any) => t.type === 'page' && !/^(devtools:|chrome:\/\/inspect)/.test(t.url))
      .map((t: any) => ({ targetId: t.targetId, title: t.title, url: t.url, own: this.own.has(t.targetId) }));
  }

  /** Resolves with the file input's backendNodeId when the page opens a file chooser (needs interception on). */
  waitForFileChooser(timeoutMs: number) {
    return new Promise<number | null>((resolve) => {
      const done = (id: number | null) => {
        clearTimeout(timer);
        this.chooserWaiters.delete(done);
        resolve(id);
      };
      const timer = setTimeout(() => done(null), timeoutMs);
      this.chooserWaiters.add(done);
    });
  }

  async use(targetId: string) {
    let sid = this.sessions.get(targetId);
    if (!sid) {
      ({ sessionId: sid } = await this.cdp.send('Target.attachToTarget', { targetId, flatten: true }));
      this.sessions.set(targetId, sid!);
      await Promise.all(['Page.enable', 'DOM.enable', 'Runtime.enable', 'Accessibility.enable'].map((m) => this.cdp.send(m, {}, sid)));
    }
    this.targetId = targetId;
    this.sessionId = sid!;
    this.dialog = null;
    await this.cdp.send('Target.activateTarget', { targetId });
  }

  /** Send a command to the active tab, re-attaching first if its session was dropped. */
  async send<T = any>(method: string, params: object = {}, timeoutMs?: number) {
    if (this.targetId && !this.sessions.has(this.targetId)) await this.use(this.targetId);
    return this.cdp.send<T>(method, params, this.sessionId, timeoutMs);
  }

  /** Resolves on the next load event, or after timeoutMs. */
  waitForLoad(timeoutMs = 15000) {
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.loadWaiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      this.loadWaiters.add(done);
    });
  }

  /**
   * Runs an input action that may open a native dialog. Chrome blocks the input call until the
   * dialog is handled, so this returns as soon as a dialog appears instead of hanging.
   */
  async raceDialog(action: Promise<unknown>): Promise<Dialog | null> {
    let stop!: () => void;
    const dialog = new Promise<Dialog>((resolve) => {
      this.dialogWaiters.add(resolve);
      stop = () => this.dialogWaiters.delete(resolve);
    });
    try {
      return await Promise.race([action.then(() => null), dialog]);
    } finally {
      stop();
    }
  }
}
