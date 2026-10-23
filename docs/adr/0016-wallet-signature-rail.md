# ADR-0016: A signature rail in front of the prepaid ledger

Date: 2026-10 · Status: accepted · Extends ADR-0005 (store adapter) and ADR-0003 (outbox)

## Context

The prepaid wallet was the one place in the system where "who authorised this?" had no
cryptographic answer. A driver topped up with a button press, the API appended a `TOPUP`
row to `wallet_ledger`, and the only thing tying the two together was the bearer token in
the request. That is fine for a demo and wrong for a system that claims to be about
certainty: **the authorisation and the settlement were the same act**, performed by
whatever held the session cookie.

Two things were also true and are worth stating, because most "connect your wallet"
features quietly ignore them:

1. A wallet signature is **public data**. It is not a payment. If the UI implies that
   signing moves ETH, the demo is lying, and the first reviewer who knows what
   `personal_sign` does will notice.
2. A signature is a **bearer instrument** unless the message binds it. A signature over
   "please credit my account" can be replayed for any amount, any number of times, forever.

## Decision

Put an **EIP-191 (`personal_sign`) authorisation rail** in front of the ledger, and make the
signed text carry every field that changes the money.

### 1. Two ceremonies, one verification path

| | Wallet link | Top-up |
|---|---|---|
| Challenge | EIP-4361-shaped, names address, chain id, nonce, issued-at, URI | domain-separated intent, names intent id, wallet, chain, **amount in INR and in wei**, expiry |
| TTL | 5 minutes | 10 minutes |
| Reuse | single-use nonce, deleted on success | single-use intent, `ALREADY_SETTLED` on replay |
| Verified by | `verifyMessage` → recovered signer must equal the claimed address | same, **plus** the intent row must still be `PENDING` and unexpired |

Both produce a real signature over real text; both are verified server-side by recovering
the signer, never by trusting a client-supplied address. `apps/api/src/wallet/rail.js` owns
the message builders so the text the UI displays and the text the server hashes cannot drift
apart — the console renders the string the API returned, byte for byte.

### 2. The amount lives inside the signature

This is the whole point. `intentMessage()` embeds `Amount: INR 500.00` and
`Credits: 2000000000000000 wei`. A signature obtained for ₹500 fails to settle ₹5,000 for
the same reason a cheque for ₹500 cannot be cashed for ₹5,000: the amount is in the signed
material. The server never reads the amount from the request body at settle time — it reads
it from the intent row it created before the signature existed.

### 3. The ledger stays append-only; the balance stays derived

`wallet_account.balance` is a materialised convenience. The authority is
`wallet_ledger.balance_after` on the newest row, and the invariant suite asserts the two
agree after every run (`test/sql/run-invariants.js`). A top-up appends exactly one row and
updates the balance inside one transaction — the same shape as the invoice payment path, so
a crash between the two is not reachable.

### 4. One active address per wallet, enforced by the database

`db/oracle/V009__wallet_link.sql` adds `wallet_link` with a **function-based unique index**:

```sql
CREATE UNIQUE INDEX uq_wallet_link_active
  ON wallet_link (CASE WHEN revoked_at IS NULL THEN address_lc END);
```

A plain `UNIQUE(address_lc)` would have been wrong: unlinking must not poison the address
for every future user, and Oracle treats `NULL`s as distinct anyway. Keying the index on the
active row gives "one live claim per address" without a partial index Oracle cannot express.

### 5. The demo signer is a real key, labelled as a demo

A machine without MetaMask must still be able to run the ceremony, so the console can
generate a secp256k1 key in the tab and keep it in `sessionStorage`. It is a real key and a
real signature — `Wallet.createRandom()` from ethers — and the UI calls it "VoltHub demo
wallet" everywhere, including the linked-address card and the ledger provenance. The
injected path (`EIP-1193` + `BrowserProvider`) is preferred whenever a provider exists.

## Consequences

**Good**

- Every rupee in the ledger traces to a signature over text that names the amount, the
  wallet and an expiry. The provenance column in the console shows the intent id.
- Replay, amount-swap, wrong-chain and address-spoofing attacks each fail with a distinct,
  tested error code (`ALREADY_SETTLED`, `SIGNATURE_MISMATCH`, `INTENT_EXPIRED`,
  `WALLET_TAKEN`, `BAD_SIGNATURE`).
- The rail is honest: no gas, no chain write, no key ever leaves the device. The reference
  rate (₹2,50,000 / ETH) is a fixed constant, not a price feed, and is labelled as such.

**Costly**

- Twelve new tests (`apps/api/test/wallet.js`) and one new table, one new sequence and a
  mirror branch in the Oracle write-through path. A re-link of an already-active address had
  to become an `UPDATE`, not an `INSERT` — the unique index rejected the second insert with
  `ORA-00001` until the mirror learned the difference.
- Six new spec'd paths (`/me/wallet`, `/me/wallet/challenge`, `/me/wallet/link`,
  `/me/wallet/link/{address}`, `/me/wallet/intent`, `/me/wallet/settle`), all covered by the
  OpenAPI drift gate.
- The signature is only as strong as the address binding: a user who links an address they
  do not control can still be phished into signing a top-up. That is a user-education
  problem, not a protocol one, and the intent text is written to be read.

## What this does not do

It does not verify that the wallet holds ETH, does not touch the chain, and does not pretend
to. If this rail were ever pointed at real money, the missing piece is a settlement leg —
an on-chain transfer or a payment processor — reconciled against the intent id. The
authorisation half would not need to change.
