/**
 * Live smoke for the Circle USDC attestation adapter.
 *
 * Hits the real circle.com/transparency page + the latest PDF. Verifies:
 *   - URL discovery picks a recent month (≥ January of the current year)
 *   - PDF passes the magic-bytes check
 *   - sha256 is a 64-char hex digest
 *   - timestamp parses to a sensible recent month
 *
 * Run: npx tsx scripts/smoke-circle-attestation.ts
 */

const adapter = require('../srv/adapters/circle-usdc-attestation');

async function main() {
  console.log('Circle USDC attestation live smoke');
  console.log('────────────────────────────────────────────────────');

  const t0 = Date.now();
  let q;
  try {
    q = await adapter.getPrice('USDCx-ATTESTATION');
  } catch (e) {
    console.error('FAIL: getPrice threw:', (e as Error)?.message ?? e);
    process.exit(1);
  }
  const elapsedMs = Date.now() - t0;

  const raw = q.rawPayload as {
    attestationUrl: string;
    sha256: string;
    contentLengthBytes: number;
    attestationDateIso: string | null;
    auditor: string;
    scope: string;
  };

  console.log(`  kind:           ${q.kind}`);
  console.log(`  unit:           ${q.unit}`);
  console.log(`  value:          ${q.value}`);
  console.log(`  url:            ${raw.attestationUrl}`);
  console.log(`  sha256:         ${raw.sha256}`);
  console.log(`  pdf size:       ${raw.contentLengthBytes.toLocaleString()} bytes`);
  console.log(`  attestation:    ${raw.attestationDateIso}`);
  console.log(`  auditor:        ${raw.auditor}`);
  console.log(`  scope:          ${raw.scope}`);
  console.log(`  fetched:        ${new Date(q.timestamp).toISOString()}`);
  console.log(`  elapsed:        ${elapsedMs} ms`);

  // Sanity bounds.
  if (!/^[0-9a-f]{64}$/.test(raw.sha256)) {
    console.error(`FAIL: sha256 ${raw.sha256} is not 64 hex chars`);
    process.exit(1);
  }
  if (raw.contentLengthBytes < 50_000 || raw.contentLengthBytes > 5_000_000) {
    console.error(`FAIL: PDF size ${raw.contentLengthBytes} outside expected 50KB-5MB band`);
    process.exit(1);
  }
  if (raw.attestationDateIso === null) {
    console.error('FAIL: attestation date could not be parsed from URL');
    process.exit(1);
  }
  // Attestation should be within the last 90 days for "fresh" (Circle is monthly).
  const ageDays = (Date.now() - new Date(raw.attestationDateIso).getTime()) / (24 * 60 * 60 * 1000);
  console.log(`  age:            ${ageDays.toFixed(1)} days`);
  if (ageDays > 90) {
    console.error(`FAIL: attestation is ${ageDays.toFixed(0)} days old — expected ≤ 90 (Circle publishes monthly)`);
    process.exit(1);
  }

  console.log('PASS');
  process.exit(0);
}

main().catch(err => { console.error('runner crash:', err?.stack ?? err); process.exit(2); });
