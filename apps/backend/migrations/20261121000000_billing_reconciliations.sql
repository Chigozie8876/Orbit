-- External billing reconciliation audit table (#Task 3)

-- migrate:up
CREATE TABLE IF NOT EXISTS billing_reconciliations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subscription_id UUID REFERENCES subscriptions(id) ON DELETE SET NULL,
    platform VARCHAR(50) NOT NULL CHECK (platform IN ('stripe', 'shopify')),
    event_id VARCHAR(255) NOT NULL,
    event_type VARCHAR(100) NOT NULL,
    external_customer_id VARCHAR(255),
    external_order_id VARCHAR(255),
    customer_email VARCHAR(255),
    status_before VARCHAR(50),
    status_after VARCHAR(50) NOT NULL,
    reconciled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    payload JSONB,
    metadata JSONB DEFAULT '{}'::jsonb,
    UNIQUE (platform, event_id)
);

CREATE INDEX IF NOT EXISTS billing_reconciliations_subscription_idx ON billing_reconciliations(subscription_id);
CREATE INDEX IF NOT EXISTS billing_reconciliations_platform_idx ON billing_reconciliations(platform, event_id);

-- migrate:down
DROP TABLE IF EXISTS billing_reconciliations;
