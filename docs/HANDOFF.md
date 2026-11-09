# Handoff: Hammad Foods Reservation Agent

Written 3 November 2026, for the next Claude Code session. Covers everything up to and including **Step 12 (Staff Dashboard)**. Read it all before changing anything.

## 1. Project at a glance

- **Backend** `backend/`: Express 5 (CommonJS), Prisma 7.10.1 + SQLite (`backend/dev.db`), `@anthropic-ai/sdk`, luxon (Asia/Karachi). Port **5002** (fixed; don't change). The `nodemon` dev server is usually already running.
- **Frontend** `frontend/`: Next.js 16.4.3 App Router (`cacheComponents` on), React 19, Tailwind v4, port 3000. `frontend/AGENTS.md` requires reading `node_modules/next/dist/docs/` before using Next.js APIs. Pages await `params` / `searchParams` (Promises) inside a `Suspense` child, then render a client component. Run `npx next typegen` for `PageProps` / `LayoutProps` route types.
- **Model:** `ANTHROPIC_MODEL=claude-haiku-5-5` in `backend/.env`. Never print `.env` values.
- **Tests:** `cd backend && npm test` (`node --test "test/**/*.test.js"`); **last run 523/523 passing**. Each test file builds a throwaway SQLite database with `test/support/test-database.js` and a mock Anthropic server; tests never touch `dev.db`. The frontend has no test framework: check it with `npx tsc --noEmit` and `npx eslint src` (both clean).
- **Prisma:** config file `backend/prisma7.config.ts`. Create migrations with `--create-only`, read the SQL (SQLite often rebuilds tables), apply with `migrate deploy`, then `npx prisma generate`.
- **Browsing the database (Prisma Studio):** from `backend/`, run `npx prisma studio --url "file://$PWD/dev.db"`, then open http://localhost:51212. The URL must be `file://` plus an absolute path. The config's `file:./dev.db`, a single-slash `file:/…`, or `sqlite:` all fail with "Prisma Studio is not supported for the … protocol". Edits saved in Studio go straight into `dev.db`.
- **Money** is integer paisa in the database and APIs. PKR is for display only (`formatPkr` in `frontend/src/components/chat/reservation-display.tsx`).

## 2. How the user works (important)

- Builds **one step at a time** from pasted step specs. Do exactly what the step asks. No unrequested features or refactors. **Ask before schema changes.**
- Writes specs in English and chats in **Roman Urdu**. Reply in Roman Urdu. After each step they often say "gpt ko bta do": they want an English status update in one markdown code block to paste into ChatGPT, preceded by a one-line Roman Urdu note.
- **Ask before anything that writes to `dev.db` or calls real Claude** (end-to-end runs). They approve with "krlo" / "hn krlo".
- Often interrupts tool calls. If a call is rejected, stop and wait.
- Sometimes reverts files. Always re-read a file before editing it; what's on disk is their decision.
- Report test results honestly. Never claim a browser test that wasn't run; no browser tool has been available so far.

## 3. What's built

### Agent and chat
- `POST /conversations/:id/chat` runs the agent loop in `src/services/claude.service.js` (max 5 tool rounds). The tools are defined in `src/agent/tools.js` and run by `src/tools/registry.js`:
  - `getRestaurantPolicies` and `reportPolicyViolation` (warnings 1–3, blocked at 3; the backend writes the reply)
  - `createReservationProposal`: refuses a phone number the guest never typed; validates; prices; creates a proposal
  - `getConversationReservations`: this conversation's reservations; card shown for confirmed ones only
  - `getReservationByCodeAndPhone`: finds a reservation from any conversation by code + phone
  - `createModificationProposal`: date, time, party, extras, special request (pass the complete new note, or leave it out to keep the current one)
  - `createCancellationProposal`
- The prompt (`SYSTEM_PROMPT` + `buildSystemPrompt(now)`) includes the policy facts, the current Karachi date, the card rules (short plain-text replies, no Markdown, don't repeat card details) and the restaurant phone `general.contactPhone` (03353021103). Whenever the agent says to contact the restaurant, it gives that number.

### Message-level UI (cards survive refresh)
- `Message` has `uiType`, `proposalId` and `reservationId` (migrations `20261103013934_add_message_ui` and `20261103034747_add_message_reservation`, both applied).
- `src/services/message-ui.service.js` builds each message's public `ui` **at load time from current database state**; there is no separate UI store. The types are `reservation_proposal`, `modification_proposal`, `cancellation_proposal` and `reservation_list`. A stored `reservation_lookup` message is shown as a `reservation_list`. List and lookup cards show only reservations that are still confirmed.
- Accepting or declining a card (`POST /conversations/:id/proposals/:proposalId/accept|decline`) makes the backend post its own reply (`src/services/proposal-reply.service.js`). That reply is linked by `proposalId`, with `uiType` null. Expired and stale proposals are handled. `toClaudeMessages` gives Claude these replies with the prefix "[Restaurant system, after the guest answered the proposal card]" and merges consecutive same-role messages, so Claude knows what happened.
- Frontend chat: `frontend/src/app/reserve/[conversationId]`, `components/chat/` (`ReservationProposalCard`, `ModificationProposalCard`, `CancellationProposalCard`, `ReservationListCards`, `ProposalActions`, `reservation-display.tsx`), `hooks/useConversation.ts`, `lib/api.ts`, `lib/chat-ui.ts`, `lib/reservation-api.ts`.

### Services and routes
- `backend/src/services/`:
  - validation: date-time, meal timing, party, guest details, extras, reservation
  - pricing, table allocation, warnings, reservation retrieval
  - proposals: create / modify / cancel / accept / decline, with stale-snapshot protection and cutoffs
- `src/routes/reservation.routes.js`: lookup, list, create/modify/cancel proposals, accept, decline.
- Dev tester page: `frontend/src/app/dev/reservations/[conversationId]`.

### Step 12: Staff Dashboard (latest; no auth, read-only, by spec)
- Backend: `src/services/staff-dashboard.service.js`, plus `src/routes/staff.routes.js` mounted in `app.js` as `app.use("/staff", createStaffRouter({ clock }))`.
  - `GET /staff/dashboard/summary` returns `{ today, todayReservations, upcomingReservations, confirmedReservations, cancelledReservations, pendingExtraApprovals }`.
    - todayReservations: confirmed, starting today (Karachi)
    - upcomingReservations: confirmed, startTime ≥ now
    - confirmed and cancelled: all dates
    - pendingExtraApprovals: pending extras on confirmed reservations from the start of today
  - `GET /staff/reservations?date=&status=&mealType=&search=` returns `{ date, search, reservations, truncated }`.
    - The date filter uses Karachi day boundaries (luxon).
    - `status`: confirmed / cancelled / all. `mealType`: buffet (lunch + dinner) / a_la_carte / all.
    - `search`: case-insensitive match on code or guest name.
    - Requires a date or a search. A search without a date covers all dates, latest first, capped at `SEARCH_LIMIT = 50`.
    - List items have no phone and no IDs.
    - Bad query: 400 `INVALID_QUERY`.
  - `GET /staff/reservations/:code` returns full details with guest and `bookedAt`; unknown code: 404 `RESERVATION_NOT_FOUND`.
  - `GET /staff/extra-approvals`: pending extras, soonest first.
- Frontend:
  - `lib/staff-api.ts`
  - `app/staff/layout.tsx`: sidebar on desktop, top bar on mobile
  - `app/staff/page.tsx`: `?date=`, default today in Karachi
  - `app/staff/reservations/[reservationCode]/page.tsx`
  - `components/staff/`:
    - `StaffDashboard`
    - `ReservationBrowser`: day navigation, URL kept in sync via `replaceState`, 300 ms debounced search, filters
    - `StaffReservationCard`, `StaffReservationDetails`, `ExtraApprovals`, `staff-ui.tsx`, `staff-dates.ts`
    - `useApiData`: keyed loader that ignores stale responses and exposes `errorStatus` for 404
  - The home page (`app/page.tsx`) has a "Staff Dashboard" link.
- Tests: `backend/test/staff-dashboard.test.js` (26 tests, fixed now = 2026-11-17 09:00 Karachi).
- Checked with curl against the dev servers (APIs and server-rendered pages). **Not checked in a real browser** (clicks, phone-width layout).

## 4. Open items / known gaps

- Staff dashboard: no browser test yet, no approve/reject for extras, and no reservation actions. Both were out of scope by spec, so wait for a step that asks for them.
- Server-rendered dates may show "Saturday, 14 November 2026" (comma, from Node ICU) while browsers may differ. This is cosmetic.
- No frontend test framework.
- `dev.db` holds test data from earlier e2e runs:
  - "Browser Test Guest" reservations RSV-Y8QN and RSV-ALC5
  - RSV-1BJG, cancelled by a test
  - RSV-6P9D: 3 adults, table T3, note "AC ahista chalaen"
  - the user's own RSV-KEDN (they cancelled it) and RSV-YFE2 (untouched)
- Next step: wait for the user's next pasted spec.
