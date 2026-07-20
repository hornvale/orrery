import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import type { Pass } from 'three/addons/postprocessing/Pass.js';
import type { TilesScene } from '../sim/scene';
import { pixelArtStyle } from './styles/pixelArt';
import { celStyle } from './styles/cel';
import { engravingStyle } from './styles/engraving';
import { watercolorStyle } from './styles/watercolor';

/** A render STYLE: how the globe is drawn, orthogonal to the data lens (which
 * chooses what data is coloured). A style is a chain of screen-space passes
 * applied to the rendered globe frame. Photoreal is the identity (no passes). */
export interface RenderStyle {
  /** Stable id, used by the URL/HUD and `styleById`. */
  id: string;
  /** Human label for the picker button. */
  label: string;
  /** Build this style's effect passes (empty = identity/photoreal). `tiles` is
   * passed so a style can derive a cheap CPU-side hook (e.g. a palette from the
   * world's biome mix) once at construction. */
  passes(tiles: TilesScene): Pass[];
}

/** The default: no effect — the globe renders exactly as it does today. */
export const photorealStyle: RenderStyle = {
  id: 'photoreal',
  label: 'photoreal',
  passes: () => [],
};

/** Every registered style, photoreal first. Later tasks push their styles here. */
export const STYLES: RenderStyle[] = [
  photorealStyle,
  pixelArtStyle,
  celStyle,
  engravingStyle,
  watercolorStyle,
];

/** The style with this id, or photoreal if none matches (a bad URL never crashes). */
export function styleById(id: string): RenderStyle {
  return STYLES.find((s) => s.id === id) ?? photorealStyle;
}

/** Owns an EffectComposer over the globe renderer and swaps pass chains when the
 * style changes. `render()` replaces the plain `renderer.render(scene, camera)`. */
export class StylePipeline {
  private composer: EffectComposer;
  private renderPass: RenderPass;

  constructor(
    private renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    private tiles: TilesScene,
  ) {
    this.composer = new EffectComposer(renderer);
    this.renderPass = new RenderPass(scene, camera);
    // Clear the composer's intermediate target to OPAQUE black. Without this the
    // target's alpha where the globe drew is 0, and three's premultiplied output
    // then zeroes the globe's RGB — so any style ShaderPass reads a black frame
    // and the globe vanishes. An opaque clear keeps the globe's colour intact for
    // the style to transform; space stays black. (Photoreal renders to screen and
    // is unaffected.)
    this.renderPass.clearColor = new THREE.Color(0, 0, 0);
    this.renderPass.clearAlpha = 1;
    this.composer.addPass(this.renderPass);
  }

  /** Rebuild the composer's pass chain: the base RenderPass + the style's effects.
   * The last pass renders to screen. */
  setStyle(style: RenderStyle): void {
    // Dispose the old effect passes' targets before dropping them.
    for (const p of this.composer.passes) {
      if (p !== this.renderPass) p.dispose();
    }
    this.composer.passes = [this.renderPass];
    for (const p of style.passes(this.tiles)) this.composer.addPass(p);
    const passes = this.composer.passes;
    passes.forEach((p, i) => {
      p.renderToScreen = i === passes.length - 1;
    });
  }

  setSize(w: number, h: number): void {
    this.composer.setSize(w, h);
  }

  render(): void {
    this.composer.render();
  }
}
