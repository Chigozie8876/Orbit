// Pre-flight policy for gasless onboarding (#297).
//
// POST /api/relayer/sponsor accepts a transaction the subscriber has already signed and
// wraps it in a FeeBumpTransaction paid by the Orbit relayer. Because the relayer pays for
// whatever it wraps, every transaction is checked against this policy first. Anything that
// is not a subscriber creating an Orbit vault for a registered merchant is refused before a
// single stroop is spent:
//
//   - the inner transaction is a plain, signed Transaction on the relayer's network, never
//     a fee bump, never sourced from (or spending from) a relayer account;
//   - every operation is one of: a vault-creation call on the Orbit contract, an `approve`
//     on an allowed token contract whose spender is the Orbit contract, or a trustline for
//     an allowed asset;
//   - the vault's merchant (the recipient of future pulls) is a registered Orbit merchant,
//     and its token is an allowed token contract;
//   - no Soroban authorization entry claims a relayer account's address.
//
// Fee limits are enforced separately in relayer.js, after the fee bump is built.
const { Address, Keypair, StrKey, scValToNative, inspectAuthEntry } = require('@stellar/stellar-sdk');
const { RelayerError } = require('./relayer-error');

// Orbit vault-creation entry points whose arguments start with (user, merchant, token).
const ORBIT_VAULT_FUNCTIONS = new Set([
    'create_vault',
    'create_vault_with_grace_period',
    'create_vault_with_setup_fee',
    'create_vault_with_trial',
    'create_vault_trial_setup_fee',
    'create_vault_with_recovery',
    'create_vault_with_signature',
]);
// Takes a DelegatedVaultAuthorization struct carrying user/merchant/token (#296).
const ORBIT_DELEGATED_FUNCTION = 'create_vault_delegated';

const reject = (code, message, status = 403) => {
    throw new RelayerError(code, status, message);
};

const scAddressToString = (scAddress) => Address.fromScAddress(scAddress).toString();

// An address argument as a G.../C... string, or null when the value is not an address
const addressArg = (scVal) => {
    try {
        const value = scValToNative(scVal);
        return typeof value === 'string' && (StrKey.isValidEd25519PublicKey(value) || StrKey.isValidContract(value)) ? value : null;
    } catch {
        return null;
    }
};

const requireAddress = (scVal, what) => addressArg(scVal) ?? reject('malformed_operation', `${what} must be an address`, 400);

const parseList = (value) => (value || '').split(',').map((s) => s.trim()).filter(Boolean);

/**
 * Builds the policy from configuration. `orbitContractId` is required; the token and
 * trustline allowlists default to USDC_CONTRACT_ID / nothing.
 */
const createSponsorshipPolicy = ({
    orbitContractId,
    allowedTokenContracts = [],
    allowedTrustlineAssets = [],
    relayerAccounts = [],
    networkPassphrase,
}) => {
    if (!orbitContractId || !StrKey.isValidContract(orbitContractId)) {
        throw new Error('Sponsorship policy needs a valid Orbit contract id');
    }
    for (const token of allowedTokenContracts) {
        if (!StrKey.isValidContract(token)) throw new Error(`Invalid allowed token contract: ${token}`);
    }
    return {
        orbitContractId,
        allowedTokenContracts: new Set(allowedTokenContracts),
        // "CODE:ISSUER" strings, compared case-sensitively like Stellar does
        allowedTrustlineAssets: new Set(allowedTrustlineAssets),
        relayerAccounts: new Set(relayerAccounts),
        networkPassphrase,
    };
};

const policyFromEnv = ({ env = process.env, relayerAccounts = [], networkPassphrase }) => createSponsorshipPolicy({
    orbitContractId: env.ORBIT_CONTRACT_ID,
    allowedTokenContracts: parseList(env.RELAYER_ALLOWED_TOKEN_CONTRACTS || env.USDC_CONTRACT_ID),
    allowedTrustlineAssets: parseList(env.RELAYER_ALLOWED_TRUSTLINE_ASSETS),
    relayerAccounts,
    networkPassphrase,
});

// Reads the (merchant, token) a vault-creation call would create a vault for
const vaultTerms = (functionName, args) => {
    if (ORBIT_VAULT_FUNCTIONS.has(functionName)) {
        if (args.length < 3) reject('malformed_operation', `${functionName} is missing arguments`, 400);
        return {
            user: requireAddress(args[0], 'user'),
            merchant: requireAddress(args[1], 'merchant'),
            token: requireAddress(args[2], 'token'),
        };
    }
    // create_vault_delegated(authorization, signature)
    const authorization = scValToNative(args[0]);
    if (!authorization || typeof authorization !== 'object') {
        reject('malformed_operation', `${ORBIT_DELEGATED_FUNCTION} needs an authorization struct`, 400);
    }
    return { user: String(authorization.user), merchant: String(authorization.merchant), token: String(authorization.token) };
};

