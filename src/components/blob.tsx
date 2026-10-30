// The stage blob: a soft, glowing organic shape behind Ottoman that breathes when idle, swells with your voice while
// listening, pulses with Ottoman's voice while speaking and swirls while working. Drawn on a canvas every frame.
import { useEffect, useRef } from 'react';
import type { VoiceState } from '../voiceState';

const HARMONICS = [2, 3, 4, 5, 6];
const PHASE = [0.3, 1.9, 4.1, 2.7, 5.2]; // fixed offsets so the harmonics never line up into a regular star

/** Relative radius (around 1) at angle `theta`, time `t` in seconds, and `energy` 0..1 (louder = wobblier). */
export function blobRadius(theta: number, t: number, energy: number): number {
  let r = 1;
  HARMONICS.forEach((k, i) => {
    const amp = (0.03 + 0.07 * energy) / Math.sqrt(k - 1);
    r += amp * Math.sin(k * theta + PHASE[i] + t * (0.6 + 0.25 * i) * (i % 2 ? -1 : 1));
  });
  return r;
}

const SPEED: Record<VoiceState, number> = { idle: 0.35, listening: 0.8, speaking: 1, working: 1.7 };

export function Blob({ state, level, className = '' }: { state: VoiceState; level: () => number; className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const live = useRef({ state, level });
  live.current = { state, level };

  useEffect(() => {
    const c = canvas.current!;
    const g = c.getContext('2d')!;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let frame = 0;
    let clock = 0; // animation time, advancing faster in livelier states
    let energy = 0;
    let last = performance.now();

    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const dpr = devicePixelRatio || 1;
      const w = c.clientWidth, h = c.clientHeight;
      if (!w || !h) return;
      if (c.width !== Math.round(w * dpr)) c.width = Math.round(w * dpr);
      if (c.height !== Math.round(h * dpr)) c.height = Math.round(h * dpr);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);

      const { state, level } = live.current;
      const loud = state === 'listening' || state === 'speaking' ? Math.min(1, level() * 6) : state === 'working' ? 0.35 : 0;
      energy += (loud - energy) * 0.12;
      clock += dt * SPEED[state];
      const t = reduced ? 0 : clock;
      const e = reduced ? 0 : energy;

      const cx = w / 2, cy = h / 2;
      const R = Math.min(w, h) * 0.2 * (1 + 0.1 * e);
      g.beginPath();
      for (let i = 0; i <= 96; i++) {
        const a = (i / 96) * Math.PI * 2;
        const r = R * blobRadius(a, t, e);
        const x = cx + r * Math.cos(a), y = cy + r * Math.sin(a);
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.closePath();

      // The light source circles slowly, so the colours swirl over the surface.
      const lx = cx + R * 0.35 * Math.cos(t * 0.7), ly = cy - R * 0.35 + R * 0.2 * Math.sin(t * 0.7);
      const fill = g.createRadialGradient(lx, ly, R * 0.05, cx, cy, R * 1.25);
      fill.addColorStop(0, '#99f6e4');
      fill.addColorStop(0.35, '#2dd4bf');
      fill.addColorStop(0.7, '#10b981');
      fill.addColorStop(1, '#0f766e');
      g.shadowColor = `rgba(16, 185, 129, ${0.35 + 0.35 * e})`;
      g.shadowBlur = R * (0.5 + 0.4 * e);
      g.fillStyle = fill;
      g.fill();
      g.shadowBlur = 0;
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);

  return <canvas ref={canvas} className={className} aria-hidden />;
}
