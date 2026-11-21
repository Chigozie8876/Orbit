# Revenue pools, vault recovery, elasticity, and sponsored onboarding

This document describes the contract interfaces introduced for issues #127–130.
All amounts are raw token units. Existing vault creation and metered billing
entrypoints retain their previous behavior; each new behavior is opt-in.

## Proportional revenue pools (#127)

Create a pool with `create_revenue_pool(owner, pool_id, token, shareholders)`.
Each shareholder tuple contains an address and a positive `u32` weight. Pool IDs
are contract-global, duplicate addresses are rejected, the shareholder list is
capped at 100, and weights are immutable. Immutability prevents an owner from
retroactively diluting revenue that shareholders have already earned.

Any authorized sender can call
`deposit_to_pool(sender, pool_id, token, amount)` after approving the Orbit
contract to spend that token. The supplied token must match the pool token.
Shareholders call `claim_shareholder_dividends(shareholder, pool_id)` to withdraw
all currently claimable whole token units.

The accumulator uses a `10^12` fixed-point scale:

```text
scaled_deposit = amount * 10^12 + prior_scaled_remainder
acc_per_share += scaled_deposit / total_shares
scaled_remainder = scaled_deposit % total_shares

gross_entitlement = shareholder_weight * acc_per_share / 10^12
claimable = gross_entitlement - previously_claimed
```

Both divisions round down. Their remainders are not paid to another participant:
deposit-level remainder is carried into the next deposit, while sub-token-unit
shareholder entitlement stays in the cumulative accumulator. The pool's
`undistributed_balance` is the actual deposited token balance not yet claimed,
including temporary rounding dust.

## Designated recovery with a 14-day challenge window (#128)

Use `create_vault_with_recovery(..., recovery_address)` to opt a fixed-interval
vault into recovery. The recovery address must differ from the subscriber.
Legacy creation entrypoints do not silently assign a recovery address.

The flow is:

1. The designated address authorizes
   `initiate_vault_recovery(recovery_address, user, merchant)`. The contract
   freezes the vault immediately and records `execute_after = now + 14 days`.
2. The original subscriber may authorize `cancel_recovery(user, merchant)` at
   any time before execution. This deletes the request and restores the vault's
   pause state from before initiation.
3. At or after `execute_after`, the designated address authorizes
   `execute_vault_recovery(recovery_address, user, merchant)`. The old Orbit
   vault, swap configuration, escrow policy, badge activity, and recovery
   configuration are removed. Equivalent billing terms are written under the
   recovery address in a **paused** replacement vault.
4. The recovered account approves a fresh token allowance and calls
   `resume_vault(recovery_address, merchant)` before the merchant can bill it.

Soroban token allowances are owned by the token holder. Orbit cannot revoke an
allowance in that external token contract on behalf of a lost key. Removing the
old vault closes the usable connection inside Orbit: no Orbit pull entrypoint can
reach that old `(user, merchant)` subscription. Operators should still advise a
user who regains the old key to revoke its obsolete token allowance directly.

Recovery does not migrate swap or escrow settings because those settings were
authorized for the old account. The recovered account can configure them again.
Execution refuses to overwrite an existing destination vault.

## Metered interval elasticity (#129)

`create_elastic_metered_vault(..., overdraft_percentage)` creates a metered
vault with an overdraft percentage from 0 through 20. The original
`create_metered_vault` remains a strict baseline-only allowance.

For baseline `B`, configured percentage `P`, and prior carry `C`:

```text
overdraft_limit = floor(B * P / 100)
adjusted_baseline = B - C
current_cycle_cap = adjusted_baseline + overdraft_limit
```

Spending above `adjusted_baseline` becomes `epoch_overdraft`. At the next cycle
rollover, that value becomes `carried_overdraft` and therefore reduces the next
baseline. Spending at or below the adjusted baseline creates no new overdraft;
the following cycle returns to the full baseline plus its configured buffer.
If more than one complete interval passes without a pull, the intervening
zero-spend repayment cycle clears the carry.

Read `get_metered_elasticity(user, merchant)` together with
`get_metered_vault(user, merchant)` to inspect the configured percentage,
incoming carry, current overdraft, and current epoch spend.

## Merchant XLM reserve and sponsored onboarding (#130)

