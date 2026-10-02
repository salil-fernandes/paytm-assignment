CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Shows Table
CREATE TABLE IF NOT EXISTS shows (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    price_paise INTEGER NOT NULL CHECK (price_paise >= 0),
    per_user_limit INTEGER NOT NULL DEFAULT 4 CHECK (per_user_limit > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Seat Status Enum
DO $$ BEGIN
    CREATE TYPE seat_status AS ENUM ('available', 'confirmed');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- 3. Seats Inventory Table
CREATE TABLE IF NOT EXISTS seats (
    show_id UUID NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
    seat_number VARCHAR(32) NOT NULL,
    status seat_status NOT NULL DEFAULT 'available',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (show_id, seat_number)
);

-- 4. Reservations Table
DO $$ BEGIN
    CREATE TYPE reservation_status AS ENUM ('confirmed', 'cancelled');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS reservations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    show_id UUID NOT NULL REFERENCES shows(id),
    user_id VARCHAR(128) NOT NULL,
    amount_paise INTEGER NOT NULL CHECK (amount_paise >= 0),
    status reservation_status NOT NULL DEFAULT 'confirmed',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reservations_user_show 
ON reservations(user_id, show_id) 
WHERE status = 'confirmed';

-- 5. Reservation Seats Junction Table
CREATE TABLE IF NOT EXISTS reservation_seats (
    reservation_id UUID NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
    show_id UUID NOT NULL,
    seat_number VARCHAR(32) NOT NULL,
    PRIMARY KEY (reservation_id, seat_number),
    FOREIGN KEY (show_id, seat_number) REFERENCES seats(show_id, seat_number)
);

-- 6. Idempotency Key Table
CREATE TABLE IF NOT EXISTS idempotency_keys (
    user_id VARCHAR(128) NOT NULL,
    key VARCHAR(255) NOT NULL,
    request_hash VARCHAR(64) NOT NULL,
    response_status INTEGER,
    response_body JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, key)
);