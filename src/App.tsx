import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Browser } from './cdp';
import { Assistant, type Settings } from './live';
import { DEFAULT_MODEL, FALLBACK_MODELS, listLiveModels, type LiveModel } from './models';
import { tauriSocket } from './tauriSocket';
import { createTools } from './tools';
import { spokenWords, useVoiceState } from './voiceState';
import { AnimatePresence, motion } from 'motion/react';
import { OttomanMark } from '@/components/ottoman-mark';
import { VoiceWave } from '@/components/voice-wave';
import { Blob } from '@/components/blob';
import { ChatSheet, stepLabel, type Entry } from '@/components/chat-sheet';
import { DEFAULT_VOICE, VOICES } from './voices';
import { Eraser, MessageSquareText, Mic, Settings as SettingsIcon, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';

const SETTINGS_KEY = 'ottoman.settings';
const statusTone = (s: string) =>
  /error|refused|failed|missing|not found|disconnected|declined/i.test(s)
    ? 'bg-destructive'
    : /connecting|starting|switched/i.test(s)
      ? 'bg-amber-500 motion-safe:animate-pulse'
      : /ready|connected|listening|fresh/i.test(s)
        ? 'bg-emerald-500'
        : 'bg-muted-foreground';
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
  const [chatOpen, setChatOpen] = useState(false);
  const [seen, setSeen] = useState(0); // replies already seen in the chat sheet, for the unread dot
  const assistant = useRef<Assistant>(null);
  const showCursor = useRef(true); // read by the browser tools on every action
  const tools = useRef<ReturnType<typeof createTools>>(null);
  const turnAudio = useRef(0); // speaker mark at the start of the current turn, for pacing the caption
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
        // Dev only: lets test scripts read the agent's tab to check what an action really did.
        if (import.meta.env.DEV) Object.assign(window, { __ottoman: { getBrowser } });
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
        tools.current = run;
        const initial = loadSettings(config.model || DEFAULT_MODEL);
        setSettings(initial);
        setNameDraft(initial.userName);
        showCursor.current = initial.showCursor;
        listLiveModels(config.api_key).then((list) =>
          // Keep a saved or .env model selectable even if the API list does not include it.
          setModels(list.some((m) => m.id === initial.model) ? list : [{ id: initial.model, name: initial.model }, ...list]),
        );
        a = new Assistant(config.api_key, initial, run, {
          transcript: (role, text) => {
            if (role === 'user') {
              run.reset();
              turnAudio.current = a.audio().speaker.mark(); // the reply's speech starts after this
            }
            push(role, text);
          },
          turnEnd: () => setEntries((list) => list.map((e) => ({ ...e, open: false }))),
          tool: (name, args, result) => {
            // Refused clicks and no-op actions come back as output, not errors; show them as failures too.
            const first = String(result.output ?? '').split('\n')[0];
            const problem = result.error ?? (/^(Not clicked|Not done|User declined)|NOTHING CHANGED/.test(first) ? first : '');
            const text = `${name}(${args && Object.keys(args).length ? JSON.stringify(args) : ''})${problem ? ` ✗ ${problem}` : ''}`;
            const tool = { name, args, problem: String(problem), summary: first };
            setEntries((list) => [...list.map((e) => ({ ...e, open: false })), { role: 'tool', text, open: false, tool }]);
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

  // Waiting on Ottoman: the last row is the user's message or a step, with no reply yet.
  const last = entries[entries.length - 1];
  const busy = !!last && (last.role === 'user' || !!last.tool) && !approval;

  // What Ottoman is doing drives the blob, the live mark, the wave and the status line.
  const voice = useVoiceState(assistant.current, micOn, busy);
  const audio = assistant.current?.audio();
  const hearing = voice === 'listening' ? audio?.mic : audio?.speaker;
  const level = () => hearing?.level() ?? 0;
  const stageStatus = approval
    ? 'Waiting for your OK'
    : {
        idle: entries.length ? 'Tap the mic to talk' : 'Tap the mic and tell me what to do',
        listening: 'Ottoman is listening…',
        speaking: 'Ottoman is speaking…',
        working: last?.tool ? `Working · ${stepLabel(last)}` : 'Thinking…',
      }[voice];
  // The caption shows the latest words said, by either side: your request while Ottoman works, then its reply.
  const said = [...entries].reverse().find((e) => e.role !== 'tool');
  const captionText = said?.text ?? `Hi${settings?.userName ? ` ${settings.userName.split(' ')[0]}` : ''}, I'm Ottoman.`;

  const replies = entries.filter((e) => e.role === 'assistant').length;
  const unread = !chatOpen && replies > seen;
  const closeChat = useCallback(() => setChatOpen(false), []);
  useEffect(() => {
    if (chatOpen) setSeen(replies);
  }, [chatOpen, replies]);
  // An approval must not hide behind the chat sheet.
  useEffect(() => {
    if (approval) setChatOpen(false);
  }, [approval]);

  const stop = () => {
    tools.current?.stop();
    assistant.current?.stop();
    setStatus('Stopped. What next?');
  };

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
    // Radix marks the Escape that closes an open dropdown as handled; only a free Escape closes the panel.
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !e.defaultPrevented && setShowSettings(false);
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [showSettings]);

  return (
    <div className="relative flex h-screen flex-col overflow-hidden bg-[radial-gradient(ellipse_at_50%_38%,color-mix(in_oklch,var(--primary)_16%,transparent),transparent_62%)]">
      <header className="relative z-20 flex items-center gap-2 px-3.5 pt-3 pb-1">
        <strong className="font-semibold tracking-tight">Ottoman</strong>
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className={`size-2 shrink-0 rounded-full transition-colors ${statusTone(status)}`} aria-hidden />
          <span className="status min-w-0 truncate text-xs text-muted-foreground" role="status" title={status}>{status}</span>
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="rounded-full"
          aria-label="Clear session"
          title="New conversation"
          disabled={!settings}
          onClick={() => {
            setEntries([]);
            setStatus('Fresh start. What can I do for you?');
            assistant.current?.clear().catch((e) => setStatus(e.message));
          }}
        >
          <Eraser />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="rounded-full"
          aria-label="Settings"
          aria-expanded={showSettings}
          aria-controls="settings"
          disabled={!settings}
          onClick={() => setShowSettings((v) => !v)}
        >
          <SettingsIcon />
        </Button>
      </header>

      {showSettings && settings && (
        <section
          className="absolute inset-x-0 top-12 z-30 flex flex-col gap-1.5 rounded-b-2xl border-b bg-card px-3.5 py-3 shadow-2xl motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-1 motion-safe:duration-200"
          id="settings"
          aria-label="Settings"
        >
          <Label htmlFor="model" className="mt-1.5">Model</Label>
          <Select value={settings.model} onValueChange={(model) => apply({ ...settings, model })}>
            <SelectTrigger id="model" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {models.map((m) => (
                <SelectItem key={m.id} value={m.id} title={m.id}>{m.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Label htmlFor="voice" className="mt-1.5">Voice</Label>
          <div className="flex gap-2">
            <Select value={settings.voice} onValueChange={(voice) => apply({ ...settings, voice })}>
              <SelectTrigger id="voice" className="min-w-0 flex-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {VOICES.map((v) => (
                  <SelectItem key={v.name} value={v.name}>{v.name}: {v.style}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" onClick={() => assistant.current?.testVoice().catch((e) => setStatus(e.message))}>
              Try voice
            </Button>
          </div>

          <Label htmlFor="username" className="mt-1.5">Your name (optional)</Label>
          <Input
            id="username"
            value={nameDraft}
            placeholder="What should I call you?"
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={() => nameDraft.trim() !== settings.userName && apply({ ...settings, userName: nameDraft.trim() })}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          />
          <small className="mt-1 text-xs text-muted-foreground">Changing model, voice or name starts a fresh conversation.</small>

          <div className="mt-2 flex items-center gap-2">
            <Switch
              id="show-cursor"
              checked={settings.showCursor}
              onCheckedChange={(checked) => {
                // Visual only: applies to the next action, no new conversation.
                const next = { ...settings, showCursor: checked };
                showCursor.current = next.showCursor;
                setSettings(next);
                saveSettings(next);
              }}
            />
            <Label htmlFor="show-cursor" className="font-normal">Show Ottoman's cursor in the page</Label>
          </div>
        </section>
      )}

      <main className="relative flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6">
        <div className="relative grid aspect-square w-full max-w-[min(300px,42vh)] shrink-0 place-items-center">
          {/* Bigger than its box, so the glow fades out before the canvas edge instead of being cut off. */}
          <div className="pointer-events-none absolute -inset-[25%]">
            <Blob state={voice} level={level} className="size-full" />
          </div>
          <OttomanMark state={voice} size={84} level={level} mono />
        </div>

        <AnimatePresence mode="wait" initial={false}>
          <motion.p
            key={stageStatus}
            className="max-w-full truncate text-xs font-medium text-muted-foreground"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.18 }}
          >
            {stageStatus}
          </motion.p>
        </AnimatePresence>

        {approval ? (
          <Card
            className="approval w-full shrink-0 ring-2 ring-destructive motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95 motion-safe:duration-200"
            role="alertdialog"
            aria-label="Approve action"
          >
            <CardHeader>
              <CardDescription>Approve this action?</CardDescription>
              <CardTitle>{approval}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <div className="flex gap-2">
                <Button onClick={() => assistant.current?.resolveApproval(true)}>Yes, do it</Button>
                <Button variant="outline" onClick={() => assistant.current?.resolveApproval(false)}>No</Button>
              </div>
              <small className="text-xs text-muted-foreground">You can also say "yes" or "no".</small>
            </CardContent>
          </Card>
        ) : (
          <Caption
            text={captionText}
            heard={said?.role === 'assistant' ? () => audio?.speaker.progress(turnAudio.current) ?? null : undefined}
            streaming={!!said?.open}
          />
        )}

        {!entries.length && !approval && (
          <div className="flex flex-wrap justify-center gap-1.5">
            {EXAMPLES.map((ex) => (
              <Button
                key={ex}
                variant="outline"
                size="sm"
                className="h-auto rounded-full bg-background/40 py-1.5 font-normal whitespace-normal backdrop-blur"
                disabled={!assistant.current}
                onClick={() => assistant.current?.sendText(ex).catch((e) => setStatus(e.message))}
              >
                {ex}
              </Button>
            ))}
          </div>
        )}
      </main>

      <div className="px-8">
        <VoiceWave state={voice} source={hearing} className="h-10" />
      </div>

      <footer className="relative z-10 flex items-center justify-center gap-7 pt-3 pb-6">
        <Button
          variant="outline"
          className="size-12 rounded-full bg-background/40 backdrop-blur"
          aria-label="Stop"
          title="Stop Ottoman"
          disabled={voice === 'idle' && !approval}
          onClick={stop}
        >
          <Square className="size-4 fill-current" />
        </Button>
        <Button
          className={`size-16 rounded-full text-white shadow-lg shadow-emerald-950/50 transition-[background,transform] active:scale-95 [&_svg:not([class*='size-'])]:size-6 ${
            micOn ? 'mic-ring bg-destructive hover:bg-destructive/90' : 'bg-[linear-gradient(135deg,#0f766e,#10b981_55%,#2dd4bf)] hover:brightness-110'
          }`}
          aria-pressed={micOn}
          aria-label={micOn ? 'Stop listening' : 'Start listening'}
          title="Ctrl+Shift+Space"
          disabled={!assistant.current}
          onClick={() => assistant.current?.toggleMic().catch((e) => setStatus(e.message))}
        >
          <Mic />
        </Button>
        <Button
          variant="outline"
          className="relative size-12 rounded-full bg-background/40 backdrop-blur"
          aria-label="Open chat"
          title="Conversation and typing"
          onClick={() => setChatOpen(true)}
        >
          <MessageSquareText />
          {unread && <span className="absolute top-2 right-2 size-2 rounded-full bg-primary ring-2 ring-background" aria-label="New messages" />}
        </Button>
      </footer>

      <ChatSheet
        open={chatOpen}
        onClose={closeChat}
        entries={entries}
        busy={busy}
        voice={voice}
        level={level}
        wave={hearing}
        text={text}
        setText={setText}
        send={send}
        input={input}
      />
    </div>
  );
}

/**
 * The words being spoken, large under the blob. For Ottoman's replies, words appear as they are actually heard
 * (`heard` is the share of the reply's audio played so far); the newest words are bright and earlier ones fade.
 * Older lines slide out of a soft top mask, and each new word fades in from a slight blur.
 */
function Caption({ text, heard, streaming }: { text: string; heard?: () => number | null; streaming: boolean }) {
  const all = text.split(/\s+/).filter(Boolean);
  const [count, setCount] = useState(all.length);
  const live = useRef({ heard, streaming, total: all.length });
  live.current = { heard, streaming, total: all.length };
  const pacing = !!heard;
  useEffect(() => {
    if (!pacing) return;
    let frame = 0;
    const tick = () => {
      const { heard, streaming, total } = live.current;
      setCount(spokenWords(total, heard?.() ?? null, streaming));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [pacing]);
  const words = all.slice(0, pacing ? count : all.length).slice(-48);
  const bright = words.length - 8;
  return (
    <div className="flex max-h-[7.2em] w-full shrink-0 flex-col justify-end overflow-hidden text-center text-xl leading-snug font-medium tracking-tight [mask-image:linear-gradient(to_bottom,transparent,black_35%)]">
      <p>
        {words.map((w, i) => (
          <motion.span
            key={`${i}-${w}`}
            className={`inline-block transition-colors duration-700 ${i >= bright ? 'text-foreground' : 'text-foreground/35'}`}
            initial={{ opacity: 0, filter: 'blur(6px)', y: 4 }}
            animate={{ opacity: 1, filter: 'blur(0px)', y: 0 }}
            transition={{ duration: 0.35, ease: 'easeOut' }}
          >
            {w}&nbsp;
          </motion.span>
        ))}
      </p>
    </div>
  );
}
