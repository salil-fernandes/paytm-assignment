import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../config/db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runMigrations() {
  const client = await pool.connect();
  try {
    const migrationFile = path.resolve(
      __dirname,
      "../../migrations/001_initial_schema.sql",
    );
    const sql = fs.readFileSync(migrationFile, "utf8");

    console.log("Running migration: 001_initial_schema.sql...");
    await client.query(sql);
    console.log("Migration completed successfully.");
  } catch (err) {
    console.error("Migration failed:", err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

runMigrations();
