'use client';

import { useEffect, useState } from 'react';
import {
  detectWallets, connectWallet, hexAddressToBech32,
  combineTxWithWitness, buildXPaymentHeader,
  type Cip30Api, type WalletInfo,
} from '@/lib/cip30';

interface UnsignedPaymentTx {
  unsignedTxCborHex: string;
  txHashHex:         string;
  requiredSignerHex: string;
  requirements: {
    scheme:            string;
    network:           string;
    maxAmountRequired: string;
    asset:             string;
    assetNameHex:      string;
    decimals:          number;
    payTo:             string;
    resource:          string;
    description:       string;
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

export function DemoFlow() {
  const [wallets, setWallets]         = useState<WalletInfo[]>([]);
  const [api, setApi]                 = useState<Cip30Api | null>(null);
  const [bech32, setBech32]           = useState<string | null>(null);

  const [step1, setStep1] = useState<Step>({ status: 'idle' });
  const [step2, setStep2] = useState<Step>({ status: 'idle' });
  const [step3, setStep3] = useState<Step>({ status: 'idle' });
  const [step4, setStep4] = useState<Step>({ status: 'idle' });

  const [unsigned,    setUnsigned]    = useState<UnsignedPaymentTx | null>(null);
  const [witnessHex,  setWitnessHex]  = useState<string | null>(null);
  const [signedTx,    setSignedTx]    = useState<{ cborHex: string; base64: string; txHash: string } | null>(null);
  const [xPaymentHdr, setXPaymentHdr] = useState<string | null>(null);
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

  async function onBuildTx() {
    if (!bech32) return;
    setStep2({ status: 'busy' });
    try {
      const res = await fetch(`${BASE_URL}/odata/v4/price/buildPaymentTx`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ buyerAddrBech32: bech32, gatedAction: TARGET_ACTION }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 240)}`);
      }
      const j = (await res.json()) as UnsignedPaymentTx;
      setUnsigned(j);
      const usdm = (Number(j.requirements.maxAmountRequired) / 10 ** j.requirements.decimals).toFixed(j.requirements.decimals);
      setStep2({
        status: 'done',
        detail: `Server built unsigned tx · pays ${usdm} mock-USDM · tx ${j.txHashHex.slice(0, 12)}…`,
      });
    } catch (err) {
      setStep2({ status: 'error', error: (err as Error)?.message ?? String(err) });
    }
  }

  async function onSign() {
    if (!api || !unsigned) return;
    setStep3({ status: 'busy' });
    try {
      const witness = await api.signTx(unsigned.unsignedTxCborHex, false);
      setWitnessHex(witness);
      const combined = await combineTxWithWitness(unsigned.unsignedTxCborHex, witness);
      setSignedTx({
        cborHex: combined.signedTxCborHex,
        base64:  combined.signedTxBase64,
        txHash:  combined.txHashHex,
      });
      const hdr = buildXPaymentHeader({
        network: unsigned.requirements.network,
        signedTxBase64: combined.signedTxBase64,
      });
      setXPaymentHdr(hdr);
      setStep3({
        status: 'done',
        detail: `Wallet signed · X-PAYMENT envelope ${hdr.length} chars · tx ${combined.txHashHex.slice(0, 12)}…`,
      });
    } catch (err) {
      setStep3({ status: 'error', error: (err as Error)?.message ?? String(err) });
    }
  }

  async function onSubmit() {
    if (!xPaymentHdr) return;
    setStep4({ status: 'busy' });
    try {
      const res = await fetch(`${BASE_URL}/odata/v4/price/${TARGET_ACTION}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-PAYMENT': xPaymentHdr,
        },
        body: JSON.stringify({ pair: TARGET_PAIR }),
      });
      const text = await res.text();
      let body: unknown;
      try { body = JSON.parse(text); } catch { body = text; }
      const xpr = res.headers.get('x-payment-response');
      let paymentResponse: unknown | null = null;
      if (xpr) {
        try {
          paymentResponse = JSON.parse(atob(xpr));
        } catch { paymentResponse = xpr; }
      }
      setFinalResponse({ status: res.status, body, paymentResponse });
      if (res.status === 200) {
        setStep4({ status: 'done', detail: `Server accepted payment · returned quote (${text.length} bytes)` });
      } else {
        setStep4({
          status: 'error',
          error: `Server returned ${res.status}: ${text.slice(0, 240)}`,
        });
      }
    } catch (err) {
      setStep4({ status: 'error', error: (err as Error)?.message ?? String(err) });
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
          onClick={onBuildTx}
          disabled={!bech32 || step2.status === 'busy' || step2.status === 'done'}
          className="px-4 py-2 rounded bg-(--accent) text-white font-semibold text-sm disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90 transition-opacity"
        >
          {step2.status === 'busy' ? 'Building…' : 'Build unsigned tx'}
        </button>
        {unsigned && <UnsignedTxView u={unsigned} />}
      </StepCard>

      <StepCard
        n={3}
        title="Sign in wallet"
        status={step3.status}
        detail={step3.detail}
        error={step3.error}
      >
        <button
          onClick={onSign}
          disabled={!unsigned || step3.status === 'busy' || step3.status === 'done'}
          className="px-4 py-2 rounded bg-(--accent) text-white font-semibold text-sm disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90 transition-opacity"
        >
          {step3.status === 'busy' ? 'Awaiting wallet…' : 'Sign with wallet'}
        </button>
        {witnessHex && (
          <details className="mt-3">
            <summary className="text-xs text-(--muted-foreground) cursor-pointer hover:text-(--foreground)">
              Witness set CBOR (from wallet) · {witnessHex.length} chars
            </summary>
            <pre className="mt-2 text-[10px] font-mono break-all bg-(--muted) border border-(--border) rounded p-2 max-h-32 overflow-auto">{witnessHex}</pre>
          </details>
        )}
        {xPaymentHdr && (
          <details className="mt-2">
            <summary className="text-xs text-(--muted-foreground) cursor-pointer hover:text-(--foreground)">
              X-PAYMENT header value · {xPaymentHdr.length} chars
            </summary>
            <pre className="mt-2 text-[10px] font-mono break-all bg-(--muted) border border-(--border) rounded p-2 max-h-32 overflow-auto">{xPaymentHdr}</pre>
          </details>
        )}
      </StepCard>

      <StepCard
        n={4}
        title="Submit X-PAYMENT and unlock the gated quote"
        status={step4.status}
        detail={step4.detail}
        error={step4.error}
      >
        <button
          onClick={onSubmit}
          disabled={!xPaymentHdr || step4.status === 'busy' || step4.status === 'done'}
          className="px-4 py-2 rounded bg-(--accent) text-white font-semibold text-sm disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90 transition-opacity"
        >
          {step4.status === 'busy' ? 'Submitting…' : `POST /${TARGET_ACTION}`}
        </button>
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
  const usdm = (Number(u.requirements.maxAmountRequired) / 10 ** u.requirements.decimals).toFixed(u.requirements.decimals);
  return (
    <div className="mt-4 space-y-2">
      <div className="grid grid-cols-2 gap-2 text-xs">
        <KV k="Amount"   v={`${usdm} USDM (${u.requirements.maxAmountRequired} raw)`} />
        <KV k="Network"  v={u.requirements.network} />
        <KV k="Pay to"   v={u.requirements.payTo} mono />
        <KV k="Asset"    v={`${u.requirements.asset.slice(0, 12)}… · ${u.requirements.assetNameHex}`} mono />
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
