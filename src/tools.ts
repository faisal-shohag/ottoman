// Browser tools exposed to Gemini as function calls, executed over CDP.
import type { FunctionDeclaration } from '@google/genai';
import type { Browser } from './cdp';
import { Pointer } from './pointer';
import { snapshot } from './snapshot';

export interface ToolContext {
  /** Returns the connected browser, starting or attaching to Chrome first; a profile name switches to that profile. */
  getBrowser: (profile?: string) => Promise<Browser>;
  /** Shows the approval prompt; resolves true only on an explicit yes from the user. */
  requestApproval: (summary: string) => Promise<boolean>;
  /** Shows an image to the model. */
  sendImage: (base64: string, mimeType: string) => void;
  /** Saves a PNG to the Ottoman folder (Pictures/Ottoman), optionally copying it to the clipboard. */
  saveImage: (pngBase64: string, name: string | undefined, copy: boolean) => Promise<{ file: string; path: string }>;
  captureDesktop: (name: string | undefined, copy: boolean) => Promise<{ file: string; path: string; png_base64: string }>;
  /** File names in the Ottoman folder, newest first. */
  listSaved: () => Promise<string[]>;
  /** Absolute path of a file in the Ottoman folder; rejects anything outside it. */
  resolveUpload: (file: string) => Promise<string>;
  copyFile: (file: string) => Promise<void>;
  /** Whether to draw Ottoman's cursor, highlight and "working" glow in the page (default true). */
  showCursor?: () => boolean;
}

// Actions that are hard to undo: payments, posting, commenting, sending, deleting. Plain links are never gated.
const RISKY = /\b(submit|send|post|publish|pay|payment|buy|order|checkout|check out|purchase|delete|confirm|place|transfer|sign ?up|subscribe|donate|tip|withdraw|book|reserve|comment|reply|tweet|retweet|repost|share|upload)\b/i;
export const isRisky = (label: string) => RISKY.test(label);

const obj = (properties: object, required: string[] = []) => ({ type: 'object', properties, required });
const ref = { type: 'integer', description: 'Element ref number from the latest snapshot.' };

