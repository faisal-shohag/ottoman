// End-to-end test of the real app: types requests into the Ottoman window, lets Gemini drive Chrome
// against the demo site, and checks what the demo site received.
// Needs GEMINI_API_KEY in .env. Run: pnpm e2e   (starts the demo site and the app if they are not running)
import { readFileSync } from 'node:fs';
import { connectApp, root, start, stopStarted, until, up } from './harness.mjs';

const DEMO = 'http://localhost:5555';

// --- Start demo site and app -------------------------------------------------
if (!(await up(`${DEMO}/api/log`))) {
  console.log('Starting demo site…');
  start('node demo/server.mjs');
  await until('demo site', () => up(`${DEMO}/api/log`), 10000, 300);
}
const log = () => fetch(`${DEMO}/api/log`).then((r) => r.json());
let app;

// Each scenario starts with an empty demo log and sees it in check().
const scenario = async (name, request, check, opts = {}) => {
  await fetch(`${DEMO}/api/log`, { method: 'DELETE' });
  return app.scenario(name, request, check, { ...opts, extra: async () => ({ log: await log() }) });
};

// --- Scenarios -----------------------------------------------------------------
let failed = 0;
try {
  app = await connectApp();
  const { evaluate, status } = app;

  const products = JSON.parse(readFileSync(new URL('demo/public/products.json', root)));
  const silentMouse = products.find((p) => p.name === 'Silent Wireless Mouse').id;

  // Needs remote debugging enabled in your Chrome (chrome://inspect/#remote-debugging) and someone to click Allow.
  console.log('If Chrome asks to allow remote debugging, click Allow.');
  // Switch the voice through the settings panel the way a user would, then check the assistant still answers.
  const switchVoice = async (voice) => {
    await evaluate(`document.querySelector('[aria-label=Settings]').click()`);
    await until('settings panel', () => evaluate(`!!document.querySelector('#voice')`), 5000, 200);
    // Radix Select opens on a mouse pointerdown and picks an option on click.
    await evaluate(`document.querySelector('#voice').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }))`);
    const pick = `[...document.querySelectorAll('[role=option]')].find((o) => o.textContent.startsWith(${JSON.stringify(voice + ':')}))`;
    await until('voice option', () => evaluate(`!!${pick}`), 5000, 200);
    await evaluate(`${pick}.click()`);
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
  app?.close();
  stopStarted();
  process.exit(failed ? 1 : 0);
}
