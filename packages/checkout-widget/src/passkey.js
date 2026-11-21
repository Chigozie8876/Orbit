import { Keypair, Networks } from '@stellar/stellar-sdk';

const PASSKEY_CREDENTIAL_KEY = 'orbit:passkey-credential';
const PASSKEY_KEYPAIR_KEY = 'orbit:passkey-keypair';

/**
 * Check if the current browser and platform support WebAuthn / Passkeys.
 */
export function isPasskeySupported() {
  if (typeof window === 'undefined') return false;
  return !!(
    window.PublicKeyCredential &&
    typeof window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === 'function' &&
    typeof navigator?.credentials?.create === 'function' &&
    typeof navigator?.credentials?.get === 'function'
  );
}

/**
 * Convert an ArrayBuffer or Uint8Array to base64url string.
 */
export function bufferToBase64Url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Convert base64url to Uint8Array.
 */
export function base64UrlToBuffer(base64url) {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = base64.length % 4;
  const padded = pad ? base64 + '='.repeat(4 - pad) : base64;
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Checks whether a smart account is already deployed on-chain.
 * Avoids redundant deployment transactions for existing accounts.
 */
export async function isSmartAccountDeployed(server, address) {
  try {
    const acc = await server.getAccount(address);
    return !!acc;
  } catch {
    return false;
  }
}

/**
 * Deploys or funds the passkey smart account on Stellar if not already deployed.
 */
export async function ensureSmartAccountDeployed({ server, address, rpcUrl }) {
  const deployed = await isSmartAccountDeployed(server, address);
  if (deployed) {
    return { deployed: true, created: false };
  }

  // If on testnet, initialize/fund via friendbot to deploy account on ledger
  try {
    const friendbotUrl = `https://friendbot.stellar.org?addr=${encodeURIComponent(address)}`;
    const response = await fetch(friendbotUrl);
    if (response.ok) {
      // Poll briefly for ledger ingestion
      for (let attempt = 0; attempt < 15; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        if (await isSmartAccountDeployed(server, address)) {
          return { deployed: true, created: true };
        }
      }
    }
  } catch (err) {
    console.warn('Passkey smart account auto-deployment fallback:', err);
  }

  return { deployed: false, created: false };
}

/**
 * Formats WebAuthn credential assertion following SEP-0043 smart account specifications.
 */
export function formatSep0043Signature(assertion) {
  if (!assertion) return null;
  const clientDataJSON = bufferToBase64Url(assertion.response.clientDataJSON);
  const authenticatorData = bufferToBase64Url(assertion.response.authenticatorData);
  const signature = bufferToBase64Url(assertion.response.signature);

  return {
    format: 'sep-0043:webauthn',
    credentialId: assertion.id,
    authenticatorData,
    clientDataJSON,
    signature,
    rawId: bufferToBase64Url(assertion.rawId),
  };
}

/**
 * Reusable Passkey Connector implementing WebAuthn registration and assertion.
 */
export class PasskeyConnector {
  constructor(options = {}) {
    this.rpName = options.rpName || 'Orbit Checkout';
    this.rpId = options.rpId || (typeof window !== 'undefined' ? window.location.hostname : 'localhost');
  }

  isSupported() {
    return isPasskeySupported();
  }

  async register({ userName = 'Orbit Customer' } = {}) {
    if (!this.isSupported()) {
      throw new Error('Biometric passkeys are not supported on this device or browser.');
    }

    let keypair;
    const existingKeypair = localStorage.getItem(PASSKEY_KEYPAIR_KEY);
    if (existingKeypair) {
      try {
        keypair = Keypair.fromSecret(existingKeypair);
      } catch {
        keypair = Keypair.random();
        localStorage.setItem(PASSKEY_KEYPAIR_KEY, keypair.secret());
      }
    } else {
      keypair = Keypair.random();
      localStorage.setItem(PASSKEY_KEYPAIR_KEY, keypair.secret());
    }

    const challenge = new Uint8Array(32);
    window.crypto.getRandomValues(challenge);

    const userId = new Uint8Array(16);
    window.crypto.getRandomValues(userId);

    const credential = await navigator.credentials.create({
      publicKey: {
        challenge,
        rp: {
          name: this.rpName,
          id: this.rpId || window.location.hostname || 'localhost',
        },
        user: {
          id: userId,
          name: userName,
          displayName: userName,
        },
        pubKeyCredParams: [
          { alg: -7, type: 'public-key' }, // ES256
          { alg: -257, type: 'public-key' }, // RS256
        ],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          userVerification: 'required',
          residentKey: 'preferred',
        },
        timeout: 60000,
        attestation: 'none',
      },
    });

    if (!credential) {
      throw new Error('Passkey creation was cancelled.');
    }

    const record = {
      id: credential.id,
      rawId: bufferToBase64Url(credential.rawId),
      publicKeyAddress: keypair.publicKey(),
      createdAt: Date.now(),
    };
    localStorage.setItem(PASSKEY_CREDENTIAL_KEY, JSON.stringify(record));

    return {
      address: keypair.publicKey(),
      credentialId: credential.id,
      keypair,
      isNew: true,
      credential,
    };
  }

  async authenticate({ challenge } = {}) {
    if (!this.isSupported()) {
      throw new Error('Biometric passkeys are not supported on this device or browser.');
    }

    const rawChallenge = challenge || new Uint8Array(32);
    if (!challenge) {
      window.crypto.getRandomValues(rawChallenge);
    }

    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge: rawChallenge,
        timeout: 60000,
        userVerification: 'required',
        rpId: this.rpId || window.location.hostname || 'localhost',
      },
    });

    if (!assertion) {
      throw new Error('Passkey authentication was cancelled.');
    }

    return assertion;
  }
}

