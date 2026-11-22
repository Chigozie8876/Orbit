#![cfg(test)]

extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token::Client as TokenClient,
    token::StellarAssetClient,
    Address, Env,
};

// ----------------------------------------------------------------------------
// BATCH PAYROLL CANCELLATION (#287)
// ----------------------------------------------------------------------------

/// Funded sender (100 tokens, approved to the contract), recipient, token and
/// orbit contract id. Ledger time starts at 1_000.
fn batch_setup(env: &Env) -> (Address, Address, Address, Address) {
    env.mock_all_auths();
    env.ledger().with_mut(|l| l.timestamp = 1_000);

    let sender = Address::generate(env);
    let recipient = Address::generate(env);
    let token_admin = Address::generate(env);
    let token = env
        .register_stellar_asset_contract_v2(token_admin)
        .address();
    StellarAssetClient::new(env, &token).mint(&sender, &100_0000000);

    let contract_id = env.register(OrbitContract, ());
    TokenClient::new(env, &token).approve(&sender, &contract_id, &100_0000000, &2000000);
    (sender, recipient, token, contract_id)
}

#[test]
fn test_cancel_refunds_only_unclaimed_balance_after_partial_claim() {
    let env = Env::default();
    let (sender, recipient, token, contract_id) = batch_setup(&env);
    let orbit = OrbitContractClient::new(&env, &contract_id);
    let token_client = TokenClient::new(&env, &token);

    let id = orbit.create_payroll_escrow(&sender, &recipient, &token, &60_0000000, &2_000);
    orbit.claim_payroll_escrow(&recipient, &id, &25_0000000);

    let refunded = orbit.cancel_batch_payroll(&sender, &id);

    assert_eq!(refunded, 35_0000000);
    // Sender started with 100, paid 60 into escrow, got 35 back.
    assert_eq!(token_client.balance(&sender), 100_0000000 - 25_0000000);
    // Recipient keeps what was already paid out and cannot be charged twice.
    assert_eq!(token_client.balance(&recipient), 25_0000000);
    let escrow = orbit.get_payroll_escrow(&id).unwrap();
    assert!(escrow.reclaimed);
    assert_eq!(escrow.claimed_amount, 25_0000000);
}

#[test]
fn test_cancel_works_before_claim_window_closes() {
    let env = Env::default();
    let (sender, recipient, token, contract_id) = batch_setup(&env);
    let orbit = OrbitContractClient::new(&env, &contract_id);
    let token_client = TokenClient::new(&env, &token);

    let id = orbit.create_payroll_escrow(&sender, &recipient, &token, &10_0000000, &2_000);

    env.ledger().with_mut(|l| l.timestamp = 1_500);
    assert_eq!(orbit.cancel_batch_payroll(&sender, &id), 10_0000000);
    assert_eq!(token_client.balance(&sender), 100_0000000);
}

#[test]
fn test_cancel_rejects_anyone_but_the_batch_creator() {
    let env = Env::default();
    let (sender, recipient, token, contract_id) = batch_setup(&env);
    let orbit = OrbitContractClient::new(&env, &contract_id);

    let id = orbit.create_payroll_escrow(&sender, &recipient, &token, &10_0000000, &2_000);

    let stranger = Address::generate(&env);
    assert!(orbit.try_cancel_batch_payroll(&stranger, &id).is_err());
    assert!(orbit.try_cancel_batch_payroll(&recipient, &id).is_err());
    assert!(!orbit.get_payroll_escrow(&id).unwrap().reclaimed);
}

#[test]
fn test_cancel_is_one_shot_and_blocks_later_claims_and_reclaims() {
    let env = Env::default();
    let (sender, recipient, token, contract_id) = batch_setup(&env);
    let orbit = OrbitContractClient::new(&env, &contract_id);
    let token_client = TokenClient::new(&env, &token);

    let id = orbit.create_payroll_escrow(&sender, &recipient, &token, &10_0000000, &2_000);
    orbit.cancel_batch_payroll(&sender, &id);

    assert!(orbit.try_cancel_batch_payroll(&sender, &id).is_err());
    assert!(orbit
        .try_claim_payroll_escrow(&recipient, &id, &1_0000000)
        .is_err());
    env.ledger().with_mut(|l| l.timestamp = 2_001);
    assert!(orbit.try_reclaim_unclaimed_payroll(&sender, &id).is_err());
    // The refund was paid exactly once.
    assert_eq!(token_client.balance(&sender), 100_0000000);
}

#[test]
fn test_cancel_fails_when_fully_claimed() {
    let env = Env::default();
    let (sender, recipient, token, contract_id) = batch_setup(&env);
    let orbit = OrbitContractClient::new(&env, &contract_id);

    let id = orbit.create_payroll_escrow(&sender, &recipient, &token, &10_0000000, &2_000);
    orbit.claim_payroll_escrow(&recipient, &id, &10_0000000);

    assert!(orbit.try_cancel_batch_payroll(&sender, &id).is_err());
}

#[test]
fn test_cancel_fails_for_unknown_batch() {
    let env = Env::default();
    let (sender, _recipient, _token, contract_id) = batch_setup(&env);
    let orbit = OrbitContractClient::new(&env, &contract_id);

    assert!(orbit.try_cancel_batch_payroll(&sender, &999).is_err());
}
