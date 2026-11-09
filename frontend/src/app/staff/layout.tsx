import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Staff dashboard | Hammad Foods",
};

const NAV = [
  { href: "/staff", label: "Overview" },
  { href: "/staff#reservations", label: "Reservations" },
  { href: "/staff#approvals", label: "Extra approvals" },
];

const linkClass = "rounded-lg px-3 py-2 text-sm font-medium text-muted transition-colors hover:bg-cream hover:text-ink";

// The staff area's shell: a sidebar on wide screens, a top bar on narrow ones.
// It's open to anyone: this demo has no staff login.
export default function StaffLayout({ children }: LayoutProps<"/staff">) {
  return (
    <div className="flex min-h-dvh flex-col lg:flex-row">
      <aside className="border-b border-line bg-surface lg:sticky lg:top-0 lg:flex lg:h-dvh lg:w-60 lg:shrink-0 lg:flex-col lg:border-r lg:border-b-0">
        <div className="flex items-center justify-between gap-3 px-4 py-3 lg:px-5 lg:py-5">
          <Link href="/staff" className="inline-flex items-center gap-3 rounded-lg text-ink">
            <span
              aria-hidden="true"
              className="flex size-9 items-center justify-center rounded-full bg-brand font-display text-base font-semibold text-white"
            >
              H
            </span>
            <span className="flex flex-col leading-tight">
              <span className="font-display text-lg font-semibold tracking-tight">Hammad Foods</span>
              <span className="text-xs font-semibold tracking-widest text-brand uppercase">Staff</span>
            </span>
          </Link>
          <Link href="/" className="rounded-full border border-line px-3 py-1.5 text-xs font-semibold text-ink hover:bg-cream lg:hidden">
            Guest site
          </Link>
        </div>

        <nav aria-label="Staff dashboard" className="overflow-x-auto px-2 pb-2 lg:flex-1 lg:px-3 lg:pb-0">
          <ul className="flex gap-1 whitespace-nowrap lg:flex-col">
            {NAV.map((item) => (
              <li key={item.href}>
                <Link href={item.href} className={`block ${linkClass}`}>
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <div className="hidden border-t border-line p-3 lg:block">
          <Link href="/" className={`block ${linkClass}`}>
            ← Guest reservations
          </Link>
        </div>
      </aside>

      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
