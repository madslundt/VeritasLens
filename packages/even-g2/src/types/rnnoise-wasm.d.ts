declare module '@jitsi/rnnoise-wasm/dist/rnnoise.js' {
  export default function createModule(options: { wasmBinary: Uint8Array }): Promise<import('@/runtime/noiseReductionEngine').RnnoiseModule>;
}
