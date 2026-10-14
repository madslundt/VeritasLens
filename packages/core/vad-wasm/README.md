# Earshot candidate detector

The app uses this small WASM build of Earshot 1.2.2 to propose speech regions.
Silero v6 then confirms those regions before the gate accepts them. Earshot
alone never authorizes an upload. The compiled asset is committed so normal
`npm install`, tests, and builds need no Rust toolchain.

Build with a standard Rust toolchain (1.87+), with the WASM target installed:

```sh
rustup target add wasm32-unknown-unknown
RUSTFLAGS='-C target-feature=+simd128' cargo build --locked --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/veritaslens_vad.wasm ../assets/vad/earshot-1.2.2.wasm
```

The exports are `memory`, `input_ptr`, `predict`, and `reset`. `predict` consumes
1–64 consecutive 256-sample frames at 16 kHz from the input buffer and returns
the pointer to that many probabilities. Inputs are mono f32 in [-1, 1]. Each
WASM instance owns one detector; callers must reset between audio snapshots
and serialize scans on a shared instance. The build uses SIMD but no threads,
workers, shared memory, or host imports.

Earshot is MIT/Apache-2.0 licensed. Its MIT license, and the Rust/libm notices,
are bundled under `../assets/vad/`.
The dependency and transitive `libm` version are pinned in Cargo.lock. The
first committed binary was built with Rust 1.97.1.
