# High-Concurrency Seat Reservation Engine

A race-free ticket reservation API built with Node.js, Fastify, TypeScript, and PostgreSQL.

## Live Service

- **Base URL**: https://paytm-assignment-shan.onrender.com
- **Readiness check**: https://paytm-assignment-shan.onrender.com/readyz
- **Prometheus metrics**: https://paytm-assignment-shan.onrender.com/metrics

> If the service has been idle, the first request may take a while while the instance wakes up.

## Architecture Overview

- **Storage engine**: PostgreSQL with row-level locking (`SELECT ... FOR UPDATE`).
- **Deadlock avoidance**: Seat IDs are sorted and locked in one canonical order across all requests.
- **Idempotency**: Records are scoped by `(user_id, idempotency_key)` and store the response payload plus a SHA-256 request hash.
- **Per-user limits**: Requests are serialized per user and show with transactional advisory locks (`pg_advisory_xact_lock`).
- **Observability**: Prometheus metrics are exported via `prom-client` on `/metrics`.

For the full design rationale, guarantees, and tradeoffs, see [WRITEUP.md](./WRITEUP.md).

## API

| Method | Path                       | Description                                                               |
| ------ | -------------------------- | ------------------------------------------------------------------------- |
| `POST` | `/reservations`            | [Create a reservation. Requires auth token and `Idempotency-Key` header.] |
| `POST` | `/reservations/:id/cancel` | Cancel a reservation (owner only).                                        |
| `GET`  | `/readyz`                  | Readiness check; returns `503` if the database is unreachable.            |
| `GET`  | `/metrics`                 | Prometheus metrics.                                                       |

## Local Setup

### Prerequisites

- Docker and Docker Compose
- Node.js 24

### Option 1: Docker Compose

```bash
docker compose up --build -d
```

The service runs migrations automatically and listens on port `3000`.

### Option 2: Without Docker

Requires a running PostgreSQL instance. [Set `DATABASE_URL` in `.env`, e.g. `postgres://user:pass@localhost:5432/dbname`.]

```bash
npm install
npm run migrate
npm run dev
```

## Verification & Testing

### Integration tests (Vitest)

Concurrency test suites covering hot-seat contention, per-user limits under races, and inventory invariants:

```bash
npm test
```

### Burst load test

Simulates an on-sale stampede: 1,100 concurrent requests, hot-seat collisions, idempotent replays, and a final invariant reconciliation.

```bash
# Against a local container
node burst.mjs http://localhost:3000

# Against the live deployment
node burst.mjs https://paytm-assignment-shan.onrender.com
```
