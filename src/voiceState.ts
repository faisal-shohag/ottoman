// What Ottoman is doing right now, for the animated mark and the voice dock.
import { useEffect, useRef, useState } from 'react';
import type { Assistant } from './live';

export type VoiceState = 'idle' | 'listening' | 'working' | 'speaking';

/** Speaker loudness (RMS) above which Ottoman counts as talking. */
export const SPEAKING_LEVEL = 0.015;
/** Keeps "speaking" through the short gaps between words, so the state does not flicker. */
export const SPEAKING_HOLD_MS = 700;

export function voiceState(s: { micOn: boolean; busy: boolean; speaking: boolean }): VoiceState {
  if (s.speaking) return 'speaking';
  if (s.busy) return 'working';
  if (s.micOn) return 'listening';
  return 'idle';
}

/** Tracks the voice state, sampling the speaker every animation frame; re-renders only when the state changes. */
export function useVoiceState(assistant: Assistant | null, micOn: boolean, busy: boolean): VoiceState {
  const [speaking, setSpeaking] = useState(false);
  const lastLoud = useRef(0);
  useEffect(() => {
    if (!assistant) return;
    const { speaker } = assistant.audio();
    let frame = 0;
    const tick = () => {
      const now = performance.now();
      if (speaker.level() > SPEAKING_LEVEL) lastLoud.current = now;
      setSpeaking(now - lastLoud.current < SPEAKING_HOLD_MS);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [assistant]);
  return voiceState({ micOn, busy, speaking });
}

/**
 * How many words of Ottoman's reply have been heard: the reply's audio and text both arrive faster than real time, so
 * words are revealed in step with the share of audio already played. Before any audio arrives, a reply still being
 * written shows nothing yet, and a finished one (e.g. text-only) shows in full.
 */
export function spokenWords(count: number, heard: number | null, streaming: boolean): number {
  if (heard === null) return streaming ? 0 : count;
  return Math.min(count, Math.ceil(count * heard));
}
