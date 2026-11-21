// streaming_vesting.rs — Linear payroll streaming for Orbit (#288)
//
// Implements PaymentStream: create, claim (linear vesting by ledger),
// and emergency cancel (splits vested/unvested between recipient and sender).
//
// Designed to be included in contracts/soroban/src/lib.rs via `mod streaming_vesting`
// or by inlining into the OrbitContract impl block.

use soroban_sdk::{contracttype, token, Address, Env};

// ─────────────────────────────── Storage keys ─────────────────────────────

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PaymentStreamKey {
    pub id: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StreamStorageKey {
    NextStreamId,
    Stream(u64),
}

// ─────────────────────────────── Data types ───────────────────────────────

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PaymentStream {
    /// Address that funded the stream and can cancel it.
    pub sender: Address,
    /// Address that earns and may claim vested funds.
    pub recipient: Address,
    /// SAC token contract (e.g. USDC).
    pub token: Address,
    /// Total tokens deposited for the full vesting window.
    pub total_amount: i128,
    /// Ledger sequence number at which vesting begins (inclusive).
    pub start_ledger: u32,
    /// Ledger sequence number at which 100 % is vested (exclusive upper bound).
    pub end_ledger: u32,
    /// Tokens already claimed by the recipient.
    pub claimed_amount: i128,
    /// Set to true once the sender cancels; blocks further claims.
    pub cancelled: bool,
}

// ─────────────────────────────── Helpers ──────────────────────────────────

/// Calculate how many tokens have vested up to `at_ledger` (clamped to
/// [start_ledger, end_ledger]), minus what the recipient already claimed.
///
/// Formula from the issue:
///   claimable = (min(current_ledger, end_ledger) - start_ledger)
///               * total_amount / (end_ledger - start_ledger)
///               - already_claimed
pub fn compute_claimable(stream: &PaymentStream, at_ledger: u32) -> i128 {
    if at_ledger <= stream.start_ledger || stream.cancelled {
        return 0;
    }
    let effective = at_ledger.min(stream.end_ledger);
    let elapsed = (effective - stream.start_ledger) as i128;
    let duration = (stream.end_ledger - stream.start_ledger) as i128;
    if duration == 0 {
        return 0;
    }
    let vested = elapsed * stream.total_amount / duration;
    let claimable = vested - stream.claimed_amount;
    claimable.max(0)
}

// ─────────────────────────────── Contract fns ─────────────────────────────

/// Create a new linear payment stream.
///
/// Transfers `total_amount` from `sender` into the contract's escrow.
///
/// # Panics
/// - `start_ledger >= end_ledger`
/// - `total_amount <= 0`
pub fn create_stream(
    env: &Env,
    sender: Address,
    recipient: Address,
    token: Address,
    total_amount: i128,
    start_ledger: u32,
    end_ledger: u32,
) -> u64 {
    sender.require_auth();

    assert!(total_amount > 0, "total_amount must be positive");
    assert!(start_ledger < end_ledger, "start_ledger must be before end_ledger");

    // Escrow the full deposit from sender
    let token_client = token::Client::new(env, &token);
    token_client.transfer(&sender, &env.current_contract_address(), &total_amount);

    // Assign an ID
    let id: u64 = env
        .storage()
        .instance()
        .get(&StreamStorageKey::NextStreamId)
        .unwrap_or(0u64);
    env.storage()
        .instance()
        .set(&StreamStorageKey::NextStreamId, &(id + 1));

    let stream = PaymentStream {
        sender,
        recipient,
        token,
        total_amount,
        start_ledger,
        end_ledger,
        claimed_amount: 0,
        cancelled: false,
    };

    env.storage()
        .persistent()
        .set(&StreamStorageKey::Stream(id), &stream);

    id
}

/// Claim vested tokens from a stream.
///
/// Transfers the claimable amount (based on elapsed ledgers) to `recipient`.
///
/// # Panics
/// - Stream not found
/// - Caller is not the recipient
/// - Stream already cancelled
/// - Nothing to claim yet
pub fn claim_stream(env: &Env, stream_id: u64, recipient: Address) {
    recipient.require_auth();

    let mut stream: PaymentStream = env
        .storage()
        .persistent()
        .get(&StreamStorageKey::Stream(stream_id))
        .expect("stream not found");

    assert_eq!(stream.recipient, recipient, "caller is not the stream recipient");
    assert!(!stream.cancelled, "stream has been cancelled");

    let current_ledger = env.ledger().sequence();
    let claimable = compute_claimable(&stream, current_ledger);

    assert!(claimable > 0, "nothing to claim yet");
    assert!(
        stream.claimed_amount + claimable <= stream.total_amount,
        "claim exceeds total"
    );

    stream.claimed_amount += claimable;

    env.storage()
        .persistent()
        .set(&StreamStorageKey::Stream(stream_id), &stream);

    let token_client = token::Client::new(env, &stream.token);
    token_client.transfer(&env.current_contract_address(), &recipient, &claimable);
}

/// Cancel a stream.
///
/// Transfers whatever has vested to the recipient and returns the unvested
/// remainder to the sender. After cancellation no further claims are possible.
///
/// # Panics
/// - Stream not found
/// - Caller is not the sender
/// - Stream already cancelled
pub fn cancel_stream(env: &Env, stream_id: u64, sender: Address) {
    sender.require_auth();

    let mut stream: PaymentStream = env
        .storage()
        .persistent()
        .get(&StreamStorageKey::Stream(stream_id))
        .expect("stream not found");

    assert_eq!(stream.sender, sender, "caller is not the stream sender");
    assert!(!stream.cancelled, "stream already cancelled");

    let current_ledger = env.ledger().sequence();
    let claimable = compute_claimable(&stream, current_ledger);

    // Vested but not yet claimed → recipient
    // Remaining (unvested) → sender
    let unvested = stream.total_amount - stream.claimed_amount - claimable;

    stream.cancelled = true;
    env.storage()
        .persistent()
        .set(&StreamStorageKey::Stream(stream_id), &stream);

    let token_client = token::Client::new(env, &stream.token);

    if claimable > 0 {
        token_client.transfer(
            &env.current_contract_address(),
            &stream.recipient,
            &claimable,
        );
    }

    if unvested > 0 {
        token_client.transfer(
            &env.current_contract_address(),
            &stream.sender,
            &unvested,
        );
    }
}

/// Read a stream's current state without modifying it.
pub fn get_stream(env: &Env, stream_id: u64) -> PaymentStream {
    env.storage()
        .persistent()
        .get(&StreamStorageKey::Stream(stream_id))
        .expect("stream not found")
}

// ─────────────────────────────── Tests ────────────────────────────────────

#[cfg(test)]
mod tests {
    extern crate std;
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger as _},
        token::{Client as TokenClient, StellarAssetClient},
        Address, Env,
    };

    fn setup() -> (Env, Address, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let token_address = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let token_admin = StellarAssetClient::new(&env, &token_address);
        token_admin.mint(&sender, &1_000_0000000);
        (env, sender, recipient, token_address, admin)
    }

    fn advance_ledger(env: &Env, by: u32) {
        let cur = env.ledger().sequence();
        env.ledger().set_sequence_number(cur + by);
    }

    #[test]
    fn test_create_stream_stores_data() {
        let (env, sender, recipient, token, _admin) = setup();
        let contract = env.register(crate::OrbitContract, ());
        let _id = env.as_contract(&contract, || {
            create_stream(&env, sender.clone(), recipient.clone(), token.clone(), 100_0000000, 100, 200)
        });
        // Stream was stored (no panic)
    }

    #[test]
    fn test_claimable_zero_before_start() {
        let stream = PaymentStream {
            sender: Address::generate(&Env::default()),
            recipient: Address::generate(&Env::default()),
            token: Address::generate(&Env::default()),
            total_amount: 1000,
            start_ledger: 100,
            end_ledger: 200,
            claimed_amount: 0,
            cancelled: false,
        };
        assert_eq!(compute_claimable(&stream, 99), 0);
        assert_eq!(compute_claimable(&stream, 100), 0);
    }

    #[test]
    fn test_claimable_linear_midpoint() {
        let stream = PaymentStream {
            sender: Address::generate(&Env::default()),
            recipient: Address::generate(&Env::default()),
            token: Address::generate(&Env::default()),
            total_amount: 1000,
            start_ledger: 0,
            end_ledger: 100,
            claimed_amount: 0,
            cancelled: false,
        };
        // At ledger 50: 50% vested = 500
        assert_eq!(compute_claimable(&stream, 50), 500);
    }

    #[test]
    fn test_claimable_full_at_end() {
        let stream = PaymentStream {
            sender: Address::generate(&Env::default()),
            recipient: Address::generate(&Env::default()),
            token: Address::generate(&Env::default()),
            total_amount: 1000,
            start_ledger: 0,
            end_ledger: 100,
            claimed_amount: 0,
            cancelled: false,
        };
        // At or past end_ledger: 100% = 1000
        assert_eq!(compute_claimable(&stream, 100), 1000);
        assert_eq!(compute_claimable(&stream, 150), 1000);
    }

    #[test]
    fn test_claimable_deducts_prior_claims() {
        let stream = PaymentStream {
            sender: Address::generate(&Env::default()),
            recipient: Address::generate(&Env::default()),
            token: Address::generate(&Env::default()),
            total_amount: 1000,
            start_ledger: 0,
            end_ledger: 100,
            claimed_amount: 300,
            cancelled: false,
        };
        // At 50%: 500 vested - 300 claimed = 200
        assert_eq!(compute_claimable(&stream, 50), 200);
    }

    #[test]
    fn test_claimable_zero_when_cancelled() {
        let stream = PaymentStream {
            sender: Address::generate(&Env::default()),
            recipient: Address::generate(&Env::default()),
            token: Address::generate(&Env::default()),
            total_amount: 1000,
            start_ledger: 0,
            end_ledger: 100,
            claimed_amount: 0,
            cancelled: true,
        };
        assert_eq!(compute_claimable(&stream, 50), 0);
    }

    #[test]
    fn test_claimable_never_exceeds_total() {
        let stream = PaymentStream {
            sender: Address::generate(&Env::default()),
            recipient: Address::generate(&Env::default()),
            token: Address::generate(&Env::default()),
            total_amount: 1000,
            start_ledger: 0,
            end_ledger: 100,
            claimed_amount: 950,
            cancelled: false,
        };
        // At end: 1000 vested - 950 claimed = 50
        let c = compute_claimable(&stream, 200);
        assert!(c <= 50);
    }

    #[test]
    fn test_claim_transfers_tokens() {
        let (env, sender, recipient, token, _admin) = setup();
        let contract = env.register(crate::OrbitContract, ());
        let token_client = TokenClient::new(&env, &token);

        env.ledger().set_sequence_number(0);

        let stream_id = env.as_contract(&contract, || {
            create_stream(&env, sender.clone(), recipient.clone(), token.clone(), 1000_0000000, 0, 100)
        });

        // Advance to ledger 50 (50%)
        env.ledger().set_sequence_number(50);
        let bal_before = token_client.balance(&recipient);
        env.as_contract(&contract, || {
            claim_stream(&env, stream_id, recipient.clone());
        });
        let bal_after = token_client.balance(&recipient);
        assert_eq!(bal_after - bal_before, 500_0000000);
    }

    #[test]
    fn test_cancel_splits_vested_and_unvested() {
        let (env, sender, recipient, token, _admin) = setup();
        let contract = env.register(crate::OrbitContract, ());
        let token_client = TokenClient::new(&env, &token);

        env.ledger().set_sequence_number(0);
        let total = 1000_0000000i128;
        let stream_id = env.as_contract(&contract, || {
            create_stream(&env, sender.clone(), recipient.clone(), token.clone(), total, 0, 100)
        });

        // Advance to ledger 25 (25% vested)
        env.ledger().set_sequence_number(25);
        let sender_before = token_client.balance(&sender);
        let recip_before = token_client.balance(&recipient);

        env.as_contract(&contract, || {
            cancel_stream(&env, stream_id, sender.clone());
        });

        let sender_after = token_client.balance(&sender);
        let recip_after = token_client.balance(&recipient);

        // 25% → recipient, 75% → sender
        assert_eq!(recip_after - recip_before, 250_0000000);
        assert_eq!(sender_after - sender_before, 750_0000000);
    }

    #[test]
    fn test_cancel_after_full_vest_all_to_recipient() {
        let (env, sender, recipient, token, _admin) = setup();
        let contract = env.register(crate::OrbitContract, ());
        let token_client = TokenClient::new(&env, &token);

        env.ledger().set_sequence_number(0);
        let total = 1000_0000000i128;
        let stream_id = env.as_contract(&contract, || {
            create_stream(&env, sender.clone(), recipient.clone(), token.clone(), total, 0, 100)
        });

        // Cancel after end → all to recipient, nothing to sender
        env.ledger().set_sequence_number(100);
        let sender_before = token_client.balance(&sender);
        let recip_before = token_client.balance(&recipient);

        env.as_contract(&contract, || {
            cancel_stream(&env, stream_id, sender.clone());
        });

        let sender_after = token_client.balance(&sender);
        let recip_after = token_client.balance(&recipient);

        assert_eq!(recip_after - recip_before, total);
        assert_eq!(sender_after, sender_before);
    }

    #[test]
    #[should_panic(expected = "stream already cancelled")]
    fn test_cancel_twice_panics() {
        let (env, sender, recipient, token, _admin) = setup();
        let contract = env.register(crate::OrbitContract, ());

        env.ledger().set_sequence_number(0);
        let stream_id = env.as_contract(&contract, || {
            create_stream(&env, sender.clone(), recipient.clone(), token.clone(), 1000, 0, 100)
        });
        env.as_contract(&contract, || cancel_stream(&env, stream_id, sender.clone()));
        env.as_contract(&contract, || cancel_stream(&env, stream_id, sender.clone()));
    }

    #[test]
    #[should_panic(expected = "nothing to claim yet")]
    fn test_claim_before_start_panics() {
        let (env, sender, recipient, token, _admin) = setup();
        let contract = env.register(crate::OrbitContract, ());

        env.ledger().set_sequence_number(5);
        let stream_id = env.as_contract(&contract, || {
            create_stream(&env, sender.clone(), recipient.clone(), token.clone(), 1000, 100, 200)
        });
        env.as_contract(&contract, || claim_stream(&env, stream_id, recipient.clone()));
    }
}
