// Wallet rail walkthrough — a scripted, reproducible run of the whole ceremony against a
// live API. Used by the demo video and by anyone who wants to see the rail work without
// clicking through the UI.
//
//   node scripts/demo/wallet-walkthrough.mjs [--api http://localhost:4000/api/v1]
//                                              [--email divya.shankar1@example.in]
//
// The key is deterministic and public (a well-known test vector) — it holds nothing.
// The point is that the server verifies a real secp256k1 signature, so the walkthrough
// cannot fake a link or a credit.
import { Wallet } from 'ethers';

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > -1 ? process.argv[i + 1] : d;
};
const API = arg('--api', 'http://localhost:4000/api/v1');
const EMAIL = arg('--email', 'divya.shankar1@example.in');
const PASSWORD = arg('--password', 'Driver@123');
const AMOUNT = Number(arg('--amount', '1000'));

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  lime: (s) => `\x1b[38;5;155m${s}\x1b[0m`,
  cream: (s) => `\x1b[38;5;230m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
};
const line = (s = '') => console.log(s);
const step = (n, s) => line(`\n${c.dim(`[${n}]`)} ${c.cream(s)}`);

async function api(path, { method = 'GET', body, token } = {}) {
  const r = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${j.error?.code || ''} ${j.error?.message || ''}`);
  return j;
}

const main = async () => {
  line(c.dim(`VoltHub wallet rail · ${API}`));
  step(1, 'Sign in');
  const { accessToken } = await api('/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } });
  const before = await api('/me/wallet', { token: accessToken });
  line(`    balance ${c.lime(`₹${before.wallet.balance}`)} · links ${before.links.length} · ledger ${before.ledger.length} rows`);

  const wallet = new Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
  step(2, `Signer ${wallet.address}`);
  line(c.dim('    a real secp256k1 key; the server never sees it'));

  step(3, 'Request a challenge (single-use, 5-minute TTL)');
  const ch = await api('/me/wallet/challenge', {
    method: 'POST',
    token: accessToken,
    body: { address: wallet.address },
  });
  line(c.dim(ch.message.split('\n').slice(0, 4).map((l) => '    ' + l).join('\n')));

  step(4, 'Sign it (EIP-191 personal_sign) and link');
  const sig = await wallet.signMessage(ch.message);
  const { link } = await api('/me/wallet/link', {
    method: 'POST',
    token: accessToken,
    body: { address: wallet.address, signature: sig, nonce: ch.nonce, label: 'CLI walkthrough' },
  });
  line(`    ${c.lime('verified')} ${link.address} · ${link.verified_by} · chain ${link.chain_id}`);

  step(5, `Create a ₹${AMOUNT} top-up authorisation`);
  const { intent } = await api('/me/wallet/intent', { method: 'POST', token: accessToken, body: { amount: AMOUNT } });
  line(`    intent ${intent.intent_id} · ${intent.amount_eth} ETH · expires ${intent.expires_at}`);

  step(6, 'Sign the authorisation and settle');
  const auth = await wallet.signMessage(intent.message);
  const out = await api('/me/wallet/settle', {
    method: 'POST',
    token: accessToken,
    body: { intent_id: intent.intent_id, signature: auth },
  });
  line(`    ${c.lime('credited')} ₹${out.receipt.amount_inr} · ledger seq ${out.receipt.ledger_seq} · balance ₹${out.receipt.balance_after}`);
  line(c.dim(`    reference ${out.receipt.reference}`));

  step(7, 'Replay the same signature — the rail must refuse');
  try {
    await api('/me/wallet/settle', {
      method: 'POST',
      token: accessToken,
      body: { intent_id: intent.intent_id, signature: auth },
    });
    line(c.red('    UNEXPECTED: replay was accepted'));
    process.exitCode = 1;
  } catch (e) {
    line(`    ${c.lime('refused')} ${e.message}`);
  }

  const after = await api('/me/wallet', { token: accessToken });
  line(
    `\n${c.cream('ledger tail')}\n` +
      after.ledger
        .slice(0, 3)
        .map((l) => `    #${String(l.seq_no).padStart(3, '0')} ${l.kind.padEnd(8)} ${String(l.amount).padStart(9)} → ${l.balance_after}  ${c.dim(l.note || '')}`)
        .join('\n')
  );
};

main().catch((e) => {
  console.error(c.red(e.message));
  process.exit(1);
});
