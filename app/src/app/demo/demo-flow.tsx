'use client';

import { useEffect, useState } from 'react';
import {
  detectWallets, connectWallet, hexAddressToBech32,
  combineTxWithWitness,
  type Cip30Api, type WalletInfo,
} from '@/lib/cip30';
import { x402Fetch } from '@odatano/x402/srv/client/fetch';
import { encodePaymentEnvelope } from '@odatano/x402/srv/client/envelope';
import type { PayHandler } from '@odatano/x402/srv/client/types';
import type { Network } from '@odatano/x402/srv/core/network';

interface UnsignedPaymentTx {
  unsignedTxCborHex: string;
  txHashHex:         string;
  requiredSignerHex: string;
  /** v2 UTxO-ref nonce `<txHash>#<index>` — goes in the envelope's payload.nonce. */
  nonceRef:          string;
  ttlSlot:           number;
  requirements: {
    scheme:      string;
    network:     string;
    amount:      string;
    asset:       string;
    payTo:       string;
    resource:    string;
    description: string;
  };
  inputs: Array<{ txHash: string; outputIndex: number; lovelace: string }>;
}

type StepStatus = 'idle' | 'busy' | 'done' | 'error';
interface Step {
  status: StepStatus;
  detail?: string;
  error?: string;
}

const BASE_URL =
  (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_CHAINFEED_BASE_URL) ||
  'http://localhost:4004';

const TARGET_ACTION = 'getBestPrice';
const TARGET_PAIR   = 'ADA-USDM';
// v2 requirements are asset-agnostic and carry no decimals — mock-USDM is 6dp.
const USDM_DECIMALS = 6;

