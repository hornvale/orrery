import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import type { Pass } from 'three/addons/postprocessing/Pass.js';
import type { TilesScene } from '../sim/scene';

/** Owns an EffectComposer over the globe renderer and swaps pass chains when the
 * Look changes. `render()` replaces the plain `renderer.render(scene, camera)`. */
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
    // the style to transform; space stays black. (A pass-free Look renders straight
    // to screen and is unaffected.)
    this.renderPass.clearColor = new THREE.Color(0, 0, 0);
    this.renderPass.clearAlpha = 1;
    this.composer.addPass(this.renderPass);
  }

  /** Rebuild the composer's pass chain: the base RenderPass + `passes`.
   * The last pass renders to screen. An empty list is the identity — what
   * the pass-free `natural` Look passes — and the composer then renders
   * exactly as a plain `renderer.render(scene, camera)` would. */
  setPasses(passes: Pass[]): void {
    for (const p of this.composer.passes) {
      if (p !== this.renderPass) p.dispose();
    }
    this.composer.passes = [this.renderPass];
    for (const p of passes) this.composer.addPass(p);
    const chain = this.composer.passes;
    chain.forEach((p, i) => {
      p.renderToScreen = i === chain.length - 1;
    });
  }

  setSize(w: number, h: number): void {
    this.composer.setSize(w, h);
  }

  render(): void {
    this.composer.render();
  }
}
