// Gemini Live session: streams mic audio and text in, plays audio out, and runs tool calls.
import { GoogleGenAI, Modality, ThinkingLevel, type LiveServerMessage, type Session } from '@google/genai';
import { Mic, Speaker } from './audio';
import { buildInstruction } from './prompt';
import { declarations } from './tools';

export interface Settings {
  model: string;
  voice: string;
  userName: string;
  /** Draw Ottoman's cursor and "working" glow in the page. */
  showCursor: boolean;
}

export interface AssistantEvents {
  transcript: (role: 'user' | 'assistant', text: string) => void;
  turnEnd: () => void;
  tool: (name: string, args: unknown, result: Record<string, unknown>) => void;
  status: (status: string) => void;
  approval: (summary: string | null) => void;
  mic: (on: boolean) => void;
  /** Small diagnostic line for the chat, e.g. why a session closed. */
  notice: (text: string) => void;
}

const YES = /\b(yes|yeah|yep|sure|okay|ok|confirm|approved?|go ahead|do it)\b/i;
const NO = /\b(no|nope|cancel|stop|don't|do not|wait)\b/i;

export class Assistant {
  private ai: GoogleGenAI;
  private session?: Session;
  private connecting?: Promise<void>;
  private handle?: string;
  private closing = false;
  private gen = 0; // bumped per session, so a replaced session's close event and tool results are ignored
  private failures = 0; // unexpected closes in a row, to stop retrying a session that keeps dying
  private cancelled = new Set<string>(); // tool call ids the server cancelled (e.g. the user interrupted)
  // Resolves once the previous socket has really closed. Gemini refuses to resume a conversation while the old
  // connection using that handle is still open ("session is already connected to an existing client").
  private lastClosed: Promise<void> = Promise.resolve();
  private resumeRetries = 0;
  private mic = new Mic();
  private speaker = new Speaker();
  private approval?: { resolve: (ok: boolean) => void; heard: string };

  constructor(
    apiKey: string,
    private settings: Settings,
    private runTool: (name: string, args: unknown) => Promise<Record<string, unknown>>,
    private on: AssistantEvents,
  ) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  /** Ensures a session is open, reusing the current one. */
  private connect() {
    if (this.session) return Promise.resolve();
    if (!this.connecting) {
      const p = this.open().finally(() => {
        if (this.connecting === p) this.connecting = undefined;
      });
      this.connecting = p;
    }
    return this.connecting;
  }

  private async open() {
    this.on.status('Connecting to Gemini…');
    this.closing = false;
    const gen = ++this.gen;
    if (this.handle) await Promise.race([this.lastClosed, new Promise((r) => setTimeout(r, 3000))]);
    if (gen !== this.gen) return; // settings changed while waiting
    let setUp = false;
    let markClosed!: () => void;
    this.lastClosed = new Promise((r) => (markClosed = r));
    const session = await this.ai.live.connect({
      model: this.settings.model,
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: buildInstruction(this.settings.userName),
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.settings.voice } } },
        // Extended-thinking Live models refuse to start without a thinking level; MEDIUM keeps voice replies snappy.
        ...(/thinking/i.test(this.settings.model) && { thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM } }),
        tools: [{ functionDeclarations: declarations }],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        contextWindowCompression: { slidingWindow: {} },
        sessionResumption: { handle: this.handle },
      },
      callbacks: {
        onopen: () => this.on.status('Listening and ready'),
        onmessage: (m) => {
          if (gen !== this.gen) return; // a replaced session must not play audio or run tools
          if (m.setupComplete) {
            setUp = true;
            this.failures = 0;
            this.resumeRetries = 0;
          }
          void this.handle_(m);
        },
        onerror: (e) => this.on.status(`Gemini error: ${e.message}`),
        onclose: (e) => {
          markClosed();
          if (gen !== this.gen) return;
          this.session = undefined;
          if (this.closing) return this.on.status('Disconnected');
          const why = `${e.code}${e.reason ? ` ${e.reason}` : ''}`;
          if (!setUp && /already connected/i.test(e.reason) && this.handle) {
            // The server has not let go of the previous connection yet: wait and resume again, then start fresh.
            if (++this.resumeRetries > 3) {
              this.resumeRetries = 0;
              this.handle = undefined;
              this.on.notice('Could not resume the conversation; starting a fresh one');
            }
            this.on.status('Reconnecting…');
            setTimeout(() => this.connect().catch((err) => this.on.status(`Gemini error: ${err.message}`)), 1500);
            return;
          }
          // Refused during setup otherwise means the model or voice is not usable; retrying would fail the same way.
          if (!setUp) return this.on.status(`Gemini refused the session: ${why}`);
          this.on.notice(`Session closed (${why}); reconnecting`);
          if (++this.failures > 3) {
            this.failures = 0;
            this.handle = undefined; // the resumed state itself may be what keeps failing
            return this.on.status('The session keeps closing. Send a message to start a fresh one.');
          }
          // Session limits, network drops and server errors: resume the same conversation.
          this.on.status('Reconnecting…');
          setTimeout(() => this.connect().catch((err) => this.on.status(`Gemini error: ${err.message}`)), 1000);
        },
      },
    });
    // Settings changed (or the session was cleared) while this one was opening: close it, or it would keep
    // running unseen, and enough of those make Gemini refuse new sessions.
    if (gen !== this.gen) return session.close();
    this.session = session;
  }

  private async handle_(m: LiveServerMessage) {
    if (m.sessionResumptionUpdate?.resumable && m.sessionResumptionUpdate.newHandle) this.handle = m.sessionResumptionUpdate.newHandle;
    if (m.goAway) {
      // Server is about to end this session; reconnect now with the latest handle.
      const old = this.session;
      this.session = undefined;
      old?.close();
      return;
    }
    const c = m.serverContent;
    if (c?.interrupted) this.speaker.flush();
    if (c?.inputTranscription?.text) {
      this.on.transcript('user', c.inputTranscription.text);
      this.checkSpokenApproval(c.inputTranscription.text);
    }
    if (c?.outputTranscription?.text) this.on.transcript('assistant', c.outputTranscription.text);
    for (const part of c?.modelTurn?.parts ?? []) {
      if (part.inlineData?.data && part.inlineData.mimeType?.startsWith('audio/')) void this.speaker.play(part.inlineData.data);
    }
    if (c?.turnComplete) this.on.turnEnd();

    for (const id of m.toolCallCancellation?.ids ?? []) this.cancelled.add(id);
    if (m.toolCall?.functionCalls?.length) {
      // Tool calls belong to the session that sent them. Browser actions (and approvals) can take long enough for
      // the session to reconnect; answering an old call in the new session makes the server close it.
      const gen = this.gen;
      const functionResponses = [];
      for (const fc of m.toolCall.functionCalls) {
        if (fc.id && this.cancelled.delete(fc.id)) continue; // the user interrupted; don't act on it
        const response = await this.runTool(fc.name!, fc.args);
        this.on.tool(fc.name!, fc.args, response);
        if (fc.id && this.cancelled.delete(fc.id)) continue; // cancelled while it ran
        functionResponses.push({ id: fc.id, name: fc.name, response });
      }
      if (gen === this.gen && functionResponses.length) this.session?.sendToolResponse({ functionResponses });
    }
  }

  async sendText(text: string) {
    await this.connect();
    this.on.transcript('user', text);
    this.on.turnEnd();
    this.session?.sendRealtimeInput({ text });
  }

  /**
   * Switches model, voice or name. The resumption handle belongs to the old session's model and voice, so the
   * conversation starts fresh. Reconnects right away if the mic is on; otherwise on the next request.
   */
  async reconfigure(settings: Settings) {
    this.settings = settings;
    this.handle = undefined;
    this.gen++; // ignore the old session's events; a connection still opening closes itself when it lands
    this.connecting = undefined; // the next request opens a new session with the new settings
    this.session?.close();
    this.session = undefined;
    if (this.mic.active) await this.connect();
  }

  /** Forgets the conversation: declines any pending approval and starts a fresh session with the same settings. */
  clear() {
    this.resolveApproval(false);
    this.speaker.flush();
    return this.reconfigure(this.settings);
  }

  /** Asks the model for a short hello, to preview the voice. */
  async testVoice() {
    await this.connect();
    this.session?.sendRealtimeInput({ text: 'Say a short, friendly one-sentence hello so I can hear your voice.' });
  }

  sendImage(base64: string, mimeType: string) {
    this.session?.sendRealtimeInput({ video: { data: base64, mimeType } });
  }

  async toggleMic() {
    if (this.mic.active) {
      this.mic.stop();
      this.session?.sendRealtimeInput({ audioStreamEnd: true });
      return this.on.mic(false);
    }
    await this.connect();
    await this.mic.start((data) => this.session?.sendRealtimeInput({ audio: { data, mimeType: 'audio/pcm;rate=16000' } }));
    this.on.mic(true);
  }

  /** Waits for the user's yes/no, from the approval buttons or spoken words (their own transcribed speech, never the model's). */
  requestApproval = (summary: string) =>
    new Promise<boolean>((resolve) => {
      this.approval?.resolve(false);
      this.approval = { resolve, heard: '' };
      this.on.approval(summary);
    });

  resolveApproval(ok: boolean) {
    const a = this.approval;
    if (!a) return;
    this.approval = undefined;
    this.on.approval(null);
    a.resolve(ok);
  }

  private checkSpokenApproval(text: string) {
    if (!this.approval) return;
    this.approval.heard += ` ${text}`;
    // "No" wins over "yes" so "yes, wait, no" is a decline.
    if (NO.test(this.approval.heard)) this.resolveApproval(false);
    else if (YES.test(this.approval.heard)) this.resolveApproval(true);
  }

  close() {
    this.closing = true;
    this.mic.stop();
    this.session?.close();
  }
}

// Holding a Web Lock keeps WebView2 from freezing this page while the window is hidden in the tray.
navigator.locks?.request('ottoman-keepalive', () => new Promise(() => {}));
