'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/** True when the user asked the OS to reduce motion — we then skip animations. */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

interface TypewriterOpts {
  /** ms per character while typing. */
  speed?: number;
  /** ms per character while erasing (looping only). */
  deleteSpeed?: number;
  /** ms to hold the full text before erasing (looping only). */
  holdTime?: number;
  /** ms to wait, empty, before typing again (looping only). */
  pauseTime?: number;
  /** ms before the first character appears. */
  startDelay?: number;
  /** When true, loops forever: type → hold → erase → pause → type … */
  loop?: boolean;
  enabled?: boolean;
}

/**
 * Reveals `text` one character at a time. With `loop`, runs a type → hold →
 * erase → pause cycle forever. The caret `blinking` flag is true only while
 * idle (holding/pausing) so it reads as a steady caret while typing.
 * Disabled (instant full text, no blink) when not `enabled` or the user
 * prefers reduced motion.
 */
function useTypewriter(
  text: string,
  {
    speed = 60,
    deleteSpeed = 30,
    holdTime = 1900,
    pauseTime = 700,
    startDelay = 400,
    loop = false,
    enabled = true,
  }: TypewriterOpts,
): { shown: string; blinking: boolean } {
  const reduced = usePrefersReducedMotion();
  const [count, setCount] = useState(0);
  const [blinking, setBlinking] = useState(false);

  useEffect(() => {
    if (!enabled || reduced) {
      setCount(text.length);
      setBlinking(false);
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const after = (ms: number, fn: () => void) => {
      timer = setTimeout(() => {
        if (!cancelled) fn();
      }, ms);
    };

    let i = 0;
    setCount(0);
    setBlinking(false);

    const type = () => {
      i += 1;
      setCount(i);
      if (i < text.length) {
        after(speed, type);
      } else if (loop) {
        setBlinking(true); // idle caret while the full command is held
        after(holdTime, erase);
      } else {
        setBlinking(true); // one-shot: leave the caret blinking at the end
      }
    };
    const erase = () => {
      setBlinking(false);
      step();
    };
    const step = () => {
      i -= 1;
      setCount(i);
      if (i > 0) {
        after(deleteSpeed, step);
      } else {
        setBlinking(true); // pause, empty, before typing again
        after(pauseTime, () => {
          setBlinking(false);
          type();
        });
      }
    };

    after(startDelay, type);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [text, speed, deleteSpeed, holdTime, pauseTime, startDelay, loop, enabled, reduced]);

  return { shown: text.slice(0, count), blinking };
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to legacy path (clipboard API needs a secure context)
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function CopyButton({ text, className = '' }: { text: string; className?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const onClick = useCallback(async () => {
    const ok = await copyText(text);
    setState(ok ? 'copied' : 'failed');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 1800);
  }, [text]);

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Copy to clipboard"
      className={`shrink-0 border border-line px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.18em] transition-colors hover:border-accent/60 hover:text-white ${
        state === 'copied' ? 'border-ok/60 text-ok' : state === 'failed' ? 'text-warn' : 'text-mut'
      } ${className}`}
    >
      {state === 'copied' ? 'copied' : state === 'failed' ? 'failed' : 'copy'}
    </button>
  );
}

/**
 * Terminal-style block with a copy button. `display` may differ from copied text.
 * `wrap` shows the command in full (soft-wrapped) instead of in a horizontal
 * scroll box — used where the command should always be readable at a glance.
 */
export function CommandBlock({
  text,
  display,
  prompt = '$',
  wrap = false,
  typewriter = false,
}: {
  text: string;
  display?: string;
  prompt?: string | null;
  wrap?: boolean;
  /** Reveal the command one character at a time with a blinking caret. */
  typewriter?: boolean;
}) {
  const full = display ?? text;
  const { shown, blinking } = useTypewriter(full, { enabled: typewriter, loop: typewriter });
  const visible = typewriter ? shown : full;
  return (
    <div className="panel flex items-start gap-3 bg-[#070A0F] px-4 py-3">
      <pre
        // The full command stays in aria-label so assistive tech reads it whole,
        // even mid-animation; the visible text fills in character by character.
        aria-label={typewriter ? full : undefined}
        className={`min-w-0 flex-1 font-mono text-[13px] leading-6 text-zinc-200 ${
          wrap ? 'whitespace-pre-wrap break-normal' : 'overflow-x-auto whitespace-pre'
        }`}
      >
        {prompt ? <span className="select-none text-accent">{prompt} </span> : null}
        <span aria-hidden={typewriter || undefined}>{visible}</span>
        {typewriter ? (
          <span
            aria-hidden
            className={`ml-0.5 inline-block h-[1.05em] w-[0.55ch] translate-y-[2px] bg-accent align-baseline ${
              blinking ? 'animate-caret-blink' : ''
            }`}
          />
        ) : null}
      </pre>
      <CopyButton text={text} className="mt-0.5" />
    </div>
  );
}
