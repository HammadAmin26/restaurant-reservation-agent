# Frontend

Next.js app for the Hammad Foods Reservation Agent: the guest chat and the staff dashboard. It talks to the Express API in [`../backend`](../backend).

## Setup

Start the backend first, then:

```bash
npm install
cp .env.example .env.local
npm run dev
```

Open http://localhost:3000.

### Environment variables (`.env.local`)

| Variable | Description |
| --- | --- |
| `NEXT_PUBLIC_API_URL` | URL of the backend API (default `http://localhost:5002`) |

## Pages

| Route | What it is |
| --- | --- |
| `/` | Home page: start a reservation chat or open the staff dashboard |
| `/reserve/[conversationId]` | Guest chat with the agent, including proposal and reservation cards |
| `/staff` | Staff dashboard: summary, reservation browser (`?date=`), pending extras |
| `/staff/reservations/[reservationCode]` | Full details of one reservation |
| `/dev/reservations/[conversationId]` | Developer page for testing the reservation APIs without the agent |

## Code layout

```
src/
  app/                    Routes (App Router)
  components/
    chat/                 Chat window, messages and proposal cards
    staff/                Staff dashboard, reservation browser and details
  hooks/useConversation   Loads a conversation and sends messages
  lib/                    API clients for chat, reservations and staff
```

## Checks

There is no frontend test suite yet. Check types and lint with:

```bash
npx tsc --noEmit
npx eslint src
```
