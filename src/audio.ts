// Mic capture at 16 kHz PCM16 and speaker playback at 24 kHz PCM16, both via AudioWorklets.

const captureWorklet = `
class Capture extends AudioWorkletProcessor {
  buf = new Int16Array(1600); n = 0; // 100 ms chunks at 16 kHz
  process([input]) {
    const ch = input[0];
    if (ch) for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = Math.max(-1, Math.min(1, ch[i])) * 0x7fff;
      if (this.n === this.buf.length) { this.port.postMessage(this.buf.buffer.slice(0)); this.n = 0; }
    }
    return true;
  }
}
registerProcessor('capture', Capture);`;

const playbackWorklet = `
class Playback extends AudioWorkletProcessor {
  queue = []; offset = 0; played = 0; reported = 0;
  constructor() {
    super();
    this.port.onmessage = (e) => {
      if (e.data !== 'flush') return void this.queue.push(e.data);
      // Dropped audio counts as played, so the running total stays in step with what was received.
      for (const q of this.queue) this.played += q.length;
      this.played -= this.offset;
      this.queue = []; this.offset = 0;
      this.port.postMessage(this.played); this.reported = this.played;
    };
  }
  process(_, [output]) {
    const out = output[0];
    const had = this.queue.length > 0;
    for (let i = 0; i < out.length; i++) {
      const cur = this.queue[0];
      if (!cur) { out[i] = 0; continue; }
      out[i] = cur[this.offset++];
      this.played++;
      if (this.offset >= cur.length) { this.queue.shift(); this.offset = 0; }
    }
    // Running total of samples played: about every 50 ms, and whenever the queue runs dry.
    if (this.played - this.reported >= 1200 || (had && !this.queue.length)) { this.port.postMessage(this.played); this.reported = this.played; }
    return true;
  }
}
registerProcessor('playback', Playback);`;

const moduleUrl = (src: string) => URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));

/** An analyser for the UI's voice wave and talking animation. */
function makeAnalyser(ctx: AudioContext) {
  const a = ctx.createAnalyser();
  a.fftSize = 256;
  a.smoothingTimeConstant = 0.8;
  return a;
}

/** Live sound of a node: frequency bins for the wave, and loudness (RMS, 0..1) for the mark. */
class Meter {
  protected analyser?: AnalyserNode;
  private wave = new Float32Array(256);

  /** Fills `out` with frequency bins; false when nothing is playing or recording. */
  frequencies(out: Uint8Array<ArrayBuffer>) {
    if (!this.analyser) return false;
    this.analyser.getByteFrequencyData(out);
    return true;
  }

  level() {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this.wave);
    let sum = 0;
    for (const v of this.wave) sum += v * v;
    return Math.sqrt(sum / this.wave.length);
  }
}

function toBase64(buf: ArrayBuffer) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export class Mic extends Meter {
  private ctx?: AudioContext;
  private stream?: MediaStream;

  /** Calls onChunk with base64 PCM16 at 16 kHz every 100 ms. */
  async start(onChunk: (base64: string) => void) {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.ctx = new AudioContext({ sampleRate: 16000 });
    await this.ctx.audioWorklet.addModule(moduleUrl(captureWorklet));
    const node = new AudioWorkletNode(this.ctx, 'capture');
    node.port.onmessage = (e) => onChunk(toBase64(e.data));
    const source = this.ctx.createMediaStreamSource(this.stream);
    source.connect(node);
    source.connect((this.analyser = makeAnalyser(this.ctx)));
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close();
    this.ctx = undefined;
    this.stream = undefined;
    this.analyser = undefined;
  }

  get active() {
    return !!this.ctx;
  }
}

export class Speaker extends Meter {
  private ctx?: AudioContext;
  private node?: AudioWorkletNode;
  private ready?: Promise<AudioWorkletNode>;
  private received = 0; // samples handed to the worklet, running total
  private played = 0; // ...and how many of them it has played (or dropped on flush)

  // Memoized so chunks arriving before setup finishes share one context.
  private ensure() {
    return (this.ready ??= (async () => {
      this.ctx = new AudioContext({ sampleRate: 24000 });
      await this.ctx.audioWorklet.addModule(moduleUrl(playbackWorklet));
      this.node = new AudioWorkletNode(this.ctx, 'playback');
      this.node.port.onmessage = (e) => void (this.played = e.data);
      this.analyser = makeAnalyser(this.ctx);
      this.node.connect(this.analyser).connect(this.ctx.destination);
      return this.node;
    })());
  }

  async play(base64Pcm16: string) {
    const node = await this.ensure();
    if (this.ctx!.state === 'suspended') await this.ctx!.resume();
    const bin = atob(base64Pcm16);
    const pcm = new Int16Array(bin.length / 2);
    for (let i = 0; i < pcm.length; i++) pcm[i] = (bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8)) << 16 >> 16;
    const f32 = Float32Array.from(pcm, (v) => v / 0x8000);
    this.received += f32.length;
    node.port.postMessage(f32, [f32.buffer]);
  }

  /** Drops queued audio, used when the user interrupts the model. */
  flush() {
    this.node?.port.postMessage('flush');
  }

  /** Marks the start of a turn: pass the result to progress() to measure that turn's speech. */
  mark() {
    return this.received;
  }

  /**
   * How much of the speech received since `mark` has been heard, 0..1, or null if none arrived yet. Audio and its
   * transcript both arrive faster than real time, so the caption uses this to reveal words as they are spoken.
   */
  progress(mark: number) {
    const got = this.received - mark;
    return got > 0 ? Math.min(1, Math.max(0, (this.played - mark) / got)) : null;
  }
}
