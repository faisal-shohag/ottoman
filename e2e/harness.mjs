// Shared end-to-end harness: starts the app if needed, connects to its window over CDP, types requests into it
// and waits for checks, answering approval prompts. Used by app.e2e.mjs (browser) and desktop.e2e.mjs (apps).
import { spawn, execSync } from 'node:child_process';

const DEBUG_PORT = 9333; // WebView2 remote debugging port for the app window
export const root = new URL('..', import.meta.url);
const started = [];

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const up = (url) => fetch(url).then(() => true, () => false);

export async function until(what, fn, timeoutMs, everyMs = 1000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(everyMs);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

export function start(cmd, env = {}) {
  const p = spawn(cmd, { cwd: root, shell: true, stdio: 'ignore', env: { ...process.env, ...env } });
  started.push(p);
  return p;
}

/** Starts the app (unless running), connects to its window and waits until it is ready. */
export async function connectApp() {
  const appPage = async () => {
    const list = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`).then((r) => r.json(), () => []);
    return list.find((t) => t.type === 'page' && /localhost:1420|tauri\.localhost/.test(t.url));
  };
  if (!(await appPage())) {
    console.log('Starting app (first build can take a few minutes)…');
    start('pnpm tauri dev', { WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${DEBUG_PORT} --remote-allow-origins=*` });
  }
  const target = await until('app window', appPage, 10 * 60000, 2000);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  let nextId = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    pending.get(m.id)?.(m);
    pending.delete(m.id);
  };
  const send = (method, params = {}) => new Promise((r) => { const id = ++nextId; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;

  const status = () => evaluate(`document.querySelector('.status')?.textContent ?? ''`);
  const transcript = () => evaluate(`[...document.querySelectorAll('.entry')].map((e) => e.className.split(' ')[1] + ': ' + e.textContent).join('\\n')`);
  const entryCount = () => evaluate(`document.querySelectorAll('.entry').length`);

  // Typing happens in the chat sheet; open it first if it is closed.
  async function ask(text) {
    if (!(await evaluate(`!!document.querySelector('input[aria-label=Message]')`))) {
      await evaluate(`document.querySelector('[aria-label="Open chat"]').click()`);
      await until('chat input', () => evaluate(`!!document.querySelector('input[aria-label=Message]')`), 5000, 100);
    }
    await evaluate(`document.querySelector('input[aria-label=Message]').focus()`);
    await send('Input.insertText', { text });
    await evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent === 'Send').click()`);
  }

  /**
   * Sends a request and waits for check() to pass. Answers approval prompts with `approve`.
   * check gets { approvals, asked, said } plus whatever `extra()` returns.
   */
  async function scenario(name, request, check, { approve = true, timeoutMs = 240000, extra = async () => ({}) } = {}) {
    const from = await entryCount();
    let approvals = 0;
    const asked = [];
    console.log(`\n▶ ${name}`);
    await ask(request);
    try {
      await until(name, async () => {
        const prompt = await evaluate(`document.querySelector('.approval [data-slot=card-title]')?.textContent ?? null`);
        if (prompt) {
          approvals++;
          asked.push(prompt);
          console.log(`  approval asked: "${prompt}" -> ${approve ? 'yes' : 'no'}`);
          await evaluate(`[...document.querySelectorAll('.approval button')].find((b) => b.textContent.startsWith(${approve ? "'Yes'" : "'No'"})).click()`);
        }
        const s = await status();
        if (/error|missing|not found|closed/i.test(s)) throw new Error(`App status: ${s}`);
        return check({ approvals, asked, said: (await transcript()).split('\n').slice(from).join('\n'), ...(await extra()) });
      }, timeoutMs, 1500);
      console.log(`PASS ${name} (${approvals} approvals)`);
      return true;
    } catch (e) {
      console.log(`FAIL ${name}: ${e.message}`);
      console.log((await transcript()).split('\n').slice(from).map((l) => `  | ${l}`).join('\n'));
      return false;
    }
  }

  await until('app ready', async () => {
    const s = await status();
    if (/error|missing|not found/i.test(s)) throw new Error(`App failed to start: ${s}`);
    return /Ready|Connected/.test(s);
  }, 120000);

  return { send, evaluate, status, transcript, ask, scenario, close: () => ws.close() };
}

/** Leaves an app the user started running; stops only what this script started. */
export function stopStarted() {
  for (const p of started) {
    try { execSync(`taskkill /T /F /PID ${p.pid}`, { stdio: 'ignore' }); } catch {}
  }
}
