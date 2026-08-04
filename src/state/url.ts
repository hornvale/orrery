import { parseSeedValue } from '../ui/seed';

/** Everything a shared link reproduces. The URL hash is the only
 * persistence — `#seed=<u64 decimal>&view=system|globe&day=<f64>`. */
export interface AppState {
  seed: string;
  view: 'system' | 'globe';
  day: number;
  controls: string;
}

export function defaultAppState(seed: string): AppState {
  return { seed, view: 'system', day: 0, controls: '' };
}

function finiteOrNull(v: string | null): number | null {
  if (v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Tolerant parse: a valid seed is required; every other field falls back
 * to its default rather than failing — a mangled link still opens the
 * world. Unknown params are silently ignored. Returns null when `seed` is
 * missing or fails validation; callers that need to tell those two cases
 * apart (to show a parse error rather than quietly minting a fresh seed)
 * use `seedError` first. */
export function parseAppState(hash: string): AppState | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const seed = parseSeedValue(params.get('seed') ?? '');
  if (seed === null) return null;
  const s = defaultAppState(seed);
  if (params.get('view') === 'globe') s.view = 'globe';
  const day = finiteOrNull(params.get('day'));
  if (day !== null) s.day = day;
  s.controls = params.get('c') ?? '';
  return s;
}

/** A `seed` param is present but fails validation — the caller shows this
 * verbatim rather than silently falling back to a random seed, so a
 * mistyped or truncated share link never quietly loads a different world.
 * Null when the seed is valid OR entirely absent (absence just means "no
 * state yet," not a broken link). */
export function seedError(hash: string): string | null {
  const raw = new URLSearchParams(hash.replace(/^#/, '')).get('seed');
  if (raw === null || raw === '') return null;
  if (parseSeedValue(raw) !== null) return null;
  return `invalid seed "${raw}" in the URL — expected a plain decimal integer from 0 to 2^64-1`;
}

/** Fixed key order; defaults omitted so simple links stay simple. `day`
 * rounds to 4 decimals (~ ms-scale on a day-length axis) purely to keep
 * shared URLs short and stable — not a determinism boundary, this is
 * client-side presentation state (decision 0022). */
export function serializeAppState(s: AppState): string {
  const parts = [`seed=${s.seed}`];
  if (s.view !== 'system') parts.push(`view=${s.view}`);
  if (s.day !== 0) parts.push(`day=${s.day.toFixed(4).replace(/\.?0+$/, '')}`);
  // The control blob. `c` rather than `controls` purely to keep a shared
  // link short — this is presentation state (decision 0022), not a
  // documented contract anyone else parses.
  if (s.controls !== '') parts.push(`c=${s.controls}`);
  return `#${parts.join('&')}`;
}
