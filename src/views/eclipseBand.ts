/** The solar-eclipse shadow band: a semi-transparent latitude strip swept
 * across the globe's surface tracing a solar eclipse's ground track
 * (`GroundTrack`, `windows/scene`'s `scene/eclipses/v1` track element), shown
 * while the sim's day sits within a small margin of the event.
 *
 * Pure geometry + visibility predicate live here (no WebGL dependency beyond
 * three's typed buffers, unit-tested directly); `./globe.ts` owns the
 * mount/show-hide wiring (lazy build + cache per event, like its true-relief
 * geometry).
 */
import * as THREE from 'three';
import { latLonToUnit } from './globe';
import type { EclipseEvent, GroundTrack } from '../sim/scene';

/** Days either side of an eclipse's exact day its band stays visible — wide
 * enough to catch a scrub through the event, pinned so a change here is
 * deliberate. */
export const MARGIN = 3;

/** Longitude steps along the arc — the strip is a ruled surface between two
 * latitude edges (not a filled polygon), so this only smooths the already
 * gentle curvature; 24 is plenty even for a wide arc. */
const LON_STEPS = 24;

/** How far above the surface a band vertex sits, as a multiple of `radius` —
 * the markers' clearance idiom, just enough to never z-fight the terrain. */
const LIFT = 1.001;

/** Umbral gray — the shadow band's color; semi-transparent so the terrain
 * beneath keeps reading through it. */
const BAND_COLOR = 0x333333;
const BAND_OPACITY = 0.4;

/** Whether `event`'s shadow band should show at `day`: solar events only
 * (`GroundTrack` is `null` on lunar events — they have no track, visible from
 * the whole night hemisphere instead), within `marginDays` of the event's
 * exact day. */
export function bandVisibleAt(event: EclipseEvent, day: number, marginDays: number): boolean {
  return event.body === 'solar' && Math.abs(day - event.day) <= marginDays;
}

/** Build one eclipse's shadow band: a latitude strip `centerLatDeg ±
 * halfWidthDeg` swept along the signed-shortest longitude arc from
 * `startLonDeg` to `endLonDeg`. Each vertex is `latLonToUnit(lat,
 * lon).multiplyScalar(radius * LIFT)` — just above the surface, the markers'
 * clearance idiom. */
export function buildEclipseBand(track: GroundTrack, radius: number): THREE.Mesh {
  const lift = radius * LIFT;

  // Signed shortest arc: wrap the raw delta into (-180, 180] so the strip
  // sweeps the short way around, never all the way round the globe.
  let delta = track.endLonDeg - track.startLonDeg;
  if (delta > 180) delta -= 360;
  if (delta <= -180) delta += 360;

  const lowLat = track.centerLatDeg - track.halfWidthDeg;
  const highLat = track.centerLatDeg + track.halfWidthDeg;

  // Two vertices per longitude step: the low- and high-latitude edge.
  const positions = new Float32Array((LON_STEPS + 1) * 2 * 3);
  for (let s = 0; s <= LON_STEPS; s++) {
    const t = s / LON_STEPS;
    const lon = track.startLonDeg + delta * t;
    const low = latLonToUnit(lowLat, lon).multiplyScalar(lift);
    const high = latLonToUnit(highLat, lon).multiplyScalar(lift);
    const base = s * 2 * 3;
    positions[base] = low.x;
    positions[base + 1] = low.y;
    positions[base + 2] = low.z;
    positions[base + 3] = high.x;
    positions[base + 4] = high.y;
    positions[base + 5] = high.z;
  }

  const indices: number[] = [];
  for (let s = 0; s < LON_STEPS; s++) {
    const i00 = s * 2; // low(s)
    const i01 = s * 2 + 1; // high(s)
    const i10 = (s + 1) * 2; // low(s+1)
    const i11 = (s + 1) * 2 + 1; // high(s+1)
    indices.push(i00, i10, i11, i00, i11, i01);
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setIndex(indices);

  // DoubleSide: whichever way the strip winds relative to the outward
  // normal, the shadow must read from the camera's side of the globe — a
  // one-sided material risks an invisible band depending on arc direction.
  const material = new THREE.MeshBasicMaterial({
    color: BAND_COLOR,
    transparent: true,
    opacity: BAND_OPACITY,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geom, material);
  mesh.name = 'eclipse-band';
  return mesh;
}
