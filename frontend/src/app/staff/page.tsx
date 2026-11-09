import { Suspense } from "react";
import { StaffDashboard } from "@/components/staff/StaffDashboard";
import { LoadingState } from "@/components/staff/staff-ui";
import { isDay, karachiToday } from "@/components/staff/staff-dates";

async function Dashboard({ searchParams }: Pick<PageProps<"/staff">, "searchParams">) {
  const { date } = await searchParams;
  const today = karachiToday();
  // ?date= opens that day, such as when coming back from a reservation's page
  const initialDate = typeof date === "string" && isDay(date) ? date : today;
  return <StaffDashboard today={today} initialDate={initialDate} />;
}

export default function StaffPage({ searchParams }: PageProps<"/staff">) {
  return (
    <Suspense fallback={<LoadingState label="Loading the dashboard..." />}>
      <Dashboard searchParams={searchParams} />
    </Suspense>
  );
}
