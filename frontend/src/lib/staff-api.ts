// Client for the Express staff dashboard routes. They are read-only and, as
// this is a demo, public: there's no staff login. Amounts are integer paisa
// and dates ISO strings, as in the other API clients.

import { request } from "./api";
import type { MealType, ReservationDetails } from "./reservation-api";

// The overview's counts, all from the database
export type StaffSummary = {
  // Today in Karachi, as YYYY-MM-DD
  today: string;
  // Confirmed reservations starting today
  todayReservations: number;
  // Confirmed reservations that haven't started yet
  upcomingReservations: number;
  confirmedReservations: number;
  cancelledReservations: number;
  // Extras awaiting approval on confirmed reservations from today on
  pendingExtraApprovals: number;
};

// A reservation in the list: everything but the guest's phone
export type StaffReservation = Omit<ReservationDetails, "guestPhone">;

export type StaffReservationList = {
  date: string | null;
  search: string | null;
  reservations: StaffReservation[];
  // True when a search without a date matched more than the backend returns
  truncated: boolean;
};

// One reservation with everything staff need, and when it was booked
export type StaffReservationDetails = ReservationDetails & { bookedAt: string };

export type PendingExtraApproval = {
  reservationCode: string;
  guestName: string;
  startTime: string;
  endTime: string;
  mealType: MealType;
  extra: { extraKey: string; name: string; quantity: number; approvalStatus: string };
};

export type StatusFilter = "all" | "confirmed" | "cancelled";
export type MealFilter = "all" | "buffet" | "a_la_carte";

export type StaffReservationQuery = {
  // YYYY-MM-DD in Karachi; left out, the search covers every day
  date?: string;
  search?: string;
  status: StatusFilter;
  mealType: MealFilter;
};

export function getStaffSummary() {
  return request<StaffSummary>("/staff/dashboard/summary");
}

// Reservations for a day or a search; the backend needs at least one of them
export function getStaffReservations({ date, search, status, mealType }: StaffReservationQuery) {
  const query = new URLSearchParams();
  if (date) query.set("date", date);
  if (search) query.set("search", search);
  if (status !== "all") query.set("status", status);
  if (mealType !== "all") query.set("mealType", mealType);
  return request<StaffReservationList>(`/staff/reservations?${query}`);
}

export function getStaffReservation(reservationCode: string) {
  return request<StaffReservationDetails>(`/staff/reservations/${encodeURIComponent(reservationCode)}`);
}

export function getPendingExtraApprovals() {
  return request<PendingExtraApproval[]>("/staff/extra-approvals");
}
