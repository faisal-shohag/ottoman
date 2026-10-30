// Voice wave: mirrored rounded bars on a canvas, fed by the mic while listening and the speaker while Ottoman talks.
// Drawn every animation frame outside React, so it stays smooth.
import { useEffect, useRef } from 'react';
import type { VoiceState } from '../voiceState';

interface Source {
  frequencies(out: Uint8Array<ArrayBuffer>): boolean;
}

const BARS = 28;
const GAP = 3;

/** Bar heights (0..1) for one frame. Voice lives in the lower bins, so bars sample the first ~60% of the spectrum. */
export function barTargets(state: VoiceState, bins: Uint8Array | null, t: number): number[] {
  return Array.from({ length: BARS }, (_, i) => {
    // Mirrored around the centre, loudest in the middle.
    const k = Math.abs(i - (BARS - 1) / 2) / ((BARS - 1) / 2);
    if (bins && (state === 'listening' || state === 'speaking')) {
      const v = bins[Math.floor(k * bins.length * 0.6)] / 255;
      return Math.max(0.06, v * (1 - k * 0.35));
    }
    // Working without sound: a gentle travelling wave. Idle: quiet dots.
    if (state === 'working') return 0.3 + 0.45 * (0.5 + 0.5 * Math.sin(t / 260 - i * 0.45)) * (1 - k * 0.5);
    return 0.06;
  });
}

export function VoiceWave({ state, source, className = '' }: { state: VoiceState; source?: Source; className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const live = useRef({ state, source });
  live.current = { state, source };

  useEffect(() => {
    const c = canvas.current!;
    const g = c.getContext('2d')!;
    const bins = new Uint8Array(128);
    const heights = new Array(BARS).fill(0.06);
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let frame = 0;

    const draw = (t: number) => {
      frame = requestAnimationFrame(draw);
      // Match the canvas to its CSS size at the device pixel ratio, for crisp bars.
      const dpr = devicePixelRatio || 1;
      const w = c.clientWidth, h = c.clientHeight;
      if (!w || !h) return;
      if (c.width !== Math.round(w * dpr)) c.width = Math.round(w * dpr);
      if (c.height !== Math.round(h * dpr)) c.height = Math.round(h * dpr);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);

      const { state, source } = live.current;
      const has = source?.frequencies(bins) ?? false;
      const targets = barTargets(state, has ? bins : null, reduced ? 0 : t);
      const grad = g.createLinearGradient(0, 0, w, 0);
      grad.addColorStop(0, '#0f766e');
      grad.addColorStop(0.5, '#10b981');
      grad.addColorStop(1, '#5eead4');
      g.fillStyle = grad;

      const bw = (w - GAP * (BARS - 1)) / BARS;
      for (let i = 0; i < BARS; i++) {
        // Ease toward the target so bars glide instead of jumping.
        heights[i] += (targets[i] - heights[i]) * (reduced ? 1 : 0.25);
        const bh = Math.max(bw, heights[i] * h);
        const x = i * (bw + GAP);
        g.beginPath();
        g.roundRect(x, (h - bh) / 2, bw, bh, bw / 2);
        g.fill();
      }
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);

  return <canvas ref={canvas} className={`h-8 w-full ${className}`} aria-hidden />;
}
