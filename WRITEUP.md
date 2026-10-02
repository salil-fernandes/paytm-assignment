# Architectural Writeup & System Guarantees

## 1. The Atomic Decision Mechanism

- **Row-level locking**: Reservations run inside PostgreSQL transactions at `READ COMMITTED` isolation, using `SELECT ... FOR UPDATE` on the candidate seat rows.
- **Race-free execution**: Naive read-then-write logic allows duplicate bookings when concurrent requests interleave. Here, competing transactions serialize at the database engine:
  1. The first transaction to acquire the locks verifies every requested seat has `status = 'available'`, sets them to `'confirmed'`, and commits.
  2. Competing transactions block on the same rows, then re-evaluate the freshly committed state (`status = 'confirmed'`), fail the domain check, roll back, and return HTTP `409 Conflict` (`seat_taken`).
- **Deadlock avoidance**: Two multi-seat requests such as `[A1, A2]` and `[A2, A1]` could otherwise form a cyclic wait (`40P01`). `FOR UPDATE` alone does not guarantee lock order, because Postgres locks rows in whatever order the plan returns them. So the order is enforced explicitly:

```sql
  SELECT seat_id, status
  FROM seats
  WHERE show_id = $1 AND seat_id = ANY($2)
  ORDER BY seat_id COLLATE "C"
  FOR UPDATE;
```

The application also sorts the seat array with a plain byte-wise string comparison. `COLLATE "C"` makes the database order match that comparison, so every worker acquires locks in one canonical order.

- **Lock acquisition order** (also part of deadlock prevention): `[idempotency key claim → per-user advisory lock → seat row locks]`. Every code path follows this order.

## 2. Idempotency Implementation

- **Key storage**: Records live in the `idempotency_keys` table with compound primary key `(user_id, key)`.
- **Request fingerprinting**: Request bodies are canonicalized and hashed with SHA-256 (`request_hash`).
- **Resolution flow**:
  - **Replay**: If `(user_id, key)` exists and `request_hash` matches, the stored response status (e.g. `201`) and body are returned without touching inventory.
  - **Payload mismatch**: If the key exists but the hash differs (different seats or show), the request is rejected with HTTP `409 Conflict` and inventory is untouched.
  - **Concurrent duplicates**: The key is claimed with `INSERT ... ON CONFLICT (user_id, key) DO NOTHING`. A second request with the same key blocks on the first transaction's uncommitted row, then reads the stored result once it commits (or claims the key itself if the first rolled back). Two simultaneous requests with one key can never both execute.
  - **Atomicity**: The idempotency record is written in the same transaction as the reservation, so a key can't exist without its outcome, or the reverse.
  - **Declines**: [State your behavior: e.g. "`409 seat_taken` responses are not stored, so a retry after seats free up can succeed" OR "all terminal responses, including declines, are stored and replayed."]

## 3. Per-User Limit Under Concurrency

A plain `SELECT COUNT(*)` lets parallel requests from one user all read the same count and bypass the per-show limit. Requests from the same user for the same show are serialized with a transaction-scoped advisory lock:

```sql
SELECT pg_advisory_xact_lock(hashtext($userId || ':' || $showId));
```

- The lock lives in Postgres shared memory, is scoped to the `(userId, showId)` pair, and is released automatically at commit or rollback.
- Different users, or the same user on different shows, are not blocked. Same-user same-show requests evaluate the quota one at a time.
- `hashtext` returns a 32-bit value, so collisions are possible. A collision only causes harmless extra serialization between two unrelated pairs, never incorrect results.

## 4. Cancellations [and Holds]

Cancellation is `POST /reservations/:id/cancel`.

- Identity is token-derived (`request.userId`); non-owners receive HTTP `403 Forbidden`.
- In one atomic transaction, the reservation is set to `'cancelled'` and its seats return to `'available'`. Both the reservation row and its seat rows are locked, in the same canonical order as bookings.
- **Double-cancel safety**: Seats are released only `WHERE reservation_id = $id`. Cancelling twice, or cancelling after the seats were re-booked by someone else, cannot free another user's seats. A repeated cancel is a no-op that returns the current state.
- **Holds**: [Either describe hold TTL / expiry handling, or write: "Temporary holds with expiry are not implemented; a reservation is immediately confirmed or declined. See Known Limitations."]

## 5. Consistency vs. Availability

The service chooses **consistency over availability** when the database is unreachable.

Double-selling a physical seat causes real-world conflicts that can't be undone, so the service fails closed:

- `/readyz` returns HTTP `503` when the database is unavailable.
- Write operations fail early with a clean error, never against stale or guessed state.
- The system runs against a single Postgres primary, so there is no divergence risk from replicas. [If you use failover/replicas: note that synchronous replication is required to preserve this guarantee.]

## 6. Observability & 2 AM Alerting

Prometheus-compatible metrics are exposed on `GET /metrics`.

**Business metrics**

- `reservations_confirmed_total` (counter)
- `reservations_declined_total{reason}` (counter; reasons: `seat_taken`, `per_user_limit`, `idempotent_mismatch`)
- `reservations_idempotent_replay_total` (counter)
- `seats_available` (gauge)

**Operational metrics**

- `http_requests_total{status}` (counter)
- `db_pool_waiting_clients` (gauge)
- `inventory_reconciliation_mismatch` (gauge, set by a background sweep that checks `available + confirmed == total_seats`)

**Page at 2 AM**

| Alert              | Condition                                                    | Why it matters                                                                                  |
| ------------------ | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| 5xx spike          | `rate(http_requests_total{status=~"5.."}[5m]) > 0.01` for 5m | Database connection exhaustion or unhandled exceptions; users are failing right now.            |
| Inventory mismatch | `inventory_reconciliation_mismatch > 0` for 1 sweep interval | Possible overselling or leaked seats. This is the invariant the whole system exists to protect. |

**Ticket / warning (do not page)**

| Alert           | Condition                              | Why it matters                                                                                     |
| --------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Pool saturation | `db_pool_waiting_clients > 10` for 10m | Early sign of load exceeding capacity; investigate in business hours unless it coincides with 5xx. |

## 7. Known Limitations & Tradeoffs

- Single Postgres primary: correctness is preserved, but the database is a single point of failure.
- [No hold TTL, if applicable.]
- Per-show hot rows serialize under extreme contention on the same seats; this is intended, since correctness is chosen over throughput.
- Advisory-lock hash collisions can cause occasional unnecessary serialization (never incorrect results).
- [Load test results: add the numbers from `burst.mjs`, e.g. "N concurrent requests for the same seat produced exactly 1 confirmation and N-1 `409`s, with 0 oversells."]

## 8. AI Usage

AI assistance was used for scaffolding boilerplate, writing multi-stage Docker build files, and generating the baseline load test harness (`burst.mjs`).

The core design decisions were made by me against the system constraints: canonical lock ordering for deadlock prevention, transactional advisory locks for per-user quotas, SHA-256 payload hashing for idempotency, and the consistency-first failure posture. Each is verified by automated integration tests.
