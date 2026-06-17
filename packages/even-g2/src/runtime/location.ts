import type { CachedLocation } from '@veritaslens/core';
import { getBridge } from '@/runtime/bridge';
import { saveCachedLocation, settings } from '@/state/store';

export type LocationProbe =
  | { kind: 'coords'; latitude: number; longitude: number; accuracy?: number; source: 'navigator' | 'callEvenApp' }
  | { kind: 'unavailable'; reason: string };

const NAVIGATOR_TIMEOUT_MS = 5_000;
/**
 * How fresh `navigator.geolocation` may serve from its OWN cache before
 * triggering a real GPS read. Kept short (60 s) so a refresh fired before a
 * prompt actually re-polls the sensor instead of returning a half-hour-old
 * fix. The cost — one GPS read per minute in active use — is negligible vs
 * the LLM round trip the wearer is paying for at the same time.
 */
const NAVIGATOR_MAX_AGE_MS = 60_000;
/**
 * Hard upper bound on how old a cached fix may be before `buildContextBlock`
 * stops injecting it. Beyond this the prompt simply omits the location lines
 * — better to give the LLM no location than a wrong one. In practice the
 * per-prompt refresh keeps `resolvedAt` current via GPS+WiFi+cell fusion, so
 * sit-down sessions (long restaurant visits, meetings) stay accurate even
 * without line-of-sight GPS. 30 min is the cliff for environments where
 * every refresh genuinely fails (deep basement, RF-shielded room).
 */
export const LOCATION_MAX_AGE_MS = 30 * 60_000;
/** Don't re-fire the probe more than once per this interval — guards against
 *  a wearer who triple-taps in 2 s spawning three GPS reads. The OS cache
 *  would dedupe anyway via `NAVIGATOR_MAX_AGE_MS`, but skipping the work in
 *  JS is cheaper still and keeps the `getUserInfo` fallback from re-hitting
 *  the host on every tap. */
const REFRESH_DEDUP_MS = 10_000;
let lastRefreshFiredAt = 0;
/**
 * Drop any fix whose `accuracy` (radius in metres of the OS confidence circle)
 * is worse than this. Cell-tower-only fixes commonly come in at 5-50 km and
 * would mislead 'nearest X' / 'here' questions far more than absent location.
 * 2 km keeps GPS + WiFi-grade fixes and rejects pure cell triangulation.
 *
 * Only applied where accuracy is reported (navigator path; the host
 * `callEvenApp` path may omit it, in which case we trust the host).
 */
const ACCURACY_MAX_METERS = 2_000;

export async function probeLocation(): Promise<LocationProbe> {
  const navResult = await tryNavigatorGeolocation();
  if (navResult) return navResult;

  const hostResult = await tryHostGeolocation();
  if (hostResult) return hostResult;

  // Profile country (`bridge.getUserInfo().country`) is intentionally NOT a
  // fallback: it's the wearer's *account* country, which can be Denmark for a
  // wearer currently in Spain. Injecting `Country: DK` would mislead the LLM
  // about currency, units, and locale far more than absent location.
  return { kind: 'unavailable', reason: 'no probe branch resolved' };
}

function tryNavigatorGeolocation(): Promise<LocationProbe | null> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: LocationProbe | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          // Drop fixes whose accuracy is worse than the cell-tower cliff: a
          // 5 km-radius circle would tell the LLM the wearer is up to 5 km
          // from where they actually are. Better no location than a wrong one.
          if (
            typeof pos.coords.accuracy === 'number'
            && Number.isFinite(pos.coords.accuracy)
            && pos.coords.accuracy > ACCURACY_MAX_METERS
          ) {
            finish(null);
            return;
          }
          finish({
            kind: 'coords',
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
            source: 'navigator',
          });
        },
        () => finish(null),
        {
          enableHighAccuracy: false,
          timeout: NAVIGATOR_TIMEOUT_MS,
          maximumAge: NAVIGATOR_MAX_AGE_MS,
        }
      );
    } catch {
      finish(null);
    }
  });
}

async function tryHostGeolocation(): Promise<LocationProbe | null> {
  let bridge;
  try {
    bridge = getBridge();
  } catch {
    return null;
  }
  try {
    const raw = await bridge.callEvenApp('getLocation');
    const coords = coerceCoords(raw);
    if (coords) {
      // Apply the same accuracy cliff as the navigator path when the host
      // reports accuracy. Hosts that omit accuracy are trusted as-is — we
      // can't filter what we can't measure, and the host knows its sensor.
      if (
        coords.accuracy !== undefined
        && coords.accuracy > ACCURACY_MAX_METERS
      ) return null;
      return { ...coords, source: 'callEvenApp' };
    }
  } catch {
    /* host does not expose this method — fall through */
  }
  return null;
}

