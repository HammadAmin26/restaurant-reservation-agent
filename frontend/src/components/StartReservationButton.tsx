"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { createConversation, getFriendlyErrorMessage } from "@/lib/api";

export function StartReservationButton() {
  const router = useRouter();
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleStart() {
    setIsStarting(true);
    setError(null);

    try {
      const conversation = await createConversation();
      router.push(`/reserve/${conversation.id}`);
    } catch (startError) {
      setError(getFriendlyErrorMessage(startError));
      setIsStarting(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-3">
      <button
        type="button"
        onClick={handleStart}
        disabled={isStarting}
        className="rounded-full bg-brand px-8 py-3.5 text-base font-semibold text-white shadow-sm transition-colors hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isStarting ? "Starting..." : "Start a reservation"}
      </button>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
