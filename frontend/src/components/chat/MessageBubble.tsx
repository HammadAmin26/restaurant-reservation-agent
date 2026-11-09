import type { ReactNode } from "react";
import type { MessageRole } from "@/lib/api";

type MessageBubbleProps = {
  role: MessageRole;
  content: string;
  // Not set for the welcome message, which isn't stored in the database
  createdAt?: string;
  // True while the message is on its way to the API and not saved yet
  isPending?: boolean;
  // A component belonging to this message, shown under the bubble
  children?: ReactNode;
};

function formatTime(createdAt: string) {
  return new Date(createdAt).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

export function MessageBubble({
  role,
  content,
  createdAt,
  isPending = false,
  children,
}: MessageBubbleProps) {
  const isGuest = role === "guest";

  return (
    <li className={`flex flex-col ${isGuest ? "items-end" : "items-start"}`}>
      <span className="mb-1 px-1 text-xs font-medium text-muted">
        {isGuest ? "You" : "Hammad Foods"}
      </span>
      <div
        className={`max-w-[85%] rounded-2xl px-4 py-2.5 leading-relaxed wrap-anywhere whitespace-pre-wrap sm:max-w-[70%] ${
          isGuest
            ? "rounded-br-sm bg-brand text-white"
            : "rounded-bl-sm border border-line bg-surface text-ink"
        } ${isPending ? "opacity-60" : ""}`}
      >
        {content}
      </div>
      {isPending && (
        <span className="mt-1 px-1 text-xs text-muted">Sending...</span>
      )}
      {createdAt && (
        <time dateTime={createdAt} className="mt-1 px-1 text-xs text-muted">
          {formatTime(createdAt)}
        </time>
      )}
      {children && <div className="mt-2 w-full">{children}</div>}
    </li>
  );
}
