export function ChatLoading() {
  return (
    <div
      role="status"
      className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 px-4 py-6"
    >
      <span className="sr-only">Loading your conversation...</span>
      <div className="h-12 w-3/5 animate-pulse rounded-2xl bg-line" />
      <div className="h-12 w-2/5 animate-pulse self-end rounded-2xl bg-line" />
      <div className="h-12 w-1/2 animate-pulse rounded-2xl bg-line" />
    </div>
  );
}
