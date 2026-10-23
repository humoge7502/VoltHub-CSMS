# The wallet rail — signed authorisations over a prepaid ledger

VoltHub's prepaid wallet is credited by **signature**, not by a button that trusts the
session cookie. A driver links an EVM address once, then authorises each top-up by signing a
message that names the amount. The API recovers the signer with `ethers.verifyMessage`,
compares it to the address on file, and appends exactly one ledger row.

Design record: [ADR-0016](adr/0016-wallet-signature-rail.md).

## What it is, and what it is not

| | |
|---|---|
| **Is** | EIP-191 `personal_sign` authorisation, verified server-side by signer recovery |
| **Is** | A single-use, amount-binding, expiring authorisation for one ledger credit |
| **Is** | Compatible with MetaMask and any EIP-1193 provider, plus a demo signer for machines with no extension |
| **Is not** | An on-chain transaction. No gas, no chain write, no ETH moves |
| **Is not** | A custodial wallet. The server stores a public address and a signature; never a key |

The reference rate (₹2,50,000 per ETH) is a fixed demo constant, not a price feed. It exists
so a receipt can show an ETH-denominated line next to the rupee amount; it is labelled as a
reference rate everywhere it appears.

## The two ceremonies

### 1. Link a wallet — prove you control the address

```
POST /api/v1/me/wallet/challenge   { address }        → { message, nonce, expires_at }
        ↓ sign `message` with personal_sign
POST /api/v1/me/wallet/link        { address, signature, nonce, label }
                                                      → { link: { address, chain_id, verified_by, linked_at } }
```

The challenge text is EIP-4361-shaped, so a human can read exactly what they are signing:

```
volthub.local wants you to link this wallet to VoltHub CSMS.

Address: 0x70997970C51812dc3A010C7d01b50e0d17dc79C8
Chain ID: 11155111
Nonce: 6f1c… (32 hex)
Issued At: 2026-10-22T21:20:00.000Z
URI: http://localhost:3120

Statement: This proves you control this address. It authorises no payment and
moves no funds. VoltHub stores the public address only — never a key.
```

The nonce is single-use and dies with the challenge (5-minute TTL). The server does **not**
trust the `address` field in the link request; it recovers the signer from the signature and
requires the two to match.

### 2. Top up — sign the amount

```
POST /api/v1/me/wallet/intent      { amount_inr }     → { intent_id, message, expires_at }
        ↓ sign `message` with personal_sign
POST /api/v1/me/wallet/settle      { intent_id, signature }
                                                      → { wallet, entry, receipt: { ledger_seq, balance_after, … } }
```

The intent text carries the money:

```
VoltHub CSMS — prepaid top-up authorisation

Intent: int_0002.6c364450
Wallet: 0xb1524a…c32f6e7c2
Chain ID: 11155111
Amount: INR 500.00
Credits: 2000000000000000 wei
Expires: 2026-10-22T21:31:00.000Z

Signing authorises a single credit of the amount above to the prepaid wallet.
It is not an on-chain transaction: no gas, no transfer, no key leaves your device.
```

A signature obtained for ₹500 cannot settle ₹5,000 — the amount is inside the signed bytes.
The settle call never reads an amount from the request body.

## Error codes you can rely on

| Code | HTTP | When |
|---|---|---|
| `INVALID_ADDRESS` | 422 | Address fails EIP-55 checksum / is not 20 bytes |
| `BAD_SIGNATURE` | 401 | Signature is not recoverable |
| `SIGNATURE_MISMATCH` | 401 | Recovered signer ≠ claimed address |
| `CHALLENGE_EXPIRED` | 409 | Challenge older than 5 minutes, or nonce already used |
| `INTENT_EXPIRED` | 409 | Intent older than 10 minutes |
| `ALREADY_SETTLED` | 409 | This intent has already credited the ledger |
| `WALLET_TAKEN` | 409 | Address is actively linked to another user |
| `NO_WALLET_LINKED` | 409 | Top-up attempted before linking |
| `AMOUNT_OUT_OF_RANGE` | 422 | Outside ₹1 – ₹10,000 |

Each of these is asserted in `apps/api/test/wallet.js` (12 cases), including the replay case
that matters most: settle the same signature twice, get one credit and one `409`.

## Data model

```sql
CREATE TABLE wallet_link (
  link_id      NUMBER PRIMARY KEY,
  user_id      NUMBER NOT NULL REFERENCES app_user(user_id),
  address      VARCHAR2(42) NOT NULL,      -- checksummed, as presented
  address_lc   VARCHAR2(42) NOT NULL,      -- lowercase, for comparison
  chain_id     NUMBER NOT NULL,
  label        VARCHAR2(80),
  verified_by  VARCHAR2(16),               -- 'eip191'
  linked_at    TIMESTAMP NOT NULL,
  revoked_at   TIMESTAMP
);

-- one live claim per address; unlinking frees it for someone else
CREATE UNIQUE INDEX uq_wallet_link_active
  ON wallet_link (CASE WHEN revoked_at IS NULL THEN address_lc END);
```

The ledger itself is unchanged and still append-only: a top-up writes one `TOPUP` row whose
`note` names the intent id and a truncated signer, so the provenance column in the console
points back at the authorisation that created it.

## Trying it

```bash
# 1. the CLI walkthrough — signs, settles, then tries to replay and shows the refusal
node scripts/demo/wallet-walkthrough.mjs

# 2. the browser — sign in as divya.shankar1@example.in / Driver@123, then /wallet
#    "Link wallet" uses MetaMask if present, otherwise generates a demo key in the tab.

# 3. the tests
node apps/api/test/wallet.js
```

## Why not just trust the client?

Because the whole project is an argument about where certainty lives. A reservation's
certainty is a row lock in Oracle. A ledger credit's certainty is a signature the server
recovered itself. In both cases the answer is "the database and the cryptography decide",
not "the application was careful".
