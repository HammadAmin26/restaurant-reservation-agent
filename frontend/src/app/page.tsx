import Link from "next/link";
import { BrandLogo } from "@/components/BrandLogo";
import { StartReservationButton } from "@/components/StartReservationButton";

export default function HomePage() {
  return (
    <main className="flex min-h-dvh flex-col">
      <header className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4 px-4 py-5 sm:px-6">
        <BrandLogo />
        {/* Open to anyone: this demo has no staff login */}
        <Link
          href="/staff"
          className="rounded-full border border-line bg-surface px-4 py-2 text-sm font-semibold text-ink shadow-sm transition-colors hover:border-brand/40 hover:bg-cream"
        >
          Staff Dashboard
        </Link>
      </header>

      <section className="mx-auto flex w-full max-w-5xl flex-1 flex-col justify-center px-4 pb-16 sm:px-6">
        <p className="text-sm font-semibold tracking-widest text-brand uppercase">
          Reservations
        </p>
        <h1 className="mt-4 max-w-2xl font-display text-4xl leading-tight font-semibold text-ink sm:text-6xl">
          Your table at Hammad Foods is one conversation away.
        </h1>
        <p className="mt-6 max-w-xl text-lg leading-relaxed text-muted">
          Tell us what you have in mind, and pick up right where you left off
          whenever you come back.
        </p>
        <div className="mt-10">
          <StartReservationButton />
        </div>
      </section>
    </main>
  );
}