const checkAuthEntries = (auth, policy) => {
    for (const entry of auth ?? []) {
        const { address } = inspectAuthEntry(entry);
        if (address && policy.relayerAccounts.has(address)) {
            reject('relayer_authorization_forbidden', 'The transaction asks a relayer account to authorize a contract call');
        }
    }
};

// Validates one invokeHostFunction operation; returns vault terms when it creates a vault
const checkContractCall = (op, source, policy) => {
    const call = op.func?.type === 'hostFunctionTypeInvokeContract' ? op.func.invokeContract : null;
    if (!call) {
        reject('operation_not_allowed', 'Only contract calls can be sponsored (no deploys or uploads)');
    }
    const contract = scAddressToString(call.contractAddress);
    const functionName = String(call.functionName);
    const args = call.args ?? [];
    checkAuthEntries(op.auth, policy);

    if (contract === policy.orbitContractId) {
        if (!ORBIT_VAULT_FUNCTIONS.has(functionName) && functionName !== ORBIT_DELEGATED_FUNCTION) {
            reject('function_not_allowed', `Orbit function ${functionName} is not eligible for sponsorship`);
        }
        let terms;
        try {
            terms = vaultTerms(functionName, args);
        } catch (err) {
            if (err?.name === 'RelayerError') throw err;
            reject('malformed_operation', `Could not read the ${functionName} arguments`, 400);
        }
        if (!policy.allowedTokenContracts.has(terms.token)) {
            reject('token_not_allowed', `Token ${terms.token} is not eligible for sponsorship`);
        }
        return terms;
    }

    if (policy.allowedTokenContracts.has(contract)) {
        if (functionName !== 'approve' || args.length < 2) {
            reject('function_not_allowed', `Only approve() may be called on token ${contract}`);
        }
        const from = requireAddress(args[0], 'approve from');
        const spender = requireAddress(args[1], 'approve spender');
        if (spender !== policy.orbitContractId) {
            reject('recipient_not_allowed', 'Token approvals may only name the Orbit contract as spender');
        }
        if (from !== source) {
            reject('recipient_not_allowed', 'Token approvals must come from the transaction source');
        }
        return null;
    }

    return reject('contract_not_allowed', `Contract ${contract} is not eligible for sponsorship`);
};

const assetKey = (line) => (line?.isNative?.() ? 'native' : `${line?.getCode?.()}:${line?.getIssuer?.()}`);

/**
 * Checks a parsed inner transaction against the policy. Returns the vault terms of every
 * vault it creates, so the caller can check merchants and charge the right budget.
 * Throws RelayerError (403 for policy refusals, 400 for malformed input).
 */
const validateSponsoredTransaction = (tx, policy) => {
    if (tx.innerTransaction) reject('fee_bump_not_allowed', 'Send the signed inner transaction, not a fee bump', 400);
    if (policy.networkPassphrase && tx.networkPassphrase !== policy.networkPassphrase) {
        reject('wrong_network', 'The transaction was built for a different network', 400);
    }
    const source = tx.source;
    if (policy.relayerAccounts.has(source)) reject('source_not_allowed', 'A relayer account cannot be the transaction source');
    if (tx.operations.length === 0) reject('malformed_transaction', 'The transaction has no operations', 400);

    const vaults = [];
    for (const op of tx.operations) {
        // An operation-level source would let the inner transaction spend from another account
        if (op.source && op.source !== source) {
            reject('source_not_allowed', 'Operations must not override the transaction source');
        }
        if (op.type === 'invokeHostFunction') {
            const terms = checkContractCall(op, source, policy);
            if (terms) vaults.push(terms);
        } else if (op.type === 'changeTrust') {
            if (!policy.allowedTrustlineAssets.has(assetKey(op.line))) {
                reject('operation_not_allowed', `Trustline ${assetKey(op.line)} is not eligible for sponsorship`);
            }
        } else {
            reject('operation_not_allowed', `Operation ${op.type} is not eligible for sponsorship`);
        }
    }
    if (vaults.length === 0) reject('operation_not_allowed', 'Only transactions that create an Orbit vault can be sponsored');

    const merchants = new Set(vaults.map((v) => v.merchant));
    if (merchants.size > 1) reject('recipient_not_allowed', 'A sponsored transaction may only create vaults for one merchant');

    // The subscriber must already have signed: the relayer never pays for an unsigned draft.
    const hash = tx.hash();
    const sourceKey = Keypair.fromPublicKey(source);
    const signedBySource = tx.signatures.some((sig) => {
        try {
            // stellar-sdk 17 exposes the bytes as a property; older versions as a method
            const bytes = typeof sig.signature === 'function' ? sig.signature() : sig.signature;
            return sourceKey.verify(hash, bytes);
        } catch {
            return false;
        }
    });
    if (!signedBySource) reject('unsigned_transaction', 'The transaction must be signed by its source account', 401);

    return { source, merchant: vaults[0].merchant, vaults };
};

module.exports = {
    ORBIT_VAULT_FUNCTIONS,
    ORBIT_DELEGATED_FUNCTION,
    createSponsorshipPolicy,
    policyFromEnv,
    validateSponsoredTransaction,
};
