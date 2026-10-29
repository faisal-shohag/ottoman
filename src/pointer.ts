// A human-like mouse for the agent: it moves along a path before pressing (so hover menus, mouseenter handlers and
// tooltips react, as with a real hand), and draws its own cursor in the page, because CDP input does not move the
// real OS cursor. All input is trusted CDP Input.dispatchMouseEvent.
import type { Browser, Dialog } from './cdp';

export interface Point {
  x: number;
  y: number;
}

/** Points from `from` to `to` (excluding the start), eased in and out; 8 to 20 steps depending on distance. */
export function easedPath(from: Point, to: Point): Point[] {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const steps = Math.min(20, Math.max(8, Math.round(dist / 40)));
  const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
  return Array.from({ length: steps }, (_, i) => {
    const e = ease((i + 1) / steps);
    return { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e };
  });
}

// Injected into the page: one fixed, click-through host with a closed shadow root, so page styles cannot touch it and
// elementFromPoint / real clicks ignore it (pointer-events: none). Idempotent; recreated after navigation.
const ENSURE_OVERLAY = `function () {
  let host = document.getElementById('ottoman-overlay');
  if (host && host.__ottoman) return host.__ottoman;
  host = document.createElement('div');
  host.id = 'ottoman-overlay';
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = \`<style>
    .cur { position: fixed; left: 0; top: 0; width: 24px; height: 24px; transform: translate(-100px, -100px); filter: drop-shadow(0 1px 2px #0007); }
    .rip { position: fixed; width: 30px; height: 30px; margin: -15px 0 0 -15px; border-radius: 50%; border: 3px solid #2563eb; opacity: 0; }
    .rip.go { animation: rip .45s ease-out; }
    @keyframes rip { from { transform: scale(.3); opacity: 1; } to { transform: scale(1.7); opacity: 0; } }
    .hl { position: fixed; border: 2px solid #2563eb; border-radius: 6px; background: #2563eb14; opacity: 0; transition: opacity .2s; }
    .glow { position: fixed; inset: 0; box-shadow: inset 0 0 0 3px #2563eb99, inset 0 0 28px #2563eb55; opacity: 0; transition: opacity .3s; }
    .pill { position: fixed; right: 12px; bottom: 12px; background: #1e3a8a; color: #fff; font: 600 12px system-ui, sans-serif; padding: 6px 12px; border-radius: 14px; opacity: 0; transition: opacity .3s; }
    .on { opacity: 1; }
  </style>
  <div class="glow"></div><div class="hl"></div><div class="rip"></div>
  <svg class="cur" viewBox="0 0 24 24"><path d="M4 2 L4 19 L8.5 14.5 L11.5 21 L14 20 L11 13.5 L17.5 13.5 Z" fill="#2563eb" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>
  <div class="pill">Ottoman is working…</div>\`;
  (document.body || document.documentElement).appendChild(host);
  const $ = (s) => root.querySelector(s);
  let idle;
  host.__ottoman = {
    move(x, y) { $('.cur').style.transform = 'translate(' + (x - 4) + 'px,' + (y - 2) + 'px)'; },
    ripple(x, y) { const e = $('.rip'); e.style.left = x + 'px'; e.style.top = y + 'px'; e.classList.remove('go'); void e.offsetWidth; e.classList.add('go'); },
    highlight(b) {
      const e = $('.hl');
      if (!b) return e.classList.remove('on');
      Object.assign(e.style, { left: b.x - 3 + 'px', top: b.y - 3 + 'px', width: b.w + 6 + 'px', height: b.h + 6 + 'px' });
      e.classList.add('on');
    },
    busy() {
      $('.glow').classList.add('on'); $('.pill').classList.add('on');
      clearTimeout(idle);
      idle = setTimeout(() => { for (const s of ['.glow', '.pill', '.hl']) $(s).classList.remove('on'); }, 1500);
    },
    hide(hidden) { host.style.display = hidden ? 'none' : ''; },
  };
  return host.__ottoman;
}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Pointer {
  private pos: Point | null = null;

  /** @param visible whether to draw the cursor overlay (the movement itself always happens). */
  constructor(private browser: Browser, private visible: () => boolean = () => true) {}

  private overlay(call: string) {
    if (!this.visible()) return Promise.resolve();
    // Never let the overlay break an action (e.g. a page with a strict CSP or mid-navigation).
    return this.browser.send('Runtime.evaluate', { expression: `(${ENSURE_OVERLAY})().${call}` }, 5000).catch(() => {});
  }

  private move(p: Point, buttons = 0) {
    return Promise.all([
      this.browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, buttons, ...(buttons && { button: 'left' }) }),
      this.overlay(`move(${p.x}, ${p.y})`),
    ]);
  }

  /** Glides to (x, y). The first move starts a little up and to the left, like a hand coming in. */
  async moveTo(x: number, y: number, buttons = 0) {
    const from = this.pos ?? { x: Math.max(0, x - 120), y: Math.max(0, y - 80) };
    await this.overlay('busy()');
    for (const p of easedPath(from, { x, y })) {
      await this.move(p, buttons);
      await sleep(12);
    }
    this.pos = { x, y };
  }

  /** Moves to the point and clicks. `box` outlines the target briefly. Returns a dialog if the click opened one. */
  async click(x: number, y: number, opts: { button?: 'left' | 'right'; clickCount?: 1 | 2; box?: { x: number; y: number; w: number; h: number } } = {}): Promise<Dialog | null> {
    const { button = 'left', clickCount = 1, box } = opts;
    if (box) await this.overlay(`highlight(${JSON.stringify(box)})`);
    await this.moveTo(x, y);
    await sleep(60);
    let dialog: Dialog | null = null;
    // A real double-click is two press/release pairs with clickCount 1 then 2.
    for (let n = 1; n <= clickCount && !dialog; n++) {
      await this.browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: n });
      dialog = await this.browser.raceDialog(this.browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: n }));
    }
    if (!dialog) {
      await this.overlay(`ripple(${x}, ${y})`);
      await this.overlay('highlight(null)');
    }
    return dialog;
  }

  /** Moves to the point and rests there so hover menus and tooltips can open. */
  async hover(x: number, y: number) {
    await this.moveTo(x, y);
    await sleep(400);
  }

  /** Presses at `from`, moves to `to` with the button held, and releases: sliders, sortable lists, drop zones. */
  async drag(from: Point, to: Point) {
    await this.moveTo(from.x, from.y);
    await this.browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1 });
    await sleep(80);
    await this.moveTo(to.x, to.y, 1);
    await sleep(80);
    await this.browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1 });
  }

  /** Scrolls the element under (x, y), e.g. an inner panel, by moving there and turning the wheel. */
  async wheel(x: number, y: number, deltaY: number) {
    await this.moveTo(x, y);
    await this.browser.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY });
  }

  /** Runs `fn` with the overlay hidden, so screenshots show only the page. */
  async withHidden<T>(fn: () => Promise<T>): Promise<T> {
    await this.overlay('hide(true)');
    try {
      return await fn();
    } finally {
      await this.overlay('hide(false)');
    }
  }
}
