import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 50, // maximum pool size
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000, // fail quickly under high load rather than hanging
});

pool.on("error", (err) => {
  console.error("Unexpected idle client error", err);
});