This feature is an on-chain **reimbursement reserve**, not a mechanism by which
a Soroban contract pays its own transaction fee. Soroban resource and inclusion
fees are charged to the transaction source. A backend relayer or wallet sponsor
must construct, simulate, sign, and submit the transaction with its funded
account as the transaction source while carrying the subscriber's signed Soroban
authorization for the contract call.

Merchant setup:

1. Call `configure_gas_subsidy(merchant, native_token, sponsor, max_subsidy)`.
   `native_token` must be the canonical native-XLM Stellar Asset Contract address
   for the deployment network. The contract cannot infer or verify that
   network-specific address. `sponsor` is the trusted funded transaction source.
2. Approve Orbit to spend native XLM and call
   `deposit_gas_subsidy(merchant, amount)`.
3. The sponsor submits `create_sponsored_vault(..., subsidy_amount, nonce)` with
   both subscriber and configured-sponsor authorization. On success, Orbit
   creates the vault and reimburses the sponsor from the merchant's reserve.
4. The merchant can call `withdraw_gas_subsidy(merchant, amount)` at any time for
   the unused balance.

The contract protects a reserve with checks-effects-interactions ordering, a
storage lock around token calls, a merchant-selected per-handshake cap, strict
monotonic nonces, checked arithmetic, sponsor authorization, and atomic rollback.
It cannot inspect the transaction source or prove the exact network fee paid, so
merchants must trust the configured sponsor and set a conservative cap. A failed
transaction consumes network fees but atomically rolls back any reimbursement.

"Zero-XLM onboarding" here means an already-existing subscriber address need not
hold spendable XLM for this invocation because a separate funded transaction
source submits it. This contract does not create or fund a Stellar account base
reserve, and it cannot make a nonexistent classic account usable by itself.

## Delegated vault authorization via typed signatures (#296)

`create_vault_delegated(authorization, signature)` creates a vault from a
payload the subscriber signed off-chain. Any account can submit it, typically
the backend relayer (`POST /api/relayer/sponsor`) or a fee-bump submitter. The
subscriber needs no XLM and no Soroban authorization entry, only the signature.

The signed payload is the typed `DelegatedVaultAuthorization`:

| Field | Meaning |
|-------|---------|
| `user` | Subscriber. Must be an Ed25519 account (`G...`) |
| `merchant`, `token` | Who may pull, and in which token. Both are signed, so a relayer cannot redirect the vault or swap the token |
| `amount` | Amount per interval, in base units |
| `interval_ledgers` | Billing interval in ledgers. Stored as `interval_ledgers * 5` seconds, the same unit as every other vault |
| `nonce` | Must equal `get_user_nonce(user)`; consumed on success |
| `expiry_ledger` | Last ledger sequence at which the signature is accepted |

The subscriber signs, with their account key, the 32-byte
`delegated_vault_digest`:

```
SHA256(contract_address_xdr || network_id || Symbol("create_vault_delegated")_xdr || XDR(authorization))
```

The contract address and network id bind the signature to one deployment on one
network. The function symbol keeps the bytes from verifying as any other signed
Orbit message.

Checks run cheapest first, so a stale request costs a single storage read:

1. `SignatureExpired` when the current ledger is past `expiry_ledger`.
2. `InvalidNonce` when `nonce` is not current: a replay, or a signature made
   for a future nonce.
3. `InvalidAuthorization` when `amount <= 0`, `interval_ledgers == 0`, or the
   interval overflows.
4. `InvalidSignature` when `user` is not an Ed25519 account, so it cannot have
   signed.
5. One `ed25519_verify` over the digest. A forged signature, one from another
   key, or one over tampered terms fails here. Soroban's `ed25519_verify` has
   no non-trapping form, so the host aborts the invocation with its own Crypto
   error rather than a contract error code. Nothing is written and the nonce is
   not consumed.

On success, the nonce is consumed and the vault is written with the default
grace period. The standard `vault_created` event fires, followed by
`vault_delegated(user, merchant) -> (token, amount, interval_ledgers, nonce)`.
The nonce is the same per-user counter that `create_vault_with_signature`
(#207) uses, so a signature for one scheme can never be replayed through the
other.

## Verification

Soroban SDK 27.0.6 requires Rust 1.91 or newer. From `contracts/soroban`:

```sh
cargo fmt --all -- --check
cargo +1.91.0 test --locked
cargo +1.91.0 clippy --all-targets --locked -- -D warnings
```
