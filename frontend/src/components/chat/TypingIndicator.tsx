const DOT_DELAYS_MS = [0, 150, 300];

// Shown in place of the agent's reply while Claude is responding
export function TypingIndicator() {
  return (
    <li className="flex flex-col items-start">
      <span className="mb-1 px-1 text-xs font-medium text-muted">
        Hammad Foods
      </span>
      <div
        role="status"
        className="flex items-center gap-1.5 rounded-2xl rounded-bl-sm border border-line bg-surface px-4 py-4"
      >
        <span className="sr-only">Hammad Foods is typing...</span>
        {DOT_DELAYS_MS.map((delay) => (
          <span
            key={delay}
            aria-hidden="true"
            className="size-2 animate-bounce rounded-full bg-muted"
            style={{ animationDelay: `${delay}ms` }}
          />
        ))}
      </div>
    </li>
  );
}
