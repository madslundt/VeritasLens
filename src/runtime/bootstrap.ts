export function attachBootstrapTeardown(
  signal: AbortController,
  ...disposeFns: Array<() => void>
): () => void {
  return () => {
    signal.abort();
    for (const dispose of disposeFns) {
      try { dispose(); } catch { /* SDK may already be torn down */ }
    }
  };
}
