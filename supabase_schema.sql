-- ====================================================================
-- XAUUSD ORDER FLOW & BOOKMAP COCKPIT - SUPABASE SCHEMA (5 DAYS RETENTION)
-- ====================================================================

-- 1. Jadual Peta Haba Bookmap (Heatmap Depth History)
CREATE TABLE IF NOT EXISTS bookmap_heatmap (
    id BIGSERIAL PRIMARY KEY,
    timestamp BIGINT NOT NULL,
    mid_price NUMERIC(10,2) NOT NULL,
    bids JSONB NOT NULL DEFAULT '{}'::jsonb,
    asks JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bookmap_heatmap_ts ON bookmap_heatmap(timestamp DESC);

-- 2. Jadual Lilin, Footprint & ClusterDelta (Volume & Delta Ladders - 5 Hari Penuh)
CREATE TABLE IF NOT EXISTS candles_history (
    id BIGSERIAL PRIMARY KEY,
    timeframe VARCHAR(10) NOT NULL DEFAULT 'M1',
    time BIGINT NOT NULL,
    open NUMERIC(10,2) NOT NULL,
    high NUMERIC(10,2) NOT NULL,
    low NUMERIC(10,2) NOT NULL,
    close NUMERIC(10,2) NOT NULL,
    volume NUMERIC(10,2) DEFAULT 0,
    delta NUMERIC(10,2) DEFAULT 0,
    clusters JSONB DEFAULT '{}'::jsonb,
    UNIQUE(timeframe, time)
);
CREATE INDEX IF NOT EXISTS idx_candles_tf_time ON candles_history(timeframe, time DESC);

-- 3. Jadual Rekod Isyarat Institusi Disahkan (Gunakan signal_type elak konflik PostgreSQL)
CREATE TABLE IF NOT EXISTS signals_history (
    id BIGSERIAL PRIMARY KEY,
    timestamp BIGINT NOT NULL,
    signal_type VARCHAR(50) NOT NULL,
    direction VARCHAR(10) NOT NULL,
    price NUMERIC(10,2) NOT NULL,
    sl NUMERIC(10,2),
    tp1 NUMERIC(10,2),
    badge VARCHAR(120),
    created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_signals_ts ON signals_history(timestamp DESC);

-- 4. Jadual Pengguna Sistem (Users - Disimpan Kekal di Supabase)
CREATE TABLE IF NOT EXISTS app_users (
    id BIGSERIAL PRIMARY KEY,
    username VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(150) NOT NULL,
    role VARCHAR(50) NOT NULL DEFAULT 'member',
    plan VARCHAR(100) NOT NULL DEFAULT 'Bulanan 30 Hari',
    created_at VARCHAR(100) NOT NULL,
    expires_at VARCHAR(100) NOT NULL DEFAULT 'never',
    is_active BOOLEAN NOT NULL DEFAULT true,
    last_login VARCHAR(100),
    notes TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_app_users_username ON app_users(username);

-- 5. Jadual Sesi Pengguna (App Sessions)
CREATE TABLE IF NOT EXISTS app_sessions (
    session_id VARCHAR(100) PRIMARY KEY,
    user_id BIGINT,
    username VARCHAR(100),
    created_at TIMESTAMPTZ DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
);

-- 6. Polisi Keselamatan Akses Penuh untuk Pelayan (Bypass RLS)
ALTER TABLE bookmap_heatmap ENABLE ROW LEVEL SECURITY;
ALTER TABLE candles_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE signals_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_sessions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    DROP POLICY IF EXISTS "Full Access bookmap_heatmap" ON bookmap_heatmap;
    CREATE POLICY "Full Access bookmap_heatmap" ON bookmap_heatmap FOR ALL USING (true) WITH CHECK (true);

    DROP POLICY IF EXISTS "Full Access candles_history" ON candles_history;
    CREATE POLICY "Full Access candles_history" ON candles_history FOR ALL USING (true) WITH CHECK (true);

    DROP POLICY IF EXISTS "Full Access signals_history" ON signals_history;
    CREATE POLICY "Full Access signals_history" ON signals_history FOR ALL USING (true) WITH CHECK (true);

    DROP POLICY IF EXISTS "Full Access app_users" ON app_users;
    CREATE POLICY "Full Access app_users" ON app_users FOR ALL USING (true) WITH CHECK (true);

    DROP POLICY IF EXISTS "Full Access app_sessions" ON app_sessions;
    CREATE POLICY "Full Access app_sessions" ON app_sessions FOR ALL USING (true) WITH CHECK (true);
END $$;

-- 7. Fungsi Pembersihan Automatik Rekod Melebihi 5 Hari (5-Day Rolling Retention)
CREATE OR REPLACE FUNCTION prune_older_than_5_days()
RETURNS void AS $$
BEGIN
    DELETE FROM bookmap_heatmap 
    WHERE timestamp < ((EXTRACT(EPOCH FROM (NOW() - INTERVAL '5 days')) * 1000)::BIGINT);

    DELETE FROM candles_history 
    WHERE time < EXTRACT(EPOCH FROM (NOW() - INTERVAL '5 days'))::BIGINT;

    DELETE FROM signals_history 
    WHERE timestamp < EXTRACT(EPOCH FROM (NOW() - INTERVAL '5 days'))::BIGINT;
END;
$$ LANGUAGE plpgsql;
