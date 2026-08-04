import { describe, expect, it } from 'vitest';
import { DITHER_DEFAULTS, DITHER_DOT_PX, createDitherMaterial } from './dither3d';

describe('the dither material', () => {
  it('defaults to colour, so the lens survives', () => {
    expect(DITHER_DEFAULTS.colourMode).toBe('colour');
  });

  it('keeps vertex colours on — the lens writes them and the dither reads them', () => {
    expect(createDitherMaterial().material.vertexColors).toBe(true);
  });

  it('exposes every setting as a live uniform', () => {
    const { material } = createDitherMaterial();
    const u = (material.userData as { ditherUniforms: Record<string, { value: unknown }> }).ditherUniforms;
    for (const key of ['uDither', 'uDotScale', 'uContrast', 'uVariability', 'uStretch', 'uInvert', 'uRadial', 'uGrayscale']) {
      expect(u[key], `missing uniform ${key}`).toBeDefined();
    }
  });

  it('writes a setting straight through to its uniform', () => {
    const { material, setSettings } = createDitherMaterial();
    const u = (material.userData as { ditherUniforms: Record<string, { value: unknown }> }).ditherUniforms;
    setSettings({ dotScale: 2.5 });
    expect(u.uDotScale!.value).toBe(2.5);
    setSettings({ colourMode: 'grayscale' });
    expect(u.uGrayscale!.value).toBe(1);
    setSettings({ invert: true });
    expect(u.uInvert!.value).toBe(1);
  });

  it('leaves untouched settings alone on a partial update', () => {
    const { material, setSettings } = createDitherMaterial();
    const u = (material.userData as { ditherUniforms: Record<string, { value: unknown }> }).ditherUniforms;
    setSettings({ dotScale: 3 });
    setSettings({ contrast: 2 });
    expect(u.uDotScale!.value).toBe(3);
  });

  it('takes the viewport in device pixels, since gl_FragCoord counts those', () => {
    const { material, setViewport } = createDitherMaterial();
    const u = (material.userData as { ditherUniforms: { uViewport: { value: { x: number; y: number } } } }).ditherUniforms;
    // A DPR-2 1280×720 window: the DRAWING BUFFER is 2560×1440, and passing
    // the CSS size instead put the radial term's centre at the quarter point
    // and blew the frame out to white.
    setViewport(2560, 1440);
    expect(u.uViewport.value.x).toBe(2560);
    expect(u.uViewport.value.y).toBe(1440);
    // Never zero: gl_FragCoord.xy / uViewport must not divide by it.
    setViewport(0, 0);
    expect(u.uViewport.value.x).toBeGreaterThan(0);
    expect(u.uViewport.value.y).toBeGreaterThan(0);
  });

  /* The three assertions below are guards on the SHAPE of the GLSL source,
   * not on what it computes — nothing in this file can compile a shader (see
   * the file's own note). Each pins one specific regression that was found by
   * reading the source and measured in a browser, and each would be silently
   * reintroduced by an edit that looks harmless. Screen-period stability
   * itself is verified by capturing frames an octave apart, not here. */
  describe('the level -> slice mapping (source shape only)', () => {
    const chunk = (): string => (createDitherMaterial().material.userData as { ditherChunk: string }).ditherChunk;

    it('drives the slice blend from the FRACTIONAL level, never the absolute one', () => {
      const src = chunk();
      expect(src).toMatch(/sliceT\s*=\s*\([^;]*fract\(lvl\)/);
      // The absolute level scales the UV and nothing else. Indexing the slices
      // by it as well makes the two multiply: the dots then halve at every
      // octave boundary instead of holding a constant screen period.
      expect(src).not.toMatch(/sliceT\s*=\s*lvl\s*\//);
      expect(src).toMatch(/exp2\(floor\(lvl\)\)/);
    });

    it('half-texel centres the slice coordinate onto a real slice', () => {
      // (BASE + fract + 0.5) / DEPTH — without the 0.5, an integer level lands
      // 83% of the way to the next slice and the centred normalization
      // `ditherTexture.ts` builds the slices around is thrown away.
      expect(chunk()).toMatch(/\+\s*0\.5\)\s*\/\s*DITHER_DEPTH/);
    });

    it('applies the anisotropy to one axis, which is what squares the cell up', () => {
      // A scalar on both axes changes dot SIZE with grazing angle instead of
      // compensating the stretch.
      expect(chunk()).toMatch(/vec2\(bias,\s*1\.0\)/);
    });

    it('solves the level for a fixed screen-pixel cell, so dotScale is in pixels', () => {
      expect(DITHER_DOT_PX).toBeGreaterThan(1);
      expect(chunk()).toMatch(/-log2\(footprint \* uDotScale \* DITHER_DOT_PX\)/);
    });
  });

  it('names no GLSL reserved word as a variable — a collision silently blacks the screen', () => {
    const { material } = createDitherMaterial();
    const src = (material.userData as { ditherChunk: string }).ditherChunk;
    for (const word of ['flat', 'sample', 'smooth', 'layout', 'patch', 'filter', 'input']) {
      expect(src, `reserved word ${word} used as an identifier`)
        .not.toMatch(new RegExp(`\\b(float|vec[234]|int|bool)\\s+${word}\\b`));
    }
  });
});
