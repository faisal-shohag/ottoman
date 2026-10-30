import { describe, expect, it } from 'vitest';
import { spokenWords, voiceState } from './voiceState';

describe('voiceState', () => {
  it('prefers speaking, then working, then listening', () => {
    expect(voiceState({ micOn: true, busy: true, speaking: true })).toBe('speaking');
    expect(voiceState({ micOn: true, busy: true, speaking: false })).toBe('working');
    expect(voiceState({ micOn: true, busy: false, speaking: false })).toBe('listening');
    expect(voiceState({ micOn: false, busy: false, speaking: false })).toBe('idle');
  });
});

describe('barTargets', () => {
  it('draws quiet dots when idle and a mirrored spectrum while listening', async () => {
    const { barTargets } = await import('./components/voice-wave');
    expect(new Set(barTargets('idle', null, 0))).toEqual(new Set([0.06]));
    const bins = Uint8Array.from({ length: 128 }, (_, i) => 255 - i * 2);
    const bars = barTargets('listening', bins, 0);
    expect(bars).toEqual([...bars].reverse());
    expect(bars[13]).toBeGreaterThan(bars[0]);
  });

  it('runs a travelling wave while working without sound', async () => {
    const { barTargets } = await import('./components/voice-wave');
    const a = barTargets('working', null, 0);
    const b = barTargets('working', null, 500);
    expect(a).not.toEqual(b);
    expect(Math.max(...a)).toBeLessThanOrEqual(0.75);
  });
});

describe('blobRadius', () => {
  it('stays round-ish when calm and wobbles more with energy', async () => {
    const { blobRadius } = await import('./components/blob');
    const spread = (energy: number) => {
      const rs = Array.from({ length: 64 }, (_, i) => blobRadius((i / 64) * Math.PI * 2, 1.3, energy));
      return Math.max(...rs) - Math.min(...rs);
    };
    expect(spread(0)).toBeLessThan(0.2);
    expect(spread(1)).toBeGreaterThan(spread(0) * 2);
    expect(Math.min(...Array.from({ length: 64 }, (_, i) => blobRadius(i / 10, 2, 1)))).toBeGreaterThan(0.6);
  });
});

describe('spokenWords', () => {
  it('reveals words in step with the audio already played', () => {
    expect(spokenWords(40, 0, true)).toBe(0);
    expect(spokenWords(40, 0.25, true)).toBe(10);
    expect(spokenWords(40, 1, false)).toBe(40);
  });

  it('waits for audio while streaming, and shows finished text without audio in full', () => {
    expect(spokenWords(12, null, true)).toBe(0);
    expect(spokenWords(12, null, false)).toBe(12);
  });
});