export function DemoFlow() {
  const [wallets, setWallets] = useState<WalletInfo[]>([]);
  const [api, setApi]         = useState<Cip30Api | null>(null);
  const [bech32, setBech32]   = useState<string | null>(null);

  const [step1, setStep1] = useState<Step>({ status: 'idle' });
  const [step2, setStep2] = useState<Step>({ status: 'idle' });
  const [step3, setStep3] = useState<Step>({ status: 'idle' });
  const [step4, setStep4] = useState<Step>({ status: 'idle' });

  const [unsigned,    setUnsigned]    = useState<UnsignedPaymentTx | null>(null);
  const [witnessHex,  setWitnessHex]  = useState<string | null>(null);
  const [signedTx,    setSignedTx]    = useState<{ cborHex: string; base64: string; txHash: string } | null>(null);
  const [paymentSigHdr, setPaymentSigHdr] = useState<string | null>(null);
  const [finalResponse, setFinalResponse] = useState<{
    status: number;
    body: unknown;
    paymentResponse: unknown | null;
  } | null>(null);

  useEffect(() => {
    setWallets(detectWallets());
  }, []);

  async function onConnect(w: WalletInfo) {
    setStep1({ status: 'busy' });
    try {
      const a = await connectWallet(w.key);
      const used = await a.getUsedAddresses();
      const candidates = used.length > 0 ? used : [await a.getChangeAddress()];
      const head = candidates[0];
      if (!head) throw new Error('wallet returned no addresses');
      const bech = await hexAddressToBech32(head);
      setApi(a);
      setBech32(bech);
      setStep1({
        status: 'done',
        detail: `${w.name} connected · ${bech.slice(0, 14)}…${bech.slice(-6)}`,
      });
    } catch (err) {
      setStep1({ status: 'error', error: (err as Error)?.message ?? String(err) });
    }
  }

  /**
   * Single-button flow powered by `@odatano/x402`'s `x402Fetch`:
   *
   *   1. x402Fetch POSTs the gated endpoint → server returns 402
   *      (x402Fetch unwraps CAP's OData error envelope internally — fixed
   *       in v0.3.0; we no longer need a custom fetch wrapper).
   *   2. x402Fetch parses v2 requirements + invokes our PayHandler
   *   3. PayHandler:
   *        a. calls CHAINFEED `buildPaymentTx` (free) → unsigned CBOR
   *        b. CIP-30 `signTx` + combine → signed CBOR
   *        c. returns { signedTxCborHex, nonceRef }
   *   4. x402Fetch encodes a `PAYMENT-SIGNATURE` envelope + retries
   *   5. Server validates + settles + returns 200 + the gated quote
   *
   * Each substep updates React state so the 4 step-cards transcribe the
   * wire artifacts as they appear — same pedagogy as the old hand-rolled
   * flow, ~80 fewer lines of orchestration.
   */
  async function onPayAndFetch() {
    if (!api || !bech32) return;

    // Reset downstream state — allow a fresh retry after an error.
    setStep2({ status: 'busy' });
    setStep3({ status: 'idle' });
    setStep4({ status: 'idle' });
    setUnsigned(null);
    setWitnessHex(null);
    setSignedTx(null);
    setPaymentSigHdr(null);
    setFinalResponse(null);

    const pay: PayHandler = async (requirement) => {
      // ── step 2: ask CHAINFEED to build an unsigned tx for this buyer ──
      const r = await fetch(`${BASE_URL}/odata/v4/price/buildPaymentTx`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ buyerAddrBech32: bech32, gatedAction: TARGET_ACTION }),
      });
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        throw new Error(`buildPaymentTx HTTP ${r.status}: ${text.slice(0, 200)}`);
      }
      const u = (await r.json()) as UnsignedPaymentTx;
      setUnsigned(u);
      const usdm = (Number(u.requirements.amount) / 10 ** USDM_DECIMALS).toFixed(USDM_DECIMALS);
      setStep2({
        status: 'done',
        detail: `server built tx · pays ${usdm} mock-USDM · nonce ${u.nonceRef.slice(0, 14)}…`,
      });

      // ── step 3: wallet signs + combine witness with tx body ───────────
      setStep3({ status: 'busy' });
      const witness = await api.signTx(u.unsignedTxCborHex, false);
      setWitnessHex(witness);
      const combined = await combineTxWithWitness(u.unsignedTxCborHex, witness);
      setSignedTx({
        cborHex: combined.signedTxCborHex,
        base64:  combined.signedTxBase64,
        txHash:  combined.txHashHex,
      });

      // The envelope x402Fetch is about to send — encoded here too so
      // the UI can display the wire payload (same encoder, byte-for-byte).
      const hdr = encodePaymentEnvelope({
        network:         requirement.network as Network,
        signedTxCborHex: combined.signedTxCborHex,
        nonceRef:        u.nonceRef,
      });
      setPaymentSigHdr(hdr);
      setStep3({
        status: 'done',
        detail: `wallet signed · PAYMENT-SIGNATURE envelope ${hdr.length} chars · tx ${combined.txHashHex.slice(0, 12)}…`,
      });

      return { signedTxCborHex: combined.signedTxCborHex, nonceRef: u.nonceRef };
    };

    setStep4({ status: 'busy' });
    try {
      const paidFetch = x402Fetch({ pay });
      const res = await paidFetch(`${BASE_URL}/odata/v4/price/${TARGET_ACTION}`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ pair: TARGET_PAIR }),
      });
      const text = await res.text();
      let body: unknown;
      try { body = JSON.parse(text); } catch { body = text; }
      const xpr = res.headers.get('x-payment-response');
      let paymentResponse: unknown | null = null;
      if (xpr) {
        try { paymentResponse = JSON.parse(atob(xpr)); } catch { paymentResponse = xpr; }
      }
      setFinalResponse({ status: res.status, body, paymentResponse });
      if (res.status === 200) {
        setStep4({ status: 'done', detail: `server accepted · returned quote (${text.length} bytes)` });
      } else {
        setStep4({ status: 'error', error: `Server returned ${res.status}: ${text.slice(0, 240)}` });
      }
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      // Pin the error to whichever step was busy.
      if (!unsigned)            setStep2({ status: 'error', error: msg });
      else if (!signedTx)       setStep3({ status: 'error', error: msg });
      setStep4({ status: 'error', error: msg });
    }
  }

  return (
    <div className="space-y-6">
      <StepCard
        n={1}
        title="Connect wallet"
        status={step1.status}
        detail={step1.detail}
        error={step1.error}
      >
        {step1.status !== 'done' && (
          <WalletPicker wallets={wallets} onPick={onConnect} disabled={step1.status === 'busy'} />
        )}
        {step1.status === 'done' && bech32 && (
          <div className="text-xs font-mono break-all bg-(--muted) border border-(--border) rounded p-3">
            {bech32}
          </div>
        )}
      </StepCard>

      <StepCard
        n={2}
        title="Request unsigned payment tx from CHAINFEED"
        status={step2.status}
        detail={step2.detail}
        error={step2.error}
      >
        <button
          onClick={onPayAndFetch}
          disabled={!bech32 || step2.status === 'busy' || step3.status === 'busy' || step4.status === 'busy' || step4.status === 'done'}
          className="px-4 py-2 rounded bg-(--accent) text-white font-semibold text-sm disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90 transition-opacity"
        >
          {step4.status === 'busy' ? 'Working…' : 'Pay & fetch quote'}
        </button>
        <p className="mt-2 text-xs text-(--muted-foreground)">
          One click runs all four steps via <code>x402Fetch</code> from <code>@odatano/x402</code>.
        </p>
        {unsigned && <UnsignedTxView u={unsigned} />}
      </StepCard>

      <StepCard
        n={3}
        title="Sign in wallet (CIP-30)"
        status={step3.status}
        detail={step3.detail}
        error={step3.error}
      >
        <p className="text-sm text-(--muted-foreground)">
          Your wallet pops up when step 2 finishes building the unsigned tx — approve to continue.
        </p>
        {witnessHex && (
          <details className="mt-3">
            <summary className="text-xs text-(--muted-foreground) cursor-pointer hover:text-(--foreground)">
              Witness set CBOR (from wallet) · {witnessHex.length} chars
            </summary>
            <pre className="mt-2 text-[10px] font-mono break-all bg-(--muted) border border-(--border) rounded p-2 max-h-32 overflow-auto">{witnessHex}</pre>
          </details>
        )}
        {paymentSigHdr && (
          <details className="mt-2">
            <summary className="text-xs text-(--muted-foreground) cursor-pointer hover:text-(--foreground)">
              PAYMENT-SIGNATURE header value · {paymentSigHdr.length} chars
            </summary>
            <pre className="mt-2 text-[10px] font-mono break-all bg-(--muted) border border-(--border) rounded p-2 max-h-32 overflow-auto">{paymentSigHdr}</pre>
          </details>
        )}
      </StepCard>

      <StepCard
        n={4}
        title="Server validates, settles on-chain, returns 200"
        status={step4.status}
        detail={step4.detail}
        error={step4.error}
      >
        <p className="text-sm text-(--muted-foreground)">
          <code>x402Fetch</code> auto-retries the original POST with the <code>PAYMENT-SIGNATURE</code>{' '}
          header. The facilitator runs the six v2 checks, submits the tx, polls for confirmation,{' '}
          and serves the gated quote.
        </p>
        {finalResponse && <FinalResponseView r={finalResponse} signedTx={signedTx} />}
      </StepCard>
    </div>
  );
}

