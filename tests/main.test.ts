import { describe, expect, it, vi } from 'vitest';
import { attachBootstrapTeardown } from '../src/runtime/bootstrap';

describe('attachBootstrapTeardown', () => {
  it('aborts the bootstrap controller and disposes all subscriptions once', () => {
    const controller = new AbortController();
    const disposeLaunch = vi.fn();
    const disposeDevice = vi.fn();

    const teardown = attachBootstrapTeardown(controller, disposeLaunch, disposeDevice);
    teardown();

    expect(controller.signal.aborted).toBe(true);
    expect(disposeLaunch).toHaveBeenCalledTimes(1);
    expect(disposeDevice).toHaveBeenCalledTimes(1);
  });

  it('continues disposing even if one disposer throws', () => {
    const controller = new AbortController();
    const boom = vi.fn(() => { throw new Error('boom'); });
    const other = vi.fn();

    const teardown = attachBootstrapTeardown(controller, boom, other);
    expect(() => teardown()).not.toThrow();

    expect(controller.signal.aborted).toBe(true);
    expect(boom).toHaveBeenCalledTimes(1);
    expect(other).toHaveBeenCalledTimes(1);
  });
});
