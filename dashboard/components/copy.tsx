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

/**
 * Reveals `text` one character at a time. Starts after `startDelay` ms and
 * advances every `speed` ms. Disabled (instant full text) when not `enabled`
 * or the user prefers reduced motion.
 */
function useTypewriter(
  text: string,
  { speed = 26, startDelay = 350, enabled = true }: { speed?: number; startDelay?: number; enabled?: boolean },
): { shown: string; done: boolean } {
  const reduced = usePrefersReducedMotion();
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!enabled || reduced) {
      setCount(text.length);
      return;
    }
    setCount(0);
    let i = 0;
    let tick: ReturnType<typeof setTimeout>;
    const begin = setTimeout(function step() {
      i += 1;
      setCount(i);
      if (i < text.length) tick = setTimeout(step, speed);
    }, startDelay);
    return () => {
      clearTimeout(begin);
      clearTimeout(tick);
    };
  }, [text, speed, startDelay, enabled, reduced]);

  return { shown: text.slice(0, count), done: count >= text.length };
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
  const { shown, done } = useTypewriter(full, { enabled: typewriter });
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
              done ? 'animate-caret-blink' : ''
            }`}
          />
        ) : null}
      </pre>
      <CopyButton text={text} className="mt-0.5" />
    </div>
  );
}
