// The Ottoman logo, alive: built from logo.svg's own paths so each part (body, sparkle, eyes) can move on its own.
import { motion, useAnimationFrame, useMotionValue, useReducedMotion, useSpring, useTransform, type TargetAndTransition } from 'motion/react';
import { useId } from 'react';
import logoSvg from '../logo.svg?raw';
import type { VoiceState } from '../voiceState';

// logo.svg holds four paths in this order: body (with the top sparkle), small left sparkle, left eye, right eye.
const doc = new DOMParser().parseFromString(logoSvg, 'image/svg+xml');
const svg = doc.documentElement;
const VIEW_BOX = svg.getAttribute('viewBox') ?? '0 0 1254 1254';
const DEFS = svg.querySelector('defs')?.innerHTML ?? '';
const PATHS = [...svg.querySelectorAll('path')].map((p) => ({
  d: p.getAttribute('d') ?? '',
  fill: p.getAttribute('fill') ?? '',
  transform: p.getAttribute('transform') ?? undefined,
}));
const [BODY, SPARKLE, LEFT_EYE, RIGHT_EYE] = PATHS;

// Each part scales and turns around its own centre.
const PART = { transformBox: 'fill-box', transformOrigin: 'center' } as const;
const loop = (duration: number, extra: object = {}) => ({ duration, repeat: Infinity, ease: 'easeInOut' as const, ...extra });

const BODY_MOTION: Record<VoiceState, TargetAndTransition> = {
  idle: { scale: [1, 1.025, 1], y: 0, transition: loop(4) },
  listening: { scale: 1.04, y: 0, transition: { type: 'spring', stiffness: 200, damping: 18 } },
  working: { scale: 1, y: [0, -14, 0], transition: loop(1.1) },
  speaking: { scale: 1, y: 0, transition: { type: 'spring', stiffness: 200, damping: 18 } },
};
const EYES_MOTION: Record<VoiceState, TargetAndTransition> = {
  // A blink every few seconds.
  idle: { x: 0, y: 0, scaleY: [1, 1, 0.1, 1], transition: { duration: 0.35, times: [0, 0.4, 0.6, 1], repeat: Infinity, repeatDelay: 3.4 } },
  listening: { x: 0, y: -10, scaleY: 1.15, transition: { type: 'spring', stiffness: 220, damping: 16 } },
  // Glancing left and right, as if reading the page.
  working: { x: [0, -26, -26, 26, 26, 0], y: 0, scaleY: 1, transition: { duration: 2.6, times: [0, 0.15, 0.4, 0.55, 0.85, 1], repeat: Infinity, ease: 'easeInOut' } },
  speaking: { x: 0, y: 0, scaleY: 1, transition: { type: 'spring', stiffness: 200, damping: 18 } },
};
const SPARKLE_MOTION: Record<VoiceState, TargetAndTransition> = {
  idle: { rotate: 0, scale: [1, 0.72, 1], opacity: [1, 0.65, 1], transition: loop(2.4) },
  listening: { rotate: 0, scale: [1, 1.2, 1], opacity: 1, transition: loop(1.2) },
  working: { rotate: 360, scale: 1, opacity: 1, transition: { duration: 2.8, repeat: Infinity, ease: 'linear' } },
  speaking: { rotate: 0, scale: [1, 1.15, 1], opacity: 1, transition: loop(0.8) },
};

interface Props {
  state: VoiceState;
  size: number;
  /** Live loudness (0..1) of whoever is talking: Ottoman when speaking, the user when listening. */
  level?: () => number;
  className?: string;
  /** All white, for sitting on a brand-coloured background such as the stage blob. */
  mono?: boolean;
}

export function OttomanMark({ state, size, level, className = '', mono = false }: Props) {
  const reduced = useReducedMotion();
  const id = useId().replace(/:/g, '');
  // Gradient ids are made unique per mark, so two marks on the page never share (or lose) a gradient.
  const defs = DEFS.replace(/id="([^"]+)"/g, `id="$1-${id}"`);
  const fill = (f: string) => (mono ? '#fff' : f.replace(/url\(#([^)]+)\)/, `url(#$1-${id})`));

  // Live loudness, smoothed by springs: while speaking the eyes squash and the body swells with the voice;
  // while listening only the halo follows the user's voice.
  const talk = useMotionValue(0);
  const glow = useMotionValue(0);
  useAnimationFrame(() => {
    const v = !reduced && level && (state === 'speaking' || state === 'listening') ? Math.min(1, level() * 6) : 0;
    talk.set(state === 'speaking' ? v : 0);
    glow.set(v);
  });
  const talkSmooth = useSpring(talk, { stiffness: 400, damping: 30 });
  const eyeTalk = useTransform(talkSmooth, [0, 1], [1, 0.45]);
  const bodyTalk = useTransform(talkSmooth, [0, 1], [1, 1.06]);
  const haloScale = useTransform(useSpring(glow, { stiffness: 120, damping: 20 }), [0, 1], [0.85, 1.35]);

  const pick = (m: Record<VoiceState, TargetAndTransition>) => (reduced ? undefined : m[state]);
  return (
    <span className={`relative inline-grid shrink-0 place-items-center ${className}`} style={{ width: size, height: size }} aria-hidden>
      {state !== 'idle' && !reduced && !mono && (
        <motion.span
          className="absolute inset-[-18%] rounded-full bg-[radial-gradient(circle,#10b98155_0%,#10b98100_70%)]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          style={{ scale: haloScale }}
        />
      )}
      <svg viewBox={VIEW_BOX} width={size} height={size} className={`relative overflow-visible ${mono ? 'drop-shadow-[0_2px_10px_rgba(4,47,46,0.45)]' : ''}`}>
        <defs dangerouslySetInnerHTML={{ __html: defs }} />
        <motion.g style={PART} animate={pick(BODY_MOTION)}>
          <motion.g style={{ ...PART, scale: bodyTalk }}>
            <path d={BODY.d} fill={fill(BODY.fill)} transform={BODY.transform} />
          </motion.g>
        </motion.g>
        <motion.g style={PART} animate={pick(SPARKLE_MOTION)}>
          <path d={SPARKLE.d} fill={fill(SPARKLE.fill)} transform={SPARKLE.transform} />
        </motion.g>
        <motion.g style={PART} animate={pick(EYES_MOTION)}>
          <motion.g style={{ ...PART, scaleY: eyeTalk }}>
            <path d={LEFT_EYE.d} fill={fill(LEFT_EYE.fill)} transform={LEFT_EYE.transform} />
            <path d={RIGHT_EYE.d} fill={fill(RIGHT_EYE.fill)} transform={RIGHT_EYE.transform} />
          </motion.g>
        </motion.g>
      </svg>
    </span>
  );
}
