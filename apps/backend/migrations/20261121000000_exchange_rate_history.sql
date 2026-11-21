-- Hourly archive of Stellar asset exchange rates (#303).
-- One row per asset per UTC hour; replays are idempotent via the unique key.

-- migrate:up
CREATE TABLE IF NOT EXISTS exchange_rate_history (
    id BIGSERIAL PRIMARY KEY,
    asset VARCHAR(8) NOT NULL,
    price_usd DOUBLE PRECISION NOT NULL CHECK (price_usd > 0),
    source VARCHAR(64) NOT NULL,
    captured_at TIMESTAMP WITH TIME ZONE NOT NULL,
    archive_hour TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    UNIQUE (asset, archive_hour)
);

CREATE INDEX IF NOT EXISTS exchange_rate_history_asset_hour_idx
    ON exchange_rate_history (asset, archive_hour DESC);

ALTER TABLE exchange_rate_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE exchange_rate_history FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE exchange_rate_history TO service_role;

-- migrate:down
DROP TABLE IF EXISTS exchange_rate_history;