export const declarations: FunctionDeclaration[] = [
  {
    name: 'open_browser',
    description: "Open the agent's window in the user's Chrome (other browser tools also do this automatically). Pass profile only when the user names a Chrome profile.",
    parametersJsonSchema: obj({ profile: { type: 'string', description: 'Chrome profile name the user said, e.g. "britto" or "Person 1".' } }),
  },
  { name: 'snapshot', description: 'Get the current page as a list of elements with [ref] numbers. Call before acting on a page you have not seen.', parametersJsonSchema: obj({}) },
  { name: 'navigate', description: 'Open a URL in the active tab. Use https://www.google.com/search?q=... for web searches.', parametersJsonSchema: obj({ url: { type: 'string' } }, ['url']) },
  { name: 'go_back', description: 'Go back in history.', parametersJsonSchema: obj({}) },
  {
    name: 'click',
    description: 'Click an element by ref (the pointer glides there first, like a real mouse). Returns the updated snapshot.',
    parametersJsonSchema: obj({
      ref,
      button: { type: 'string', enum: ['left', 'right'], description: 'right opens context menus.' },
      double: { type: 'boolean', description: 'Double-click, e.g. to rename or open an item.' },
    }, ['ref']),
  },
  { name: 'hover', description: 'Move the pointer over an element and rest there, to open hover menus, dropdowns or tooltips. Returns the updated snapshot.', parametersJsonSchema: obj({ ref }, ['ref']) },
  {
    name: 'drag',
    description: 'Press, drag and release: sliders, reordering lists, drop zones. Use from_ref with to_ref (drop onto an element) or with dx/dy (move by pixels, e.g. a slider thumb), or screenshot coordinates from_x, from_y, to_x, to_y.',
    parametersJsonSchema: obj({
      from_ref: ref, to_ref: ref,
      dx: { type: 'number' }, dy: { type: 'number' },
      from_x: { type: 'number' }, from_y: { type: 'number' }, to_x: { type: 'number' }, to_y: { type: 'number' },
    }),
  },
  { name: 'type', description: 'Type text into an input, textarea or rich editor. Replaces existing text unless clear=false.', parametersJsonSchema: obj({ ref, text: { type: 'string' }, clear: { type: 'boolean' }, submit: { type: 'boolean', description: 'Press Enter after typing.' } }, ['ref', 'text']) },
  { name: 'select_option', description: 'Choose option(s) in a native <select> by value or visible text. For custom dropdowns, click them instead.', parametersJsonSchema: obj({ ref, values: { type: 'array', items: { type: 'string' } } }, ['ref', 'values']) },
  { name: 'press_key', description: 'Press a key in the focused element, e.g. Enter, Tab, Escape, ArrowDown, Control+A.', parametersJsonSchema: obj({ key: { type: 'string' } }, ['key']) },
  {
    name: 'scroll',
    description: 'Scroll the page up or down by about one screen. With ref only: scroll that element into view. With ref and direction: scroll inside that element (a feed, chat or side panel with its own scrollbar).',
    parametersJsonSchema: obj({ direction: { type: 'string', enum: ['up', 'down'] }, ref }),
  },
  { name: 'wait', description: 'Wait until text appears on the page, or for a number of seconds.', parametersJsonSchema: obj({ text: { type: 'string' }, seconds: { type: 'number' } }) },
  { name: 'read_page', description: 'Get the visible text of the whole page, for reading or extracting information.', parametersJsonSchema: obj({}) },
  { name: 'screenshot', description: 'See the page as an image. Use when the snapshot is missing something visual (canvas, images, charts).', parametersJsonSchema: obj({}) },
  { name: 'click_at', description: 'Click at pixel coordinates of the latest screenshot. Only for things not in the snapshot.', parametersJsonSchema: obj({ x: { type: 'number' }, y: { type: 'number' } }, ['x', 'y']) },
  {
    name: 'take_screenshot',
    description: 'Take a screenshot for the user and save it to their Ottoman folder (Pictures/Ottoman); optionally copy it to the clipboard. target: page (visible part), full_page, element (needs ref), or desktop (whole screen, any app).',
    parametersJsonSchema: obj({
      target: { type: 'string', enum: ['page', 'full_page', 'element', 'desktop'] },
      ref,
      copy: { type: 'boolean', description: 'Also copy the image to the clipboard.' },
      name: { type: 'string', description: 'File name without extension; default is timestamped.' },
    }),
  },
  { name: 'list_saved', description: 'List files in the Ottoman folder (screenshots and files the user put there), newest first.', parametersJsonSchema: obj({}) },
  {
    name: 'upload_file',
    description: 'Attach a file from the Ottoman folder to the page: pass the ref of the file input or of the attach/upload button. Only files in that folder can be used.',
    parametersJsonSchema: obj({ ref, file: { type: 'string', description: 'File name from list_saved.' } }, ['ref', 'file']),
  },
  {
    name: 'paste_image',
    description: 'Paste an image into a chat box, email body or editor (ref). Uses the newest saved image unless file is given.',
    parametersJsonSchema: obj({ ref, file: { type: 'string' } }, ['ref']),
  },
  { name: 'list_tabs', description: "List all open Chrome tabs, including the user's own.", parametersJsonSchema: obj({}) },
  { name: 'switch_tab', description: "Work in a tab by its index from list_tabs, including one the user opened earlier.", parametersJsonSchema: obj({ index: { type: 'integer' } }, ['index']) },
  { name: 'new_tab', description: 'Open a new tab with a URL and make it active.', parametersJsonSchema: obj({ url: { type: 'string' } }, ['url']) },
  { name: 'close_tab', description: 'Close a tab by index.', parametersJsonSchema: obj({ index: { type: 'integer' } }, ['index']) },
  { name: 'handle_dialog', description: 'Accept or dismiss an open alert/confirm/prompt dialog.', parametersJsonSchema: obj({ accept: { type: 'boolean' }, text: { type: 'string', description: 'Answer for prompt dialogs.' } }, ['accept']) },
  { name: 'confirm_action', description: 'Ask the user to approve an important action BEFORE doing it: payment, order, posting, commenting, replying, sending, publishing, submitting, deleting, subscribing. Include exactly what will be paid or posted (amount, text). Then do that one action right away on the same page.', parametersJsonSchema: obj({ summary: { type: 'string' } }, ['summary']) },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Adds a scheme to bare addresses: http for local hosts, https otherwise. */
export const normalizeUrl = (url: string) =>
  /^(https?|file|about|data|chrome):/i.test(url) ? url : `${/^(localhost|127\.|\d+\.\d+\.\d+\.\d+)/.test(url) ? 'http' : 'https'}://${url}`;
// Text nodes act through their parent element, and labels through the control they label.
const ELEMENT = `let el = this.nodeType === 3 ? this.parentElement : this;
  if (el.tagName === 'LABEL' && el.control) el = el.control;`;

export function createTools(ctx: ToolContext) {
  let browser!: Browser;
  let refs = new Map<number, number>();
  let approval: { until: number; url: string } | null = null;
  let shotScale = 1;

  // Read from the browser, not the page: page scripts hang while a dialog is open.
  const pageUrl = async () =>
    browser ? (await browser.cdp.send('Target.getTargetInfo', { targetId: browser.targetId })).targetInfo.url as string : '';

  /**
   * Guardrail for irreversible actions. Uses the model's confirm_action approval only if it is fresh and was
   * given on this same page; otherwise asks the user directly, naming the real action. Returns null to proceed.
   */
  async function gate(action: string): Promise<string | null> {
    const url = await pageUrl();
    const a = approval;
    approval = null;
    if (a && Date.now() < a.until && a.url === url) return null;
    const where = url.replace(/^https?:\/\//, '').split(/[?#]/)[0];
    if (await ctx.requestApproval(`${action} on ${where}`)) return null;
    return `User declined: ${action}. Not done. Do not retry; ask the user what to do instead.`;
  }

  async function look() {
    const s = await snapshot(browser);
    refs = s.refs;
    return s.text;
  }

  async function call<T = any>(r: number, fn: string, args: unknown[] = []): Promise<T> {
    const backendNodeId = refs.get(r);
    if (backendNodeId === undefined) throw new Error(`Unknown ref ${r}. Take a new snapshot.`);
    const { object } = await browser.send('DOM.resolveNode', { backendNodeId }).catch(() => {
      throw new Error(`Element ${r} is gone (page changed). Take a new snapshot.`);
    });
    const { result, exceptionDetails } = await browser.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: fn,
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  }

  /** Bounding box of an element in main-frame viewport coordinates (what CDP input uses). */
  async function box(r: number) {
    const { quads } = await browser.send('DOM.getContentQuads', { backendNodeId: refs.get(r) });
    if (!quads?.length) throw new Error(`Element ${r} is not visible.`);
    const xs = [quads[0][0], quads[0][2], quads[0][4], quads[0][6]];
    const ys = [quads[0][1], quads[0][3], quads[0][5], quads[0][7]];
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }

  async function center(r: number) {
    const b = await box(r);
    return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  }

  // One human-like pointer per browser connection; it remembers where the cursor is.
  const pointers = new WeakMap<Browser, Pointer>();
  const pointer = () => {
    if (!pointers.has(browser)) pointers.set(browser, new Pointer(browser, () => ctx.showCursor?.() ?? true));
    return pointers.get(browser)!;
  };

  const mouseClick = (x: number, y: number, opts?: Parameters<Pointer['click']>[2]) => pointer().click(x, y, opts);

  /** Lets navigation or re-rendering triggered by an action settle before the next snapshot. */
  async function settle() {
    await sleep(400);
    if (browser.dialog) return;
    const state = await browser.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }, 5000).catch(() => null);
    if (state?.result?.value !== 'complete') await browser.waitForLoad(10000);
  }

  // Cheap fingerprint of the page, to tell whether an action did anything.
  const pageSignature = async () =>
    (await browser.send('Runtime.evaluate', {
      expression: `location.href + '|' + document.body.innerText.length + '|' + document.getElementsByTagName('*').length`,
      returnByValue: true,
    }, 5000).catch(() => null))?.result?.value as string | undefined;

  /** Lets the page settle, then returns the new snapshot. With `before`, also reports when nothing changed. */
  async function after(prefix: string, before?: string) {
    await settle();
    if (browser.dialog) return `${prefix}\nA ${browser.dialog.type} dialog opened: "${browser.dialog.message}". Use handle_dialog.`;
    if (before && !browser.notice) {
      // Single-page apps can take a moment to react; recheck briefly before calling it a no-op.
      let same = true;
      for (let i = 0; i < 4 && same; i++) {
        same = (await pageSignature()) === before;
        if (same) await sleep(500);
      }
      if (same) prefix += ' NOTHING CHANGED on the page after this (same address and content). Do not repeat it; try a different element, read_page, or screenshot to look.';
    }
    return `${prefix}\n${await look()}`;
  }

  const KEYS: Record<string, [string, number, string?]> = {
    Enter: ['Enter', 13, '\r'], Tab: ['Tab', 9], Escape: ['Escape', 27], Backspace: ['Backspace', 8], Delete: ['Delete', 46],
    ArrowUp: ['ArrowUp', 38], ArrowDown: ['ArrowDown', 40], ArrowLeft: ['ArrowLeft', 37], ArrowRight: ['ArrowRight', 39],
    PageUp: ['PageUp', 33], PageDown: ['PageDown', 34], Home: ['Home', 36], End: ['End', 35], Space: [' ', 32, ' '],
  };
  async function pressKey(combo: string) {
    const parts = combo.split('+');
    const key = parts.pop()!;
    const mods = parts.reduce((m, p) => m | ({ Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Shift: 8 }[p] ?? 0), 0);
    const [k, code, text] = KEYS[key] ?? [key, key.toUpperCase().charCodeAt(0), mods & ~8 ? undefined : key];
    const common = { key: k, code: key.length === 1 ? `Key${key.toUpperCase()}` : k, windowsVirtualKeyCode: code, modifiers: mods };
    await browser.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', text, ...common });
    return browser.raceDialog(browser.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common }));
  }

  /**
   * Describes what pressing Enter in the focused field would do, if that is risky: submit a form whose submit
   * button is risky, or send a comment/reply/message box that submits on Enter without a form (common on social sites).
   */
  async function riskyEnter(): Promise<string> {
    const { result } = await browser.send('Runtime.evaluate', {
      expression: `(() => {
        let a = document.activeElement;
        while (a?.shadowRoot?.activeElement || a?.contentDocument?.activeElement) a = a.shadowRoot?.activeElement || a.contentDocument.activeElement;
        if (!a) return null;
        if (a.form && a.tagName !== 'TEXTAREA') {
          const b = a.form.querySelector('button:not([type=button]),input[type=submit]');
          return b ? { kind: 'form', label: (b.innerText || b.value || b.getAttribute('aria-label') || 'Submit').trim() } : null;
        }
        if (a.isContentEditable || a.tagName === 'TEXTAREA' || a.getAttribute('role') === 'textbox') {
          const hint = [a.getAttribute('aria-label'), a.getAttribute('placeholder'), a.dataset?.placeholder, a.closest('[aria-label]')?.getAttribute('aria-label')].filter(Boolean).join(' ');
          return /comment|reply|post|message|tweet|write|chat/i.test(hint) ? { kind: 'box', label: hint.trim().slice(0, 60) } : null;
        }
        return null;
      })()`,
      returnByValue: true,
    });
    const r = result.value as { kind: string; label: string } | null;
    if (!r) return '';
    if (r.kind === 'box') return `Press Enter to send in "${r.label}"`;
    return isRisky(r.label) ? `Press Enter to submit ("${r.label}")` : '';
  }

  const handlers: Record<string, (a: any) => Promise<string>> = {
    open_browser: () => look(),
    snapshot: () => look(),

    async navigate({ url }) {
      const loaded = browser.waitForLoad();
      const { errorText } = await browser.send('Page.navigate', { url: normalizeUrl(url) });
      if (errorText) throw new Error(`Navigation failed: ${errorText}`);
      await loaded;
      return look();
    },

    async go_back() {
      await browser.send('Runtime.evaluate', { expression: 'history.back()' });
      return after('Went back.');
    },

    async click({ ref: r, button = 'left', double = false }) {
      const info = await call<{ label: string; risky: boolean; fx: number; fy: number; blocker: string; overlay: string }>(r, `function (risky) { ${ELEMENT}
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        const target = el.closest('button,a,input,[role=button],[role=link],[role=menuitem]') || el;
        // Walks up through shadow roots too, which Node.contains does not.
        const inside = (n, anc) => { for (; n; n = n.parentNode || n.host) if (n === anc) return true; return false; };
        // elementFromPoint stops at shadow hosts; follow into open shadow roots to the real element.
        const deepHit = (x, y) => {
          let h = el.ownerDocument.elementFromPoint(x, y);
          while (h && h.shadowRoot) { const d = h.shadowRoot.elementFromPoint(x, y); if (!d || d === h) break; h = d; }
          return h;
        };
        const box = el.getBoundingClientRect();
        // Center first, then other spots, for elements partly hidden by a header or a neighbour.
        const spots = [[0.5, 0.5], [0.25, 0.5], [0.75, 0.5], [0.5, 0.25], [0.5, 0.75], [0.15, 0.15], [0.85, 0.85]];
        let pick = null;
        for (const [fx, fy] of spots) {
          const h = deepHit(box.x + box.width * fx, box.y + box.height * fy);
          if (h && (inside(h, el) || inside(h, target))) { pick = [fx, fy]; break; }
        }
        let blocker = '', overlay = '';
        if (!pick) {
          const h = deepHit(box.x + box.width / 2, box.y + box.height / 2);
          const text = h ? (h.innerText || h.getAttribute('aria-label') || h.tagName).trim().slice(0, 80) : '';
          // Only real blockers stop the click: dialogs, popups and fixed or sticky bars. Anything else is usually a
          // transparent link layer over a card, which is exactly what a person would click.
          let real = false;
          for (let n = h; n && n.nodeType === 1; n = n.parentNode?.nodeType === 11 ? n.parentNode.host : n.parentElement) {
            const pos = getComputedStyle(n).position;
            if (n.matches('[role=dialog],[role=alertdialog],[aria-modal=true],dialog') || pos === 'fixed' || pos === 'sticky') { real = true; break; }
          }
          if (real) blocker = text; else overlay = text;
          pick = [0.5, 0.5];
        }
        // Icon-only buttons on social sites carry their meaning in aria-label or title.
        const names = [target.innerText, target.value, target.getAttribute('aria-label'), target.getAttribute('title')].filter(Boolean).map((s) => String(s).trim());
        const re = new RegExp(risky, 'i');
        const label = (names.find((n) => re.test(n)) || names[0] || '').slice(0, 80);
        const isLink = target.tagName === 'A' && target.hasAttribute('href');
        return { label, risky: !isLink && re.test(names.join(' ')), fx: pick[0], fy: pick[1], blocker, overlay };
      }`, [RISKY.source]);
      if (info.blocker) return `Not clicked: element ${r} is covered by "${info.blocker}" (a popup, dialog or fixed bar). Close it or scroll first.\n${await look()}`;
      if (info.risky) {
        const declined = await gate(`Click "${info.label}"`);
        if (declined) return declined;
      }
      const b = await box(r);
      const before = await pageSignature();
      await mouseClick(b.x + b.w * info.fx, b.y + b.h * info.fy, { button, clickCount: double ? 2 : 1, box: b });
      const via = info.overlay ? ` (through "${info.overlay}" layered on top)` : '';
      const kind = double ? 'Double-clicked' : button === 'right' ? 'Right-clicked' : 'Clicked';
      return after(`${kind} "${info.label}"${via}.`, before);
    },

    async hover({ ref: r }) {
      await call(r, `function () { ${ELEMENT} el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); }`);
      const { x, y } = await center(r);
      await pointer().hover(x, y);
      return after(`Hovering over ${r}.`);
    },

    async drag({ from_ref, to_ref, dx, dy, from_x, from_y, to_x, to_y }) {
      let from, to;
      if (from_ref !== undefined) {
        await call(from_ref, `function () { ${ELEMENT} el.scrollIntoView({ block: 'center', behavior: 'instant' }); }`);
        from = await center(from_ref);
        if (to_ref !== undefined) to = await center(to_ref);
        else if (dx !== undefined || dy !== undefined) to = { x: from.x + (dx ?? 0), y: from.y + (dy ?? 0) };
        else throw new Error('drag needs to_ref, or dx/dy, together with from_ref.');
      } else if ([from_x, from_y, to_x, to_y].every((v) => typeof v === 'number')) {
        // Screenshot pixel coordinates, like click_at.
        from = { x: from_x * shotScale, y: from_y * shotScale };
        to = { x: to_x * shotScale, y: to_y * shotScale };
      } else throw new Error('drag needs from_ref (with to_ref or dx/dy), or from_x, from_y, to_x, to_y.');
      const before = await pageSignature();
      await pointer().drag(from, to);
      return after('Dragged.', before);
    },

    async click_at({ x, y }) {
      const [cx, cy] = [x * shotScale, y * shotScale];
      const { result } = await browser.send('Runtime.evaluate', {
        expression: `(() => { const e = document.elementFromPoint(${cx}, ${cy})?.closest('button,a,input,[role=button]') || document.elementFromPoint(${cx}, ${cy});
          return e ? [e.innerText, e.value, e.getAttribute('aria-label'), e.getAttribute('title')].filter(Boolean).join(' ').trim().slice(0, 80) : ''; })()`,
        returnByValue: true,
      });
      if (isRisky(result.value)) {
        const declined = await gate(`Click "${result.value}"`);
        if (declined) return declined;
      }
      await mouseClick(cx, cy);
      return after(`Clicked at ${Math.round(cx)},${Math.round(cy)}.`);
    },

    async type({ ref: r, text, clear = true, submit = false }) {
      const mode = await call<string>(r, `function (text, clear) { ${ELEMENT}
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        // Typing does not work on these input types; set the value the way a picker would.
        // The ref can point into the input's built-in shadow DOM, so walk up to the host <input>.
        let input = el;
        while (input && input.tagName !== 'INPUT') input = input.parentNode || input.host;
        if (input && /^(date|time|datetime-local|month|week|color|range)$/.test(input.type)) {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, text);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          return 'set';
        }
        el.focus();
        let a = document.activeElement;
        while (a && (a.shadowRoot?.activeElement || a.contentDocument?.activeElement)) a = a.shadowRoot?.activeElement || a.contentDocument.activeElement;
        if (a !== el && !el.contains(a)) return 'unfocused';
        if (clear) {
          if (el.select) el.select();
          else { const s = el.ownerDocument.getSelection(); s.removeAllRanges(); const rg = el.ownerDocument.createRange(); rg.selectNodeContents(el); s.addRange(rg); }
        }
        return 'focused';
      }`, [text, clear]);
      if (mode === 'unfocused') {
        // Not focusable by script (e.g. a label or wrapper); a real click usually focuses the right field.
        const { x, y } = await center(r);
        await mouseClick(x, y);
        if (clear) await pressKey('Control+A');
      }
      if (mode !== 'set') {
        if (text) await browser.send('Input.insertText', { text });
        else if (clear) await pressKey('Backspace');
      }
      let note = `Typed into ${r}.`;
      if (submit) {
        const action = await riskyEnter();
        const declined = action ? await gate(action) : null;
        if (declined) return `${note} ${declined}`;
        await pressKey('Enter');
        note += ' Pressed Enter.';
      }
      return after(note);
    },

    async select_option({ ref: r, values }) {
      const picked = await call<string[] | string>(r, `function (values) { ${ELEMENT}
        if (el.tagName !== 'SELECT') return 'not a native select; click it and then click the option';
        const want = values.map((v) => v.toLowerCase().trim());
        const matches = [...el.options].filter((o) => want.includes(o.value.toLowerCase()) || want.includes(o.text.toLowerCase().trim()));
        if (!matches.length) return 'no matching option. Options: ' + [...el.options].map((o) => o.text).join(', ');
        for (const o of el.options) o.selected = el.multiple ? matches.includes(o) : o === matches[0];
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return matches.map((o) => o.text);
      }`, [values]);
      if (typeof picked === 'string') throw new Error(picked);
      return after(`Selected ${picked.join(', ')}.`);
    },

    async press_key({ key }) {
      const action = /^Enter$/i.test(key) ? await riskyEnter() : '';
      if (action) {
        const declined = await gate(action);
        if (declined) return declined;
      }
      await pressKey(key);
      return after(`Pressed ${key}.`);
    },

    async scroll({ direction, ref: r }) {
      const sign = direction === 'up' ? -1 : 1;
      if (r !== undefined && !direction) {
        await call(r, `function () { ${ELEMENT} el.scrollIntoView({ block: 'center', behavior: 'instant' }); }`);
        return after('Scrolled it into view.');
      }
      if (r !== undefined) {
        // Turn the wheel over that element, so its own scroll area (a feed, chat or side panel) moves. The amount
        // follows the nearest scrollable container, so any row inside a panel works as the target.
        const height = await call<number>(r, `function () { ${ELEMENT}
          el.scrollIntoView({ block: 'nearest', behavior: 'instant' });
          for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
            const o = getComputedStyle(n).overflowY;
            if ((o === 'auto' || o === 'scroll') && n.scrollHeight > n.clientHeight) return n.clientHeight;
          }
          return innerHeight;
        }`);
        const b = await box(r);
        await pointer().wheel(b.x + b.w / 2, b.y + Math.min(b.h / 2, 200), sign * 0.8 * height);
      } else {
        const { cssLayoutViewport: v } = await browser.send('Page.getLayoutMetrics');
        await pointer().wheel(v.clientWidth / 2, v.clientHeight / 2, sign * 0.8 * v.clientHeight);
      }
      await sleep(600); // infinite-scroll pages load more after a scroll
      return after('Scrolled.');
    },

    async wait({ text, seconds }) {
      const deadline = Date.now() + Math.min(seconds ?? 10, 30) * 1000;
      if (!text) {
        await sleep(deadline - Date.now());
        return look();
      }
      while (Date.now() < deadline) {
        const { result } = await browser.send('Runtime.evaluate', { expression: `document.body.innerText.includes(${JSON.stringify(text)})`, returnByValue: true });
        if (result.value) return look();
        await sleep(300);
      }
      return `"${text}" did not appear.\n${await look()}`;
    },

    async read_page() {
      const { result } = await browser.send('Runtime.evaluate', {
        expression: `(() => { let t = document.body.innerText; for (const f of document.querySelectorAll('iframe')) { try { t += '\\n[iframe]\\n' + f.contentDocument.body.innerText; } catch {} } return document.title + '\\n' + location.href + '\\n\\n' + t; })()`,
        returnByValue: true,
      });
      const text = String(result.value);
      return text.length > 20000 ? text.slice(0, 20000) + '\n… (truncated)' : text;
    },

    async screenshot() {
      // The drawn cursor is hidden while capturing, so the model sees only the page.
      const [{ data }, { cssLayoutViewport: v }] = await pointer().withHidden(() =>
        Promise.all([browser.send('Page.captureScreenshot', { format: 'jpeg', quality: 60 }), browser.send('Page.getLayoutMetrics')]),
      );
      const img = await createImageBitmap(await (await fetch(`data:image/jpeg;base64,${data}`)).blob());
      shotScale = v.clientWidth / img.width;
      ctx.sendImage(data, 'image/jpeg');
      return `Screenshot sent as an image (${img.width}x${img.height}). For click_at use pixel coordinates in that image.`;
    },

    async take_screenshot({ target = 'page', ref: r, copy = false, name }) {
      if (target === 'desktop') {
        const shot = await ctx.captureDesktop(name, copy);
        ctx.sendImage(shot.png_base64, 'image/png');
        return `Saved desktop screenshot as ${shot.file} (${shot.path})${copy ? ', copied to clipboard' : ''}. The image was sent to you.`;
      }
      const params: Record<string, unknown> = { format: 'png' };
      if (target === 'full_page') {
        const { cssContentSize: c } = await browser.send('Page.getLayoutMetrics');
        Object.assign(params, { captureBeyondViewport: true, clip: { x: 0, y: 0, width: c.width, height: c.height, scale: 1 } });
      } else if (target === 'element') {
        if (r === undefined) throw new Error('target "element" needs a ref.');
        await call(r, `function () { ${ELEMENT} el.scrollIntoView({ block: 'center', behavior: 'instant' }); }`);
        const { model } = await browser.send('DOM.getBoxModel', { backendNodeId: refs.get(r) });
        const [x1, y1, , , x3, y3] = model.border;
        // Box model is relative to the viewport; the clip is in page coordinates.
        const { cssVisualViewport: v } = await browser.send('Page.getLayoutMetrics');
        Object.assign(params, { clip: { x: x1 + v.pageX, y: y1 + v.pageY, width: x3 - x1, height: y3 - y1, scale: 1 } });
      }
      const { data } = await pointer().withHidden(() => browser.send('Page.captureScreenshot', params, 60000));
      const saved = await ctx.saveImage(data, name, copy);
      ctx.sendImage(data, 'image/png');
      return `Saved ${target.replace('_', ' ')} screenshot as ${saved.file} (${saved.path})${copy ? ', copied to clipboard' : ''}. The image was sent to you.`;
    },

    async list_saved() {
      const files = await ctx.listSaved();
      return files.length ? `Files in the Ottoman folder, newest first:\n${files.join('\n')}` : 'The Ottoman folder is empty.';
    },

    async upload_file({ ref: r, file }) {
      const path = await ctx.resolveUpload(file);
      const isInput = await call<boolean>(r, `function () { ${ELEMENT} return el.tagName === 'INPUT' && el.type === 'file'; }`);
      if (isInput) {
        await browser.send('DOM.setFileInputFiles', { files: [path], backendNodeId: refs.get(r) });
        return after(`Attached ${file}.`);
      }
      // An "Attach" button usually opens a hidden file input; catch its chooser instead of showing a dialog.
      await browser.send('Page.setInterceptFileChooserDialog', { enabled: true });
      try {
        const chooser = browser.waitForFileChooser(5000);
        const { x, y } = await center(r);
        await mouseClick(x, y);
        const backendNodeId = await chooser;
        if (!backendNodeId) throw new Error(`Clicking ${r} did not open a file chooser. Pass the ref of the attach button or file input.`);
        await browser.send('DOM.setFileInputFiles', { files: [path], backendNodeId });
      } finally {
        await browser.send('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {});
      }
      return after(`Attached ${file}.`);
    },

    async paste_image({ ref: r, file }) {
      const name = file ?? (await ctx.listSaved())[0];
      if (!name) throw new Error('No saved image to paste. Take a screenshot first.');
      await ctx.copyFile(name);
      await call(r, `function () { ${ELEMENT} el.scrollIntoView({ block: 'center', behavior: 'instant' }); el.focus(); }`);
      const { x, y } = await center(r);
      await mouseClick(x, y);
      const key = { key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 2, commands: ['paste'] };
      await browser.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key });
      await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
      return after(`Pasted ${name}.`);
    },

    async list_tabs() {
      const lines = (await browser.allTabs()).map(
        (t, i) => `${i}: ${t.title || '(untitled)'} ${t.url}  (${t.own ? 'Ottoman' : 'user'})${t.targetId === browser.targetId ? ' (active)' : ''}`,
      );
      return `${lines.join('\n')}\nUse switch_tab to work in any of these, including the user's own tabs.`;
    },

    async switch_tab({ index }) {
      const tab = (await browser.allTabs())[index];
      if (!tab) throw new Error(`No tab ${index}.`);
      await browser.adopt(tab.targetId);
      return look();
    },

    async new_tab({ url }) {
      await browser.newTab(normalizeUrl(url));
      return look();
    },

    async close_tab({ index }) {
      const tabs = await browser.allTabs();
      const tab = tabs[index];
      if (!tab) throw new Error(`No tab ${index}.`);
      // Closing a tab the user opened can lose their work.
      if (!tab.own) {
        const declined = await gate(`Close your tab "${tab.title || tab.url}"`);
        if (declined) return declined;
      }
      await browser.cdp.send('Target.closeTarget', { targetId: tab.targetId });
      if (tab.targetId === browser.targetId) {
        const next = tabs.find((t) => t.own && t.targetId !== tab.targetId);
        if (next) await browser.use(next.targetId);
        else await browser.newTab('about:blank');
      }
      return handlers.list_tabs({});
    },

    async handle_dialog({ accept, text }) {
      const d = browser.dialog;
      if (!d) return 'No dialog is open.';
      if (accept && d.type === 'confirm' && isRisky(d.message)) {
        const declined = await gate(`Accept dialog "${d.message}"`);
        if (declined) return declined;
      }
      await browser.send('Page.handleJavaScriptDialog', { accept, promptText: text });
      browser.dialog = null;
      return after(`Dialog ${accept ? 'accepted' : 'dismissed'}.`);
    },

    async confirm_action({ summary }) {
      const ok = await ctx.requestApproval(summary);
      // Valid once, for a minute, on this page only; anything else makes the tool ask the user again.
      approval = ok ? { until: Date.now() + 60_000, url: await pageUrl() } : null;
      return ok ? 'User approved. Do the action now.' : 'User declined. Do not do it; ask what to do instead.';
    },
  };

  // Page commands hang while a native dialog is open, so only these may run then.
  const DIALOG_SAFE = new Set(['handle_dialog', 'confirm_action', 'list_tabs']);

  // Actions that already failed or changed nothing, keyed by tool + arguments, until something works. Stops the
  // model from clicking the same dead button over and over.
  const fruitless = new Map<string, number>();
  const failed = (r: Record<string, unknown>) =>
    !!r.error || /^(Not clicked|Not done)|NOTHING CHANGED/.test(String(r.output ?? ''));

  return async function run(name: string, args: any): Promise<Record<string, unknown>> {
    const key = `${name}${JSON.stringify(args ?? {})}`;
    if ((fruitless.get(key) ?? 0) >= 2) {
      return {
        error: `Stopped: ${name} with these arguments already failed twice. Do not repeat it. Try something different ` +
          '(another element, read_page, screenshot) or tell the user what you see and ask how to continue.',
      };
    }
    const result = await execute(name, args);
    if (failed(result)) fruitless.set(key, (fruitless.get(key) ?? 0) + 1);
    else if (!['snapshot', 'read_page', 'list_tabs', 'list_saved', 'wait', 'screenshot'].includes(name)) fruitless.clear();
    return result;
  };

  async function execute(name: string, args: any): Promise<Record<string, unknown>> {
    const handler = handlers[name];
    if (!handler) return { error: `Unknown tool ${name}` };
    try {
      // Chrome opens on the first tool that needs it, or reopens if the user closed it.
      const noBrowser = name === 'confirm_action' || name === 'list_saved' || (name === 'take_screenshot' && args?.target === 'desktop');
      if (!noBrowser) browser = await ctx.getBrowser(name === 'open_browser' ? args?.profile : undefined);
      if (browser?.dialog && !DIALOG_SAFE.has(name)) {
        return { error: `A ${browser.dialog.type} dialog is open: "${browser.dialog.message}". Call handle_dialog first.` };
      }
      let output = await handler(args ?? {});
      if (browser?.notice) {
        output = `${browser.notice}\n${output}`;
        browser.notice = '';
      }
      return { output };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }
}
