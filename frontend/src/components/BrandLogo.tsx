import Link from "next/link";

export function BrandLogo() {
  return (
    <Link
      href="/"
      className="inline-flex items-center gap-3 rounded-lg text-ink"
      aria-label="Hammad Foods home"
    >
      <span
        aria-hidden="true"
        className="flex size-10 items-center justify-center rounded-full bg-brand font-display text-lg font-semibold text-white"
      >
        H
      </span>
      <span className="font-display text-xl font-semibold tracking-tight">
        Hammad Foods
      </span>
    </Link>
  );
}
