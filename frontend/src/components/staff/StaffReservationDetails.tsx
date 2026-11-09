"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { getStaffReservation } from "@/lib/staff-api";
import { formatPkr, MEAL_LABELS, Row } from "../chat/reservation-display";
import { formatDateTime, formatLongDay, formatTimeRange, karachiDayOf } from "./staff-dates";
import { ApprovalStatusBadge, EmptyState, ErrorState, LoadingState, Panel, ReservationStatusBadge } from "./staff-ui";
import { useApiData } from "./useApiData";

const SECTION_LABELS: Record<string, string> = { GENERAL: "General", FAMILY: "Family" };

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Panel>
      <h2 className="border-b border-line px-4 py-3 font-display text-lg font-semibold text-ink">{title}</h2>
      <div className="px-4 py-3">{children}</div>
    </Panel>
  );
}

const Fields = ({ children }: { children: ReactNode }) => (
  <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 text-sm">{children}</dl>
);

// Everything about one reservation, for staff. Read-only: every value and
// price is the backend's, shown as stored.
export function StaffReservationDetails({ reservationCode }: { reservationCode: string }) {
  const { data: reservation, error, errorStatus, isLoading, retry } = useApiData(
    () => getStaffReservation(reservationCode),
    reservationCode,
  );

  const backHref = reservation ? `/staff?date=${karachiDayOf(reservation.startTime)}` : "/staff";

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-4 py-6 sm:px-6 lg:py-8">
      <Link href={backHref} className="self-start rounded-lg text-sm font-semibold text-brand hover:text-brand-dark">
        ← Back to reservations
      </Link>

      {isLoading ? (
        <Panel>
          <LoadingState label="Loading the reservation..." />
        </Panel>
      ) : !reservation ? (
        <Panel>
          {/* A missing code is a 404, worth saying plainly; other failures can be retried */}
          {errorStatus === 404 ? (
            <EmptyState title="Reservation not found">
              There&apos;s no reservation with the code {reservationCode}.
            </EmptyState>
          ) : (
            <ErrorState message={error ?? "Something went wrong."} onRetry={retry} />
          )}
        </Panel>
      ) : (
        <>
          <header className="flex flex-wrap items-center gap-3">
            <h1 className="font-mono text-2xl font-semibold tracking-wide text-ink sm:text-3xl">{reservation.reservationCode}</h1>
            <ReservationStatusBadge status={reservation.status} />
            <p className="w-full text-sm text-muted">
              {formatLongDay(karachiDayOf(reservation.startTime))}, {formatTimeRange(reservation.startTime, reservation.endTime)} · Booked{" "}
              {formatDateTime(reservation.bookedAt)}
            </p>
          </header>

          {reservation.status === "cancelled" && (
            <div role="note" className="rounded-2xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
              This reservation was cancelled
              {reservation.cancelledAt ? ` on ${formatDateTime(reservation.cancelledAt)}` : ""}. Its tables are free for other guests.
            </div>
          )}

          <div className="grid gap-5 md:grid-cols-2">
            <Section title="Guest">
              <Fields>
                <Row label="Name">{reservation.guestName}</Row>
                <Row label="Phone">
                  <a href={`tel:${reservation.guestPhone}`} className="font-medium text-brand hover:text-brand-dark">
                    {reservation.guestPhone}
                  </a>
                </Row>
                <Row label="Code">
                  <span className="font-mono">{reservation.reservationCode}</span>
                </Row>
              </Fields>
            </Section>

            <Section title="Reservation">
              <Fields>
                <Row label="Date">{formatLongDay(karachiDayOf(reservation.startTime))}</Row>
                <Row label="Time">{formatTimeRange(reservation.startTime, reservation.endTime)}</Row>
                <Row label="Meal">{MEAL_LABELS[reservation.mealType] ?? reservation.mealType}</Row>
                <Row label="Adults">{reservation.adults}</Row>
                <Row label="Children">{reservation.children}</Row>
                <Row label="Status">
                  <ReservationStatusBadge status={reservation.status} />
                </Row>
                <Row label="Tables">
                  {reservation.tables.length > 0
                    ? reservation.tables.map((table) => (
                        <span key={table.tableNumber} className="block">
                          {table.tableNumber} · {SECTION_LABELS[table.section] ?? table.section} section · seats {table.capacity}
                        </span>
                      ))
                    : "None assigned"}
                </Row>
              </Fields>
            </Section>
          </div>

          <Section title="Extras">
            {reservation.extras.length === 0 ? (
              <p className="py-2 text-sm text-muted">No extras.</p>
            ) : (
              <div className="-mx-4 overflow-x-auto">
                <table className="w-full min-w-[34rem] text-left text-sm">
                  <thead>
                    <tr className="text-xs text-muted">
                      <th scope="col" className="px-4 pb-2 font-medium">Extra</th>
                      <th scope="col" className="px-2 pb-2 text-right font-medium">Qty</th>
                      <th scope="col" className="px-2 pb-2 text-right font-medium">Unit price</th>
                      <th scope="col" className="px-2 pb-2 text-right font-medium">Line total</th>
                      <th scope="col" className="px-4 pb-2 font-medium">Approval</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reservation.extras.map((extra) => (
                      <tr key={extra.extraKey} className="border-t border-line">
                        <td className="px-4 py-2 text-ink">
                          {extra.name}
                          {extra.extraKey === "outside_cake" && (
                            <span className="block text-xs text-muted">The guest is bringing their own cake</span>
                          )}
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums">{extra.quantity}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{formatPkr(extra.unitPricePaisa)}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{formatPkr(extra.lineTotalPaisa)}</td>
                        <td className="px-4 py-2">
                          <ApprovalStatusBadge status={extra.approvalStatus} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>

          <div className="grid gap-5 md:grid-cols-2">
            <Section title="Pricing">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm text-muted">Estimated total</span>
                <span className="font-display text-2xl font-semibold text-ink tabular-nums">
                  {formatPkr(reservation.estimatedTotalPaisa)}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted">As calculated by the booking system, including the extras above.</p>
            </Section>

            <Section title="Special request">
              {reservation.specialRequest ? (
                <p className="text-sm whitespace-pre-wrap text-ink wrap-anywhere">{reservation.specialRequest}</p>
              ) : (
                <p className="text-sm text-muted">No special request.</p>
              )}
            </Section>
          </div>
        </>
      )}
    </main>
  );
}
