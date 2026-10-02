import { FastifyInstance } from "fastify";
import { pool } from "../../config/db.js";
import { register } from "./metrics.js";

export async function healthRoutes(fastify: FastifyInstance) {
  // 1. Liveness Probe
  fastify.get("/healthz", async (_request, reply) => {
    return reply.status(200).send({ status: "live" });
  });

  // 2. Readiness Probe (Checks PostgreSQL connectivity)
  fastify.get("/readyz", async (request, reply) => {
    try {
      const client = await pool.connect();
      try {
        await client.query("SELECT 1");
        return reply
          .status(200)
          .send({ status: "ready", database: "connected" });
      } finally {
        client.release();
      }
    } catch (err) {
      request.log.error(err, "Readiness check failed");
      return reply
        .status(503)
        .send({ status: "unready", database: "disconnected" });
    }
  });

  // 3. Prometheus Metrics Scraping Endpoint
  fastify.get("/metrics", async (_request, reply) => {
    reply.header("Content-Type", register.contentType);
    return reply.send(await register.metrics());
  });
}
