import Link from "next/link";

type ChatErrorProps = {
  message: string;
  onRetry?: () => void;
};

export function ChatError({ message, onRetry }: ChatErrorProps) {
  return (
    <div
      role="alert"
      className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-5 px-4 py-12 text-center"
    >
      <h1 className="font-display text-2xl font-semibold text-ink">
        We hit a small snag
      </h1>
      <p className="text-muted">{message}</p>
      <div className="flex flex-wrap items-center justify-center gap-3">
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="rounded-full bg-brand px-6 py-2.5 font-semibold text-white transition-colors hover:bg-brand-dark"
          >
            Try again
          </button>
        )}
        <Link
          href="/"
          className="rounded-full border border-line bg-surface px-6 py-2.5 font-semibold text-ink transition-colors hover:bg-cream"
        >
          Back to home
        </Link>
      </div>
    </div>
  );
}
