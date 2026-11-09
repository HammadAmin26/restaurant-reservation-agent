// Small pieces the staff dashboard's sections share

import type { ReactNode } from "react";

const RESERVATION_STATUS: Record<string, { label: string; className: string }> = {
  confirmed: { label: "Confirmed", className: "bg-emerald-50 text-emerald-800 ring-emerald-600/20" },
  cancelled: { label: "Cancelled", className: "bg-danger/5 text-danger ring-danger/20" },
};

const APPROVAL_STATUS: Record<string, { label: string; className: string }> = {
  not_required: { label: "Not required", className: "bg-ink/5 text-muted ring-ink/10" },
  pending: { label: "Awaiting approval", className: "bg-amber-50 text-amber-800 ring-amber-600/20" },
  approved: { label: "Approved", className: "bg-emerald-50 text-emerald-800 ring-emerald-600/20" },
  rejected: { label: "Rejected", className: "bg-danger/5 text-danger ring-danger/20" },
};

function Badge({ label, className }: { label: string; className: string }) {
  return (
    <span className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${className}`}>
      {label}
    </span>
  );
}

export function ReservationStatusBadge({ status }: { status: string }) {
  const known = RESERVATION_STATUS[status];
  return <Badge label={known?.label ?? status} className={known?.className ?? "bg-ink/5 text-muted ring-ink/10"} />;
}

export function ApprovalStatusBadge({ status }: { status: string }) {
  const known = APPROVAL_STATUS[status];
  return <Badge label={known?.label ?? status} className={known?.className ?? "bg-ink/5 text-muted ring-ink/10"} />;
}

// A white panel with an optional heading row
export function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-2xl border border-line bg-surface shadow-sm ${className}`}>{children}</div>;
}

export function LoadingState({ label }: { label: string }) {
  return (
    <div role="status" className="flex items-center justify-center gap-3 px-4 py-10 text-sm text-muted">
      <span aria-hidden="true" className="size-4 animate-spin rounded-full border-2 border-line border-t-brand" />
      {label}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="px-4 py-10 text-center">
      <p className="font-display text-lg font-semibold text-ink">{title}</p>
      {children && <p className="mx-auto mt-1 max-w-md text-sm text-muted">{children}</p>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center gap-3 px-4 py-10 text-center">
      <p className="text-sm text-danger">{message}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="rounded-full border border-line bg-surface px-4 py-1.5 text-sm font-semibold text-ink transition-colors hover:bg-cream"
        >
          Try again
        </button>
      )}
    </div>
  );
}
