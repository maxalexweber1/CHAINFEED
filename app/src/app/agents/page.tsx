export const metadata = { title: 'CHAINFEED · Agentic patterns' };

export default function AgentsPage() {
  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-3xl font-bold tracking-tight">Built for AI agents</h1>
        <p className="mt-3 text-(--muted-foreground) max-w-3xl">
          Autonomous agents need fresh, verifiable, pay-per-call data. CHAINFEED
          ships every response with on-chain provenance, and bills in USDM
          micropayments. Your agent settles a 0.01 USDM tx per call and
          continues. No preallocated budget, no API key rotation, no shared
          team account.
        </p>
      </header>

      <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <PatternCard
          n="01"
          title="Treasury risk agent"
          intent="Rebalance from one stable to another when peg breaks."
          flow={[
            'Subscribe webhook → POST /subscribePegAlert',
            'CHAINFEED fires HMAC-signed POST at threshold-cross',
            'Agent receives event → re-checks via /getStableHealth',
            'If risk.composite < 0.7 → execute swap on-chain',
          ]}
          paid={['/subscribePegAlert', '/getBestPrice (post-event verify)']}
          free={['/getStableHealth']}
        />
        <PatternCard
          n="02"
          title="DeFi allocation bot"
          intent="Block stable allocations into low-confidence venues."
          flow={[
            'Pre-trade: fetch /getStableHealth(target)',
            'Inspect risk.reserveAdequacy + alerts[]',
            'If alerts include "reserves-unsubstantiated" or risk < 0.7, block',
            'Else proceed with trade, attach computedAt + sourcesUsed to log',
          ]}
          paid={[]}
          free={['/getStableHealth', '/getServiceStatus']}
        />
        <PatternCard
          n="03"
          title="Compliance audit agent"
          intent="Archive verifiable price+reserves snapshots nightly."
          flow={[
            'Cron: every UTC 00:05 fetch /Prices for the day',
            'For each quote, /getAuditPack(quoteId) → JSON envelope',
            'Verify per-file sha256 inside the envelope',
            'Re-fetch on-chain tx hashes via Cardano node, compare datums',
            'Archive to immutable storage. Replay-defeated by signedAt + Ed25519 sig.',
          ]}
          paid={['/Prices', '/getAuditPack']}
          free={['/getServiceStatus']}
        />
      </section>

      <section className="border border-(--border) rounded-lg p-5">
        <h2 className="font-semibold">Why x402 fits autonomous agents</h2>
        <ul className="mt-3 space-y-2 text-sm text-(--muted-foreground)">
          <li>
            <strong className="text-(--foreground)">No preallocated budget.</strong>{' '}
            Each call settles its own micropayment. An agent given a wallet can
            run indefinitely without any sysadmin top-up loop.
          </li>
          <li>
            <strong className="text-(--foreground)">No accounts to share.</strong>{' '}
            Multiple agents under one principal pay independently. No "team API
            key" with rotation drama.
          </li>
          <li>
            <strong className="text-(--foreground)">Verifiable cost trail.</strong>{' '}
            Every paid call has an on-chain tx hash in the response. Audit logs
            cost-attribute per call without trusting any centralized billing.
          </li>
          <li>
            <strong className="text-(--foreground)">Verifiable answer trail.</strong>{' '}
            Every paid response can ship an Ed25519-signed canonical-JSON
            envelope plus a downloadable audit pack. Downstream systems can
            forward the answer without losing trust.
          </li>
        </ul>
      </section>

      <section className="border border-(--border) rounded-lg p-5">
        <h2 className="font-semibold mb-3">Tool-use snippet (Anthropic SDK)</h2>
        <pre className="text-xs bg-(--muted) border border-(--border) rounded p-3 overflow-x-auto"><code>{`// Define CHAINFEED as a tool the model can call:
const tools = [{
  name: 'getStableHealth',
  description: 'Live health snapshot for a Cardano stablecoin: price, peg deviation, reserve coverage, risk score.',
  input_schema: {
    type: 'object',
    properties: { symbol: { type: 'string', enum: ['USDM','DJED','iUSD','USDA','USDCx'] } },
    required: ['symbol'],
  },
}];

// Tool implementation: free read, no x402 needed
async function getStableHealth({ symbol }) {
  const r = await fetch('https://chainfeed/odata/v4/price/getStableHealth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol }),
  });
  return r.json();
}`}</code></pre>
      </section>
    </div>
  );
}

interface PatternCardProps {
  n: string;
  title: string;
  intent: string;
  flow: string[];
  paid: string[];
  free: string[];
}

function PatternCard({ n, title, intent, flow, paid, free }: PatternCardProps) {
  return (
    <div className="border border-(--border) rounded-lg p-5 flex flex-col">
      <div className="flex items-baseline gap-2">
        <span className="text-xs text-(--muted-foreground) tabular-nums">{n}</span>
        <h3 className="font-semibold">{title}</h3>
      </div>
      <p className="mt-2 text-sm text-(--muted-foreground)">{intent}</p>
      <ol className="mt-4 space-y-1.5 text-sm flex-1">
        {flow.map((step, i) => (
          <li key={i} className="flex gap-2">
            <span className="text-(--muted-foreground) tabular-nums">{i + 1}.</span>
            <span>{step}</span>
          </li>
        ))}
      </ol>
      <div className="mt-4 pt-3 border-t border-(--border) text-xs space-y-1">
        {paid.length > 0 && (
          <div>
            <span className="text-(--muted-foreground)">Paid: </span>
            <span className="text-(--accent)">{paid.join(', ')}</span>
          </div>
        )}
        {free.length > 0 && (
          <div>
            <span className="text-(--muted-foreground)">Free: </span>
            <span className="text-(--healthy)">{free.join(', ')}</span>
          </div>
        )}
      </div>
    </div>
  );
}
