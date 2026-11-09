# Hammad Foods Reservation Agent

An AI chat agent that takes table reservations for a restaurant. Guests talk to it in plain language; it checks the restaurant's rules, prices the booking and shows a proposal card that the guest accepts or declines. Staff get a read-only dashboard of the day's bookings.

Built with Claude (Anthropic API) using tool calling, an Express + Prisma backend and a Next.js frontend.

## What it does

**For guests (chat at `/reserve/:conversationId`)**
- Book a buffet (lunch or dinner) or à la carte table by chatting
- Change or cancel an existing booking, found by reservation code + phone number
- Add extras such as a birthday cake, candles, balloons or a high chair
- Every booking, change and cancellation is shown as a card the guest must accept, so the agent never commits anything on its own

**For staff (`/staff`)**
- Summary of today's, upcoming, confirmed and cancelled reservations
- Browse reservations by day, status and meal type, or search by code or guest name
- List of extras waiting for staff approval

**Rules the agent enforces**
- Opening hours (closed Mondays), buffet sessions and 30-minute à la carte slots
- Bookings up to 30 days ahead, parties of up to 15
- Child pricing, and parties with children seated in the family section
- Changes and cancellations close 3 hours before the reservation
- Table allocation from the restaurant's 10 tables
- Off-topic or abusive messages get up to 3 warnings, then the chat is blocked

## How it works

```
Guest ──▶ Next.js chat UI ──▶ Express API ──▶ Claude (tool calling)
                                   │               │
                                   │        tools: policies, create / modify /
                                   │        cancel proposal, look up reservation
                                   ▼               │
                            SQLite (Prisma) ◀──────┘
```

Claude never writes to the database directly. Its tools create *proposals*; the backend validates and prices them using the policies in [`backend/src/config/restaurant-policies.js`](backend/src/config/restaurant-policies.js), and a reservation is only confirmed when the guest accepts the card.

## Tech stack

| Part | Tech |
| --- | --- |
| Agent | Anthropic API (`@anthropic-ai/sdk`), tool calling |
| Backend | Node.js, Express 5, Prisma 7, SQLite, Luxon (Asia/Karachi time) |
| Frontend | Next.js 16 (App Router), React 19, Tailwind CSS 4, TypeScript |
| Tests | Node's built-in test runner, 500+ backend tests |

## Project structure

```
backend/    Express API, Claude agent, Prisma schema and tests
frontend/   Next.js app: guest chat and staff dashboard
docs/       Development notes
```

## Getting started

You need Node.js 20+ and an [Anthropic API key](https://console.anthropic.com/).

**1. Backend** (runs on http://localhost:5002)

```bash
cd backend
npm install
cp .env.example .env          # then put your ANTHROPIC_API_KEY in .env
npx prisma migrate deploy --config prisma7.config.ts
npx prisma generate --config prisma7.config.ts
npm run seed                  # adds the restaurant's tables
npm run dev
```

**2. Frontend** (runs on http://localhost:3000), in a second terminal

```bash
cd frontend
npm install
cp .env.example .env.local
npm run dev
```

Open http://localhost:3000 to start a reservation, or http://localhost:3000/staff for the staff dashboard.

See [backend/README.md](backend/README.md) and [frontend/README.md](frontend/README.md) for more detail.

## Tests

```bash
cd backend
npm test
```

Each test file uses its own throwaway SQLite database and a mock Anthropic server, so tests don't need an API key and never touch `dev.db`.
