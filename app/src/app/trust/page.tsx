export const metadata = { title: 'CHAINFEED · Trust & verification' };

export default function TrustPage() {
  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-3xl font-bold tracking-tight">Trust by construction</h1>
        <p className="mt-3 text-(--muted-foreground) max-w-3xl">
          A consumer who distrusts CHAINFEED can re-verify every quote
          end-to-end. Each price ships with on-chain tx hashes; each audit pack
          ships with per-file sha256 checksums; each signed response carries an
          Ed25519 signature over canonical JSON.
        </p>
      </header>

      <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Layer
          n="1"
          title="On-chain provenance"
          body={[
            'Every price quote attaches the tx hashes of the source UTxOs.',
            'For oracles (Charli3, Orcfax): the feed-update tx that produced the datum we decoded.',
            'For DEX pools: the latest pool-state tx whose reserves we read.',
            'Re-fetch any tx via a Cardano node and confirm we read the same datum bytes.',
          ]}
        />
        <Layer
          n="2"
          title="Audit-pack envelopes"
          body={[
            'getAuditPack returns a JSON envelope with all source observations + per-file sha256.',
            'Includes a README with the consumer-side verification recipe.',
            'No CHAINFEED-specific tooling needed: sha256 + a Cardano indexer is enough.',
            'Tamper-detection: changing any file in the pack invalidates the checksum manifest.',
          ]}
        />
        <Layer
          n="3"
          title="Ed25519 response signing (optional)"
          body={[
            'When CHAINFEED_SIGNING_PRIVATE_KEY_HEX is configured, every response can ship a sig envelope.',
            'Canonical JSON sorting keys recursively → deterministic signing bytes.',
            'KeyId prefix in envelope, replay defense via signedAt timestamp inside signed bytes.',
            'Native node:crypto Ed25519: same scheme Cardano stake-keys use.',
          ]}
        />
        <Layer
          n="4"
          title="Reserve attestation"
          body={[
            'For every Cardano-native stable, CHAINFEED surfaces the reserves source distinctly.',
            'On-chain attestation (USDM via Charli3 ODV): datum decoded from the publisher\'s feed UTxO.',
            'On-chain collateral aggregate (DJED, Indigo CDPs): sum of ADA at the protocol\'s reserve / CDP-manager script.',
            'Off-chain hash-sealed PDF (USDCx via Circle\'s Deloitte report): sha256 over the bytes, URL pinned.',
          ]}
        />
      </section>

      <section className="border border-(--border) rounded-lg p-5">
        <h2 className="font-semibold mb-3">Audit-pack verification recipe</h2>
        <pre className="text-xs bg-(--muted) border border-(--border) rounded p-3 overflow-x-auto"><code>{`# 1. Pull the audit pack (paid: 0.05 USDM)
curl -X POST $URL/getAuditPack -H 'Content-Type: application/json' \\
  -d '{"quoteId":"<id>"}' > pack.json

# 2. For each file in pack.envelope.files, hash and compare against
#    pack.envelope.checksum.files[name]:
node -e "
const p = require('./pack.json');
const crypto = require('crypto');
for (const [name, body] of Object.entries(p.envelope.files)) {
  const want = p.envelope.checksum.files[name];
  const have = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
  console.log(name, want === have ? 'OK' : 'MISMATCH');
}"

# 3. For each on-chain tx hash in the pack, query a Cardano node and
#    verify the datum bytes match what CHAINFEED decoded.`}</code></pre>
      </section>
    </div>
  );
}

function Layer({ n, title, body }: { n: string; title: string; body: string[] }) {
  return (
    <div className="border border-(--border) rounded-lg p-5">
      <div className="flex items-baseline gap-2">
        <span className="text-xs text-(--muted-foreground) tabular-nums">{n}</span>
        <h3 className="font-semibold">{title}</h3>
      </div>
      <ul className="mt-3 space-y-1.5 text-sm text-(--muted-foreground)">
        {body.map((line, i) => (
          <li key={i} className="flex gap-2"><span>·</span><span>{line}</span></li>
        ))}
      </ul>
    </div>
  );
}
