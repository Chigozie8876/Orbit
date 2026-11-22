-- migrate:up
CREATE TABLE IF NOT EXISTS escrow_disputes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    contract_id VARCHAR(255) NOT NULL,
    escrow_id VARCHAR(255) NOT NULL,
    merchant_id UUID REFERENCES merchants(id) ON DELETE CASCADE,
    employer_address VARCHAR(255),
    contractor_address VARCHAR(255),
    arbiter_address VARCHAR(255),
    actor_address VARCHAR(255) NOT NULL,
    event_type VARCHAR(50) NOT NULL,
    status VARCHAR(50) NOT NULL,
    disputed_balance NUMERIC NOT NULL DEFAULT 0,
    disputed_balance_units NUMERIC NOT NULL DEFAULT 0,
    ledger_sequence BIGINT NOT NULL,
    transaction_hash VARCHAR(255),
    resolution_url TEXT,
    timeline JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS escrow_disputes_contract_escrow_idx ON escrow_disputes (contract_id, escrow_id);
CREATE INDEX IF NOT EXISTS escrow_disputes_merchant_id_idx ON escrow_disputes (merchant_id);

ALTER TABLE escrow_disputes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE escrow_disputes FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON escrow_disputes TO service_role;

-- migrate:down
DROP TABLE IF EXISTS escrow_disputes;
