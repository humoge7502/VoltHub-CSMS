// Wallet rail — cryptographically verified wallet linking + signed top-up authorisations.
//
// What this is: an EIP-191 (`personal_sign`) authorisation rail in front of the prepaid
// ledger. The signature is the authorisation; the ledger is the settlement. No private
// key, seed phrase or card number ever reaches this process — only a signature and a
// public address, both of which are public data.
//
// What this is not: an on-chain transaction. There is no gas and no chain write; the
// digest below is a domain-separated message that names the intent id, the amount and
// an expiry, so a signature cannot be replayed for a different amount or a second time.
// The UI says this out loud (docs/wallet.md) — a demo that pretends to move ETH would be
// the one thing this codebase refuses to do.
'use strict';
const crypto = require('crypto');
const { verifyMessage, getAddress } = require('ethers');

// Demo economy: a fixed reference rate so the INR amount the driver picks has a stable
// ETH-denominated line on the receipt. Deliberately not a live oracle — a price feed is
// a dependency, and this is a demo rail (ADR-0016).
const INR_PER_ETH = 250000;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const INTENT_TTL_MS = 10 * 60 * 1000;
const CHAIN_ID = Number(process.env.WALLET_CHAIN_ID || 11155111); // Sepolia — a testnet, named as such
const CHAIN_NAME = process.env.WALLET_CHAIN_NAME || 'Sepolia';
const MAX_TOPUP_INR = 10000;

const wei = (inr) => BigInt(Math.round((Number(inr) / INR_PER_ETH) * 1e18));
const eth = (inr) => (Number(inr) / INR_PER_ETH).toFixed(8);

function nonce() {
  return crypto.randomBytes(16).toString('hex');
}

function normalise(address) {
  try {
    return getAddress(String(address || '').trim()); // checksummed; throws on bad input
  } catch {
    const e = new Error('address is not a valid EVM address');
    e.code = 'INVALID_ADDRESS';
    e.status = 422;
    throw e;
  }
}

// EIP-4361-shaped: a human can read exactly what they are about to sign.
function challengeMessage({ address, chainId, nonce: n, issuedAt, uri, domain }) {
  return [
    `${domain} wants you to link this wallet to VoltHub CSMS.`,
    '',
    `Address: ${address}`,
    `Chain ID: ${chainId}`,
    `Nonce: ${n}`,
    `Issued At: ${issuedAt}`,
    `URI: ${uri}`,
    '',
    'Statement: This proves you control this address. It authorises no payment and',
    'moves no funds. VoltHub stores the public address only — never a key.',
  ].join('\n');
}

// Domain-separated top-up authorisation. Every field that changes the money is inside
// the signed text, so a signature for ₹500 cannot settle ₹5,000.
function intentMessage({ intentId, address, amountInr, amountWei, chainId, expiresAt }) {
  return [
    'VoltHub CSMS — prepaid top-up authorisation',
    '',
    `Intent: ${intentId}`,
    `Wallet: ${address}`,
    `Chain ID: ${chainId}`,
    `Amount: INR ${Number(amountInr).toFixed(2)}`,
    `Credits: ${amountWei} wei`,
    `Expires: ${expiresAt}`,
    '',
    'Signing authorises a single credit of the amount above to the prepaid wallet.',
    'It is not an on-chain transaction: no gas, no transfer, no key leaves your device.',
  ].join('\n');
}

// Returns the checksummed signer, or throws a typed 401. verifyMessage never throws on a
// malformed signature — it returns an address that simply will not match, so the caller
// must compare, which is exactly what `verifySignature` does.
function recover(message, signature) {
  let signer;
  try {
    signer = verifyMessage(message, signature);
  } catch {
    const e = new Error('signature could not be recovered');
    e.code = 'BAD_SIGNATURE';
    e.status = 401;
    throw e;
  }
  return getAddress(signer);
}

function verifySignature({ message, signature, address }) {
  const signer = recover(message, signature);
  if (signer.toLowerCase() !== normalise(address).toLowerCase()) {
    const e = new Error('signature does not match the claimed address');
    e.code = 'SIGNATURE_MISMATCH';
    e.status = 401;
    throw e;
  }
  return signer;
}

module.exports = {
  INR_PER_ETH,
  CHALLENGE_TTL_MS,
  INTENT_TTL_MS,
  CHAIN_ID,
  CHAIN_NAME,
  MAX_TOPUP_INR,
  wei,
  eth,
  nonce,
  normalise,
  challengeMessage,
  intentMessage,
  verifySignature,
  recover,
};
