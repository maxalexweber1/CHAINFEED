export const metadata = { title: 'CHAINFEED · API · x402 micropayments' };

export default function DevelopersPage() {
  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-3xl font-bold tracking-tight">API · x402 micropayments</h1>
        <p className="mt-3 text-(--muted-foreground) max-w-2xl">
          0.01 USDM per call. No API keys. No accounts. No signup. Your buyer
          settles a small Cardano transaction in mock-USDM (preprod) or USDM
          (mainnet), the response ships with the on-chain payment hash, and
          replay is blocked at two layers.
        </p>
      </header>

      <section>
        <h2 className="font-semibold mb-3">Endpoint catalog</h2>
        <div className="border border-(--border) rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-(--muted)">
              <tr className="text-left text-(--muted-foreground)">
                <th className="px-4 py-3 font-medium">Endpoint</th>
                <th className="px-4 py-3 font-medium">Price</th>
                <th className="px-4 py-3 font-medium">What it returns</th>
              </tr>
            </thead>
            <tbody>
              {[
                { e: 'POST /getStableHealth', p: 'free',       r: 'Composite per-stable: price + reserves + supply + liquidity-depth + risk-score + alerts' },
                { e: 'POST /getStableConvergence', p: 'free',  r: 'NxN cross-rate matrix across all stables, outliers, convergence score' },
                { e: 'POST /getOhlcv',        p: 'free',       r: '1m / 5m / 15m / 1h / 4h / 1d candles from oracle history' },
                { e: 'POST /getFluidtokensHealth', p: 'free',  r: 'FluidTokens v3 lending: per-asset rollup, liquidatable count, accrued interest' },
                { e: 'POST /getLiqwidHealth', p: 'free',       r: 'Liqwid v2 stable markets (DJED, iUSD, USDM): supply, borrow, utilization, APY' },
                { e: 'POST /getServiceStatus',p: 'free',       r: 'Per-adapter cache snapshot for ops dashboards' },
                { e: 'POST /getBestPrice',    p: '0.01 USDM',  r: 'Multi-source aggregated quote + pegDeviationBps + audit tx hashes' },
                { e: 'POST /getTWAP',         p: '0.02 USDM',  r: 'Time-weighted average price over a window' },
                { e: 'POST /getArbitrageOpportunities', p: '0.05 USDM', r: 'Best-buy / best-sell DEX, spread%, profitable flag' },
                { e: 'POST /getAuditPack',    p: '0.05 USDM',  r: 'Self-contained JSON envelope, per-file sha256, on-chain tx hashes' },
                { e: 'POST /subscribePegAlert', p: 'curve (0.74 USDM/24h@5%)', r: 'Threshold-cross webhook subscription, HMAC-signed POSTs' },
              ].map((row) => (
                <tr key={row.e} className="border-t border-(--border)">
                  <td className="px-4 py-3 font-mono text-xs">{row.e}</td>
                  <td className="px-4 py-3"><span className={row.p === 'free' ? 'text-(--healthy)' : 'text-(--accent)'}>{row.p}</span></td>
                  <td className="px-4 py-3 text-(--muted-foreground)">{row.r}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="border border-(--border) rounded-lg p-5">
          <h3 className="font-semibold mb-3">Free read · curl</h3>
          <pre className="text-xs bg-(--muted) border border-(--border) rounded p-3 overflow-x-auto"><code>{`curl -sL -X POST http://localhost:4004/odata/v4/price/getStableHealth \\
  -H 'Content-Type: application/json' \\
  -d '{"symbol":"USDM"}'`}</code></pre>
        </div>

        <div className="border border-(--border) rounded-lg p-5">
          <h3 className="font-semibold mb-3">Paid read · buyer flow</h3>
          <pre className="text-xs bg-(--muted) border border-(--border) rounded p-3 overflow-x-auto"><code>{`# 1. First call → 402 with payment requirements
curl -sL -X POST $URL/getBestPrice \\
  -H 'Content-Type: application/json' \\
  -d '{"pair":"ADA-USDM"}'
# → { "asset": "<USDM-policy>.<nameHex>",
#     "amount": "10000",
#     "payTo": "addr_test1q…",
#     "network": "cardano:preprod" }

# 2. Buyer builds + signs a Cardano tx (with a TTL + a
#    UTxO-ref nonce), base64-wraps it, re-sends with the
#    PAYMENT-SIGNATURE header. Response carries
#    X-PAYMENT-RESPONSE with the on-chain tx hash.`}</code></pre>
        </div>
      </section>

      <section className="border border-(--border) rounded-lg p-5">
        <h3 className="font-semibold mb-2">x402 wire compatibility</h3>
        <p className="text-sm text-(--muted-foreground)">
          CHAINFEED gates paid reads with{' '}
          <a href="https://www.npmjs.com/package/@odatano/x402"
             className="text-(--accent) hover:underline" target="_blank" rel="noreferrer">@odatano/x402</a>
          {' '}— the Cardano-x402-v2 payment library — running in-process. No
          external facilitator. The 402 body is the canonical v2 shape
          (<code>x402Version: 2</code>, <code>accepts[]</code>, colon-form
          network, single <code>&lt;policy&gt;.&lt;nameHex&gt;</code> asset
          string). Replay defence is on-chain: the buyer references a UTxO in{' '}
          <code>payload.nonce</code>, that UTxO is an input of the payment tx,
          and Cardano consumes it on settlement — no server-side nonce table.
        </p>
      </section>
    </div>
  );
}
