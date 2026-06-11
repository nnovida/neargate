'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

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
}: {
  text: string;
  display?: string;
  prompt?: string | null;
  wrap?: boolean;
}) {
  const shown = display ?? text;
  return (
    <div className="panel flex items-start gap-3 bg-[#070A0F] px-4 py-3">
      <pre
        className={`min-w-0 flex-1 font-mono text-[13px] leading-6 text-zinc-200 ${
          wrap ? 'whitespace-pre-wrap break-words' : 'overflow-x-auto whitespace-pre'
        }`}
      >
        {prompt ? <span className="select-none text-accent">{prompt} </span> : null}
        {shown}
      </pre>
      <CopyButton text={text} className="mt-0.5" />
    </div>
  );
}
