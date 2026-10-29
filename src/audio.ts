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
  queue = []; offset = 0;
  constructor() {
    super();
    this.port.onmessage = (e) => { if (e.data === 'flush') { this.queue = []; this.offset = 0; } else this.queue.push(e.data); };
  }
  process(_, [output]) {
    const out = output[0];
    for (let i = 0; i < out.length; i++) {
      const cur = this.queue[0];
      if (!cur) { out[i] = 0; continue; }
      out[i] = cur[this.offset++];
      if (this.offset >= cur.length) { this.queue.shift(); this.offset = 0; }
    }
    return true;
  }
}
registerProcessor('playback', Playback);`;

const moduleUrl = (src: string) => URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));

function toBase64(buf: ArrayBuffer) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export class Mic {
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
    this.ctx.createMediaStreamSource(this.stream).connect(node);
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close();
    this.ctx = undefined;
    this.stream = undefined;
  }

  get active() {
    return !!this.ctx;
  }
}

export class Speaker {
  private ctx?: AudioContext;
  private node?: AudioWorkletNode;
  private ready?: Promise<AudioWorkletNode>;

  // Memoized so chunks arriving before setup finishes share one context.
  private ensure() {
    return (this.ready ??= (async () => {
      this.ctx = new AudioContext({ sampleRate: 24000 });
      await this.ctx.audioWorklet.addModule(moduleUrl(playbackWorklet));
      this.node = new AudioWorkletNode(this.ctx, 'playback');
      this.node.connect(this.ctx.destination);
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
    node.port.postMessage(f32, [f32.buffer]);
  }

  /** Drops queued audio, used when the user interrupts the model. */
  flush() {
    this.node?.port.postMessage('flush');
  }
}
