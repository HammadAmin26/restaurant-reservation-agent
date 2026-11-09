# Backend

Express API for the Hammad Foods Reservation Agent. It runs the Claude agent loop, validates and prices reservations, and serves the staff dashboard data.

## Setup

```bash
npm install
cp .env.example .env
npx prisma migrate deploy --config prisma7.config.ts
npx prisma generate --config prisma7.config.ts
npm run seed
npm run dev
```

The API runs on http://localhost:5002. Check it with `GET /health`.

### Environment variables (`.env`)

| Variable | Description |
| --- | --- |
| `PORT` | Port the API listens on (default `5002`) |
| `DATABASE_URL` | SQLite file, e.g. `file:./dev.db` |
| `ANTHROPIC_API_KEY` | Your Anthropic API key. Keep it in `.env` only |
| `ANTHROPIC_MODEL` | Claude model the agent uses |

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Start with nodemon (restarts on changes) |
| `npm start` | Start without reloading |
| `npm run seed` | Add or update the restaurant's tables (safe to re-run) |
| `npm test` | Run all tests |

## Code layout

```
src/
  agent/tools.js        Tool definitions given to Claude
  tools/                Tool implementations and the registry that runs them
  services/
    claude.service.js   Agent loop (up to 5 tool rounds per message)
    *-validation.*      Date/time, meal timing, party, guest, extras checks
    pricing, table-allocation, proposal, warning, staff-dashboard ...
  config/               Restaurant policies and table layout (single source of truth)
  routes/               Conversation, reservation and staff routes
prisma/                 Schema, migrations and seed script
test/                   Node test runner tests
```

Money is stored as integer paisa (PKR 1 = 100 paisa). All dates and times use the `Asia/Karachi` timezone.

## API

**Conversations**
- `POST /conversations` start a conversation
- `GET /conversations/:id` get a conversation and its messages
- `POST /conversations/:id/chat` send a guest message and get the agent's reply

**Reservations**
- `GET /reservations/lookup` find a reservation by code and phone
- `GET /conversations/:id/reservations` reservations from this conversation
- `POST /conversations/:id/reservations/proposals` create a booking proposal
- `POST /conversations/:id/reservations/modifications` propose a change
- `POST /conversations/:id/reservations/cancellations` propose a cancellation
- `POST /conversations/:id/proposals/:proposalId/accept` accept a proposal
- `POST /conversations/:id/proposals/:proposalId/decline` decline a proposal

**Staff** (read-only)
- `GET /staff/dashboard/summary` counts for today, upcoming, confirmed, cancelled and pending extras
- `GET /staff/reservations?date=&status=&mealType=&search=` browse or search reservations
- `GET /staff/reservations/:code` one reservation's full details
- `GET /staff/extra-approvals` extras waiting for approval

A Postman collection is in [`postman/`](postman/).

## Database

Prisma 7 with SQLite. The Prisma config is `prisma7.config.ts`.

To browse the data with Prisma Studio (the URL must be an absolute `file://` path):

```bash
npx prisma studio --url "file://$PWD/dev.db"
```

## Tests

```bash
npm test
```

Tests use a throwaway SQLite database per file and a mock Anthropic server, so no API key is needed.
