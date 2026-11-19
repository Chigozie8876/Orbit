-- Durable claims and retry state for autonomous subscription pulls.

-- migrate:up
CREATE TABLE IF NOT EXISTS recurring_pull_executions (
    vault_id VARCHAR(64) NOT NULL,
    billing_cycle TIMESTAMP WITH TIME ZONE NOT NULL,
    subscription_id UUID NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
    state VARCHAR(16) NOT NULL CHECK (state IN ('processing', 'retry', 'settled', 'failed')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_retry_at TIMESTAMP WITH TIME ZONE,
    lease_token UUID,
    locked_until TIMESTAMP WITH TIME ZONE,
    transaction_hash VARCHAR(64),
    last_error TEXT,
    settled_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    PRIMARY KEY (vault_id, billing_cycle)
);

CREATE INDEX IF NOT EXISTS recurring_pull_executions_due_idx
    ON recurring_pull_executions (state, next_retry_at)
    WHERE state = 'retry';
CREATE INDEX IF NOT EXISTS recurring_pull_executions_subscription_idx
    ON recurring_pull_executions (subscription_id, billing_cycle DESC);

ALTER TABLE recurring_pull_executions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE recurring_pull_executions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE recurring_pull_executions TO service_role;

CREATE OR REPLACE FUNCTION claim_recurring_pull_cycle(
    p_vault_id VARCHAR,
    p_billing_cycle TIMESTAMP WITH TIME ZONE,
    p_subscription_id UUID,
    p_lease_token UUID,
    p_lease_seconds INTEGER
)
RETURNS TABLE(claimed BOOLEAN, transaction_hash VARCHAR, attempt_count INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_execution recurring_pull_executions%ROWTYPE;
BEGIN
    IF p_lease_seconds <= 0 THEN
        RAISE EXCEPTION 'lease duration must be positive';
    END IF;

    INSERT INTO recurring_pull_executions (
        vault_id, billing_cycle, subscription_id, state, attempt_count,
        lease_token, locked_until
    )
    VALUES (
        p_vault_id, p_billing_cycle, p_subscription_id, 'processing', 1,
        p_lease_token, NOW() + make_interval(secs => p_lease_seconds)
    )
    ON CONFLICT (vault_id, billing_cycle) DO UPDATE
    SET subscription_id = EXCLUDED.subscription_id,
        state = 'processing',
        attempt_count = CASE
            WHEN recurring_pull_executions.transaction_hash IS NULL
                THEN recurring_pull_executions.attempt_count + 1
            ELSE recurring_pull_executions.attempt_count
        END,
        next_retry_at = NULL,
        lease_token = EXCLUDED.lease_token,
        locked_until = EXCLUDED.locked_until,
        updated_at = NOW()
    WHERE (
        recurring_pull_executions.state = 'retry'
        AND recurring_pull_executions.next_retry_at <= NOW()
    ) OR (
        recurring_pull_executions.state = 'processing'
        AND recurring_pull_executions.locked_until <= NOW()
    )
    RETURNING * INTO v_execution;

    IF FOUND THEN
        RETURN QUERY SELECT TRUE, v_execution.transaction_hash, v_execution.attempt_count;
    ELSE
        RETURN QUERY SELECT FALSE, NULL::VARCHAR, 0;
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION claim_recurring_pull_cycle(VARCHAR, TIMESTAMP WITH TIME ZONE, UUID, UUID, INTEGER)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_recurring_pull_cycle(VARCHAR, TIMESTAMP WITH TIME ZONE, UUID, UUID, INTEGER)
    TO service_role;

CREATE OR REPLACE FUNCTION settle_recurring_pull_cycle(
    p_vault_id VARCHAR,
    p_billing_cycle TIMESTAMP WITH TIME ZONE,
    p_lease_token UUID,
    p_transaction_hash VARCHAR,
    p_settled_at TIMESTAMP WITH TIME ZONE,
    p_next_billing_date TIMESTAMP WITH TIME ZONE
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_subscription_id UUID;
BEGIN
    SELECT subscription_id INTO v_subscription_id
    FROM recurring_pull_executions
    WHERE vault_id = p_vault_id
      AND billing_cycle = p_billing_cycle
      AND lease_token = p_lease_token
      AND state = 'processing'
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    UPDATE subscriptions
    SET next_billing_date = p_next_billing_date,
        status = 'active',
        retry_count = 0,
        dunning_status = NULL,
        next_dunning_retry_at = NULL,
        last_failure = NULL
    WHERE id = v_subscription_id;

    UPDATE recurring_pull_executions
    SET state = 'settled',
        transaction_hash = p_transaction_hash,
        settled_at = p_settled_at,
        next_retry_at = NULL,
        last_error = NULL,
        lease_token = NULL,
        locked_until = NULL,
        updated_at = p_settled_at
    WHERE vault_id = p_vault_id
      AND billing_cycle = p_billing_cycle
      AND lease_token = p_lease_token
      AND state = 'processing';

    RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION settle_recurring_pull_cycle(VARCHAR, TIMESTAMP WITH TIME ZONE, UUID, VARCHAR, TIMESTAMP WITH TIME ZONE, TIMESTAMP WITH TIME ZONE)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION settle_recurring_pull_cycle(VARCHAR, TIMESTAMP WITH TIME ZONE, UUID, VARCHAR, TIMESTAMP WITH TIME ZONE, TIMESTAMP WITH TIME ZONE)
    TO service_role;

-- migrate:down
DROP FUNCTION IF EXISTS settle_recurring_pull_cycle(VARCHAR, TIMESTAMP WITH TIME ZONE, UUID, VARCHAR, TIMESTAMP WITH TIME ZONE, TIMESTAMP WITH TIME ZONE);
DROP FUNCTION IF EXISTS claim_recurring_pull_cycle(VARCHAR, TIMESTAMP WITH TIME ZONE, UUID, UUID, INTEGER);
DROP TABLE IF EXISTS recurring_pull_executions;
