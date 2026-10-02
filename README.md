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

## API Reference

All request bodies use `Content-Type: application/json`. Authenticated routes read the caller's identity from the header `Authorization: Bearer <user_id>`.

### Endpoint summary

| Method | Path                       | Auth         | Description                                |
| ------ | -------------------------- | ------------ | ------------------------------------------ |
| `GET`  | `/`                        | None         | Service metadata and route directory       |
| `GET`  | `/healthz`                 | None         | Liveness check                             |
| `GET`  | `/readyz`                  | None         | Readiness check (database connectivity)    |
| `GET`  | `/metrics`                 | None         | Prometheus metrics                         |
| `POST` | `/shows`                   | Admin token  | Create a show with initial seat inventory  |
| `GET`  | `/shows/:id`               | None         | Live inventory counts for a show           |
| `POST` | `/shows/:id/reserve`       | User         | Atomically reserve one or more seats       |
| `POST` | `/reservations/:id/cancel` | User (owner) | Cancel a reservation and release its seats |

---

### System health & observability

#### `GET /`

Service metadata, status, and route directory.

**Response `200 OK`**

```json
{
  "service": "high-concurrency-seat-reservation-api",
  "status": "healthy",
  "documentation": {
    "health": "/healthz",
    "readiness": "/readyz",
    "metrics": "/metrics",
    "shows": "/shows"
  }
}
```

#### `GET /healthz`

Liveness check confirming the application process is running.

**Response `200 OK`**

```json
{ "status": "ok" }
```

#### `GET /readyz`

Readiness probe that verifies the connection pool can reach PostgreSQL. Returns `503` if the database is unreachable.

**Response `200 OK`**

```json
{ "status": "ready", "database": "connected" }
```

#### `GET /metrics`

Prometheus metrics endpoint exposing application counters, gauges, and request durations.

**Response `200 OK`**: Prometheus plaintext exposition format.

---

### Shows & inventory

#### `POST /shows`

Creates a new show with an initial seat inventory.

**Headers**: `Authorization: Bearer <admin_token>`

**Request body**

```json
{
  "name": "Rock Concert 2026",
  "seats": ["A1", "A2", "A3", "A4"],
  "price_paise": 15000,
  "per_user_limit": 4
}
```

**Response `201 Created`**

```json
{
  "id": "452ea8eb-eb96-44fa-a341-9c08154acecf",
  "name": "Rock Concert 2026",
  "total_seats": 4,
  "per_user_limit": 4
}
```

#### `GET /shows/:id`

Returns live inventory counts for a show.

**Response `200 OK`**

```json
{
  "id": "452ea8eb-eb96-44fa-a341-9c08154acecf",
  "name": "Rock Concert 2026",
  "total_seats": 4,
  "counts": {
    "total": 4,
    "available": 4,
    "confirmed": 0
  }
}
```

---

### Reservations

#### `POST /shows/:id/reserve`

Atomically reserves one or more seats. Seat rows are locked in canonical order, and requests from the same user for the same show are serialized with a transactional advisory lock.

**Headers**: `Authorization: Bearer <user_id>`

**Request body**

```json
{
  "seats": ["A1", "A2"],
  "idempotency_key": "unique-uuid-or-token"
}
```

**Response `201 Created`**

```json
{
  "reservation_id": "8d39f4e2-411a-4ab6-8f3e-430c5e7b2190",
  "show_id": "452ea8eb-eb96-44fa-a341-9c08154acecf",
  "seats": ["A1", "A2"],
  "status": "confirmed",
  "total_price_paise": 30000
}
```

Replaying the same `idempotency_key` with an identical body returns the original response without changing inventory.

**Response `409 Conflict`**: the `reason` field identifies the cause.

| `reason`                  | Meaning                                             |
| ------------------------- | --------------------------------------------------- |
| `seat_taken`              | One or more requested seats are no longer available |
| `per_user_limit_exceeded` | The booking                                         |

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
