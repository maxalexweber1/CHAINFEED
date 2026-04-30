/**
 * Generate a fresh Cardano wallet (BIP39 mnemonic + CIP-1852 derivation)
 * and write it to .env.local. Used for the CHAINFEED dev receiver wallet
 * (preprod). Run once; persist the mnemonic securely.
 *
 * Output:
 *   - prints the bech32 base addresses (preprod + mainnet) to stdout
 *   - writes a `# CHAINFEED dev wallet` block to .env.local (or stdout if
 *     the file already contains an X402_PAY_TO line — bail rather than
 *     overwrite an existing wallet)
 *
 * Usage:
 *   npx tsx scripts/gen-wallet.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as bip39 from 'bip39';
import * as CSL from '@emurgo/cardano-serialization-lib-nodejs';

const ENV_LOCAL = path.join(__dirname, '..', '.env.local');

function harden(n: number): number { return n | 0x80000000; }

interface KeyPair {
  payment: CSL.Bip32PrivateKey;
  stake: CSL.Bip32PrivateKey;
}

function deriveKeys(rootKey: CSL.Bip32PrivateKey): KeyPair {
  const account = rootKey
    .derive(harden(1852))   // CIP-1852 purpose
    .derive(harden(1815))   // Cardano coin type
    .derive(harden(0));     // account 0
  const payment = account.derive(0).derive(0);   // role 0 = external payment
  const stake   = account.derive(2).derive(0);   // role 2 = staking
  return { payment, stake };
}

function baseAddress(networkId: number, payment: CSL.Bip32PrivateKey, stake: CSL.Bip32PrivateKey): string {
  const paymentHash = payment.to_public().to_raw_key().hash();
  const stakeHash   = stake.to_public().to_raw_key().hash();
  return CSL.BaseAddress.new(
    networkId,
    CSL.Credential.from_keyhash(paymentHash),
    CSL.Credential.from_keyhash(stakeHash),
  ).to_address().to_bech32();
}

function main(): void {
  // 24-word mnemonic = 256 bits entropy = standard Cardano wallet strength
  const mnemonic = bip39.generateMnemonic(256);
  const entropy  = bip39.mnemonicToEntropy(mnemonic);

  const rootKey = CSL.Bip32PrivateKey.from_bip39_entropy(
    Buffer.from(entropy, 'hex'),
    Buffer.from(''),
  );

  const { payment, stake } = deriveKeys(rootKey);

  const preprodAddr = baseAddress(0, payment, stake);  // network 0 = testnet
  const mainnetAddr = baseAddress(1, payment, stake);  // network 1 = mainnet

  const block = `\n# CHAINFEED dev wallet — generated ${new Date().toISOString()}\n` +
                `# DO NOT COMMIT. Faucet preprod tADA to X402_PAY_TO_PREPROD before minting mock-USDM.\n` +
                `CHAINFEED_WALLET_MNEMONIC="${mnemonic}"\n` +
                `X402_PAY_TO_PREPROD=${preprodAddr}\n` +
                `X402_PAY_TO_MAINNET=${mainnetAddr}\n` +
                `# Active receiver address (default to preprod for dev)\n` +
                `X402_PAY_TO=${preprodAddr}\n`;

  let existing = '';
  if (fs.existsSync(ENV_LOCAL)) {
    existing = fs.readFileSync(ENV_LOCAL, 'utf8');
    if (/^X402_PAY_TO=/m.test(existing)) {
      console.error('REFUSING to overwrite — .env.local already has X402_PAY_TO set.');
      console.error('Delete the existing wallet block manually if you want a new wallet.');
      process.exit(2);
    }
  }

  fs.writeFileSync(ENV_LOCAL, existing + block, { mode: 0o600 });

  console.log('Wallet generated and written to .env.local (chmod 600).');
  console.log('');
  console.log('Preprod address: ' + preprodAddr);
  console.log('Mainnet address: ' + mainnetAddr);
  console.log('');
  console.log('Next steps:');
  console.log('  1. Faucet preprod tADA to the preprod address above:');
  console.log('     https://docs.cardano.org/cardano-testnets/tools/faucet/');
  console.log('  2. Once funded, run the mock-USDM mint script (next).');
  console.log('  3. The mnemonic is in .env.local. Back it up if you want to keep this wallet.');
}

main();
