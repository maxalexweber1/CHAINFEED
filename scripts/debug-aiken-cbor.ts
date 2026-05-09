import { createPublicKey, verify as verifyEd25519 } from 'node:crypto';
import {
  canonicalQuoteBytes, signQuote, publicKeyHexFromPrivate,
} from '../srv/lib/aiken-quote-encoder';

const cfPriv = process.env.CHAINFEED_SIGNING_PRIVATE_KEY_HEX!;
const cfPub = publicKeyHexFromPrivate(cfPriv);

// Reproduce the EXACT quote that failed on-chain
const quote = {
  pair: 'ADA-USD',
  priceMilliUnits: 500_000n,
  validUntilMs:    1_779_124_871_275n,
  signedAtMs:      1_779_124_511_403n,
};

console.log('Quote input:', JSON.stringify({...quote, priceMilliUnits: quote.priceMilliUnits.toString(), validUntilMs: quote.validUntilMs.toString(), signedAtMs: quote.signedAtMs.toString()}));
const bytes = canonicalQuoteBytes(quote);
console.log('TS bytes:    ', bytes.toString('hex'));
console.log('TS bytes len:', bytes.length);

// Re-sign + check we can verify what we signed
const fresh = signQuote(quote, cfPriv);
console.log('Fresh sig:   ', fresh.signatureHex);

const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
const pubKey = createPublicKey({ key: Buffer.concat([spkiPrefix, Buffer.from(cfPub, 'hex')]), format: 'der', type: 'spki' });

// 1. Does our fresh sig verify against the bytes we just signed? (sanity)
console.log('Fresh ok:    ', verifyEd25519(null, bytes, pubKey, Buffer.from(fresh.signatureHex, 'hex')));

// 2. Does the FAILED spend's signature verify against the same bytes?
const failedSig = 'bae60aa2e689965f45ba00db812e9321452cf4ea73d263d7cba35fdbd1f2df554fb6903dd915375a3257e0d2403cb54d69476e671872adbf035b704e38e2a501';
console.log('Failed ok:   ', verifyEd25519(null, bytes, pubKey, Buffer.from(failedSig, 'hex')));
