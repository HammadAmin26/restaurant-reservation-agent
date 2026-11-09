import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ReservationTester } from "@/components/dev/ReservationTester";

export const metadata: Metadata = {
  title: "Reservation tester | Hammad Foods",
};

async function Tester({
  params,
}: Pick<PageProps<"/dev/reservations/[conversationId]">, "params">) {
  const { conversationId } = await params;

  // key resets the tester's state when the URL points to another conversation
  return <ReservationTester key={conversationId} conversationId={conversationId} />;
}

// A developer tool for trying the reservation API from the browser.
// It doesn't exist in production builds.
export default function ReservationTesterPage({
  params,
}: PageProps<"/dev/reservations/[conversationId]">) {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }

  return (
    <Suspense
      fallback={
        <div role="status" className="flex flex-1 items-center justify-center p-8 text-sm text-muted">
          Loading the reservation tester...
        </div>
      }
    >
      <Tester params={params} />
    </Suspense>
  );
}
