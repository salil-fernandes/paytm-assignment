import {
  FastifyInstance,
  FastifyPluginOptions,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { createHash } from "node:crypto";
import { pool } from "../../config/db.js";
import {
  reservationsConfirmedTotal,
  reservationsDeclinedTotal,
  reservationsIdempotentReplayTotal,
} from "../health/metrics.js";

interface ReserveRequestBody {
  seats: string[];
  idempotency_key?: string;
}

export async function reservationRoutes(
  fastify: FastifyInstance,
  _opts: FastifyPluginOptions,
) {
  // 1. Decorate request so Fastify preserves userId across hooks and handlers
  if (!fastify.hasRequestDecorator("userId")) {
    fastify.decorateRequest("userId", "");
  }

  // 2. Auth hook
  const authenticate = async (request: FastifyRequest, reply: FastifyReply) => {
    const authHeader = request.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return reply.status(401).send({
        error: "Unauthorized",
        message:
          "Missing or malformed Authorization header. Expected Bearer <token>",
      });
    }

    const token = authHeader.slice(7).trim();
    if (!token) {
      return reply.status(401).send({
        error: "Unauthorized",
        message: "Token cannot be empty",
      });
    }

    request.userId = token;
  };

  // POST /shows/:id/reserve
  fastify.post<{
    Params: { id: string };
    Body: ReserveRequestBody;
  }>(
    "/shows/:id/reserve",
    { preHandler: [authenticate] },
    async (request, reply) => {
      const showId = request.params.id;
      const userId = request.userId;

      if (!userId) {
        return reply.status(401).send({
          error: "Unauthorized",
          message: "User authentication required",
        });
      }

      const body = request.body || {};
      const idempotencyKey =
        (request.headers["idempotency-key"] as string) || body.idempotency_key;

      if (!idempotencyKey) {
        return reply.status(400).send({
          error: "Bad Request",
          message: "idempotency_key is required in headers or body",
        });
      }

      const rawSeats = body.seats;
      if (!Array.isArray(rawSeats) || rawSeats.length === 0) {
        return reply.status(400).send({
          error: "Bad Request",
          message: "seats must be a non-empty array of seat numbers",
        });
      }

      // 1. DEADLOCK PREVENTION: Enforce global canonical sorting order
      const requestedSeats = Array.from(new Set(rawSeats)).sort();

      // Canonical hash of the payload for idempotency verification
      const canonicalPayload = JSON.stringify({ seats: requestedSeats });
      const requestHash = createHash("sha256")
        .update(canonicalPayload)
        .digest("hex");

      const client = await pool.connect();

      try {
        await client.query("BEGIN");

        // 2. IDEMPOTENCY CHECK
        const existingKeyRes = await client.query(
          `SELECT request_hash, response_status, response_body 
           FROM idempotency_keys 
           WHERE user_id = $1 AND key = $2 
           FOR UPDATE`,
          [userId, idempotencyKey],
        );

        if (existingKeyRes.rowCount && existingKeyRes.rowCount > 0) {
          const recorded = existingKeyRes.rows[0];

          // Same key, different body -> 409 Conflict
          if (recorded.request_hash !== requestHash) {
            reservationsDeclinedTotal.inc({ reason: "idempotent_mismatch" });
            await client.query("ROLLBACK");
            return reply.status(409).send({
              error: "Conflict",
              message:
                "Idempotency key reused with different request parameters",
            });
          }

          // Same key, same body -> Return cached response (replay)
          reservationsIdempotentReplayTotal.inc();
          await client.query("ROLLBACK");
          return reply
            .status(recorded.response_status)
            .send(recorded.response_body);
        }

        // 3. FETCH SHOW DETAILS
        const showRes = await client.query(
          "SELECT id, price_paise, per_user_limit FROM shows WHERE id = $1",
          [showId],
        );

        if (showRes.rowCount === 0) {
          await client.query("ROLLBACK");
          return reply
            .status(404)
            .send({ error: "Not Found", message: "Show not found" });
        }

        const show = showRes.rows[0];

        // 4. ATOMIC PER-USER LIMIT PROTECTION
        // Take a user-and-show-scoped advisory lock to serialize limit checks per user
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `${userId}:${showId}`,
        ]);

        const userSeatCountRes = await client.query(
          `SELECT COUNT(*)::int as count 
           FROM reservation_seats rs
           JOIN reservations r ON rs.reservation_id = r.id
           WHERE r.user_id = $1 AND r.show_id = $2 AND r.status = 'confirmed'`,
          [userId, showId],
        );

        const currentBookedCount = userSeatCountRes.rows[0].count;
        if (currentBookedCount + requestedSeats.length > show.per_user_limit) {
          reservationsDeclinedTotal.inc({ reason: "per_user_limit" });
          await client.query("ROLLBACK");
          return reply.status(409).send({
            error: "Conflict",
            reason: "per_user_limit_exceeded",
            message: `Booking exceeds per-user limit of ${show.per_user_limit} seats`,
            current_held: currentBookedCount,
            requested: requestedSeats.length,
          });
        }

        // 5. ATOMIC SEAT LOCKING & VERIFICATION (All-or-Nothing)
        // Select matching seats FOR UPDATE in deterministic order
        const lockSeatsRes = await client.query(
          `SELECT seat_number, status 
           FROM seats 
           WHERE show_id = $1 AND seat_number = ANY($2::text[])
           ORDER BY seat_number ASC
           FOR UPDATE`,
          [showId, requestedSeats],
        );

        // Check if all requested seats actually exist in this show
        if (lockSeatsRes.rowCount !== requestedSeats.length) {
          await client.query("ROLLBACK");
          return reply.status(400).send({
            error: "Bad Request",
            message: "One or more requested seats do not exist for this show",
          });
        }

        // Check if ANY requested seat is already taken
        const unavailable = lockSeatsRes.rows.filter(
          (s) => s.status !== "available",
        );
        if (unavailable.length > 0) {
          reservationsDeclinedTotal.inc({ reason: "seat_taken" });
          await client.query("ROLLBACK");
          return reply.status(409).send({
            error: "Conflict",
            reason: "seat_taken",
            message: "One or more requested seats are already reserved",
            unavailable_seats: unavailable.map((s) => s.seat_number),
          });
        }

        // 6. UPDATE SEAT STATUS
        await client.query(
          `UPDATE seats 
           SET status = 'confirmed', updated_at = NOW() 
           WHERE show_id = $1 AND seat_number = ANY($2::text[])`,
          [showId, requestedSeats],
        );

        // 7. RECORD RESERVATION
        const totalAmount = show.price_paise * requestedSeats.length;
        const reservationRes = await client.query(
          `INSERT INTO reservations (show_id, user_id, amount_paise, status)
           VALUES ($1, $2, $3, 'confirmed')
           RETURNING id, show_id, user_id, amount_paise, status`,
          [showId, userId, totalAmount],
        );
        const reservation = reservationRes.rows[0];

        // Link seats to reservation
        for (const seat of requestedSeats) {
          await client.query(
            `INSERT INTO reservation_seats (reservation_id, show_id, seat_number)
             VALUES ($1, $2, $3)`,
            [reservation.id, showId, seat],
          );
        }

        const responsePayload = {
          reservation_id: reservation.id,
          show_id: reservation.show_id,
          user_id: reservation.user_id,
          seats: requestedSeats,
          amount_paise: reservation.amount_paise,
          status: reservation.status,
        };

        // 8. RECORD IDEMPOTENCY KEY
        await client.query(
          `INSERT INTO idempotency_keys (user_id, key, request_hash, response_status, response_body)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            userId,
            idempotencyKey,
            requestHash,
            201,
            JSON.stringify(responsePayload),
          ],
        );

        await client.query("COMMIT");
        reservationsConfirmedTotal.inc();
        return reply.status(201).send(responsePayload);
      } catch (err: any) {
        await client.query("ROLLBACK");
        request.log.error(err, "Reservation processing failed");

        // Catch unique constraint or concurrency serialization violations cleanly
        if (err.code === "23505" || err.code === "40001") {
          return reply.status(409).send({
            error: "Conflict",
            reason: "concurrent_modification",
            message: "Seat state changed concurrently. Please retry.",
          });
        }

        return reply.status(500).send({
          error: "Internal Server Error",
          message: "An unexpected error occurred while processing reservation",
        });
      } finally {
        client.release();
      }
    },
  );

  // POST /reservations/:id/cancel
  fastify.post<{ Params: { id: string } }>(
    "/reservations/:id/cancel",
    { preHandler: [authenticate] },
    async (request, reply) => {
      const reservationId = request.params.id;
      const userId = request.userId;

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        // 1. Fetch reservation with an exclusive row lock
        const resQuery = await client.query(
          `SELECT id, show_id, user_id, status 
           FROM reservations 
           WHERE id = $1 
           FOR UPDATE`,
          [reservationId],
        );

        if (resQuery.rowCount === 0) {
          await client.query("ROLLBACK");
          return reply
            .status(404)
            .send({ error: "Not Found", message: "Reservation not found" });
        }

        const reservation = resQuery.rows[0];

        // 2. Strict ownership check
        if (reservation.user_id !== userId) {
          await client.query("ROLLBACK");
          return reply.status(403).send({
            error: "Forbidden",
            message: "You are not authorized to cancel this reservation",
          });
        }

        // 3. Prevent duplicate cancellation
        if (reservation.status === "cancelled") {
          await client.query("ROLLBACK");
          return reply.status(400).send({
            error: "Bad Request",
            message: "Reservation is already cancelled",
          });
        }

        // 4. Retrieve associated seats
        const seatsQuery = await client.query(
          `SELECT seat_number 
           FROM reservation_seats 
           WHERE reservation_id = $1 
           ORDER BY seat_number ASC 
           FOR UPDATE`,
          [reservationId],
        );

        const seatNumbers = seatsQuery.rows.map((r) => r.seat_number);

        // 5. Transition reservation status
        await client.query(
          `UPDATE reservations 
           SET status = 'cancelled' 
           WHERE id = $1`,
          [reservationId],
        );

        // 6. Atomically return seats to 'available'
        await client.query(
          `UPDATE seats 
           SET status = 'available', updated_at = NOW() 
           WHERE show_id = $1 AND seat_number = ANY($2::text[])`,
          [reservation.show_id, seatNumbers],
        );

        await client.query("COMMIT");

        return reply.status(200).send({
          reservation_id: reservation.id,
          status: "cancelled",
          seats_released: seatNumbers,
        });
      } catch (err) {
        await client.query("ROLLBACK");
        request.log.error(err, "Failed to cancel reservation");
        return reply.status(500).send({
          error: "Internal Server Error",
          message: "An error occurred while cancelling reservation",
        });
      } finally {
        client.release();
      }
    },
  );
}