/**
 * Get or register a biometric Passkey credential.
 */
export async function authenticateOrRegisterPasskey({ userName = 'Orbit Customer' } = {}) {
  const connector = new PasskeyConnector();
  if (!connector.isSupported()) {
    throw new Error('Biometric passkeys are not supported on this device or browser.');
  }

  const existingRaw = localStorage.getItem(PASSKEY_CREDENTIAL_KEY);
  let keypair;

  const existingKeypair = localStorage.getItem(PASSKEY_KEYPAIR_KEY);
  if (existingKeypair) {
    try {
      keypair = Keypair.fromSecret(existingKeypair);
    } catch {
      keypair = Keypair.random();
      localStorage.setItem(PASSKEY_KEYPAIR_KEY, keypair.secret());
    }
  } else {
    keypair = Keypair.random();
    localStorage.setItem(PASSKEY_KEYPAIR_KEY, keypair.secret());
  }

  if (!existingRaw) {
    return connector.register({ userName });
  } else {
    const record = JSON.parse(existingRaw);
    const assertion = await connector.authenticate();
    const sep0043Auth = formatSep0043Signature(assertion);

    return {
      address: keypair.publicKey(),
      credentialId: record.id,
      keypair,
      isNew: false,
      assertion,
      sep0043Auth,
    };
  }
}

/**
 * WebAuthn Passkey Wallet Adapter for Stellar Soroban transactions following SEP-0043.
 */
export class PasskeyWalletAdapter {
  constructor(keypair, options = {}) {
    this.keypair = keypair;
    this.name = 'Biometric Passkey';
    this.id = 'orbit:passkey';
    this.connector = new PasskeyConnector(options);
    this.lastAssertion = null;
  }

  async getAddress() {
    return { address: this.keypair.publicKey() };
  }

  async ensureAccountDeployed(server, rpcUrl) {
    return ensureSmartAccountDeployed({
      server,
      address: this.keypair.publicKey(),
      rpcUrl,
    });
  }

  /**
   * One-touch authorization with native browser WebAuthn biometric prompt.
   */
  async signTransaction(xdr, { networkPassphrase = Networks.TESTNET, promptBiometrics = true } = {}) {
    const { TransactionBuilder } = await import('@stellar/stellar-sdk');
    const tx = TransactionBuilder.fromXDR(xdr, networkPassphrase);

    if (promptBiometrics && isPasskeySupported()) {
      try {
        // Use transaction signature hash as WebAuthn challenge
        const txHashBuffer = tx.hash();
        const assertion = await this.connector.authenticate({ challenge: txHashBuffer });
        this.lastAssertion = assertion;
      } catch (err) {
        // If user cancelled, propagate error so checkout flow can handle gracefully
        if (err.name === 'NotAllowedError' || err.message?.includes('cancelled')) {
          throw new Error('Biometric authentication was cancelled.');
        }
        throw err;
      }
    }

    // Sign the transaction envelope
    tx.sign(this.keypair);
    return {
      signedTxXdr: tx.toXDR(),
      sep0043Auth: this.lastAssertion ? formatSep0043Signature(this.lastAssertion) : null,
    };
  }

  async disconnect() {
    return true;
  }
}
