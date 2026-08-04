/** Serializes the control values that differ from their defaults, for the
 * URL hash and for localStorage (same payload, two homes).
 *
 * Decode is deliberately FORGIVING, and that tolerance IS the versioning
 * story: an unknown id is ignored, an out-of-range number clamps, a bad
 * choice is dropped. Renaming or removing a control degrades an old link
 * instead of breaking it, so no schema-version negotiation is needed. */
import type { Control, ControlValue } from './kinds';

/** `id:value` pairs joined by commas; empty when nothing differs. */
export function encodeControls(nonDefaults: Record<string, ControlValue>): string {
  const parts: string[] = [];
  for (const [id, v] of Object.entries(nonDefaults)) {
    parts.push(`${id}:${encodeValue(v)}`);
  }
  return parts.join(',');
}

function encodeValue(v: ControlValue): string {
  if (typeof v === 'boolean') return v ? '1' : '0';
  // 4 decimals is well under any slider's useful precision and keeps a
  // shared URL short. Not a determinism boundary (decision 0022).
  if (typeof v === 'number') return v.toFixed(4).replace(/\.?0+$/, '');
  return v;
}

export function decodeControls(
  encoded: string,
  controls: readonly Control[],
): Record<string, ControlValue> {
  const byId = new Map(controls.map((c) => [c.id, c]));
  const out: Record<string, ControlValue> = {};
  if (encoded === '') return out;
  for (const pair of encoded.split(',')) {
    const sep = pair.indexOf(':');
    if (sep <= 0) continue; // malformed: no separator, or an empty id
    const id = pair.slice(0, sep);
    const raw = pair.slice(sep + 1);
    const c = byId.get(id);
    if (!c) continue; // unknown id — an old link naming a deleted control
    const v = decodeValue(c, raw);
    if (v !== undefined) out[id] = v;
  }
  return out;
}

function decodeValue(c: Control, raw: string): ControlValue | undefined {
  if (c.kind === 'toggle') {
    if (raw === '1') return true;
    if (raw === '0') return false;
    return undefined;
  }
  if (c.kind === 'choice') {
    return c.options.some((o) => o.id === raw) ? raw : undefined;
  }
  if (c.kind === 'slider') {
    const n = Number(raw);
    if (!Number.isFinite(n)) return undefined;
    return Math.min(c.max, Math.max(c.min, n));
  }
  return undefined; // an action holds no value
}
