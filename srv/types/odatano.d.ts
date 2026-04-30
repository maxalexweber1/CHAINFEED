// Minimal ambient declaration for @odatano/core. The package ships JS only;
// we type only what `srv/external/odatano-bridge.ts` actually consumes.
declare module '@odatano/core' {
  export function initialize(): Promise<unknown>;
  export function shutdown(): Promise<unknown>;
  export function getCardanoClient(): {
    getAddressUtxos(address: string): Promise<unknown[]>;
    getTransaction(txHash: string): Promise<unknown>;
    getProtocolParameters(): Promise<unknown>;
    submitTransaction(cborHex: string): Promise<string>;
  };
  export function getStatus(): unknown;
}
