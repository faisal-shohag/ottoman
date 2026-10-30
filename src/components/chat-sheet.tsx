// The conversation sheet: messages and step groups, plus the floating input. Slides up over the voice stage.
import { AnimatePresence, motion, useDragControls } from 'motion/react';
import { useEffect, useRef, type RefObject } from 'react';
import { Check, ChevronRight, Info, ListChecks, LoaderCircle, SendHorizontal, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { OttomanMark } from '@/components/ottoman-mark';
import { VoiceWave } from '@/components/voice-wave';
import type { VoiceState } from '../voiceState';

export interface Step {
  name: string;
  args: any;
  problem: string;
  summary: string; // first line of the tool's output
}

export interface Entry {
  role: 'user' | 'assistant' | 'tool';
  text: string;
  open: boolean; // still receiving transcript chunks
  tool?: Step; // tool steps; tool entries without it are notices
}

// shrink-0: rows in the scrolling flex column must not shrink, or overflow-hidden content collapses to nothing.
const ROW = 'shrink-0 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-200';
const BUBBLE = `${ROW} max-w-[85%] rounded-2xl px-3.5 py-2 leading-relaxed break-words whitespace-pre-wrap`;
const ENTRY_CLASS = {
  user: `${BUBBLE} self-end rounded-br-md bg-user`,
  assistant: `${BUBBLE} self-start rounded-bl-md border bg-card`,
};

// "google.com/search?q=weather": host without www, plus the path and query when there is one.
const host = (url: unknown) => {
  try {
    const u = new URL(/^[a-z]+:/i.test(String(url)) ? String(url) : `https://${url}`);
    return decodeURIComponent(u.host.replace(/^www\./, '') + (u.pathname + u.search).replace(/^\/$/, ''));
  } catch {
    return String(url);
  }
};
// Plain words for the steps list; tools not listed fall back to their name.
const STEP_LABEL: Record<string, (s: Step) => string> = {
  navigate: (s) => `Opened ${host(s.args?.url)}`,
  new_tab: (s) => `Opened ${host(s.args?.url)} in a new tab`,
  click: (s) => s.summary.match(/^((?:Double-|Right-)?[Cc]licked "[^"]*")/)?.[1] ?? 'Clicked',
  click_at: () => 'Clicked a spot on the page',
  type: (s) => `Typed "${s.args?.text ?? ''}"`,
  press_key: (s) => `Pressed ${s.args?.key ?? 'a key'}`,
  scroll: (s) => `Scrolled ${s.args?.direction ?? ''}`.trim(),
  screenshot: () => 'Looked at the page',
  snapshot: () => 'Read the page',
  read_page: () => 'Read the text',
};
export const stepLabel = (e: Entry) =>
  !e.tool ? e.text : (STEP_LABEL[e.tool.name]?.(e.tool) ?? e.tool.name.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()));

/** Consecutive tool steps, folded into one expandable line. */
function Steps({ steps, active }: { steps: Entry[]; active: boolean }) {
  const failed = steps.filter((s) => s.tool?.problem).length;
  return (
    <details className={`group ${ROW} max-w-[85%] min-w-0 self-start rounded-xl border border-dashed text-xs text-muted-foreground`}>
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-xl px-2.5 py-1.5 select-none hover:bg-muted/50 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3.5 shrink-0 transition-transform group-open:rotate-90" />
        {active ? <LoaderCircle className="size-3.5 shrink-0 animate-spin text-primary" /> : <ListChecks className="size-3.5 shrink-0" />}
        <span className="shrink-0 font-medium text-foreground/80">
          {steps.length} {steps.length === 1 ? 'step' : 'steps'}
        </span>
        <span className="min-w-0 truncate">· {stepLabel(steps[steps.length - 1])}</span>
        {failed > 0 && <span className="shrink-0 text-destructive">· {failed} failed</span>}
      </summary>
      <ol className="flex flex-col gap-1 border-t border-dashed px-2.5 py-2">
        {steps.map((s, i) => (
          <li key={i} className="entry tool flex min-w-0 gap-1.5" title={s.text}>
            {!s.tool ? <Info className="mt-0.5 size-3.5 shrink-0" /> : s.tool.problem ? <X className="mt-0.5 size-3.5 shrink-0 text-destructive" /> : <Check className="mt-0.5 size-3.5 shrink-0 text-primary" />}
            <div className="min-w-0">
              <div className="truncate">{stepLabel(s)}</div>
              {s.tool?.problem && <div className="line-clamp-2 text-destructive">{s.tool.problem}</div>}
            </div>
          </li>
        ))}
      </ol>
    </details>
  );
}

/** Folds runs of consecutive tool rows into one group; keys are the index of each row's first entry. */
function groupRows(entries: Entry[]) {
  const rows: { key: number; entry?: Entry; steps?: Entry[] }[] = [];
  entries.forEach((e, i) => {
    const prev = rows[rows.length - 1];
    if (e.role !== 'tool') rows.push({ key: i, entry: e });
    else if (prev?.steps) prev.steps.push(e);
    else rows.push({ key: i, steps: [e] });
  });
  return rows;
}

interface SheetProps {
  open: boolean;
  onClose: () => void;
  entries: Entry[];
  busy: boolean;
  voice: VoiceState;
  level: () => number;
  wave?: { frequencies(out: Uint8Array<ArrayBuffer>): boolean };
  text: string;
  setText: (t: string) => void;
  send: () => void;
  input: RefObject<HTMLInputElement | null>;
}

/**
 * The conversation, sliding up over the stage: messages and steps, with a floating input at the bottom.
 * The list stays mounted while closed (just off-screen and inert), so its rows can always be found.
 */
export function ChatSheet({ open, onClose, entries, busy, voice, level, wave, text, setText, send, input }: SheetProps) {
  const drag = useDragControls();
  const bottom = useRef<HTMLDivElement>(null);
  const rows = groupRows(entries);

  // Braces matter: scrollIntoView returns a Promise in current Chromium, and React would call it as cleanup.
  useEffect(() => {
    if (open) bottom.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [open, entries, busy]);

  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !e.defaultPrevented && onClose();
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [open, onClose, input]);

  return (
    <>
      <AnimatePresence>
        {open && (
          <motion.div
            key="backdrop"
            className="absolute inset-0 z-30 bg-background/50 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
        )}
      </AnimatePresence>
      <motion.section
        className="absolute inset-x-0 bottom-0 z-40 flex h-[88%] flex-col rounded-t-3xl border-t bg-card shadow-2xl"
        aria-label="Conversation"
        inert={!open}
        initial={false}
        animate={{ y: open ? 0 : '105%' }}
        transition={{ type: 'spring', stiffness: 320, damping: 34 }}
        drag="y"
        dragControls={drag}
        dragListener={false}
        dragConstraints={{ top: 0, bottom: 0 }}
        dragElastic={{ top: 0, bottom: 0.7 }}
        onDragEnd={(_, info) => (info.offset.y > 120 || info.velocity.y > 600) && onClose()}
      >
        <div className="flex cursor-grab touch-none flex-col items-center px-3 pt-2 pb-2 active:cursor-grabbing" onPointerDown={(e) => drag.start(e)}>
          <span className="mb-2 h-1 w-10 rounded-full bg-muted-foreground/30" />
          <div className="flex w-full items-center gap-2.5">
            <OttomanMark state={voice} size={28} level={level} />
            <VoiceWave state={voice} source={wave} className="h-6 min-w-0 flex-1" />
            <Button variant="ghost" size="icon" className="rounded-full" aria-label="Close chat" onClick={onClose}>
              <X />
            </Button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-x-hidden overflow-y-auto border-t px-3 py-3">
          {!entries.length && <p className="m-auto text-sm text-muted-foreground">No messages yet. Talk to Ottoman or type below.</p>}
          {rows.map((r, i) =>
            r.steps ? (
              <Steps key={r.key} steps={r.steps} active={busy && i === rows.length - 1} />
            ) : (
              <div key={r.key} className={`entry ${r.entry!.role} ${ENTRY_CLASS[r.entry!.role as 'user' | 'assistant']}`}>
                {r.entry!.text}
              </div>
            ),
          )}
          <div ref={bottom} />
        </div>

        {open && (
          <div className="p-3 pt-0">
            <div className="flex items-center gap-1.5 rounded-2xl border bg-background p-1.5 shadow-lg transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/25">
              <Input
                ref={input}
                className="h-9 flex-1 border-0 bg-transparent px-2 shadow-none focus-visible:ring-0 dark:bg-transparent"
                value={text}
                placeholder="Type a request…"
                aria-label="Message"
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && send()}
              />
              <Button size="icon" className="rounded-xl" onClick={send} disabled={!text.trim()} title="Send (Enter)">
                <SendHorizontal />
                <span className="sr-only">Send</span>
              </Button>
            </div>
          </div>
        )}
      </motion.section>
    </>
  );
}