function StepCard({
  n, title, status, detail, error, children,
}: {
  n: number;
  title: string;
  status: StepStatus;
  detail?: string;
  error?: string;
  children: React.ReactNode;
}) {
  const dot =
    status === 'done'  ? 'bg-(--healthy)'  :
    status === 'busy'  ? 'bg-(--warning) animate-pulse' :
    status === 'error' ? 'bg-(--critical)' :
                         'bg-(--border)';
  return (
    <section className="border border-(--border) rounded-lg p-5">
      <div className="flex items-baseline gap-3 mb-3">
        <span className={`inline-block w-3 h-3 rounded-full ${dot}`} />
        <span className="text-xs font-mono text-(--muted-foreground) tabular-nums">step {n}</span>
        <h2 className="font-semibold">{title}</h2>
      </div>
      {detail && <p className="text-sm text-(--muted-foreground) mb-3">{detail}</p>}
      {error && (
        <p className="text-sm text-(--critical) mb-3 font-mono break-words">{error}</p>
      )}
      {children}
    </section>
  );
}

function WalletPicker({
  wallets, onPick, disabled,
}: {
  wallets: WalletInfo[];
  onPick: (w: WalletInfo) => void;
  disabled: boolean;
}) {
  if (wallets.length === 0) {
    return (
      <p className="text-sm text-(--muted-foreground)">
        No CIP-30 wallet detected. Install <a href="https://www.lace.io" className="text-(--accent) hover:underline" target="_blank" rel="noreferrer">Lace</a>,{' '}
        <a href="https://eternl.io" className="text-(--accent) hover:underline" target="_blank" rel="noreferrer">Eternl</a>, or{' '}
        <a href="https://namiwallet.io" className="text-(--accent) hover:underline" target="_blank" rel="noreferrer">Nami</a>{' '}
        and reload this page.
      </p>
    );
  }
  return (
    <div className="flex flex-wrap gap-2">
      {wallets.map(w => (
        <button
          key={w.key}
          onClick={() => onPick(w)}
          disabled={disabled}
          className="flex items-center gap-2 px-3 py-2 rounded border border-(--border) hover:border-(--accent) hover:bg-(--muted) transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {/*
            Wallet icon — vendor-supplied, often a data: URL. We use a
            plain <img> rather than next/image because data URLs aren't
            supported by next/image's loader without extra config.
          */}
          <img src={w.icon} alt="" className="w-5 h-5 rounded" />
          <span className="text-sm">{w.name}</span>
        </button>
      ))}
    </div>
  );
}

