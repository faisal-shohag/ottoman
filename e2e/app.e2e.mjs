// End-to-end test of the real app: types requests into the Ottoman window, lets Gemini drive Chrome
// against the demo site, and checks what the demo site received.
// Needs GEMINI_API_KEY in .env. Run: pnpm e2e   (starts the demo site and the app if they are not running)
import { spawn, execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const DEMO = 'http://localhost:5555';
const DEBUG_PORT = 9333; // WebView2 remote debugging port for the app window
const root = new URL('..', import.meta.url);
const started = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const up = (url) => fetch(url).then(() => true, () => false);

async function until(what, fn, timeoutMs, everyMs = 1000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(everyMs);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

function start(cmd, env = {}) {
  const p = spawn(cmd, { cwd: root, shell: true, stdio: 'ignore', env: { ...process.env, ...env } });
  started.push(p);
  return p;
}

// --- Start demo site and app -------------------------------------------------
if (!(await up(`${DEMO}/api/log`))) {
  console.log('Starting demo site…');
  start('node demo/server.mjs');
  await until('demo site', () => up(`${DEMO}/api/log`), 10000, 300);
}
const appPage = async () => {
  const list = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`).then((r) => r.json(), () => []);
  return list.find((t) => t.type === 'page' && /localhost:1420|tauri\.localhost/.test(t.url));
};
if (!(await appPage())) {
  console.log('Starting app (first build can take a few minutes)…');
  start('pnpm tauri dev', { WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${DEBUG_PORT} --remote-allow-origins=*` });
}
const target = await until('app window', appPage, 10 * 60000, 2000);

// --- CDP connection to the app window ------------------------------------------
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
const log = () => fetch(`${DEMO}/api/log`).then((r) => r.json());

async function ask(text) {
  await evaluate(`document.querySelector('footer input').focus()`);
  await send('Input.insertText', { text });
  await evaluate(`[...document.querySelectorAll('footer button')].find((b) => b.textContent === 'Send').click()`);
}

/**
 * Sends a request and waits for check() to pass. Answers approval prompts with `approve`.
 * Returns the number of approval prompts seen.
 */
async function scenario(name, request, check, { approve = true, timeoutMs = 240000 } = {}) {
  await fetch(`${DEMO}/api/log`, { method: 'DELETE' });
  const from = await entryCount();
  let approvals = 0;
  console.log(`\n▶ ${name}`);
  await ask(request);
  try {
    await until(name, async () => {
      const prompt = await evaluate(`document.querySelector('.approval p')?.textContent ?? null`);
      if (prompt) {
        approvals++;
        console.log(`  approval asked: "${prompt}" -> ${approve ? 'yes' : 'no'}`);
        await evaluate(`[...document.querySelectorAll('.approval button')].find((b) => b.textContent.startsWith(${approve ? "'Yes'" : "'No'"})).click()`);
      }
      const s = await status();
      if (/error|missing|not found|closed/i.test(s)) throw new Error(`App status: ${s}`);
      return check({ approvals, log: await log(), said: (await transcript()).split('\n').slice(from).join('\n') });
    }, timeoutMs, 1500);
    console.log(`PASS ${name} (${approvals} approvals)`);
    return true;
  } catch (e) {
    console.log(`FAIL ${name}: ${e.message}`);
    console.log((await transcript()).split('\n').slice(from).map((l) => `  | ${l}`).join('\n'));
    return false;
  }
}

// --- Scenarios -----------------------------------------------------------------
let failed = 0;
try {
  await until('app ready', async () => {
    const s = await status();
    if (/error|missing|not found/i.test(s)) throw new Error(`App failed to start: ${s}`);
    return /Ready|Connected/.test(s);
  }, 120000);

  const products = JSON.parse(readFileSync(new URL('demo/public/products.json', root)));
  const silentMouse = products.find((p) => p.name === 'Silent Wireless Mouse').id;

  // Needs remote debugging enabled in your Chrome (chrome://inspect/#remote-debugging) and someone to click Allow.
  console.log('If Chrome asks to allow remote debugging, click Allow.');
  // Switch the voice through the settings panel the way a user would, then check the assistant still answers.
  const switchVoice = async (voice) => {
    await evaluate(`document.querySelector('[aria-label=Settings]').click()`);
    await until('settings panel', () => evaluate(`!!document.querySelector('#voice')`), 5000, 200);
    // React listens for the native value setter + change event.
    await evaluate(`(() => { const s = document.querySelector('#voice');
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, ${JSON.stringify(voice)});
      s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await evaluate(`document.querySelector('[aria-label=Settings]').click()`);
  };

  const results = [
    await (async () => {
      await switchVoice('Sulafat');
      const switched = /Switched to .* · Sulafat/.test(await status());
      if (!switched) console.log(`  status after switch: ${await status()}`);
      return switched && scenario('voice switch then reply', 'Say hello in one short sentence.', ({ said }) => /assistant: \S/.test(said), { timeoutMs: 60000 });
    })(),
    await scenario('open browser on request', 'Open Chrome.', async () => /Chrome connected/.test(await status()), { timeoutMs: 90000 }),
    await scenario(
      'fill and send contact form',
      `Open ${DEMO}/forms.html. Fill full name "Test Agent", email test@agent.dev, country Bangladesh, message "End to end test", accept the terms, then send the form.`,
      ({ approvals, log }) => {
        const d = log.find((e) => e.form === 'contact')?.data;
        return approvals >= 1 && d?.name === 'Test Agent' && d.email === 'test@agent.dev' && d.country === 'bd' && /End to end test/.test(d.message);
      },
    ),
    await scenario(
      'search product and check out',
      `On ${DEMO}/shop.html find the cheapest wireless mouse under 30 dollars, add it to the cart, open the cart and pay with name "Test Agent", email t@agent.dev, card 4242424242424242, expiry 12/30, CVC 123.`,
      ({ approvals, log }) => approvals >= 1 && log.some((e) => e.form === 'checkout' && e.data.items?.some((i) => i.id === silentMouse)),
    ),
    await scenario(
      'extract information',
      `Go to ${DEMO}/data.html and tell me the email address of Northwind Supply.`,
      ({ said }) => /hello\s*(at|@)\s*northwind/i.test(said),
      { timeoutMs: 120000 },
    ),
    await scenario(
      'declined approval does not publish',
      `Go to ${DEMO}/post.html and publish a post titled "Should not publish" with body "test".`,
      ({ approvals, log }) => approvals >= 1 && !log.some((e) => e.form === 'post'),
      { approve: false, timeoutMs: 180000 },
    ),
  ];
  failed = results.filter((r) => !r).length;
} catch (e) {
  failed++;
  console.log(`ERROR ${e.message}`);
} finally {
  console.log(`\n${failed ? `${failed} FAILED` : 'ALL PASSED'}`);
  ws.close();
  // Leave an app the user started running; stop only what this script started.
  for (const p of started) {
    try { execSync(`taskkill /T /F /PID ${p.pid}`, { stdio: 'ignore' }); } catch {}
  }
  process.exit(failed ? 1 : 0);
}