function coerceCoords(raw: unknown): { kind: 'coords'; latitude: number; longitude: number; accuracy?: number } | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Record<string, unknown>;
  const nested = (candidate.coords && typeof candidate.coords === 'object' ? (candidate.coords as Record<string, unknown>) : candidate);
  const lat = pickNumber(nested.latitude, nested.lat);
  const lon = pickNumber(nested.longitude, nested.lon, nested.lng);
  if (lat === null || lon === null) return null;
  const accuracy = pickNumber(nested.accuracy);
  return {
    kind: 'coords',
    latitude: lat,
    longitude: lon,
    ...(accuracy !== null ? { accuracy } : {}),
  };
}

function pickNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

/**
 * Run the probe and persist the result. Fire-and-forget at boot.
 *
 * Skips entirely when the wearer has turned location off in Settings. The
 * `setLs` parameter is the same `bridge.setLocalStorage` getter the rest of
 * the store uses — passed in so this stays SDK-agnostic for tests.
 *
 * Failure path: a probe that lands on `unavailable` leaves the existing cache
 * intact. We never overwrite a good cache with `null` just because the next
 * boot couldn't reach the GPS — that would silently strip context from every
 * prompt for the rest of the session.
 */
export async function probeAndCacheLocation(
  setLs: (k: string, v: string) => Promise<boolean>,
): Promise<CachedLocation | null> {
  if (!settings().locationEnabled) return settings().cachedLocation;
  const probe = await probeLocation();
  const cached = await probeToCached(probe);
  if (!cached) return settings().cachedLocation;
  await saveCachedLocation(setLs, cached);
  return cached;
}

/**
 * Whether a cached fix is fresh enough to inject into a prompt. A `null`
 * cache is never fresh; an entry older than `LOCATION_MAX_AGE_MS` is dropped.
 * Exported so `buildContextBlock` can gate injection without re-implementing
 * the rule (and so tests can lock the threshold).
 */
export function isLocationFresh(loc: CachedLocation | null, now = Date.now()): boolean {
  if (!loc) return false;
  return now - loc.resolvedAt <= LOCATION_MAX_AGE_MS;
}

/**
 * Fire-and-forget location refresh for the per-prompt path. Dedupes within
 * `REFRESH_DEDUP_MS` so two prompts in quick succession only trigger one
 * probe. Silently no-ops when location is disabled or the bridge isn't ready
 * — both states are valid (e.g. very early in boot) and should not throw.
 */
export function kickOffLocationRefresh(
  setLs: (k: string, v: string) => Promise<boolean>,
  now = Date.now(),
): void {
  if (!settings().locationEnabled) return;
  if (now - lastRefreshFiredAt < REFRESH_DEDUP_MS) return;
  lastRefreshFiredAt = now;
  void probeAndCacheLocation(setLs);
}

/** Reset the dedupe latch. Test-only — production callers should never need
 *  this, since the latch self-clears once `REFRESH_DEDUP_MS` elapses. */
export function _resetRefreshLatchForTesting(): void {
  lastRefreshFiredAt = 0;
}

async function probeToCached(probe: LocationProbe): Promise<CachedLocation | null> {
  if (probe.kind !== 'coords') return null;
  // Best-effort reverse geocode. Failures land us in a coords-only entry,
  // which is still useful — the LLM can usually derive city/country itself,
  // we just lose the strong-signal ground-truth labels.
  const labels = await reverseGeocode(probe.latitude, probe.longitude);
  return {
    resolvedAt: Date.now(),
    source: probe.source,
    latitude: probe.latitude,
    longitude: probe.longitude,
    ...(probe.accuracy !== undefined ? { accuracy: probe.accuracy } : {}),
    ...(labels?.city ? { city: labels.city } : {}),
    ...(labels?.country ? { country: labels.country } : {}),
    ...(labels?.countryCode ? { countryCode: labels.countryCode } : {}),
  };
}

const BIGDATACLOUD_URL = 'https://api.bigdatacloud.net/data/reverse-geocode-client';
const REVERSE_GEOCODE_TIMEOUT_MS = 5_000;

/**
 * Free reverse-geocode call. No API key, generous rate limits per
 * BigDataCloud's docs (the `-client` endpoint is intended for direct browser
 * use). Always returns gracefully on error — geocoding is enrichment, not a
 * gate. The caller must fall back to coords-only when this returns `null` or
 * an empty object.
 */
async function reverseGeocode(
  latitude: number,
  longitude: number,
): Promise<{ city?: string; country?: string; countryCode?: string } | null> {
  try {
    const url = `${BIGDATACLOUD_URL}?latitude=${encodeURIComponent(String(latitude))}&longitude=${encodeURIComponent(String(longitude))}&localityLanguage=en`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REVERSE_GEOCODE_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown>;
    // BigDataCloud's `city` is the principal city; `locality` is the
    // neighbourhood. Prefer city; fall back to locality for very small
    // settlements where `city` may be empty.
    const city = pickString(data.city) ?? pickString(data.locality) ?? undefined;
    const country = pickString(data.countryName) ?? undefined;
    const countryCode = pickString(data.countryCode) ?? undefined;
    if (!city && !country && !countryCode) return null;
    return { city, country, countryCode };
  } catch {
    return null;
  }
}

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
