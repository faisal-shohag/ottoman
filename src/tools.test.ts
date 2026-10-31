import { describe, expect, it } from 'vitest';
import { calculate, createTools, isRisky, isRiskyInApp, normalizeUrl, type ToolContext } from './tools';

describe('isRisky', () => {
  it.each(['Pay now', 'Place order', 'Checkout', 'Post', 'Publish', 'Reply', 'Comment', 'Tweet', 'Repost', 'Share', 'Send message', 'Delete my data', 'Subscribe', 'Donate', 'Withdraw'])(
    'gates "%s"',
    (label) => expect(isRisky(label)).toBe(true),
  );

  it.each(['Search', 'Add to cart', 'Next', 'Sign in', 'Save draft', 'Load more comments?', 'Open'])('allows "%s"', (label) => {
    // "Load more comments?" contains "comments", not the word "comment".
    expect(isRisky(label)).toBe(false);
  });
});

describe('normalizeUrl', () => {
  it('adds http for local hosts and https otherwise', () => {
    expect(normalizeUrl('localhost:5555/shop.html')).toBe('http://localhost:5555/shop.html');
    expect(normalizeUrl('127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
    expect(normalizeUrl('example.com')).toBe('https://example.com');
    expect(normalizeUrl('https://x.dev/a')).toBe('https://x.dev/a');
  });
});

describe('stop', () => {
  it('refuses every tool after Stop until the next request', async () => {
    let calls = 0;
    const run = createTools({ listSaved: async () => (calls++, ['a.png']) } as unknown as ToolContext);
    expect((await run('list_saved', {})).error).toBeUndefined();
    run.stop();
    expect(String((await run('list_saved', {})).error)).toMatch(/^Stopped by the user/);
    run.reset();
    expect((await run('list_saved', {})).error).toBeUndefined();
    expect(calls).toBe(2);
  });
});

describe('isRiskyInApp', () => {
  it.each(["Don't save", 'Don’t save', 'Discard changes', 'Uninstall', 'Empty Recycle Bin', 'Sign out', 'Shut down', 'Send'])('gates "%s"', (label) =>
    expect(isRiskyInApp(label)).toBe(true),
  );
  it.each(['Save', 'Replace', 'Equals', 'Plus', 'File', 'Text editor', 'Format painter?'])('allows "%s"', (label) => {
    // "Format painter?" still says "format"; listed to document that formatting-like labels are gated.
    expect(isRiskyInApp(label)).toBe(label.startsWith('Format'));
  });
});

describe('desktop app gate', () => {
  const notepad = { window: 'Notepad', hwnd: 7, text: `Window "Notepad":\n[1] button "Don't save"\n[2] button "Save"`, labels: { 1: "Don't save", 2: 'Save' } };
  const setup = (answers: boolean[], snap = notepad, focused = { name: '', text_entry: false }) => {
    const calls: string[] = [];
    const asked: string[] = [];
    const run = createTools({
      desktop: async (command: string) => (calls.push(command), command === 'app_focused' ? focused : snap),
      requestApproval: async (summary: string) => (asked.push(summary), answers.shift() ?? false),
    } as unknown as ToolContext);
    return { run, calls, asked };
  };

  it(`asks before "Don't save" and does nothing when declined`, async () => {
    const { run, calls, asked } = setup([false]);
    await run('app_snapshot', { window: 'Notepad' });
    expect(String((await run('app_click', { ref: 1 })).output)).toMatch(/^User declined/);
    expect(asked).toEqual([`Click "Don't save" in Notepad`]);
    expect(calls).toEqual(['app_snapshot']);
  });

  it('clicks safe controls without asking', async () => {
    const { run, calls, asked } = setup([]);
    await run('app_snapshot', { window: 'Notepad' });
    await run('app_click', { ref: 2 });
    expect(asked).toEqual([]);
    expect(calls).toEqual(['app_snapshot', 'app_click']);
  });

  it('a confirm_action approval in the same app window covers the next risky click', async () => {
    const { run, calls, asked } = setup([true]);
    await run('app_snapshot', { window: 'Notepad' });
    await run('confirm_action', { summary: 'Close Notepad without saving' });
    await run('app_click', { ref: 1 });
    expect(asked).toEqual(['Close Notepad without saving']);
    expect(calls).toEqual(['app_snapshot', 'app_click']);
  });

  it('gates Enter in a message box when the window can send', async () => {
    const chat = { window: 'Chat', hwnd: 8, text: `Window "Chat":\n[1] edit "Message"\n[2] button "Send"`, labels: { 1: 'Message', 2: 'Send' } };
    const { run, calls, asked } = setup([false], chat, { name: 'Message', text_entry: true });
    await run('app_snapshot', { window: 'Chat' });
    await run('app_type', { ref: 1, text: 'hi', submit: true });
    expect(asked).toEqual(['Press Enter to send (the window has a "Send" button) in Chat']);
    expect(calls).toEqual(['app_snapshot', 'app_focused']);
  });

  it('does not gate Enter outside text boxes (File Explorer has a Share button)', async () => {
    const explorer = { window: 'Pictures', hwnd: 9, text: `Window "Pictures":\n[1] list item "New folder"\n[2] button "Share"`, labels: { 1: 'New folder', 2: 'Share' } };
    const { run, calls, asked } = setup([], explorer, { name: 'New folder', text_entry: false });
    await run('app_snapshot', { window: 'Pictures' });
    await run('app_key', { key: 'Enter' });
    expect(asked).toEqual([]);
    expect(calls).toEqual(['app_snapshot', 'app_focused', 'app_key']);
  });

  it('gates Shift+Delete', async () => {
    const { run, calls, asked } = setup([false]);
    await run('app_snapshot', { window: 'Notepad' });
    await run('app_key', { key: 'Shift+Delete' });
    expect(asked).toHaveLength(1);
    expect(calls).toEqual(['app_snapshot']);
  });
});

describe('calculate', () => {
  it.each([
    ['5 + 5', 10],
    ['12 * 3 + 4', 40],
    ['(12*3+4)/8', 5],
    ['100 ÷ 8', 12.5],
    ['7 × 6', 42],
    ['2 ^ 10', 1024],
    ['2 ** 3 ** 2', 512],
    ['-3 + 1', -2],
    ['sqrt(144)', 12],
    ['0.1 + 0.2', 0.3],
    ['1,250 * 2', 2500],
    ['10 % 4', 2],
  ])('%s = %d', (expression, want) => expect(calculate(expression)).toBe(want));

  it.each(['5 / 0', '2 +', 'alert(1)', '(1 + 2', '3 3'])('rejects "%s"', (expression) => expect(() => calculate(expression)).toThrow());

  it('runs without opening the browser', async () => {
    const run = createTools({ getBrowser: () => Promise.reject(new Error('browser opened')) } as unknown as ToolContext);
    expect((await run('calculate', { expression: '5 + 5' })).output).toBe('5 + 5 = 10');
  });
});