function UnsignedTxView({ u }: { u: UnsignedPaymentTx }) {
  const usdm = (Number(u.requirements.amount) / 10 ** USDM_DECIMALS).toFixed(USDM_DECIMALS);
  return (
    <div className="mt-4 space-y-2">
      <div className="grid grid-cols-2 gap-2 text-xs">
        <KV k="Amount"   v={`${usdm} USDM (${u.requirements.amount} raw)`} />
        <KV k="Network"  v={u.requirements.network} />
        <KV k="Pay to"   v={u.requirements.payTo} mono />
        <KV k="Asset"    v={u.requirements.asset} mono />
        <KV k="Nonce"    v={u.nonceRef} mono />
        <KV k="Tx hash"  v={u.txHashHex} mono />
        <KV k="Inputs"   v={`${u.inputs.length} UTxO${u.inputs.length === 1 ? '' : 's'}`} />
      </div>
      <details>
        <summary className="text-xs text-(--muted-foreground) cursor-pointer hover:text-(--foreground)">
          Unsigned tx CBOR · {u.unsignedTxCborHex.length} chars
        </summary>
        <pre className="mt-2 text-[10px] font-mono break-all bg-(--muted) border border-(--border) rounded p-2 max-h-32 overflow-auto">{u.unsignedTxCborHex}</pre>
      </details>
    </div>
  );
}

function FinalResponseView({
  r, signedTx,
}: {
  r: { status: number; body: unknown; paymentResponse: unknown | null };
  signedTx: { cborHex: string; base64: string; txHash: string } | null;
}) {
  const success = r.status === 200;
  return (
    <div className="mt-4 space-y-3">
      <div className="flex items-center gap-3">
        <span className={`px-2 py-0.5 rounded text-xs font-semibold ${
          success ? 'bg-(--healthy)/20 text-(--healthy)' :
                    'bg-(--critical)/20 text-(--critical)'
        }`}>
          HTTP {r.status}
        </span>
        {success && signedTx && (
          <a
            href={`https://preprod.cardanoscan.io/transaction/${signedTx.txHash}`}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-(--accent) hover:underline"
          >
            View on Cardanoscan ↗
          </a>
        )}
      </div>

      {r.paymentResponse !== null && (
        <details open>
          <summary className="text-xs text-(--muted-foreground) cursor-pointer hover:text-(--foreground)">
            X-PAYMENT-RESPONSE (server's settlement receipt)
          </summary>
          <pre className="mt-2 text-xs font-mono bg-(--muted) border border-(--border) rounded p-3 overflow-auto">
{JSON.stringify(r.paymentResponse, null, 2)}
          </pre>
        </details>
      )}

      <details open>
        <summary className="text-xs text-(--muted-foreground) cursor-pointer hover:text-(--foreground)">
          Response body (the gated quote you just paid for)
        </summary>
        <pre className="mt-2 text-xs font-mono bg-(--muted) border border-(--border) rounded p-3 overflow-auto max-h-96">
{typeof r.body === 'string' ? r.body : JSON.stringify(r.body, null, 2)}
        </pre>
      </details>
    </div>
  );
}

function KV({ k, v, mono = false }: { k: string; v: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-(--muted-foreground)">{k}</div>
      <div className={`mt-0.5 text-xs ${mono ? 'font-mono break-all' : ''}`}>{v}</div>
    </div>
  );
}
