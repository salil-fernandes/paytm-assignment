#!/usr/bin/env node

const BASE_URL =
  process.argv[2] || process.env.BASE_URL || "http://localhost:3000";
console.log(`Starting on-sale stampede against: ${BASE_URL}\n`);

async function run() {
  const t0 = Date.now();

  // 1. Create a fresh test show with 100 seats
  const seatList = [];
  for (let row of ["A", "B", "C", "D", "E"]) {
    for (let num = 1; num <= 20; num++) {
      seatList.push(`${row}${num}`);
    }
  }

  console.log(`[1/4] Creating show with ${seatList.length} seats...`);
  const showRes = await fetch(`${BASE_URL}/shows`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer admin",
    },
    body: JSON.stringify({
      name: `stampede-${Date.now()}`,
      seats: seatList,
      price_paise: 20000,
      per_user_limit: 4,
    }),
  });

  if (!showRes.ok) {
    console.error("Failed to create test show:", await showRes.text());
    process.exit(1);
  }

  const show = await showRes.json();
  const showId = show.id;
  console.log(`Show created: ${showId}\n`);

  // 2. Prepare Stampede
  // 500 buyers fighting over hot seat A1
  // 500 buyers requesting random seats across the venue
  // 100 duplicate idempotent retries
  console.log("[2/4] Firing concurrent on-sale stampede (1,100 requests)...");

  const requests = [];
  let counts = {
    c201: 0,
    c409_seat_taken: 0,
    c409_limit: 0,
    c409_idemp_mismatch: 0,
    c409_other: 0,
    c5xx: 0,
    other: 0,
  };

  // Hot seat storm: 500 users targeting A1
  for (let i = 0; i < 500; i++) {
    requests.push({
      user: `user_hot_${i}`,
      seats: ["A1"],
      key: `key_hot_${i}`,
    });
  }

  // Idempotent retries: 50 replays of user_hot_0
  for (let i = 0; i < 50; i++) {
    requests.push({
      user: `user_hot_0`,
      seats: ["A1"],
      key: `key_hot_0`,
    });
  }

  // Idempotent mismatch: same key, different seats
  for (let i = 0; i < 50; i++) {
    requests.push({
      user: `user_hot_0`,
      seats: ["A2"],
      key: `key_hot_0`,
    });
  }

  // Broad contention: 500 random bookings
  for (let i = 0; i < 500; i++) {
    const randomSeat = seatList[Math.floor(Math.random() * seatList.length)];
    requests.push({
      user: `buyer_general_${i % 100}`, // 100 users making multiple requests
      seats: [randomSeat],
      key: `key_gen_${i}`,
    });
  }

  // Fire in parallel batches of 50 to avoid local socket starvation
  const BATCH_SIZE = 50;
  for (let i = 0; i < requests.length; i += BATCH_SIZE) {
    const batch = requests.slice(i, i + BATCH_SIZE);
    const promises = batch.map(async (req) => {
      try {
        const res = await fetch(`${BASE_URL}/shows/${showId}/reserve`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${req.user}`,
          },
          body: JSON.stringify({
            seats: req.seats,
            idempotency_key: req.key,
          }),
        });

        const status = res.status;
        const body = await res.json().catch(() => ({}));

        if (status === 201) counts.c201++;
        else if (status === 409) {
          if (body.reason === "seat_taken") counts.c409_seat_taken++;
          else if (body.reason === "per_user_limit_exceeded")
            counts.c409_limit++;
          else if (body.message?.includes("different request parameters"))
            counts.c409_idemp_mismatch++;
          else counts.c409_other++;
        } else if (status >= 500) {
          counts.c5xx++;
        } else {
          counts.other++;
        }
      } catch (err) {
        counts.c5xx++;
      }
    });

    await Promise.all(promises);
  }

  console.log(
    `Stampede finished in ${((Date.now() - t0) / 1000).toFixed(2)}s\n`,
  );

  // 3. Print Results Distribution
  console.log("--- OUTCOME DISTRIBUTION ---");
  console.log(`201 Confirmed (includes idempotent replays): ${counts.c201}`);
  console.log(
    `409 Declined (Seat Taken):                 ${counts.c409_seat_taken}`,
  );
  console.log(
    `409 Declined (Per-User Limit):             ${counts.c409_limit}`,
  );
  console.log(
    `409 Declined (Idempotency Mismatch):       ${counts.c409_idemp_mismatch}`,
  );
  console.log(
    `409 Declined (Other / Contention):         ${counts.c409_other}`,
  );
  console.log(`5xx Server Errors:                         ${counts.c5xx}`);
  console.log("----------------------------\n");

  // 4. Verify Invariant Reconciliation
  console.log("[3/4] Checking Reconciliation Invariant...");
  const stateRes = await fetch(`${BASE_URL}/shows/${showId}`);
  const state = await stateRes.json();
  const stats = state.counts || state.summary;
  const { available, confirmed } = stats;
  const total = stats.total ?? state.total_seats;

  console.log(`Total Seats:     ${total}`);
  console.log(`Available Seats: ${available}`);
  console.log(`Confirmed Seats: ${confirmed}`);
  console.log(`Sum:             ${available + confirmed}`);

  const reconciled = available + confirmed === total && counts.c5xx === 0;
  console.log(`\nReconciliation Valid: ${reconciled ? "PASS" : "FAIL"}`);

  if (!reconciled) process.exit(1);
}

run();
