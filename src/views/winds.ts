/** The prevailing-wind overlay.
 *
 * `windAt` (../sim/climate) takes no `day`: the model's winds are a pure
 * function of latitude and the world's circulation-band count, so this is
 * build-once static geometry, not a per-frame cost. It mounts in the globe's
 * spin group so it rides the world rather than the camera.
 *
 * An overlay, not a lens: it composes with whichever lens is active.
 * Presentation only (decision 0022) — the sim ships a band count, not arrows. */
import * as THREE from 'three';
import { windAt } from '../sim/climate';
import type { TilesScene } from '../sim/scene';

/** Arrows drawn per band, evenly spaced in longitude. */
export const WIND_MERIDIANS = 24;
/** Arrow half-length, in degrees of longitude. */
const ARROW_DEG = 6;
/** Lift above the sphere, so exaggerated relief cannot swallow the arrows. */
const LIFT = 1.02;

/** Every band's mid-latitude, northern hemisphere then southern. */
export function bandLatitudes(bands: number): number[] {
  const width = 90 / bands;
  const north = Array.from({ length: bands }, (_, b) => (b + 0.5) * width);
  return [...north, ...north.map((lat) => -lat)];
}

/** Lat/lon (degrees) to a point on a sphere of `radius` — matches this
 * codebase's one true convention (`globe.ts`'s `latLonToUnit`, the exact
 * inverse of `cubeSphere.ts`'s `unitLatLon`: lat = asin(z), lon =
 * atan2(y, x)), not the physics spherical-coordinate convention the brief's
 * draft used (which put the pole on the Y axis and would have landed every
 * arrow in the wrong hemisphere here). */
function onSphere(lat: number, lon: number, radius: number): THREE.Vector3 {
  const latRad = (lat * Math.PI) / 180;
  const lonRad = (lon * Math.PI) / 180;
  return new THREE.Vector3(
    radius * Math.cos(latRad) * Math.cos(lonRad),
    radius * Math.cos(latRad) * Math.sin(lonRad),
    radius * Math.sin(latRad),
  );
}

/** The overlay, or `null` when the world is tidally locked and has no bands —
 * the caller must SAY so rather than silently hiding the control. */
export function createWinds(
  tiles: TilesScene,
  radius: number,
): { object3d: THREE.Object3D; setVisible(on: boolean): void } | null {
  const bands = tiles.circulationBands;
  if (bands === null) return null;

  const r = radius * LIFT;
  const points: THREE.Vector3[] = [];
  for (const lat of bandLatitudes(bands)) {
    // Direction is the producer's evaluator, never re-derived here.
    const { direction } = windAt(bands, lat);
    const sign = direction === 'easterly' ? 1 : -1;
    for (let m = 0; m < WIND_MERIDIANS; m++) {
      const lon = -180 + (360 / WIND_MERIDIANS) * m;
      points.push(onSphere(lat, lon - sign * ARROW_DEG, r));
      points.push(onSphere(lat, lon + sign * ARROW_DEG, r));
    }
  }

  const geom = new THREE.BufferGeometry().setFromPoints(points);
  const lines = new THREE.LineSegments(
    geom,
    new THREE.LineBasicMaterial({ color: 0xcfd8e3, transparent: true, opacity: 0.8 }),
  );
  lines.name = 'globe-winds';
  lines.visible = false;
  return {
    object3d: lines,
    setVisible: (on) => {
      lines.visible = on;
    },
  };
}
