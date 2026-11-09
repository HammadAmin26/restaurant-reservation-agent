"use client";

import { useState, type KeyboardEvent, type SubmitEvent } from "react";

type MessageInputProps = {
  isSending: boolean;
  onSend: (content: string) => Promise<boolean>;
};

// Send errors are shown by ChatWindow as a toast
export function MessageInput({ isSending, onSend }: MessageInputProps) {
  const [draft, setDraft] = useState("");
  const canSend = draft.trim() !== "" && !isSending;

  async function submit() {
    if (!canSend) return;

    // The message moves into the chat right away. If it isn't saved, put it back.
    const content = draft;
    setDraft("");
    const wasSent = await onSend(content);
    if (!wasSent) setDraft(content);
  }

  function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    submit();
  }

  // Enter sends, Shift+Enter adds a new line
  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mx-auto w-full max-w-3xl px-4 py-3">
      <div className="flex items-end gap-2">
        <label htmlFor="message" className="sr-only">
          Your message
        </label>
        <textarea
          id="message"
          rows={1}
          value={draft}
          // Locked until the API answers, so only one message is sent at a time
          readOnly={isSending}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type your message..."
          className="max-h-32 min-h-12 flex-1 resize-none rounded-3xl border border-line bg-surface px-4 py-3 text-ink field-sizing-content placeholder:text-muted"
        />
        <button
          type="submit"
          disabled={!canSend}
          className="h-12 rounded-full bg-brand px-6 font-semibold text-white transition-colors hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSending ? "Sending..." : "Send"}
        </button>
      </div>
    </form>
  );
}
