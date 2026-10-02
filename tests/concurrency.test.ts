import { describe, it, expect, beforeAll } from "vitest";
import crypto from "node:crypto";

const BASE_URL = "http://127.0.0.1:3000";

async function makeRequest(path: string, options: RequestInit = {}) {
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  const fullUrl = `${BASE_URL}${cleanPath}`;

  const res = await fetch(fullUrl, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

describe("Seat Reservation Concurrency & Correctness Bar", () => {
  let showId: string;
  const runId = crypto.randomUUID().slice(0, 8);

  beforeAll(async () => {
    const seats = Array.from({ length: 20 }, (_, i) => `S${i + 1}`);

    const res = await makeRequest("/shows", {
      method: "POST",
      headers: {
        Authorization: "Bearer admin",
      },
      body: JSON.stringify({
        name: `test-show-${runId}`,
        seats,
        price_paise: 15000,
        per_user_limit: 4,
      }),
    });

    expect(res.status).toBe(201);
    showId = res.data.id;
  });

  it("1. Hot seat contention: 50 concurrent buyers fight for S1; exactly ONE wins", async () => {
    const buyers = Array.from({ length: 50 }, (_, i) => ({
      userId: `buyer_${runId}_${i}`,
      key: `key_${runId}_${i}`,
    }));

    const promises = buyers.map((b) =>
      makeRequest(`/shows/${showId}/reserve`, {
        method: "POST",
        headers: { Authorization: `Bearer ${b.userId}` },
        body: JSON.stringify({
          seats: ["S1"],
          idempotency_key: b.key,
        }),
      }),
    );

    const results = await Promise.all(promises);

    const winners = results.filter((r) => r.status === 201);
    const conflicts = results.filter((r) => r.status === 409);
    const serverErrors = results.filter((r) => r.status >= 500);

    expect(winners.length).toBe(1);
    expect(conflicts.length).toBe(49);
    expect(serverErrors.length).toBe(0);
  });

  it("2. Per-user limit under concurrency: single user fires 10 parallel requests for 1 seat each", async () => {
    const targetSeats = [
      "S2",
      "S3",
      "S4",
      "S5",
      "S6",
      "S7",
      "S8",
      "S9",
      "S10",
      "S11",
    ];
    const userId = `greedy_user_${runId}`;

    const promises = targetSeats.map((seat, i) =>
      makeRequest(`/shows/${showId}/reserve`, {
        method: "POST",
        headers: { Authorization: `Bearer ${userId}` },
        body: JSON.stringify({
          seats: [seat],
          idempotency_key: `greedy_key_${runId}_${i}`,
        }),
      }),
    );

    const results = await Promise.all(promises);

    const successes = results.filter((r) => r.status === 201);
    const limited = results.filter(
      (r) => r.status === 409 && r.data.reason === "per_user_limit_exceeded",
    );
    const serverErrors = results.filter((r) => r.status >= 500);

    expect(successes.length).toBe(4);
    expect(limited.length).toBe(6);
    expect(serverErrors.length).toBe(0);
  });

  it("3. Reconciliation invariant holds during and after the burst", async () => {
    const res = await makeRequest(`/shows/${showId}`);
    expect(res.status).toBe(200);

    const stats = res.data.counts || res.data.summary;
    expect(stats).toBeDefined();

    const { available, confirmed } = stats;
    const total = stats.total ?? res.data.total_seats;

    expect(available + confirmed).toBe(total);
    // 1 won from hot-seat S1 + 4 won by greedy_user = exactly 5 confirmed
    expect(confirmed).toBe(5);
    expect(available).toBe(15);
  });
});
