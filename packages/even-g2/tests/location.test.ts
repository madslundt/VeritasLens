// tests/location.test.ts
//
// Covers the location pipeline: probe fallback ordering, store round-trip for
// `locationEnabled` / `cachedLocation`, and the coerce path that tolerates a
// corrupt KV blob without wedging boot. The bridge is mocked the same way
// other runtime tests mock it; navigator.geolocation is stubbed per case.

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

function fakeLocalStorage(): {
  get: (k: string) => Promise<string>;
  set: (k: string, v: string) => Promise<boolean>;
  data: Map<string, string>;
} {
  const data = new Map<string, string>();
  return {
    data,
    get: async (k) => data.get(k) ?? '',
    set: async (k, v) => { data.set(k, v); return true; },
  };
}

// The bridge module is mocked because @/runtime/bridge calls into the SDK at
// import time. We hold a mutable handle so each test can swap behaviours
// without rewiring the module mock.
const fakeBridge: {
  callEvenApp: ReturnType<typeof vi.fn>;
  getUserInfo: ReturnType<typeof vi.fn>;
} = {
  callEvenApp: vi.fn(),
  getUserInfo: vi.fn(),
};

vi.mock('@/runtime/bridge', () => ({
  getBridge: () => fakeBridge,
}));

// Pull in store + probe AFTER the mock is in place. These must be `await
// import()` rather than top-level imports so the mock is registered first.
async function importLocationModule() {
  const mod = await import('../src/runtime/location');
  const store = await import('../src/state/store');
  return { mod, store };
}

// BigDataCloud reverse-geocode is mocked through `globalThis.fetch`. Each
// test sets the desired response via `setReverseGeocodeResponse` so we never
// hit the network from a test run.
const fetchMock = vi.fn();
function setReverseGeocodeResponse(body: unknown, ok = true): void {
  fetchMock.mockResolvedValueOnce({
    ok,
    json: async () => body,
  } as Response);
}

