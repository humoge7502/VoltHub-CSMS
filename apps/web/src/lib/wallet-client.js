'use client';
// Client side of the wallet rail (ADR-0016).
//
// Two ways to hold a key, one interface:
//   • injected  — MetaMask / any EIP-1193 provider; the key never leaves the extension.
//   • demo      — an ephemeral key generated in this tab and kept in sessionStorage, so
//                 the flow is demonstrable on a machine with no extension installed.
// Both produce a real EIP-191 signature that the API verifies with ethers.verifyMessage,
// which is the point: the server never trusts the client's claim about who signed.
import { api } from './ui';

const DEMO_KEY = 'vh_demo_wallet_pk';
const DEMO_ADDR = 'vh_demo_wallet_addr';

const loadEthers = () => import('ethers');

export const hasInjected = () => typeof window !== 'undefined' && !!window.ethereum;

export function demoWalletAddress() {
  if (typeof window === 'undefined') return null;
  return sessionStorage.getItem(DEMO_ADDR);
}

// A demo key is a real secp256k1 key — it just lives in this tab and dies with it. It is
// labelled "Demo wallet" everywhere so nobody mistakes it for a hardware-backed signer.
export async function createDemoWallet() {
  const { Wallet } = await loadEthers();
  const existing = sessionStorage.getItem(DEMO_KEY);
  if (existing) {
    const w = new Wallet(existing);
    sessionStorage.setItem(DEMO_ADDR, w.address);
    return w.address;
  }
  const w = Wallet.createRandom();
  sessionStorage.setItem(DEMO_KEY, w.privateKey);
  sessionStorage.setItem(DEMO_ADDR, w.address);
  return w.address;
}

export async function signWithDemo(message) {
  const { Wallet } = await loadEthers();
  const pk = sessionStorage.getItem(DEMO_KEY);
  if (!pk) throw new Error('no demo wallet in this tab — create one first');
  return new Wallet(pk).signMessage(message);
}

export async function connectInjected() {
  if (!window.ethereum) throw new Error('no browser wallet detected');
  const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
  if (!accounts?.length) throw new Error('no account authorised');
  const { BrowserProvider } = await loadEthers();
  const provider = new BrowserProvider(window.ethereum);
  const net = await provider.getNetwork();
  return { address: accounts[0], chainId: Number(net.chainId) };
}

export async function signWithInjected(message) {
  const { BrowserProvider } = await loadEthers();
  const provider = new BrowserProvider(window.ethereum);
  const signer = await provider.getSigner();
  return signer.signMessage(message);
}

// The link ceremony: challenge → sign → verify. Returns the stored link row.
export async function linkWallet({ mode, label }) {
  const address = mode === 'demo' ? await createDemoWallet() : (await connectInjected()).address;
  const ch = await api('/me/wallet/challenge', {
    method: 'POST',
    body: JSON.stringify({ address }),
  });
  const signature = mode === 'demo' ? await signWithDemo(ch.message) : await signWithInjected(ch.message);
  const out = await api('/me/wallet/link', {
    method: 'POST',
    body: JSON.stringify({ address, signature, nonce: ch.nonce, label }),
  });
  return { link: out.link, message: ch.message, signature };
}

// One top-up: intent → sign the exact text → settle. The message shown to the user in the
// UI is byte-for-byte the message the server will verify.
export async function topUpWithSignature({ amount, mode, onStep }) {
  onStep?.('intent');
  const { intent } = await api('/me/wallet/intent', {
    method: 'POST',
    body: JSON.stringify({ amount }),
  });
  onStep?.('sign');
  const signature = mode === 'demo' ? await signWithDemo(intent.message) : await signWithInjected(intent.message);
  onStep?.('verify');
  const out = await api('/me/wallet/settle', {
    method: 'POST',
    body: JSON.stringify({ intent_id: intent.intent_id, signature }),
  });
  onStep?.('done');
  return { ...out, intent, signature };
}

export const shortAddr = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
