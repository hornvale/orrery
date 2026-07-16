import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { WIND_MERIDIANS, bandLatitudes, createWinds } from './winds';
import type { TilesScene } from '../sim/scene';

const banded = (bands: number | null): TilesScene => ({ circulationBands: bands }) as never;

describe('bandLatitudes', () => {
  it('places each band at its mid-latitude, mirrored across the equator', () => {
    // 3 bands ⇒ 30° wide ⇒ mid-latitudes 15, 45, 75 in each hemisphere.
    expect(bandLatitudes(3)).toEqual([15, 45, 75, -15, -45, -75]);
  });

  it('handles a single band', () => {
    expect(bandLatitudes(1)).toEqual([45, -45]);
  });
});

describe('createWinds', () => {
  it('returns null on a locked world with no circulation bands', () => {
    expect(createWinds(banded(null), 1)).toBeNull();
  });

  it('builds one arrow per band per meridian, both hemispheres', () => {
    const winds = createWinds(banded(3), 1)!;
    const lines = winds.object3d as THREE.LineSegments;
    const positions = lines.geometry.getAttribute('position');
    // 3 bands × 2 hemispheres × WIND_MERIDIANS arrows, 2 vertices each.
    expect(positions.count).toBe(3 * 2 * WIND_MERIDIANS * 2);
  });

  it('starts hidden', () => {
    expect(createWinds(banded(3), 1)!.object3d.visible).toBe(false);
  });

  it('shows and hides', () => {
    const winds = createWinds(banded(3), 1)!;
    winds.setVisible(true);
    expect(winds.object3d.visible).toBe(true);
    winds.setVisible(false);
    expect(winds.object3d.visible).toBe(false);
  });

  it('sits above the sphere so relief cannot swallow it', () => {
    const winds = createWinds(banded(3), 10)!;
    const p = (winds.object3d as THREE.LineSegments).geometry.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      const r = Math.hypot(p.getX(i), p.getY(i), p.getZ(i));
      expect(r).toBeGreaterThan(10);
    }
  });
});
