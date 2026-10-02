import Fastify from "fastify";
import dotenv from "dotenv";
import crypto from "node:crypto";
import { showRoutes } from "./modules/shows/shows.routes.js";
import { reservationRoutes } from "./modules/reservations/reservations.routes.js";
import { healthRoutes } from "./modules/health/health.routes.js";

dotenv.config();

const fastify = Fastify({
  logger: {
    transport:
      process.env.NODE_ENV !== "production"
        ? {
            target: "pino-pretty",
            options: { colorize: true },
          }
        : undefined,
  },
  genReqId: (req) =>
    (req.headers["x-request-id"] as string) || crypto.randomUUID(),
});

// Attach correlation ID to request context
fastify.addHook("onRequest", async (request, reply) => {
  request.correlationId = request.id;
  reply.header("x-request-id", request.id);
});

// Root route
fastify.get("/", async (_request, reply) => {
  return reply.status(200).send({
    service: "high-concurrency-seat-reservation-api",
    status: "healthy",
    documentation: {
      health: "/healthz",
      readiness: "/readyz",
      metrics: "/metrics",
      shows: "/shows",
    },
  });
});

// Register show routes
fastify.register(healthRoutes);
fastify.register(showRoutes);
fastify.register(reservationRoutes);

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";

async function start() {
  try {
    await fastify.listen({ port: PORT, host: HOST });
    console.log(`Server listening on http://${HOST}:${PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

start();
