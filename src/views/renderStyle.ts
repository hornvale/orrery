import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import type { Pass } from 'three/addons/postprocessing/Pass.js';
import type { TilesScene } from '../sim/scene';
import { pixelArtStyle } from './styles/pixelArt';
import { celStyle } from './styles/cel';
import { engravingStyle } from './styles/engraving';
import { watercolorStyle } from './styles/watercolor';
import type { SymbolLayer } from './symbols/symbolLayer';
import { buildSymbolLayer } from './symbols/symbolLayer';

/** How the globe SURFACE is shaded, as a per-vertex colour transform applied
 * on top of the active lens's colour inside globe.ts's computeBaseColor.
 * Absent on a style = today's realistic relief surface, untouched. */
export interface BaseTreatment {
  id: string;
  /** rgb is 0–255 (the lens output). Return 0–255. `src`/`idx` give the
   * treatment the raw datum (e.g. src.ocean[idx]) so it shades from data. */
  transform(rgb: readonly [number, number, number], src: TilesScene, idx: number): [number, number, number];
}

/** A scene-graph layer of derived-feature symbols. A later task fills in the
 * builder; this task only reserves the slot. */
export interface SymbolLayerSpec {
  id: string;
}

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
  /** How the globe surface is shaded. Absent = realistic relief (today). */
  base?: BaseTreatment;
  /** A layer of derived-feature symbols mounted on the globe. Absent = none. */
  symbolLayer?: SymbolLayerSpec;
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

/** The minimal structural surface `StylePipeline` needs from the globe view to
 * apply a style's scene-renderer aspects (base treatment + symbol layer) —
 * kept narrow so this module doesn't need to import all of globe.ts. The
 * globe view returned by `createGlobeView` satisfies this today. */
export interface GlobeStyleTarget {
  setBaseTreatment(t: BaseTreatment | null): void;
  mountSymbolLayer(layer: SymbolLayer): void;
  unmountSymbolLayer(): void;
}

/** Owns an EffectComposer over the globe renderer and swaps pass chains when the
 * style changes. `render()` replaces the plain `renderer.render(scene, camera)`. */
export class StylePipeline {
  private composer: EffectComposer;
  private renderPass: RenderPass;
  private activeSymbolLayer: SymbolLayer | null = null;

  constructor(
    private renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    private tiles: TilesScene,
    private globe: GlobeStyleTarget,
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

    // Scene-renderer aspects: base treatment + symbol layer.
    if (this.activeSymbolLayer) {
      this.globe.unmountSymbolLayer();
      this.activeSymbolLayer.dispose();
      this.activeSymbolLayer = null;
    }
    this.globe.setBaseTreatment(style.base ?? null);
    if (style.symbolLayer) {
      this.activeSymbolLayer = buildSymbolLayer(this.tiles);
      this.globe.mountSymbolLayer(this.activeSymbolLayer);
    }
  }

  setSize(w: number, h: number): void {
    this.composer.setSize(w, h);
  }

  render(): void {
    this.composer.render();
  }
}
