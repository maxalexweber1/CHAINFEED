import Link from 'next/link';
import { DemoFlow } from './demo-flow';

export const metadata = { title: 'CHAINFEED · Live x402 demo' };

export default function DemoPage() {
  return (
    <div className="space-y-8">
      <header>
        <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-(--accent)">
          <span className="inline-block w-2 h-2 rounded-full bg-(--accent)" />
          Live · preprod · settles a real Cardano tx
        </div>
        <h1 className="mt-3 text-3xl font-bold tracking-tight">x402 in your browser</h1>
        <p className="mt-3 text-(--muted-foreground) max-w-3xl">
          Connect a CIP-30 Cardano wallet (Lace, Eternl, Nami, …), pay 0.01
          mock-USDM on preprod, and unlock a verifiable multi-source ADA-USDM
          quote, all in your browser. Every wire payload (the 402 body, the
          unsigned tx, the X-PAYMENT envelope, the on-chain tx hash) is
          exposed below so you can inspect what flows over the network.
        </p>
        <p className="mt-3 text-sm text-(--muted-foreground)">
          Don&apos;t have a CIP-30 wallet?{' '}
          <a href="https://www.lace.io" target="_blank" rel="noreferrer" className="text-(--accent) hover:underline">
            Lace
          </a>{' '}
          installs in 30 seconds. Switch to <strong>preprod</strong> in
          settings, fund the wallet from the{' '}
          <a href="https://docs.cardano.org/cardano-testnets/tools/faucet/" target="_blank" rel="noreferrer" className="text-(--accent) hover:underline">
            preprod faucet
          </a>
          , then come back. You also need mock-USDM to pay (see{' '}
          <Link href="/developers" className="text-(--accent) hover:underline">
            the API docs
          </Link>{' '}
          for how that works).
        </p>
      </header>

      <DemoFlow />
    </div>
  );
}
