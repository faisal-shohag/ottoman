import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useEffect, useRef, useState } from 'react';
import { Browser } from './cdp';
import { Assistant, type Settings } from './live';
import { DEFAULT_MODEL, FALLBACK_MODELS, listLiveModels, type LiveModel } from './models';
import { tauriSocket } from './tauriSocket';
import { createTools } from './tools';
import { DEFAULT_VOICE, VOICES } from './voices';

interface Entry {
  role: 'user' | 'assistant' | 'tool';
  text: string;
  open: boolean; // still receiving transcript chunks
}

const SETTINGS_KEY = 'ottoman.settings';
const EXAMPLES = ['Find me a wireless mouse under $30', 'Take a screenshot of my desktop and copy it', 'What tabs do I have open?'];

// Storage can be unavailable or hold stale data; settings then fall back to defaults.
function loadSettings(defaultModel: string): Settings {
  const defaults = { model: defaultModel, voice: DEFAULT_VOICE, userName: '', showCursor: true };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') };
  } catch {
    return defaults;
  }
}
function saveSettings(s: Settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // Not saved; the choice still applies for this run.
  }
}

export default function App() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [status, setStatus] = useState('Starting…');
  const [micOn, setMicOn] = useState(false);
  const [approval, setApproval] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [models, setModels] = useState<LiveModel[]>(FALLBACK_MODELS);
  const [showSettings, setShowSettings] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const assistant = useRef<Assistant>(null);
  const showCursor = useRef(true); // read by the browser tools on every action
  const bottom = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Appends a transcript chunk to the open bubble of the same role, or starts a new one.
    const push = (role: Entry['role'], chunk: string) =>
      setEntries((list) => {
        const last = list[list.length - 1];
        if (role !== 'tool' && last?.role === role && last.open) return [...list.slice(0, -1), { ...last, text: last.text + chunk }];
        return [...list.map((e) => ({ ...e, open: false })), { role, text: chunk.trimStart(), open: role !== 'tool' }];
      });

    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const config = await invoke<{ api_key: string; model: string }>('get_config');
        // Attaches to the user's Chrome only when a tool first needs it, in one of two ways: the Ottoman extension through
        // the app's local relay (preferred), or Chrome's own remote debugging as a fallback. Either way there is exactly
        // one connection: chrome://inspect debugging accepts a single client and answers a second with 403.
        let browser: Promise<Browser> | undefined;
        let mode: 'extension' | 'debugging' = 'extension';
        let profileDir = ''; // debugging mode: profile that new agent tabs open in
        const onClose = () => {
          browser = undefined;
          setStatus('Chrome disconnected. Ask for a page to reconnect.');
        };
        const findProfile = async (name: string) => {
          const { profiles } = await invoke<{ profiles: { dir: string; name: string }[] }>('chrome_profiles');
          const p = name.toLowerCase().trim();
          const match = profiles.find((x) => x.name.toLowerCase() === p || x.dir.toLowerCase() === p) ?? profiles.find((x) => x.name.toLowerCase().includes(p));
          if (!match) throw new Error(`No Chrome profile named "${name}". Profiles: ${profiles.map((x) => x.name).join(', ')}`);
          return match.dir;
        };
        const extensionId = () => invoke<number | null>('extension_status');
        // Waits for an extension connection other than `except` (e.g. one in a profile we just started).
        const waitForExtension = async (except: number | null, ms: number) => {
          for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 300))) {
            const id = await extensionId();
            if (id != null && id !== except) return id;
          }
          return null;
        };
        // Preferred path: the Ottoman extension, reached through the app's local relay. No debugging toggle,
        // no Allow prompt, and agent tabs go into an "Ottoman" tab group.
        const connectExtension = async () => {
          setStatus('Connecting to Chrome through the Ottoman extension…');
          const b = new Browser(); // default socket and tab opening: the extension maps both onto chrome.* APIs
          b.cdp.onclose = onClose;
          await b.connect(await invoke<string>('relay_url'));
          setStatus('Chrome connected (extension)');
          return b;
        };
        const connect = async (dir?: string) => {
          let ext = await extensionId();
          if (ext == null && !(await invoke<boolean>('chrome_is_running'))) {
            // Start Chrome; its extension, if installed, connects within a few seconds.
            await invoke('start_chrome', { profile: dir ?? null });
            ext = await waitForExtension(null, 8000);
          }
          if (ext == null) {
            mode = 'debugging';
            return connectDebugging(dir);
          }
          mode = 'extension';
          const b = await connectExtension();
          return dir ? switchProfile(b, dir) : b;
        };
        const switchProfile = async (b: Browser, dir: string): Promise<Browser> => {
          if (mode === 'debugging') {
            // The one debugging connection sees every profile: just open a tab in that profile's window.
            profileDir = dir;
            await b.newTab('about:blank');
            return b;
          }
          // The extension lives inside one profile, so start that profile and use its extension instance; the relay
          // drops our connection when it connects. If none appears (same profile, or not installed there), keep this one.
          const before = await extensionId();
          await invoke('start_chrome', { profile: dir });
          if ((await waitForExtension(before, 8000)) == null) return b;
          browser = undefined;
          return (browser = connectExtension());
        };
        // Fallback: Chrome's own remote debugging (chrome://inspect/#remote-debugging), when the extension is not installed.
        const connectDebugging = async (dir?: string) => {
          setStatus('Connecting to Chrome… click Allow in Chrome if it asks.');
          const nonce = Math.random().toString(36).slice(2);
          const conn = await invoke<{ ws_url: string; profile: string }>('connect_chrome', { profile: dir ?? null, nonce }).catch((e) => {
            if (String(e) !== 'REMOTE_DEBUGGING_OFF') throw new Error(String(e));
            const help = 'Chrome remote debugging is off. In Chrome, open chrome://inspect/#remote-debugging and turn on "Allow remote debugging", then ask again.';
            setStatus(help);
            throw new Error(`${help} Tell the user exactly this.`);
          });
          profileDir = conn.profile;
          const b = new Browser(tauriSocket, (n) => invoke('open_tab', { profile: profileDir, nonce: n }));
          b.cdp.onclose = onClose;
          await b.connect(conn.ws_url, nonce).catch((e) => {
            b.cdp.close();
            if (/403/.test(String(e))) {
              throw new Error(
                'Chrome refused the remote-debugging connection (403). Easiest fix: install the Ottoman Chrome extension ' +
                  '(chrome://extensions, Developer mode, Load unpacked, pick the "extension" folder of the Ottoman project). ' +
                  'Otherwise fully quit Chrome, reopen it, and click Allow when asked. Tell the user this.',
              );
            }
            throw e;
          });
          setStatus('Chrome connected');
          return b;
        };
        const getBrowser = async (profile?: string) => {
          const dir = profile ? await findProfile(profile) : undefined;
          if (!browser) {
            const p = (browser = connect(dir).catch((e) => {
              if (browser === p) browser = undefined;
              throw e;
            }));
            return p; // connect already opened the agent's tab, in `dir` when given
          }
          const b = await browser;
          if (dir && dir !== profileDir) return switchProfile(b, dir);
          await b.ensureWindow();
          return b;
        };
        let a!: Assistant;
        const run = createTools({
          getBrowser,
          requestApproval: (s) => a.requestApproval(s),
          sendImage: (d, mime) => a.sendImage(d, mime),
          saveImage: (pngBase64, name, copy) => invoke('save_image', { pngBase64, name: name ?? null, copy }),
          captureDesktop: (name, copy) => invoke('capture_desktop', { name: name ?? null, copy }),
          listSaved: () => invoke('list_saved'),
          resolveUpload: (file) => invoke('resolve_upload', { file }),
          copyFile: (file) => invoke('copy_file_to_clipboard', { file }),
          showCursor: () => showCursor.current,
        });
        const initial = loadSettings(config.model || DEFAULT_MODEL);
        setSettings(initial);
        setNameDraft(initial.userName);
        showCursor.current = initial.showCursor;
        listLiveModels(config.api_key).then((list) =>
          // Keep a saved or .env model selectable even if the API list does not include it.
          setModels(list.some((m) => m.id === initial.model) ? list : [{ id: initial.model, name: initial.model }, ...list]),
        );
        a = new Assistant(config.api_key, initial, run, {
          transcript: push,
          turnEnd: () => setEntries((list) => list.map((e) => ({ ...e, open: false }))),
          tool: (name, args, result) => {
            // Refused clicks and no-op actions come back as output, not errors; show them as failures too.
            const first = String(result.output ?? '').split('\n')[0];
            const problem = result.error ?? (/^(Not clicked|Not done|User declined)|NOTHING CHANGED/.test(first) ? first : '');
            push('tool', `${name}(${args && Object.keys(args).length ? JSON.stringify(args) : ''})${problem ? ` ✗ ${problem}` : ''}`);
          },
          status: setStatus,
          approval: setApproval,
          mic: setMicOn,
          notice: (t) => push('tool', t),
        });
        assistant.current = a;
        setStatus('Ready when you are');
        unlisten = await listen('toggle-mic', () => a.toggleMic().catch((e) => setStatus(e.message)));
      } catch (e) {
        setStatus(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      unlisten?.();
      assistant.current?.close();
    };
  }, []);

  // Braces matter: scrollIntoView returns a Promise in current Chromium, and React would call it as cleanup.
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [entries, approval]);

  const send = () => {
    const t = text.trim();
    if (!t || !assistant.current) return;
    setText('');
    assistant.current.sendText(t).catch((e) => setStatus(e.message));
  };

  const apply = (next: Settings) => {
    setSettings(next);
    saveSettings(next);
    const model = models.find((m) => m.id === next.model)?.name ?? next.model;
    setStatus(`Switched to ${model} · ${next.voice}`);
    assistant.current?.reconfigure(next).catch((e) => setStatus(e.message));
  };

  useEffect(() => {
    if (!showSettings) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setShowSettings(false);
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [showSettings]);

  return (
    <div className="app">
      <header>
        <strong>Ottoman</strong>
        <span className="status" role="status">{status}</span>
        <button
          className="icon secondary"
          aria-label="Clear session"
          title="Clear session: new conversation"
          disabled={!settings}
          onClick={() => {
            setEntries([]);
            setStatus('Fresh start. What can I do for you?');
            assistant.current?.clear().catch((e) => setStatus(e.message));
          }}
        >
          🧹
        </button>
        <button
          className="icon secondary"
          aria-label="Settings"
          aria-expanded={showSettings}
          aria-controls="settings"
          disabled={!settings}
          onClick={() => setShowSettings((v) => !v)}
        >
          ⚙
        </button>
      </header>

      {showSettings && settings && (
        <section className="settings" id="settings" aria-label="Settings">
          <label htmlFor="model">Model</label>
          <select id="model" value={settings.model} onChange={(e) => apply({ ...settings, model: e.target.value })}>
            {models.map((m) => (
              <option key={m.id} value={m.id} title={m.id}>{m.name}</option>
            ))}
          </select>

          <label htmlFor="voice">Voice</label>
          <div className="row">
            <select id="voice" value={settings.voice} onChange={(e) => apply({ ...settings, voice: e.target.value })}>
              {VOICES.map((v) => (
                <option key={v.name} value={v.name}>{v.name}: {v.style}</option>
              ))}
            </select>
            <button className="secondary" onClick={() => assistant.current?.testVoice().catch((e) => setStatus(e.message))}>
              Try voice
            </button>
          </div>

          <label htmlFor="username">Your name (optional)</label>
          <input
            id="username"
            value={nameDraft}
            placeholder="What should I call you?"
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={() => nameDraft.trim() !== settings.userName && apply({ ...settings, userName: nameDraft.trim() })}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          />
          <small>Changing model, voice or name starts a fresh conversation.</small>

          <label className="check">
            <input
              type="checkbox"
              checked={settings.showCursor}
              onChange={(e) => {
                // Visual only: applies to the next action, no new conversation.
                const next = { ...settings, showCursor: e.target.checked };
                showCursor.current = next.showCursor;
                setSettings(next);
                saveSettings(next);
              }}
            />
            Show Ottoman's cursor in the page
          </label>
        </section>
      )}

      <main className="log">
        {!entries.length && (
          <div className="welcome">
            <h2>Hi{settings?.userName ? `, ${settings.userName}` : ''}! I'm Ottoman 👋</h2>
            <p>I can browse, fill forms, shop, post and grab screenshots for you. I'll always ask before paying, posting or sending anything.</p>
            <p>Press the mic (or Ctrl+Shift+Space) and talk, or try one of these:</p>
            <div className="chips">
              {EXAMPLES.map((ex) => (
                <button key={ex} className="chip" onClick={() => (setText(ex), input.current?.focus())}>
                  {ex}
                </button>
              ))}
            </div>
          </div>
        )}
        {entries.map((e, i) => (
          <div key={i} className={`entry ${e.role}`}>{e.text}</div>
        ))}
        {approval && (
          <div className="approval" role="alertdialog" aria-label="Approve action">
            <div>Approve this action?</div>
            <p>{approval}</p>
            <div className="row">
              <button onClick={() => assistant.current?.resolveApproval(true)}>Yes, do it</button>
              <button className="secondary" onClick={() => assistant.current?.resolveApproval(false)}>No</button>
            </div>
            <small>You can also say "yes" or "no".</small>
          </div>
        )}
        <div ref={bottom} />
      </main>

      <footer>
        <button
          className={`mic ${micOn ? 'on' : ''}`}
          aria-pressed={micOn}
          aria-label={micOn ? 'Stop listening' : 'Start listening'}
          title="Ctrl+Shift+Space"
          disabled={!assistant.current}
          onClick={() => assistant.current?.toggleMic().catch((e) => setStatus(e.message))}
        >
          {micOn ? '■' : '🎤'}
        </button>
        <input
          ref={input}
          value={text}
          placeholder="Ask me anything…"
          aria-label="Message"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
        />
        <button onClick={send} disabled={!text.trim()}>Send</button>
      </footer>
    </div>
  );
}
