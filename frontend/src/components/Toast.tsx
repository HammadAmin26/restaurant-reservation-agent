"use client";

import { useEffect } from "react";

type ToastProps = {
  message: string | null;
  onDismiss: () => void;
};

// How long a toast stays on screen before it hides itself
const TOAST_DURATION_MS = 6000;

// A small error notice at the top of the screen. Shows nothing when message is null.
export function Toast({ message, onDismiss }: ToastProps) {
  useEffect(() => {
    if (!message) return;

    const timer = setTimeout(onDismiss, TOAST_DURATION_MS);
    return () => clearTimeout(timer);
  }, [message, onDismiss]);

  if (!message) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 top-4 z-50 flex justify-center px-4">
      <div
        role="alert"
        className="pointer-events-auto flex w-full max-w-md items-start gap-3 rounded-2xl border border-line border-l-4 border-l-danger bg-surface px-4 py-3 shadow-lg motion-safe:animate-[toast-in_200ms_ease-out]"
      >
        <p className="flex-1 text-sm text-ink">{message}</p>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="-mr-1 rounded-full px-2 text-lg leading-none text-muted hover:text-ink"
        >
          ×
        </button>
      </div>
    </div>
  );
}
