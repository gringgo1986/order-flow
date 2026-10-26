-- ====================================================================
-- XAUUSD ORDER FLOW & BOOKMAP COCKPIT - SUPABASE SCHEMA
-- Jalankan skrip ini di Supabase SQL Editor (1 Klik Sahaja)
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

-- 2. Jadual Lilin, Footprint & ClusterDelta (Volume & Delta Ladders)
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

-- 3. Jadual Rekod Isyarat Institusi Disahkan (Signal Journal)
CREATE TABLE IF NOT EXISTS signals_history (
    id BIGSERIAL PRIMARY KEY,
    timestamp BIGINT NOT NULL,
    type VARCHAR(50) NOT NULL,
    direction VARCHAR(10) NOT NULL,
    price NUMERIC(10,2) NOT NULL,
    sl NUMERIC(10,2),
    tp1 NUMERIC(10,2),
    badge VARCHAR(120),
    created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_signals_ts ON signals_history(timestamp DESC);

-- 4. Polisi Keselamatan Akses Penuh untuk Pelayan (RLS Policies)
ALTER TABLE bookmap_heatmap ENABLE ROW LEVEL SECURITY;
ALTER TABLE candles_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE signals_history ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    DROP POLICY IF EXISTS "Full Access bookmap_heatmap" ON bookmap_heatmap;
    CREATE POLICY "Full Access bookmap_heatmap" ON bookmap_heatmap FOR ALL USING (true) WITH CHECK (true);

    DROP POLICY IF EXISTS "Full Access candles_history" ON candles_history;
    CREATE POLICY "Full Access candles_history" ON candles_history FOR ALL USING (true) WITH CHECK (true);

    DROP POLICY IF EXISTS "Full Access signals_history" ON signals_history;
    CREATE POLICY "Full Access signals_history" ON signals_history FOR ALL USING (true) WITH CHECK (true);
END $$;
