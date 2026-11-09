import { Suspense } from "react";
import { StaffReservationDetails } from "@/components/staff/StaffReservationDetails";
import { LoadingState } from "@/components/staff/staff-ui";

async function Details({ params }: Pick<PageProps<"/staff/reservations/[reservationCode]">, "params">) {
  const { reservationCode } = await params;
  // key resets the page's state when the URL points to another reservation
  return <StaffReservationDetails key={reservationCode} reservationCode={decodeURIComponent(reservationCode)} />;
}

export default function StaffReservationPage({ params }: PageProps<"/staff/reservations/[reservationCode]">) {
  return (
    <Suspense fallback={<LoadingState label="Loading the reservation..." />}>
      <Details params={params} />
    </Suspense>
  );
}
