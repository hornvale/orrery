import { describe, expect, it } from 'vitest';
import { DITHER_DEFAULTS, createDitherMaterial } from './dither3d';

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

  it('names no GLSL reserved word as a variable — a collision silently blacks the screen', () => {
    const { material } = createDitherMaterial();
    const src = (material.userData as { ditherChunk: string }).ditherChunk;
    for (const word of ['flat', 'sample', 'smooth', 'layout', 'patch', 'filter', 'input']) {
      expect(src, `reserved word ${word} used as an identifier`)
        .not.toMatch(new RegExp(`\\b(float|vec[234]|int|bool)\\s+${word}\\b`));
    }
  });
});