beforeEach(() => {
  fakeBridge.callEvenApp.mockReset();
  fakeBridge.getUserInfo.mockReset();
  fetchMock.mockReset();
  // navigator.geolocation default: not present.
  Object.defineProperty(globalThis, 'navigator', {
    value: {},
    configurable: true,
  });
  Object.defineProperty(globalThis, 'fetch', {
    value: fetchMock,
    configurable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function stubNavigator(impl: (success: PositionCallback, error?: PositionErrorCallback) => void) {
  Object.defineProperty(globalThis, 'navigator', {
    value: { geolocation: { getCurrentPosition: impl } },
    configurable: true,
  });
}

describe('probeLocation', () => {
  it('resolves from navigator.geolocation when available', async () => {
    stubNavigator((success) => {
      success({
        coords: {
          latitude: 55.6761,
          longitude: 12.5683,
          accuracy: 12,
          altitude: null,
          altitudeAccuracy: null,
          heading: null,
          speed: null,
        },
        timestamp: 0,
      } as unknown as GeolocationPosition);
    });
    const { mod } = await importLocationModule();
    const probe = await mod.probeLocation();
    expect(probe).toEqual({
      kind: 'coords',
      latitude: 55.6761,
      longitude: 12.5683,
      accuracy: 12,
      source: 'navigator',
    });
    // callEvenApp must never be hit when navigator wins — saves a host round-trip.
    expect(fakeBridge.callEvenApp).not.toHaveBeenCalled();
  });

  it('falls back to callEvenApp("getLocation") when navigator errors', async () => {
    stubNavigator((_success, error) => {
      error?.({ code: 1, message: 'denied' } as unknown as GeolocationPositionError);
    });
    fakeBridge.callEvenApp.mockResolvedValueOnce({ latitude: 1.23, longitude: 4.56 });
    const { mod } = await importLocationModule();
    const probe = await mod.probeLocation();
    expect(probe).toEqual({
      kind: 'coords',
      latitude: 1.23,
      longitude: 4.56,
      source: 'callEvenApp',
    });
    expect(fakeBridge.callEvenApp).toHaveBeenCalledWith('getLocation');
  });

  it('never falls back to profile country even when getUserInfo returns one', async () => {
    // navigator absent (default in beforeEach)
    fakeBridge.callEvenApp.mockRejectedValueOnce(new Error('unknown method'));
    // getUserInfo must NOT be called — we removed the profile-country fallback
    // because account country can differ from current country (traveller case).
    fakeBridge.getUserInfo.mockResolvedValue({ uid: 1, name: 'A', avatar: '', country: 'DK' });
    const { mod } = await importLocationModule();
    const probe = await mod.probeLocation();
    expect(probe.kind).toBe('unavailable');
    expect(fakeBridge.getUserInfo).not.toHaveBeenCalled();
  });

  it('drops a navigator fix whose accuracy is worse than the cliff', async () => {
    stubNavigator((success) => {
      success({
        coords: {
          latitude: 55.6,
          longitude: 12.5,
          accuracy: 5_000, // 5 km — cell-tower-grade, must be dropped
          altitude: null,
          altitudeAccuracy: null,
          heading: null,
          speed: null,
        },
        timestamp: 0,
      } as unknown as GeolocationPosition);
    });
    fakeBridge.callEvenApp.mockRejectedValueOnce(new Error('nope'));
    const { mod } = await importLocationModule();
    const probe = await mod.probeLocation();
    // Filter dropped the navigator fix; callEvenApp also failed; with the
    // userInfo fallback gone, this must terminate at unavailable.
    expect(probe.kind).toBe('unavailable');
  });

  it('returns unavailable when every remaining branch fails', async () => {
    fakeBridge.callEvenApp.mockRejectedValueOnce(new Error('nope'));
    const { mod } = await importLocationModule();
    const probe = await mod.probeLocation();
    expect(probe.kind).toBe('unavailable');
  });
});

describe('probeAndCacheLocation', () => {
  it('skips the probe entirely when location is disabled in settings', async () => {
    const ls = fakeLocalStorage();
    const { mod, store } = await importLocationModule();
    await store.saveLocationEnabled(ls.set, false);
    fakeBridge.callEvenApp.mockResolvedValue({ latitude: 9, longitude: 9 });
    await mod.probeAndCacheLocation(ls.set);
    // Neither the navigator stub nor the bridge fallback should have run; the
    // toggle is the gate. If we accidentally probed, callEvenApp would have
    // been hit because navigator is absent in this case.
    expect(fakeBridge.callEvenApp).not.toHaveBeenCalled();
  });

  it('persists a coords result so the next loadSettings restores it', async () => {
    const ls = fakeLocalStorage();
    stubNavigator((success) => {
      success({
        coords: { latitude: 40, longitude: -74, accuracy: 20, altitude: null, altitudeAccuracy: null, heading: null, speed: null },
        timestamp: 0,
      } as unknown as GeolocationPosition);
    });
    setReverseGeocodeResponse({ city: 'New York', countryName: 'United States', countryCode: 'US' });
    const { mod, store } = await importLocationModule();
    // `settings` is a module-scoped Solid signal so a prior test that flipped
    // location off would leak into this one. Re-enable explicitly to keep this
    // case order-independent.
    await store.saveLocationEnabled(ls.set, true);
    const cached = await mod.probeAndCacheLocation(ls.set);
    expect(cached?.latitude).toBe(40);
    expect(cached?.city).toBe('New York');
    expect(cached?.country).toBe('United States');
    expect(cached?.countryCode).toBe('US');
    // Round-trip: a fresh loadSettings must see the same cache, including
    // the reverse-geocoded labels.
    await store.loadSettings(ls.get);
    const loaded = store.settings().cachedLocation;
    expect(loaded?.latitude).toBe(40);
    expect(loaded?.longitude).toBe(-74);
    expect(loaded?.source).toBe('navigator');
    expect(loaded?.city).toBe('New York');
    expect(loaded?.countryCode).toBe('US');
  });

  it('still caches coords when reverse geocode fails', async () => {
    const ls = fakeLocalStorage();
    stubNavigator((success) => {
      success({
        coords: { latitude: 1, longitude: 2, accuracy: 10, altitude: null, altitudeAccuracy: null, heading: null, speed: null },
        timestamp: 0,
      } as unknown as GeolocationPosition);
    });
    // Network failure on the geocode call.
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    const { mod, store } = await importLocationModule();
    await store.saveLocationEnabled(ls.set, true);
    const cached = await mod.probeAndCacheLocation(ls.set);
    // Coords still land; labels are simply absent. Prompt will inject the
    // Coords line only, with no City/Country lines.
    expect(cached?.latitude).toBe(1);
    expect(cached?.city).toBeUndefined();
    expect(cached?.country).toBeUndefined();
  });

  it('falls back to locality when the geocoder reports no city', async () => {
    // BigDataCloud returns `locality` (neighbourhood / small settlement) when
    // the location isn't part of a recognised city — we use it as a sensible
    // city stand-in rather than dropping the label entirely.
    const ls = fakeLocalStorage();
    stubNavigator((success) => {
      success({
        coords: { latitude: 5, longitude: 6, accuracy: 15, altitude: null, altitudeAccuracy: null, heading: null, speed: null },
        timestamp: 0,
      } as unknown as GeolocationPosition);
    });
    setReverseGeocodeResponse({ city: '', locality: 'Smalltown', countryName: 'Nowhere', countryCode: 'NO' });
    const { mod, store } = await importLocationModule();
    await store.saveLocationEnabled(ls.set, true);
    const cached = await mod.probeAndCacheLocation(ls.set);
    expect(cached?.city).toBe('Smalltown');
  });
});

describe('cachedLocation coercion', () => {
  it('drops a corrupt KV blob and continues with null', async () => {
    const ls = fakeLocalStorage();
    ls.data.set('veritaslens.cachedLocation', '{not json');
    const { store } = await importLocationModule();
    await store.loadSettings(ls.get);
    expect(store.settings().cachedLocation).toBeNull();
    // Default-off on new install: the EvenHub Android host doesn't pass
    // geolocation through to the WebView (EvenDemoApp issue #50), so the
    // probe would silently fail. Wearers opt in once a host update lands.
    expect(store.settings().locationEnabled).toBe(false);
  });

  it('drops an entry missing the timestamp/source fields', async () => {
    const ls = fakeLocalStorage();
    ls.data.set('veritaslens.cachedLocation', JSON.stringify({ latitude: 1, longitude: 2 }));
    const { store } = await importLocationModule();
    await store.loadSettings(ls.get);
    expect(store.settings().cachedLocation).toBeNull();
  });

  it('drops a legacy entry whose source is the retired "userInfo" value', async () => {
    // Pre-cleanup builds wrote entries with `source: "userInfo"` and a bare
    // country string. The current schema requires lat/lon; legacy blobs must
    // be quietly dropped rather than crashing boot.
    const ls = fakeLocalStorage();
    ls.data.set('veritaslens.cachedLocation', JSON.stringify({
      resolvedAt: 1_700_000_000_000,
      source: 'userInfo',
      country: 'DK',
    }));
    const { store } = await importLocationModule();
    await store.loadSettings(ls.get);
    expect(store.settings().cachedLocation).toBeNull();
  });
});

describe('isLocationFresh', () => {
  it('rejects a null cache', async () => {
    const { mod } = await importLocationModule();
    expect(mod.isLocationFresh(null)).toBe(false);
  });

  it('accepts a cache resolved just now', async () => {
    const { mod } = await importLocationModule();
    const now = 1_700_000_000_000;
    expect(
      mod.isLocationFresh(
        { resolvedAt: now, source: 'navigator', latitude: 1, longitude: 2 },
        now,
      ),
    ).toBe(true);
  });

  it('rejects a cache older than LOCATION_MAX_AGE_MS', async () => {
    const { mod } = await importLocationModule();
    const now = 1_700_000_000_000;
    const tooOld = now - mod.LOCATION_MAX_AGE_MS - 1;
    expect(
      mod.isLocationFresh(
        { resolvedAt: tooOld, source: 'navigator', latitude: 1, longitude: 2 },
        now,
      ),
    ).toBe(false);
  });

  it('accepts a cache exactly at the boundary', async () => {
    const { mod } = await importLocationModule();
    const now = 1_700_000_000_000;
    const exactBoundary = now - mod.LOCATION_MAX_AGE_MS;
    expect(
      mod.isLocationFresh(
        { resolvedAt: exactBoundary, source: 'navigator', latitude: 1, longitude: 2 },
        now,
      ),
    ).toBe(true);
  });
});

describe('kickOffLocationRefresh', () => {
  it('dedupes back-to-back calls within the latch window', async () => {
    const ls = fakeLocalStorage();
    let navigatorHits = 0;
    stubNavigator((success) => {
      navigatorHits += 1;
      success({
        coords: { latitude: 1, longitude: 2, accuracy: 5, altitude: null, altitudeAccuracy: null, heading: null, speed: null },
        timestamp: 0,
      } as unknown as GeolocationPosition);
    });
    // The probe runs end-to-end including reverse geocode — stub it for each
    // fire so the call resolves cleanly. mockResolvedValue (no `Once`) lets
    // multiple calls share the response.
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ city: 'X', countryName: 'Y', countryCode: 'YY' }),
    } as Response);
    const { mod, store } = await importLocationModule();
    mod._resetRefreshLatchForTesting();
    await store.saveLocationEnabled(ls.set, true);
    const t = 1_700_000_000_000;
    mod.kickOffLocationRefresh(ls.set, t);
    mod.kickOffLocationRefresh(ls.set, t + 1_000); // same window → suppressed
    mod.kickOffLocationRefresh(ls.set, t + 11_000); // outside window → fires
    // Three calls in, two fires expected: the navigator stub increments per
    // probe so `navigatorHits` reflects the actual GPS reads triggered.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(navigatorHits).toBe(2);
  });

  it('skips entirely when location is disabled', async () => {
    const ls = fakeLocalStorage();
    const { mod, store } = await importLocationModule();
    mod._resetRefreshLatchForTesting();
    await store.saveLocationEnabled(ls.set, false);
    stubNavigator(() => {
      throw new Error('should not be called');
    });
    fakeBridge.callEvenApp.mockImplementation(() => {
      throw new Error('should not be called');
    });
    // No throw is the assertion — the helper short-circuits before any probe.
    mod.kickOffLocationRefresh(ls.set);
  });
});

describe('saveLocationEnabled', () => {
  it('clears the cache when toggling off', async () => {
    const ls = fakeLocalStorage();
    const { store } = await importLocationModule();
    await store.saveCachedLocation(ls.set, {
      resolvedAt: 1,
      source: 'navigator',
      latitude: 1,
      longitude: 2,
    });
    expect(store.settings().cachedLocation).not.toBeNull();
    await store.saveLocationEnabled(ls.set, false);
    expect(store.settings().cachedLocation).toBeNull();
    // The KV blob must also be cleared so a re-enable later doesn't restore a
    // stale fix from the previous session.
    expect(ls.data.get('veritaslens.cachedLocation')).toBe('');
  });
});
