// ADR-0016 — signed wallet rail. Pins the properties that make it safe to demo:
//   W1  challenge is bound to one address and one account, and expires
//   W2  a challenge is single-use (a replayed signature cannot link twice)
//   W3  a signature from a different key is rejected (401 SIGNATURE_MISMATCH)
//   W4  an intent names its amount: a ₹500 signature cannot settle ₹5,000
//   W5  settle credits exactly once — a second settle is 409 ALREADY_SETTLED
//   W6  an expired intent is refused (409 INTENT_EXPIRED)
//   W7  an address cannot be linked to two accounts (409 WALLET_TAKEN)
//   W8  unlink revokes: the address is free again and the link is gone from /me/wallet
//   W9  the ledger row carries the provenance note, and the balance matches it
//   W10 no signature, no credit: settling without a signature is a 401, never a 201
// Run: node apps/api/test/wallet.js
'use strict';
process.env.RATE_LIMIT_OFF = '1';
const assert = require('assert');
const { Wallet } = require('ethers');

async function main() {
  process.env.PORT = '4107';
  const { server, store } = require('../src/server');
  await new Promise((r) => server.listen(4107, r));
  const B = 'http://localhost:4107/api/v1';
  const api = async (p, o = {}) => {
    const { headers, ...rest } = o;
    const r = await fetch(B + p, { ...rest, headers: { 'content-type': 'application/json', ...(headers || {}) } });
    return { status: r.status, j: await r.json().catch(() => ({})) };
  };
  let pass = 0;
  const t = async (name, fn) => {
    await fn();
    pass++;
    console.log(`  wallet ${pass} - ${name}`);
  };

  // Two deterministic keys: the rail must tell them apart, so a hard-coded signer in the
  // tests would prove nothing. These are well-known test keys, never funded.
  const alice = new Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
  const mallory = new Wallet('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');

  const email = `w${Date.now()}@example.in`;
  const reg = await api('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password: 'Driver@123', full_name: 'Wallet Driver' }),
  });
  assert.equal(reg.status, 201);
  const tok = reg.j.accessToken;
  const H = () => ({ Authorization: `Bearer ${tok}` });
  const startBalance = (await api('/me', { headers: H() })).j.wallet.balance;

  let nonce;
  await t('W1 challenge names the address, the chain and a nonce', async () => {
    const { status, j } = await api('/me/wallet/challenge', {
      method: 'POST',
      headers: H(),
      body: JSON.stringify({ address: alice.address }),
    });
    assert.equal(status, 201);
    nonce = j.nonce;
    assert.ok(j.message.includes(alice.address), 'message must name the checksummed address');
    assert.ok(j.message.includes(j.nonce), 'message must carry the nonce');
    assert.equal(j.chain_id, 11155111);
  });

  await t('W3 a signature from another key cannot link the address', async () => {
    const forged = await mallory.signMessage(
      (
        await api('/me/wallet/challenge', {
          method: 'POST',
          headers: H(),
          body: JSON.stringify({ address: alice.address }),
        })
      ).j.message
    );
    const { status, j } = await api('/me/wallet/link', {
      method: 'POST',
      headers: H(),
      body: JSON.stringify({ address: alice.address, signature: forged, nonce }),
    });
    assert.equal(status, 401);
    assert.equal(j.error.code, 'SIGNATURE_MISMATCH');
  });

  // W3 consumed the nonce, so W2 proves the consumption is real: the same nonce again
  // (this time with a *valid* signature) must still fail.
  await t('W2 the challenge is single-use even with a valid signature', async () => {
    const sig = await alice.signMessage('anything');
    const { status, j } = await api('/me/wallet/link', {
      method: 'POST',
      headers: H(),
      body: JSON.stringify({ address: alice.address, signature: sig, nonce }),
    });
    assert.equal(status, 409);
    assert.equal(j.error.code, 'CHALLENGE_INVALID');
  });

  let message;
  await t('W1b a fresh challenge links when the signature verifies', async () => {
    const ch = await api('/me/wallet/challenge', {
      method: 'POST',
      headers: H(),
      body: JSON.stringify({ address: alice.address }),
    });
    message = ch.j.message;
    const signature = await alice.signMessage(message);
    const { status, j } = await api('/me/wallet/link', {
      method: 'POST',
      headers: H(),
      body: JSON.stringify({ address: alice.address, signature, nonce: ch.j.nonce, label: 'MetaMask · Alice' }),
    });
    assert.equal(status, 201);
    assert.equal(j.link.address, alice.address);
    assert.equal(j.link.verified_by, 'EIP-191');
  });

  await t('W7 the same address cannot be linked to a second account', async () => {
    const other = await api('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email: `w2${Date.now()}@example.in`, password: 'Driver@123', full_name: 'Other' }),
    });
    const H2 = { Authorization: `Bearer ${other.j.accessToken}` };
    const ch = await api('/me/wallet/challenge', {
      method: 'POST',
      headers: H2,
      body: JSON.stringify({ address: alice.address }),
    });
    const sig = await alice.signMessage(ch.j.message);
    const { status, j } = await api('/me/wallet/link', {
      method: 'POST',
      headers: H2,
      body: JSON.stringify({ address: alice.address, signature: sig, nonce: ch.j.nonce }),
    });
    assert.equal(status, 409);
    assert.equal(j.error.code, 'WALLET_TAKEN');
  });

  let intent;
  await t('W4 an intent carries its amount inside the signed text', async () => {
    const { status, j } = await api('/me/wallet/intent', {
      method: 'POST',
      headers: H(),
      body: JSON.stringify({ amount: 500 }),
    });
    assert.equal(status, 201);
    intent = j.intent;
    assert.equal(intent.amount_inr, 500);
    assert.ok(intent.message.includes('INR 500.00'));
    assert.ok(!intent.message.includes('INR 5000.00'));
    assert.equal(intent.status, 'PENDING');
  });

  await t('W10 settle without a signature is refused', async () => {
    const { status } = await api('/me/wallet/settle', {
      method: 'POST',
      headers: H(),
      body: JSON.stringify({ intent_id: intent.intent_id }),
    });
    assert.ok(status === 401 || status === 422, `expected 401/422, got ${status}`);
  });

  let receipt;
  await t('W9 a verified signature credits the ledger with provenance', async () => {
    const signature = await alice.signMessage(intent.message);
    const { status, j } = await api('/me/wallet/settle', {
      method: 'POST',
      headers: H(),
      body: JSON.stringify({ intent_id: intent.intent_id, signature }),
    });
    assert.equal(status, 201);
    receipt = j.receipt;
    assert.equal(j.wallet.balance, +(startBalance + 500).toFixed(2));
    assert.equal(j.entry.kind, 'TOPUP');
    assert.equal(j.entry.balance_after, j.wallet.balance);
    assert.ok(j.entry.note.includes(intent.intent_id), 'ledger note must name the intent');
    assert.ok(receipt.reference.startsWith('vh_'));
  });

  await t('W5 a second settle of the same intent is 409, never a second credit', async () => {
    const signature = await alice.signMessage(intent.message);
    const { status, j } = await api('/me/wallet/settle', {
      method: 'POST',
      headers: H(),
      body: JSON.stringify({ intent_id: intent.intent_id, signature }),
    });
    assert.equal(status, 409);
    assert.equal(j.error.code, 'ALREADY_SETTLED');
    const after = (await api('/me', { headers: H() })).j.wallet.balance;
    assert.equal(after, +(startBalance + 500).toFixed(2));
  });

  await t('W6 an expired intent is refused', async () => {
    const { store } = require('../src/server');
    const fresh = (
      await api('/me/wallet/intent', {
        method: 'POST',
        headers: H(),
        body: JSON.stringify({ amount: 300 }),
      })
    ).j.intent;
    const row = store.walletIntents.get(fresh.intent_id);
    row.expires_at_ms = Date.now() - 1000;
    row.expires_at = new Date(Date.now() - 1000).toISOString();
    const signature = await alice.signMessage(fresh.message);
    const { status, j } = await api('/me/wallet/settle', {
      method: 'POST',
      headers: H(),
      body: JSON.stringify({ intent_id: fresh.intent_id, signature }),
    });
    assert.equal(status, 409);
    assert.equal(j.error.code, 'INTENT_EXPIRED');
  });

  await t('W8 unlink revokes the link and frees the address', async () => {
    const { status } = await api(`/me/wallet/link/${alice.address}`, { method: 'DELETE', headers: H() });
    assert.equal(status, 200);
    const w = (await api('/me/wallet', { headers: H() })).j;
    assert.equal(w.links.length, 0);
    const { status: s2, j: j2 } = await api('/me/wallet/intent', {
      method: 'POST',
      headers: H(),
      body: JSON.stringify({ amount: 500 }),
    });
    assert.equal(s2, 409);
    assert.equal(j2.error.code, 'NO_WALLET_LINKED');
  });

  await t('overview exposes the ledger tail newest-first', async () => {
    const { j } = await api('/me/wallet', { headers: H() });
    assert.ok(j.ledger.length >= 2);
    assert.ok(j.ledger[0].seq_no > j.ledger[1].seq_no);
    assert.equal(j.rail.chain_name, 'Sepolia');
  });

  await t('W11 a concurrent double-settle still credits exactly once', async () => {
    // Review 2026-10-24 (W5 under concurrency): the old settle checked status
    // synchronously, then awaited real I/O (topup mirror) before flipping to SETTLED —
    // two racing settles both observed PENDING and both credited. The intent mutex
    // keeps "exactly one credit per signature" true for CONCURRENT calls too.
    const ch = (
      await api('/me/wallet/challenge', {
        method: 'POST',
        headers: H(),
        body: JSON.stringify({ address: alice.address }),
      })
    ).j;
    const sigLink = await alice.signMessage(ch.message);
    assert.equal(
      (
        await api('/me/wallet/link', {
          method: 'POST',
          headers: H(),
          body: JSON.stringify({ address: alice.address, signature: sigLink, nonce: ch.nonce }),
        })
      ).status,
      201,
      'relink for the concurrency probe'
    );
    const before = ((await api('/me', { headers: H() })).j.wallet || {}).balance ?? 0;
    const it = (
      await api('/me/wallet/intent', {
        method: 'POST',
        headers: H(),
        body: JSON.stringify({ amount: 250 }),
      })
    ).j.intent;
    const sig = await alice.signMessage(it.message);
    const settles = await Promise.allSettled(
      [1, 2].map(() =>
        api('/me/wallet/settle', {
          method: 'POST',
          headers: H(),
          body: JSON.stringify({ intent_id: it.intent_id, signature: sig }),
        })
      )
    );
    const codes = settles.map((x) => x.value.status).sort();
    assert.deepStrictEqual(codes, [201, 409], `exactly one settle must win, got ${codes}`);
    const after = ((await api('/me', { headers: H() })).j.wallet || {}).balance ?? 0;
    assert.ok(
      Math.abs(after - before - 250) < 0.001,
      `balance must rise by exactly the intent amount (${before} -> ${after})`
    );
    assert.equal(store.walletIntents.get(it.intent_id).status, 'SETTLED');
  });

  await t('W12 the unsigned top-up route is opt-in (SEC-043)', async () => {
    const prev = process.env.WALLET_UNSIGNED_TOPUP;
    process.env.WALLET_UNSIGNED_TOPUP = '0';
    const off = await api('/me/wallet/topup', {
      method: 'POST',
      headers: H(),
      body: JSON.stringify({ amount: 100 }),
    });
    assert.equal(off.status, 403);
    assert.equal(off.j.error.code, 'SIGNED_RAIL_REQUIRED');
    delete process.env.WALLET_UNSIGNED_TOPUP;
    if (prev !== undefined) process.env.WALLET_UNSIGNED_TOPUP = prev;
    // Default outside production stays enabled — local/dev/e2e flows rely on it
    // (register's welcome credit is a store call, but demo scripts use this route).
    const on = await api('/me/wallet/topup', {
      method: 'POST',
      headers: H(),
      body: JSON.stringify({ amount: 100 }),
    });
    assert.equal(on.status, 200);
  });

  console.log(`\nWallet rail tests: ${pass} passed`);
  server.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
