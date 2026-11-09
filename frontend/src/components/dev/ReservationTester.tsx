"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode, type SubmitEvent } from "react";
import { BrandLogo } from "@/components/BrandLogo";
import { ApiError } from "@/lib/api";
import {
  acceptProposal,
  declineProposal,
  getConversationReservations,
  proposeModification,
  proposeReservation,
  type ConversationReservation,
  type ExtraKey,
  type MealType,
  type Proposal,
  type ReservationDetails,
  type ReservationExtra,
  type ModificationProposalPayload,
  type ReservationProposalPayload,
  type StoredModificationPayload,
  type ReservationTable,
} from "@/lib/reservation-api";

type ReservationTesterProps = {
  conversationId: string;
};

// The extras the backend accepts, with the names it gives them
const EXTRAS: { key: ExtraKey; label: string }[] = [
  { key: "birthday_cake", label: "Birthday cake" },
  { key: "candles", label: "Candles" },
  { key: "high_chair", label: "High chair" },
  { key: "balloons", label: "Balloons" },
  { key: "birthday_decorations", label: "Birthday decorations" },
];

const MEAL_TYPES: { value: MealType; label: string }[] = [
  { value: "buffet_lunch", label: "Buffet lunch" },
  { value: "buffet_dinner", label: "Buffet dinner" },
  { value: "a_la_carte", label: "À la carte" },
];

const mealLabel = (mealType: string) => MEAL_TYPES.find((meal) => meal.value === mealType)?.label ?? mealType;

// Form values are kept as typed, so a failed request never loses them
type CreateForm = {
  guestName: string;
  guestPhone: string;
  date: string;
  time: string;
  mealType: MealType;
  adults: string;
  children: string;
  childrenUnder3: string;
  specialRequest: string;
  extras: Record<ExtraKey, string>;
  outsideCake: boolean;
};

const EMPTY_FORM: CreateForm = {
  guestName: "",
  guestPhone: "",
  date: "",
  time: "",
  mealType: "buffet_dinner",
  adults: "2",
  children: "0",
  childrenUnder3: "",
  specialRequest: "",
  extras: { birthday_cake: "0", candles: "0", high_chair: "0", balloons: "0", birthday_decorations: "0" },
  outsideCake: false,
};

type LogEntry = {
  id: number;
  name: string;
  ok: boolean;
  // Only known for failures: the API client returns just the data on success
  status: number | null;
  code?: string;
  at: string;
  body: unknown;
};

type CallResult<T> = { ok: true; data: T } | { ok: false; error: unknown };

const isWholeNumber = (value: string) => /^\d+$/.test(value.trim());

// Basic checks only; the backend applies the real rules (party size, dates, phone…)
function validateForm(form: CreateForm): string[] {
  const errors: string[] = [];
  if (!form.guestName.trim()) errors.push("Guest name is required.");
  if (!form.guestPhone.trim()) errors.push("Guest phone is required.");
  if (!form.date) errors.push("Date is required.");
  if (form.mealType === "a_la_carte" && !form.time) errors.push("Time is required for à la carte.");
  if (!isWholeNumber(form.adults)) errors.push("Adults must be a whole number.");
  if (!isWholeNumber(form.children)) errors.push("Children must be a whole number.");
  if (form.childrenUnder3.trim() && !isWholeNumber(form.childrenUnder3)) {
    errors.push("Children under 3 must be a whole number.");
  }
  for (const extra of EXTRAS) {
    if (!isWholeNumber(form.extras[extra.key])) errors.push(`${extra.label} quantity must be a whole number.`);
  }
  return errors;
}

function toPayload(form: CreateForm): ReservationProposalPayload {
  return {
    guestName: form.guestName.trim(),
    guestPhone: form.guestPhone.trim(),
    date: form.date,
    ...(form.time && { time: form.time }),
    mealType: form.mealType,
    adults: Number(form.adults),
    children: Number(form.children),
    ...(form.childrenUnder3.trim() && { childrenUnder3: Number(form.childrenUnder3) }),
    extras: EXTRAS.filter((extra) => Number(form.extras[extra.key]) > 0).map((extra) => ({
      extraKey: extra.key,
      quantity: Number(form.extras[extra.key]),
    })),
    ...(form.outsideCake && { outsideCake: true }),
    ...(form.specialRequest.trim() && { specialRequest: form.specialRequest.trim() }),
  };
}

// The new details for an existing reservation, kept as typed
type ModifyForm = {
  reservationCode: string;
  guestPhone: string;
  date: string;
  time: string;
  mealType: MealType;
  adults: string;
  children: string;
  childrenUnder3: string;
};

const EMPTY_MODIFY_FORM: ModifyForm = {
  reservationCode: "",
  guestPhone: "",
  date: "",
  time: "",
  mealType: "buffet_dinner",
  adults: "2",
  children: "0",
  childrenUnder3: "",
};

