/**
 * FluidTokens Lending V3 — static on-chain configuration (mainnet).
 *
 * Reverse-engineered 2026-05-05 from the live ConfigDatum at
 * `addr1wysesvs49vky3y6c7nqz5xqc6vf2s5d374thft5grce6jpcwela6v` (config-NFT
 * `(21983215..., "parameters")`). Anchor tx that locked it down is the
 * 2026-04-17 borrow `db1e928ae25ea4bf05a8eb15db82a0cb803907fdc0de8320a63f2a8e649e1c61`
 * (one of the first live FluidTokens v3 user transactions). Source code +
 * audit are open: https://github.com/FluidTokens/ft-cardano-loans-v3,
 * https://fluidtokens.com/audits/FluidTokens_Lending_V3_Vacuum_Labs.pdf.
 *
 * The deployed Aiken validators are parameterized — every script-hash here
 * is the Live (post-`apply_parameters`) credential, NOT the un-parameterized
 * blueprint hash from `plutus.json`. Treat as black-box constants — only
 * the FluidTokens deployer can mint a new ConfigDatum.
 *
 * No preview/preprod entries — V3 is mainnet-only as of 2026-05-05. If a
 * test deployment ships, add it under `preview` / `preprod` keys following
 * the same shape (charli3-style network-override resolution).
 */

export type FluidNetwork = 'mainnet';

interface FluidNetworkConfig {
  /** Single config-NFT identifying the protocol deploy. UTxO holding it
   *  contains the inline ConfigDatum (≥ 16 fields of script-hashes / policies). */
  configNft: { policyId: string; assetNameHex: string };
  /** Pool spend-validator script-hash. Holds every active lender pool. */
  poolSpendHash: string;
  /** Loan spend-validator script-hash. Holds every active loan UTxO. */
  loanSpendHash: string;
  /** Request spend-validator (intent stage before fill). */
  requestSpendHash: string;
  /** Repayment spend-validator. */
  repaymentSpendHash: string;
  /** Pool-NFT minting policy — one NFT minted per pool create. */
  poolPolicy: string;
  /** Loan-NFT minting policy — one NFT minted per loan claim. */
  loanPolicy: string;
  /** Request-NFT minting policy. */
  requestPolicy: string;
  /** Repayment-receipt minting policy. */
  repaymentPolicy: string;
  /** Lender bond-NFT policy — position token held by the lender. */
  lenderBondPolicy: string;
  /** Borrower bond-NFT policy — position token held by the borrower. */
  borrowerBondPolicy: string;
  /** Smart-tokens spend script. CIP-113 programmable-token integration. */
  smartTokensSpendHash: string;
  /** Bech32 address of the live config UTxO (payment-cred = config script-hash). */
  configAddrBech32: string;
  /** Bech32 address of the live pool UTxOs (payment-cred = poolSpendHash). */
  poolAddrBech32: string;
}

export const FLUIDTOKENS_CONFIG: Readonly<Record<FluidNetwork, FluidNetworkConfig>> = Object.freeze({
  mainnet: {
    configNft: {
      policyId:     '219832152b2c489358f4c02a1818d312a851b1f55774ae881e33a907',
      assetNameHex: '706172616d6574657273',
    },
    poolSpendHash:        'ad353a777c817f4d9d6c4324930f5c6128400517ec9dae0461e034cd',
    loanSpendHash:        '5abbaa2eb177b574707fa3617e3436295d45d7795e0874623a9504da',
    requestSpendHash:     'dc9003272dbd7fc5d19ce4f0eb3a92bec2c4ffcbd58c8ce4493888bc',
    repaymentSpendHash:   'e20678c018fe01a9b0d116a5a1bfa57e2efe8520645ca303d2c26a0e',
    poolPolicy:           'befbcb19919ff8ce5323d123c835da8e7653a098ad482271a72b72f2',
    loanPolicy:           '30f1095a8a2acb68bb0ffa193e18e004b6dd3e12b5d9c2375a1d5c41',
    requestPolicy:        'a37578f027ae878115cc70cd0909ddc855d67b6dd3bd038a757bd221',
    repaymentPolicy:      '1fb02a2a8f89d1484141e57bd370587773b3dbd69d45fec93a6b2a94',
    lenderBondPolicy:     'bcd713bb7858d4b08738bed90ee7068d8f9b38d02e0cae0b45ac7a9b',
    borrowerBondPolicy:   'eadc69a5d2d1357acc9b9d49ec5390fcdf6e080c7a40139917223dcb',
    smartTokensSpendHash: 'fca77bcce1e5e73c97a0bfa8c90f7cd2faff6fd6ed5b6fec1c04eefa',
    configAddrBech32:     'addr1wysesvs49vky3y6c7nqz5xqc6vf2s5d374thft5grce6jpcwela6v',
    poolAddrBech32:       'addr1wxk8m9gswzuwf9w0xkus5qa7m4lgq0sryxrtlktsp225m4qesdhsr',
  },
} as const satisfies Readonly<Record<FluidNetwork, FluidNetworkConfig>>);

/**
 * Resolve the active FluidTokens network. Charli3-style override:
 *   FLUIDTOKENS_NETWORK > NETWORK > 'mainnet' (the only deployed network).
 * Throws on any value other than 'mainnet' so a stray `NETWORK=preview`
 * env doesn't silently produce empty results.
 */
export function resolveFluidNetwork(): FluidNetwork {
  const raw = (process.env.FLUIDTOKENS_NETWORK || process.env.NETWORK || 'mainnet').toLowerCase();
  if (raw !== 'mainnet') {
    throw new Error(
      `fluidtokens: unsupported network '${raw}' (only 'mainnet' is deployed; ` +
      `set FLUIDTOKENS_NETWORK=mainnet to override a global NETWORK=${raw})`,
    );
  }
  return 'mainnet';
}

/** Convenience accessor — `cfg('mainnet')` returns the typed network record. */
export function cfg(network: FluidNetwork = resolveFluidNetwork()): FluidNetworkConfig {
  const c = FLUIDTOKENS_CONFIG[network];
  if (!c) throw new Error(`fluidtokens: missing config for network '${network}'`);
  return c;
}
