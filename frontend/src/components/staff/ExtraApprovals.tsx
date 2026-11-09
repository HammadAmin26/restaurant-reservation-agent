import Link from "next/link";
import type { PendingExtraApproval } from "@/lib/staff-api";
import { MEAL_LABELS } from "../chat/reservation-display";
import { formatLongDay, formatTimeRange, karachiDayOf } from "./staff-dates";
import { ApprovalStatusBadge, EmptyState, ErrorState, LoadingState, Panel } from "./staff-ui";

type ExtraApprovalsProps = {
  approvals: {
    data: PendingExtraApproval[] | null;
    error: string | null;
    isLoading: boolean;
    retry: () => void;
  };
};

// Extras waiting for staff approval on confirmed reservations from today on.
// Read-only for now: approving and rejecting need their own workflow.
export function ExtraApprovals({ approvals }: ExtraApprovalsProps) {
  const { data, error, isLoading, retry } = approvals;

  return (
    <section id="approvals" aria-labelledby="approvals-heading" className="scroll-mt-24 lg:scroll-mt-8">
      <div className="mb-3">
        <h2 id="approvals-heading" className="font-display text-2xl font-semibold text-ink">
          Extras awaiting approval
        </h2>
        <p className="mt-0.5 text-sm text-muted">Confirmed reservations from today on. View only: approving isn&apos;t available yet.</p>
      </div>

      <Panel>
        {isLoading ? (
          <LoadingState label="Loading extras..." />
        ) : error ? (
          <ErrorState message={error} onRetry={retry} />
        ) : data && data.length > 0 ? (
          <ul className="divide-y divide-line">
            {data.map((item, index) => (
              <li key={`${item.reservationCode}-${item.extra.extraKey}-${index}`}>
                <Link
                  href={`/staff/reservations/${encodeURIComponent(item.reservationCode)}`}
                  className="grid gap-x-4 gap-y-1 px-4 py-3 transition-colors hover:bg-cream/40 sm:grid-cols-[8rem_minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-center"
                >
                  <span className="font-mono text-sm font-semibold tracking-wide text-brand">{item.reservationCode}</span>
                  <span className="min-w-0">
                    <span className="block truncate font-semibold text-ink">{item.guestName}</span>
                    <span className="block text-xs text-muted">
                      {formatLongDay(karachiDayOf(item.startTime))}, {formatTimeRange(item.startTime, item.endTime)} ·{" "}
                      {MEAL_LABELS[item.mealType] ?? item.mealType}
                    </span>
                  </span>
                  <span className="text-sm text-ink">
                    {item.extra.name} × {item.extra.quantity}
                  </span>
                  <span>
                    <ApprovalStatusBadge status={item.extra.approvalStatus} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="Nothing to approve">No upcoming reservation has an extra waiting for approval.</EmptyState>
        )}
      </Panel>
    </section>
  );
}
