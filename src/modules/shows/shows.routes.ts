import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { pool } from "../../config/db.js";
import { requireAdmin } from "../../middleware/auth.js";

interface CreateShowBody {
  name: string;
  seats: string[];
  price_paise: number;
  per_user_limit?: number;
}

interface ShowParams {
  id: string;
}

export async function showRoutes(fastify: FastifyInstance) {
  // 1. Create Show (Admin)
  fastify.post<{ Body: CreateShowBody }>(
    "/shows",
    { preHandler: [requireAdmin] },
    async (
      request: FastifyRequest<{ Body: CreateShowBody }>,
      reply: FastifyReply,
    ) => {
      const { name, seats, price_paise, per_user_limit = 4 } = request.body;

      if (
        !name ||
        !Array.isArray(seats) ||
        seats.length === 0 ||
        typeof price_paise !== "number"
      ) {
        return reply.status(400).send({
          error:
            "Invalid request body. Requires name, seats array, and price_paise.",
        });
      }

      // Deduplicate seats in input
      const uniqueSeats = Array.from(new Set(seats));

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        // Create show
        const showRes = await client.query(
          `INSERT INTO shows (name, price_paise, per_user_limit)
           VALUES ($1, $2, $3)
           RETURNING id, name, price_paise, per_user_limit, created_at`,
          [name, price_paise, per_user_limit],
        );
        const show = showRes.rows[0];

        // Bulk insert seats using unnest for high performance
        await client.query(
          `INSERT INTO seats (show_id, seat_number, status)
           SELECT $1, unnest($2::text[]), 'available'::seat_status`,
          [show.id, uniqueSeats],
        );

        await client.query("COMMIT");

        return reply.status(201).send({
          id: show.id,
          name: show.name,
          price_paise: show.price_paise,
          per_user_limit: show.per_user_limit,
          total_seats: uniqueSeats.length,
          status: "available",
        });
      } catch (err) {
        await client.query("ROLLBACK");
        request.log.error(err, "Failed to create show");
        return reply.status(500).send({ error: "Internal server error" });
      } finally {
        client.release();
      }
    },
  );

  // 2. Get Show State
  fastify.get<{ Params: ShowParams }>(
    "/shows/:id",
    async (
      request: FastifyRequest<{ Params: ShowParams }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;

      const client = await pool.connect();
      try {
        // Fetch show details
        const showRes = await client.query(
          `SELECT id, name, price_paise, per_user_limit FROM shows WHERE id = $1`,
          [id],
        );

        if (showRes.rows.length === 0) {
          return reply.status(404).send({ error: "Show not found" });
        }
        const show = showRes.rows[0];

        // Fetch all seats and status counts in a single query
        const seatsRes = await client.query(
          `SELECT seat_number, status FROM seats WHERE show_id = $1 ORDER BY seat_number ASC`,
          [id],
        );

        let availableCount = 0;
        let confirmedCount = 0;
        const seatsMap: Record<string, string> = {};

        for (const row of seatsRes.rows) {
          seatsMap[row.seat_number] = row.status;
          if (row.status === "available") availableCount++;
          if (row.status === "confirmed") confirmedCount++;
        }

        const totalSeats = seatsRes.rows.length;

        // Reconciliation Invariant Assertion
        const isReconciled = availableCount + confirmedCount === totalSeats;

        return reply.status(200).send({
          id: show.id,
          name: show.name,
          price_paise: show.price_paise,
          per_user_limit: show.per_user_limit,
          counts: {
            total: totalSeats,
            available: availableCount,
            confirmed: confirmedCount,
          },
          reconciled: isReconciled,
          seats: seatsMap,
        });
      } catch (err) {
        request.log.error(err, "Failed to fetch show state");
        return reply.status(500).send({ error: "Internal server error" });
      } finally {
        client.release();
      }
    },
  );
}
