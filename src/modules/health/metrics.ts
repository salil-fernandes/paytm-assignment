import client from "prom-client";

export const register = new client.Registry();

// Collect default Node.js runtime metrics (memory, event loop lag, CPU)
client.collectDefaultMetrics({ register, prefix: "seat_service_" });

export const reservationsConfirmedTotal = new client.Counter({
  name: "reservations_confirmed_total",
  help: "Total number of successfully confirmed seat reservations",
  registers: [register],
});

export const reservationsDeclinedTotal = new client.Counter({
  name: "reservations_declined_total",
  help: "Total number of declined seat reservations partitioned by reason",
  labelNames: ["reason"] as const,
  registers: [register],
});

export const reservationsIdempotentReplayTotal = new client.Counter({
  name: "reservations_idempotent_replay_total",
  help: "Total number of requests satisfied by idempotent replay",
  registers: [register],
});

export const seatsAvailableGauge = new client.Gauge({
  name: "seats_available",
  help: "Current number of seats available per show",
  labelNames: ["show_id"] as const,
  registers: [register],
});