// Basic checks only, as for the create form
function validateModifyForm(form: ModifyForm): string[] {
  const errors: string[] = [];
  if (!form.reservationCode.trim()) errors.push("Reservation code is required.");
  if (!form.guestPhone.trim()) errors.push("Guest phone is required.");
  if (!form.date) errors.push("New date is required.");
  if (form.mealType === "a_la_carte" && !form.time) errors.push("New time is required for à la carte.");
  if (!isWholeNumber(form.adults)) errors.push("Adults must be a whole number.");
  if (!isWholeNumber(form.children)) errors.push("Children must be a whole number.");
  if (form.childrenUnder3.trim() && !isWholeNumber(form.childrenUnder3)) {
    errors.push("Children under 3 must be a whole number.");
  }
  return errors;
}

function toModificationPayload(form: ModifyForm): ModificationProposalPayload {
  return {
    reservationCode: form.reservationCode.trim(),
    guestPhone: form.guestPhone.trim(),
    date: form.date,
    ...(form.time && { time: form.time }),
    mealType: form.mealType,
    adults: Number(form.adults),
    children: Number(form.children),
    ...(form.childrenUnder3.trim() && { childrenUnder3: Number(form.childrenUnder3) }),
  };
}

// Display only: amounts are always integer paisa in the API
function formatPkr(paisa: number) {
  const rupees = (paisa / 100).toLocaleString("en-US", {
    minimumFractionDigits: paisa % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return `PKR ${rupees}`;
}

const karachiDateTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Karachi",
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const karachiTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Karachi",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

// "Tue, 17 Nov 2026, 19:00–23:00" in Karachi time
const formatSlot = (start: string, end: string) =>
  `${karachiDateTime.format(new Date(start))}–${karachiTime.format(new Date(end))}`;

// The weekday of a YYYY-MM-DD date in Karachi, to make closed days easy to spot
const weekdayOf = (date: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Karachi", weekday: "long" }).format(new Date(`${date}T12:00:00+05:00`));

function formatCountdown(ms: number) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

// The backend's code and message, as one line
function describeError(error: unknown) {
  if (error instanceof ApiError) return error.code ? `${error.code}: ${error.message}` : error.message;
  return error instanceof Error ? error.message : "Unexpected error";
}

function errorBody(error: unknown) {
  if (error instanceof ApiError) {
    return { status: error.status, code: error.code, kind: error.kind, message: error.message, data: error.data };
  }
  return { message: error instanceof Error ? error.message : String(error) };
}

// A field from ApiError.data, if it's there
function errorData<T>(error: unknown, key: string): T | undefined {
  if (error instanceof ApiError && error.data && typeof error.data === "object" && key in error.data) {
    return (error.data as Record<string, T>)[key];
  }
  return undefined;
}

// Try the reservation API for one conversation, from the browser
export function ReservationTester({ conversationId }: ReservationTesterProps) {
  const [form, setForm] = useState<CreateForm>(EMPTY_FORM);
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const [createError, setCreateError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const [modifyForm, setModifyForm] = useState<ModifyForm>(EMPTY_MODIFY_FORM);
  const [modifyErrors, setModifyErrors] = useState<string[]>([]);
  const [modifyError, setModifyError] = useState<string | null>(null);
  const [isModifying, setIsModifying] = useState(false);

  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [acceptedReservation, setAcceptedReservation] = useState<ReservationDetails | null>(null);
  const [proposalError, setProposalError] = useState<string | null>(null);
  const [proposalAction, setProposalAction] = useState<"accept" | "decline" | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const [includeCancelled, setIncludeCancelled] = useState(false);
  const [reservations, setReservations] = useState<ConversationReservation[] | null>(null);
  const [reservationsError, setReservationsError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const [log, setLog] = useState<LogEntry[]>([]);

  // Run an API call and add it to the log
  const run = useCallback(async <T,>(name: string, call: () => Promise<T>): Promise<CallResult<T>> => {
    const at = new Date().toLocaleTimeString();
    try {
      const data = await call();
      setLog((entries) => [{ id: Date.now() + Math.random(), name, ok: true, status: null, at, body: data }, ...entries]);
      return { ok: true, data };
    } catch (error) {
      setLog((entries) => [
        {
          id: Date.now() + Math.random(),
          name,
          ok: false,
          status: error instanceof ApiError ? error.status : null,
          code: error instanceof ApiError ? error.code : undefined,
          at,
          body: errorBody(error),
        },
        ...entries,
      ]);
      return { ok: false, error };
    }
  }, []);

  const loadReservations = useCallback(
    async (withCancelled: boolean) => {
      setIsRefreshing(true);
      const result = await run(`List reservations${withCancelled ? " (with cancelled)" : ""}`, () =>
        getConversationReservations(conversationId, withCancelled),
      );
      if (result.ok) {
        setReservations(result.data);
        setReservationsError(null);
      } else {
        setReservationsError(describeError(result.error));
      }
      setIsRefreshing(false);
    },
    [conversationId, run],
  );

  // Load the conversation's reservations once when the page opens
  useEffect(() => {
    let ignore = false;
    getConversationReservations(conversationId, false)
      .then((data) => {
        if (!ignore) setReservations(data);
      })
      .catch((error: unknown) => {
        if (!ignore) setReservationsError(describeError(error));
      });
    return () => {
      ignore = true;
    };
  }, [conversationId]);

  // Tick the countdown while the proposal is pending and not yet expired
  const isPending = proposal?.status === "pending";
  const remainingMs = proposal ? new Date(proposal.expiresAt).getTime() - now : 0;
  const hasExpired = isPending && remainingMs <= 0;
  useEffect(() => {
    if (!isPending || hasExpired) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [isPending, hasExpired]);

  async function handleCreate(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isCreating) return;

    const errors = validateForm(form);
    setFormErrors(errors);
    setCreateError(null);
    if (errors.length > 0) return;

    setIsCreating(true);
    const result = await run("Create proposal", () => proposeReservation(conversationId, toPayload(form)));
    if (result.ok) {
      setProposal(result.data);
      setAcceptedReservation(null);
      setProposalError(null);
      setNow(Date.now());
    } else {
      setCreateError(describeError(result.error));
    }
    setIsCreating(false);
  }

  async function handleModify(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isModifying) return;

    const errors = validateModifyForm(modifyForm);
    setModifyErrors(errors);
    setModifyError(null);
    if (errors.length > 0) return;

    setIsModifying(true);
    const result = await run("Propose modification", () =>
      proposeModification(conversationId, toModificationPayload(modifyForm)),
    );
    if (result.ok) {
      setProposal(result.data);
      setAcceptedReservation(null);
      setProposalError(null);
      setNow(Date.now());
    } else {
      setModifyError(describeError(result.error));
    }
    setIsModifying(false);
  }

  // After a refusal the backend sends the proposal's new state, or just its status
  function applyProposalError(error: unknown) {
    const updated = errorData<Proposal>(error, "proposal");
    const status = errorData<Proposal["status"]>(error, "proposalStatus");
    if (updated) setProposal(updated);
    else if (status) setProposal((current) => (current ? { ...current, status } : current));
    setProposalError(describeError(error));
  }

  async function handleAccept() {
    if (!proposal || proposalAction) return;
    setProposalAction("accept");
    setProposalError(null);
    const result = await run("Accept proposal", () => acceptProposal(conversationId, proposal.id));
    if (result.ok) {
      setProposal(result.data.proposal);
      setAcceptedReservation(result.data.reservation);
      await loadReservations(includeCancelled);
    } else {
      applyProposalError(result.error);
    }
    setProposalAction(null);
  }

  async function handleDecline() {
    if (!proposal || proposalAction) return;
    setProposalAction("decline");
    setProposalError(null);
    const result = await run("Decline proposal", () => declineProposal(conversationId, proposal.id));
    if (result.ok) setProposal(result.data.proposal);
    else applyProposalError(result.error);
    setProposalAction(null);
  }

  function handleIncludeCancelled(checked: boolean) {
    setIncludeCancelled(checked);
    loadReservations(checked);
  }

  const updateForm = <K extends keyof CreateForm>(key: K, value: CreateForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));
  const updateModifyForm = <K extends keyof ModifyForm>(key: K, value: ModifyForm[K]) =>
    setModifyForm((current) => ({ ...current, [key]: value }));

  return (
    <main className="flex min-h-dvh flex-col">
      <header className="border-b border-line bg-cream">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <BrandLogo />
            <span className="rounded-full border border-brand/30 bg-brand/10 px-2.5 py-0.5 text-xs font-semibold tracking-wide text-brand uppercase">
              Dev
            </span>
          </div>
          <Link
            href={`/reserve/${encodeURIComponent(conversationId)}`}
            className="rounded-full border border-line bg-surface px-4 py-2 text-sm font-semibold text-ink transition-colors hover:bg-cream"
          >
            ← Back to conversation
          </Link>
        </div>
      </header>

      <div className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6">
        <div className="mb-6">
          <h1 className="font-display text-3xl font-semibold text-ink">Reservation tester</h1>
          <p className="mt-1 text-sm text-muted">
            Try the reservation API for this conversation. Everything here reads and writes the
            development database.
          </p>
          <div className="mt-4 inline-flex max-w-full flex-wrap items-center gap-2 rounded-2xl border border-line bg-surface px-4 py-2.5">
            <span className="text-xs font-semibold tracking-wide text-muted uppercase">Conversation</span>
            <code className="font-mono text-sm break-all text-ink">{conversationId}</code>
          </div>
        </div>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
          <div className="flex flex-col gap-6">
            <Section
              title="Create reservation"
              description="Propose a new reservation. Its details are checked when the proposal is accepted."
            >
              <form onSubmit={handleCreate} noValidate className="flex flex-col gap-4">
                <FieldGrid>
                  <Field label="Guest name" value={form.guestName} onChange={(v) => updateForm("guestName", v)} placeholder="Hammad Amin" />
                  <Field label="Guest phone" value={form.guestPhone} onChange={(v) => updateForm("guestPhone", v)} placeholder="03001234567" inputMode="tel" />
                  <Field
                    label="Date"
                    type="date"
                    value={form.date}
                    onChange={(v) => updateForm("date", v)}
                    hint={form.date ? weekdayOf(form.date) : undefined}
                  />
                  <Field
                    label="Time"
                    type="time"
                    value={form.time}
                    onChange={(v) => updateForm("time", v)}
                    hint={form.mealType === "a_la_carte" ? "Required for à la carte" : "Not used for buffets"}
                  />
                  <SelectField
                    label="Meal type"
                    value={form.mealType}
                    onChange={(v) => updateForm("mealType", v as MealType)}
                    options={MEAL_TYPES}
                  />
                  <Field label="Adults" value={form.adults} onChange={(v) => updateForm("adults", v)} inputMode="numeric" />
                  <Field label="Children (under 12)" value={form.children} onChange={(v) => updateForm("children", v)} inputMode="numeric" />
                  <Field
                    label="Children under 3"
                    value={form.childrenUnder3}
                    onChange={(v) => updateForm("childrenUnder3", v)}
                    placeholder="0"
                    inputMode="numeric"
                    hint="Eat the buffet free"
                  />
                </FieldGrid>
                <Field
                  label="Special request"
                  value={form.specialRequest}
                  onChange={(v) => updateForm("specialRequest", v)}
                  placeholder="Window seat, please"
                />

                <fieldset className="flex flex-col gap-3">
                  <legend className="mb-1 text-sm font-medium text-ink">Extras (quantity)</legend>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {EXTRAS.map((extra) => (
                      <label key={extra.key} className="flex items-center justify-between gap-3 rounded-xl border border-line bg-cream px-3 py-2">
                        <span className="text-sm text-ink">{extra.label}</span>
                        <input
                          type="text"
                          inputMode="numeric"
                          value={form.extras[extra.key]}
                          onChange={(event) => updateForm("extras", { ...form.extras, [extra.key]: event.target.value })}
                          aria-label={`${extra.label} quantity`}
                          className="w-14 rounded-lg border border-line bg-surface px-2 py-1 text-right text-sm text-ink"
                        />
                      </label>
                    ))}
                  </div>
                  <label className="flex items-center gap-2 text-sm text-ink">
                    <input
                      type="checkbox"
                      checked={form.outsideCake}
                      onChange={(event) => updateForm("outsideCake", event.target.checked)}
                      className="size-4 accent-brand"
                    />
                    The guest brings their own cake (service fee, needs Staff approval)
                  </label>
                </fieldset>

                {formErrors.length > 0 && (
                  <ul role="alert" className="list-disc rounded-xl border border-danger/30 bg-danger/5 py-3 pr-4 pl-8 text-sm text-danger">
                    {formErrors.map((error) => (
                      <li key={error}>{error}</li>
                    ))}
                  </ul>
                )}
                {createError && <ErrorNote>{createError}</ErrorNote>}

                <div className="flex flex-wrap items-center justify-end gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      setForm(EMPTY_FORM);
                      setFormErrors([]);
                      setCreateError(null);
                    }}
                    disabled={isCreating}
                    className="rounded-full border border-line bg-surface px-5 py-2 text-sm font-semibold whitespace-nowrap text-ink transition-colors hover:bg-cream disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Clear
                  </button>
                  <button
                    type="submit"
                    disabled={isCreating}
                    className="rounded-full bg-brand px-5 py-2 text-sm font-semibold whitespace-nowrap text-white transition-colors hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isCreating ? "Creating..." : "Create proposal"}
                  </button>
                </div>
              </form>
            </Section>

            <Section
              title="Modify reservation"
              description="Propose new details for an existing reservation. Its extras and special request stay as they are."
            >
              <form onSubmit={handleModify} noValidate aria-label="Modify reservation" className="flex flex-col gap-4">
                <FieldGrid>
                  <Field
                    label="Reservation code"
                    value={modifyForm.reservationCode}
                    onChange={(v) => updateModifyForm("reservationCode", v)}
                    placeholder="RSV-AB12"
                  />
                  <Field
                    label="Guest phone"
                    value={modifyForm.guestPhone}
                    onChange={(v) => updateModifyForm("guestPhone", v)}
                    placeholder="03001234567"
                    inputMode="tel"
                  />
                  <Field
                    label="New date"
                    type="date"
                    value={modifyForm.date}
                    onChange={(v) => updateModifyForm("date", v)}
                    hint={modifyForm.date ? weekdayOf(modifyForm.date) : undefined}
                  />
                  <Field
                    label="New time"
                    type="time"
                    value={modifyForm.time}
                    onChange={(v) => updateModifyForm("time", v)}
                    hint={modifyForm.mealType === "a_la_carte" ? "Required for à la carte" : "Not used for buffets"}
                  />
                  <SelectField
                    label="New meal type"
                    value={modifyForm.mealType}
                    onChange={(v) => updateModifyForm("mealType", v as MealType)}
                    options={MEAL_TYPES}
                  />
                  <Field label="Adults" value={modifyForm.adults} onChange={(v) => updateModifyForm("adults", v)} inputMode="numeric" />
                  <Field
                    label="Children (under 12)"
                    value={modifyForm.children}
                    onChange={(v) => updateModifyForm("children", v)}
                    inputMode="numeric"
                  />
                  <Field
                    label="Children under 3"
                    value={modifyForm.childrenUnder3}
                    onChange={(v) => updateModifyForm("childrenUnder3", v)}
                    placeholder="0"
                    inputMode="numeric"
                    hint="Eat the buffet free"
                  />
                </FieldGrid>

                {modifyErrors.length > 0 && (
                  <ul role="alert" className="list-disc rounded-xl border border-danger/30 bg-danger/5 py-3 pr-4 pl-8 text-sm text-danger">
                    {modifyErrors.map((error) => (
                      <li key={error}>{error}</li>
                    ))}
                  </ul>
                )}
                {modifyError && <ErrorNote>{modifyError}</ErrorNote>}

                <div className="flex flex-wrap items-center justify-end gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      setModifyForm(EMPTY_MODIFY_FORM);
                      setModifyErrors([]);
                      setModifyError(null);
                    }}
                    disabled={isModifying}
                    className="rounded-full border border-line bg-surface px-5 py-2 text-sm font-semibold whitespace-nowrap text-ink transition-colors hover:bg-cream disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Clear
                  </button>
                  <button
                    type="submit"
                    disabled={isModifying}
                    className="rounded-full bg-brand px-5 py-2 text-sm font-semibold whitespace-nowrap text-white transition-colors hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isModifying ? "Proposing..." : "Propose changes"}
                  </button>
                </div>
              </form>
            </Section>

            <div className="grid gap-6 md:grid-cols-2">
              <Section title="Cancel reservation" description="Propose cancelling a reservation.">
                <PlaceholderField label="Reservation code" placeholder="RSV-AB12" />
                <PlaceholderField label="Guest phone" placeholder="03001234567" />
                <ActionRow label="Propose cancellation" />
              </Section>

              <Section title="Look up reservation" description="Find a reservation by its code and phone number.">
                <PlaceholderField label="Reservation code" placeholder="RSV-AB12" />
                <PlaceholderField label="Guest phone" placeholder="03001234567" />
                <ActionRow label="Look up" />
              </Section>
            </div>
          </div>

          {/* Stays in view while scrolling through the forms on wide screens */}
          <div className="flex flex-col gap-6 lg:sticky lg:top-6 lg:self-start">
            <Section title="Pending proposal" description="The latest proposal, with accept and decline.">
              {proposal ? (
                <ProposalCard
                  proposal={proposal}
                  remainingMs={remainingMs}
                  hasExpired={hasExpired}
                  action={proposalAction}
                  error={proposalError}
                  onAccept={handleAccept}
                  onDecline={handleDecline}
                  knownReservations={reservations ?? []}
                />
              ) : (
                <EmptyState>No proposal yet. Create, modify or cancel a reservation to make one.</EmptyState>
              )}
              {acceptedReservation && <ReservationCard reservation={acceptedReservation} />}
            </Section>

            <Section
              title="Conversation reservations"
              description="Reservations made in this conversation, earliest first."
              actions={
                <button
                  type="button"
                  onClick={() => loadReservations(includeCancelled)}
                  disabled={isRefreshing}
                  className="rounded-full border border-line bg-surface px-4 py-1.5 text-sm font-semibold text-ink transition-colors hover:bg-cream disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isRefreshing ? "Refreshing..." : "Refresh"}
                </button>
              }
            >
              <label className="flex items-center gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  checked={includeCancelled}
                  onChange={(event) => handleIncludeCancelled(event.target.checked)}
                  disabled={isRefreshing}
                  className="size-4 accent-brand"
                />
                Include cancelled reservations
              </label>
              {reservationsError && <ErrorNote>{reservationsError}</ErrorNote>}
              {reservations === null ? (
                <EmptyState>Loading reservations...</EmptyState>
              ) : reservations.length === 0 ? (
                <EmptyState>No reservations in this conversation.</EmptyState>
              ) : (
                <ul className="flex flex-col gap-3">
                  {reservations.map((reservation) => (
                    <li key={reservation.reservationCode} className="rounded-xl border border-line bg-cream px-4 py-3 text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono font-semibold text-ink">{reservation.reservationCode}</span>
                        <StatusBadge status={reservation.status} />
                      </div>
                      <p className="mt-1 text-ink">
                        {mealLabel(reservation.mealType)} · {formatSlot(reservation.startTime, reservation.endTime)}
                      </p>
                      <p className="text-muted">
                        {partyText(reservation.adults, reservation.children)} · {tablesText(reservation.tables)} ·{" "}
                        {formatPkr(reservation.estimatedTotalPaisa)}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section
              title="API response log"
              description="Each request's status and JSON response, newest first."
              actions={
                log.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setLog([])}
                    className="rounded-full border border-line bg-surface px-4 py-1.5 text-sm font-semibold text-ink transition-colors hover:bg-cream"
                  >
                    Clear
                  </button>
                )
              }
            >
              {log.length === 0 ? (
                <EmptyState>No requests yet.</EmptyState>
              ) : (
                <ul className="flex max-h-[32rem] flex-col gap-3 overflow-y-auto">
                  {log.map((entry) => (
                    <li key={entry.id} className="rounded-xl border border-line bg-cream">
                      <details>
                        <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2 text-sm">
                          <span
                            className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                              entry.ok ? "bg-brand/10 text-brand" : "bg-danger/10 text-danger"
                            }`}
                          >
                            {entry.ok ? "OK" : (entry.status ?? "ERR")}
                          </span>
                          <span className="font-medium text-ink">{entry.name}</span>
                          {entry.code && <code className="font-mono text-xs text-danger">{entry.code}</code>}
                          <span className="ml-auto text-xs text-muted">{entry.at}</span>
                        </summary>
                        <pre className="max-h-72 overflow-auto border-t border-line px-3 py-2 font-mono text-xs leading-relaxed text-ink">
                          {JSON.stringify(entry.body, null, 2)}
                        </pre>
                      </details>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </div>
        </div>
      </div>
    </main>
  );
}

const partyText = (adults: number, children: number) =>
  `${adults} ${adults === 1 ? "adult" : "adults"}${children ? `, ${children} ${children === 1 ? "child" : "children"}` : ""}`;

const tablesText = (tables: ReservationTable[]) =>
  tables.length ? `Tables ${tables.map((table) => `${table.tableNumber} (${table.section}, ${table.capacity})`).join(", ")}` : "No tables";

function ProposalCard({
  proposal,
  remainingMs,
  hasExpired,
  action,
  error,
  onAccept,
  onDecline,
  knownReservations,
}: {
  proposal: Proposal;
  remainingMs: number;
  hasExpired: boolean;
  action: "accept" | "decline" | null;
  error: string | null;
  onAccept: () => void;
  onDecline: () => void;
  // Used to name the current tables of a reservation being modified
  knownReservations: ConversationReservation[];
}) {
  const isPending = proposal.status === "pending";
  const expiresAt = new Date(proposal.expiresAt).toLocaleTimeString();

  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-ink/5 px-2.5 py-0.5 text-xs font-semibold tracking-wide text-ink uppercase">
          {proposal.actionType}
        </span>
        <StatusBadge status={proposal.status} />
        <span className="ml-auto text-xs text-muted">
          {isPending
            ? hasExpired
              ? `Expired at ${expiresAt}`
              : `Expires in ${formatCountdown(remainingMs)} (${expiresAt})`
            : `Expiry was ${expiresAt}`}
        </span>
      </div>

      {proposal.actionType === "create" && proposal.payload ? (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 rounded-xl border border-line bg-cream px-4 py-3">
          <Detail label="Guest">
            {proposal.payload.guestName} · {proposal.payload.guestPhone}
          </Detail>
          <Detail label="When">
            {weekdayOf(proposal.payload.date)} {proposal.payload.date}
            {proposal.payload.time ? ` at ${proposal.payload.time}` : ""}
          </Detail>
          <Detail label="Meal">{mealLabel(proposal.payload.mealType)}</Detail>
          <Detail label="Party">
            {partyText(proposal.payload.adults, proposal.payload.children)}
            {proposal.payload.childrenUnder3 ? ` (${proposal.payload.childrenUnder3} under 3)` : ""}
          </Detail>
          <Detail label="Extras">
            {proposal.payload.extras?.length
              ? proposal.payload.extras
                  .map((extra) => `${EXTRAS.find((e) => e.key === extra.extraKey)?.label ?? extra.extraKey} × ${extra.quantity}`)
                  .join(", ")
              : "None"}
            {proposal.payload.outsideCake ? " + own cake" : ""}
          </Detail>
          {proposal.payload.specialRequest && <Detail label="Request">{proposal.payload.specialRequest}</Detail>}
          <Detail label="Price">
            <span className="text-muted">Worked out by the backend when the proposal is accepted.</span>
          </Detail>
        </dl>
      ) : proposal.actionType === "modify" && proposal.payload ? (
        <ModificationDetails payload={proposal.payload} knownReservations={knownReservations} />
      ) : (
        <pre className="max-h-48 overflow-auto rounded-xl border border-line bg-cream px-3 py-2 font-mono text-xs text-ink">
          {JSON.stringify(proposal.payload, null, 2)}
        </pre>
      )}

      {error && <ErrorNote>{error}</ErrorNote>}

      {isPending && (
        <div className="flex flex-wrap items-center justify-end gap-3">
          <button
            type="button"
            onClick={onDecline}
            disabled={action !== null}
            className="rounded-full border border-line bg-surface px-5 py-2 text-sm font-semibold whitespace-nowrap text-ink transition-colors hover:bg-cream disabled:cursor-not-allowed disabled:opacity-50"
          >
            {action === "decline" ? "Declining..." : "Decline"}
          </button>
          <button
            type="button"
            onClick={onAccept}
            disabled={action !== null}
            className="rounded-full bg-brand px-5 py-2 text-sm font-semibold whitespace-nowrap text-white transition-colors hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-50"
          >
            {action === "accept" ? "Accepting..." : "Accept"}
          </button>
        </div>
      )}
    </div>
  );
}

// The reservation as it is now beside what the modification would make it.
// Changed rows are highlighted.
function ModificationDetails({
  payload,
  knownReservations,
}: {
  payload: StoredModificationPayload;
  knownReservations: ConversationReservation[];
}) {
  const { current, target } = payload;
  // The snapshot only has table ids; name them if the reservation is in the list
  const known = knownReservations.find((reservation) => reservation.reservationCode === payload.reservationCode);
  const currentTables = known
    ? known.tables.map((table) => table.tableNumber).join(", ")
    : `${current.tableIds.length} ${current.tableIds.length === 1 ? "table" : "tables"}`;
  const targetTables = target.tables.map((table) => `${table.tableNumber} (${table.section}, ${table.capacity})`).join(", ");
  const sameTables =
    !!known &&
    [...known.tables.map((table) => table.tableNumber)].sort().join() ===
      [...target.tables.map((table) => table.tableNumber)].sort().join();

  const rows: { label: string; now: string; proposed: string; changed: boolean }[] = [
    {
      label: "When",
      now: formatSlot(current.startTime, current.endTime),
      proposed: formatSlot(target.startTime, target.endTime),
      changed: current.startTime !== target.startTime || current.endTime !== target.endTime,
    },
    {
      label: "Meal",
      now: mealLabel(current.mealType),
      proposed: mealLabel(target.mealType),
      changed: current.mealType !== target.mealType,
    },
    {
      label: "Party",
      now: partyText(current.adults, current.children),
      proposed: `${partyText(target.adults, target.children)}${target.childrenUnder3 ? ` (${target.childrenUnder3} under 3)` : ""}`,
      changed: current.adults !== target.adults || current.children !== target.children,
    },
    { label: "Tables", now: currentTables, proposed: targetTables, changed: !sameTables },
    {
      label: "Estimated total",
      now: formatPkr(current.estimatedTotalPaisa),
      proposed: formatPkr(target.estimatedTotalPaisa),
      changed: current.estimatedTotalPaisa !== target.estimatedTotalPaisa,
    },
  ];

  return (
    <div className="flex flex-col gap-2">
      <p className="font-mono font-semibold text-ink">{payload.reservationCode}</p>
      <div className="overflow-x-auto rounded-xl border border-line bg-cream">
        <table className="w-full text-left text-xs">
          <thead className="text-muted">
            <tr>
              <th className="px-3 py-2 font-medium" />
              <th className="px-3 py-2 font-medium">Now</th>
              <th className="px-3 py-2 font-medium">Proposed</th>
            </tr>
          </thead>
          <tbody className="text-ink">
            {rows.map((row) => (
              <tr key={row.label} className={`border-t border-line ${row.changed ? "bg-brand/5" : ""}`}>
                <th scope="row" className="px-3 py-2 font-medium whitespace-nowrap text-muted">
                  {row.label}
                </th>
                <td className="px-3 py-2">{row.now}</td>
                <td className={`px-3 py-2 ${row.changed ? "font-semibold text-brand" : ""}`}>{row.proposed}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted">
        The reservation code, guest details, special request and extras (with their approval statuses) stay as
        they are. The proposed total includes the existing extras. Tables are chosen again on acceptance.
      </p>
    </div>
  );
}

function ReservationCard({ reservation }: { reservation: ReservationDetails }) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-brand/30 bg-brand/5 px-4 py-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-base font-semibold text-ink">{reservation.reservationCode}</span>
        <StatusBadge status={reservation.status} />
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5">
        <Detail label="When">{formatSlot(reservation.startTime, reservation.endTime)}</Detail>
        <Detail label="Meal">{mealLabel(reservation.mealType)}</Detail>
        <Detail label="Guest">
          {reservation.guestName} · {reservation.guestPhone}
        </Detail>
        <Detail label="Party">{partyText(reservation.adults, reservation.children)}</Detail>
        <Detail label="Tables">{tablesText(reservation.tables)}</Detail>
        {reservation.specialRequest && <Detail label="Request">{reservation.specialRequest}</Detail>}
        {reservation.cancelledAt && <Detail label="Cancelled">{new Date(reservation.cancelledAt).toLocaleString()}</Detail>}
      </dl>
      {reservation.extras.length > 0 && <ExtrasTable extras={reservation.extras} />}
      <div className="flex items-center justify-between border-t border-brand/20 pt-2 font-semibold text-ink">
        <span>Estimated total</span>
        <span>{formatPkr(reservation.estimatedTotalPaisa)}</span>
      </div>
    </div>
  );
}

function ExtrasTable({ extras }: { extras: ReservationExtra[] }) {
  return (
    <table className="w-full text-left text-xs">
      <thead className="text-muted">
        <tr>
          <th className="py-1 font-medium">Extra</th>
          <th className="py-1 pl-3 text-right font-medium whitespace-nowrap">Qty</th>
          <th className="py-1 pl-3 text-right font-medium whitespace-nowrap">Unit</th>
          <th className="py-1 pl-3 text-right font-medium whitespace-nowrap">Total</th>
          <th className="py-1 pl-3 font-medium">Approval</th>
        </tr>
      </thead>
      <tbody className="text-ink">
        {extras.map((extra) => (
          <tr key={extra.extraKey} className="border-t border-brand/10">
            <td className="py-1">{extra.name}</td>
            <td className="py-1 pl-3 text-right whitespace-nowrap">{extra.quantity}</td>
            <td className="py-1 pl-3 text-right whitespace-nowrap">{formatPkr(extra.unitPricePaisa)}</td>
            <td className="py-1 pl-3 text-right whitespace-nowrap">{formatPkr(extra.lineTotalPaisa)}</td>
            <td className="py-1 pl-3">{extra.approvalStatus.replace("_", " ")}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === "pending"
      ? "bg-ink/5 text-ink"
      : status === "accepted" || status === "confirmed"
        ? "bg-brand/10 text-brand"
        : "bg-danger/10 text-danger";
  return <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${tone}`}>{status}</span>;
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="text-ink">{children}</dd>
    </>
  );
}

function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="rounded-xl border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">
      {children}
    </p>
  );
}

function Section({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-lg font-semibold text-ink">{title}</h2>
          <p className="mt-0.5 text-sm text-muted">{description}</p>
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

function FieldGrid({ children }: { children: ReactNode }) {
  return <div className="grid gap-4 sm:grid-cols-2">{children}</div>;
}

const inputClassName =
  "w-full rounded-xl border border-line bg-cream px-3 py-2 text-sm text-ink placeholder:text-muted/70";

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  inputMode,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: "text" | "date" | "time";
  inputMode?: "numeric" | "tel";
  hint?: string;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="flex items-baseline justify-between gap-2 text-sm font-medium text-ink">
        {label}
        {hint && <span className="text-xs font-normal text-muted">{hint}</span>}
      </span>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        inputMode={inputMode}
        className={inputClassName}
      />
    </label>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-ink">{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} className={inputClassName}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

// An input for a form that isn't connected yet
function PlaceholderField({ label, placeholder }: { label: string; placeholder: string }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-ink">{label}</span>
      <input type="text" placeholder={placeholder} className={inputClassName} />
    </label>
  );
}

// The section's main button; disabled until the API calls are connected
function ActionRow({ label }: { label: string }) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-3">
      <span className="text-xs text-muted">Not connected yet</span>
      <button
        type="button"
        disabled
        className="rounded-full bg-brand px-5 py-2 text-sm font-semibold whitespace-nowrap text-white transition-colors hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-50"
      >
        {label}
      </button>
    </div>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-sm text-muted">{children}</p>
  );
}
