# The Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Orrery's hand-wired HUD with a phone-first control surface driven by a declarative control registry, collapse three style axes into one `Look` axis, and add Surface-Stable Fractal Dithering as a material shader.

**Architecture:** Controls become data (four kinds: toggle / choice / slider / action) in `src/ui/controls/`. A generic sheet renderer walks the registry and produces a tabbed bottom sheet; it never knows what any individual control means. A single `Look` type replaces `RenderStyle`, `GlobeStyle` and `MapStyle`, and contributes its own settings into the registry. Dither3D is a `MeshStandardMaterial` variant fed by runtime-generated Bayer `Data3DTexture` and face-space tile UVs.

**Tech Stack:** TypeScript, three.js 0.166 (WebGL2), Vite, vitest (`happy-dom` environment), Playwright. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-08-03-the-console-design.md`

## Global Constraints

- **No new runtime dependencies.** `CLAUDE.md` opens by calling this a dependency-free three.js app. Dev dependencies are equally out of scope for this plan.
- **The gate is four commands:** `npm test`, `npm run smoke`, `npm run build`, `npm run e2e`. `npm run build` is `tsc --noEmit && vite build` — the typecheck IS the lint; there is no separate linter.
- **Gate cadence** (Nathan's pre-flight ruling, matching `CLAUDE.md`'s "run all four before pushing" rather than before every commit): **every task** runs `npm test` and `npm run build` before committing. `npm run smoke` and `npm run e2e` run at each of the **five stage boundaries** (after Tasks 3, 5, 10, 11 and 15) and before the branch is finished. e2e takes ~13 minutes, and some tasks cannot pass it by construction — Task 8 deletes `hud.ts` while the e2e selectors do not move to `data-control` until Task 10 — so a per-task e2e gate is both slow and impossible. Where an individual task below lists `npm run e2e` in its own steps, that task is a stage boundary or genuinely changes e2e-visible behaviour; run it there as written.
- **The wasm is required for tests.** `npm run wasm:release` fetches the pinned `world-wasm-v14` build. Without `public/hornvale_world.wasm`, ~15 fixture tests fail; that is an environment gap, not a regression.
- **Vitest environment is `happy-dom`,** not jsdom. DOM tests construct elements directly; there is no `document.body` fixture convention in this repo.
- **Tests are co-located** as `*.test.ts` next to the module under test.
- **Decision 0022 governs:** the sim emits data, the client renders. Never invent precision the producer does not ship. Presentation here is deliberately non-deterministic — do not import determinism anxieties into a rendering change.
- **GLSL ES 3.00 reserved words silently break the whole shader compile** (→ black screen). Never name a variable `flat`, `sample`, `smooth`, `layout`, `patch`, `filter`, or `input`. Existing shaders carry this warning in comments; keep it.
- **Touch targets are ≥ 44 CSS px** in both dimensions for every interactive element.
- **Every rendered control carries `data-control="<id>"`** — the same id the URL codec writes and e2e addresses.
- **Commit messages** follow the repo's `type(campaign): summary` form, campaign `the-console`, e.g. `feat(the-console): the control store`.

## Stage boundaries

Each stage ends with the gate green and is independently shippable. Stop after any stage.

| Stage | Tasks | Deliverable |
|---|---|---|
| 1 — Strip | 1–3 | Dead skins deleted; one `Look` axis behind the existing HUD |
| 2 — Registry | 4–5 | `kinds` / `store` / `codec`, pure and tested, no UI |
| 3 — Surface | 6–10 | The new control surface; `hud.ts` deleted; mobile-first CSS |
| 4 — Persistence | 11 | URL + localStorage |
| 5 — Dither3D | 12–15 | Face-space UVs, Bayer texture, material, settings |

---

# Stage 1 — Strip

## Task 1: Delete the three dead post-process skins

`cel`, `watercolor` and `engraving` leave. `photoreal` and `pixelArt` stay — `pixelArt` becomes the `pixel` Look's post pass in Task 3.

**Files:**
- Delete: `src/views/styles/cel.ts`, `src/views/styles/watercolor.ts`, `src/views/styles/engraving.ts`
- Modify: `src/views/renderStyle.ts:6-9` (imports), `:33-39` (the `STYLES` roster)
- Modify: `src/ui/hud.test.ts` (any assertion counting styles)
- Modify: `e2e/smoke.spec.ts` (the `[data-style]` roster test)

**Interfaces:**
- Consumes: nothing.
- Produces: `STYLES` shrinks to `[photorealStyle, pixelArtStyle]`. `styleById(id)` still returns `photorealStyle` for an unknown id.

- [ ] **Step 1: Find every reference to the three doomed styles**

```bash
grep -rn "celStyle\|watercolorStyle\|engravingStyle\|'cel'\|'watercolor'\|'engraving'" src e2e
```

Expected: hits in `src/views/renderStyle.ts` only, plus possibly `e2e/smoke.spec.ts`. Note every file the grep names — you must touch all of them in this task.

- [ ] **Step 2: Delete the three style files**

```bash
git rm src/views/styles/cel.ts src/views/styles/watercolor.ts src/views/styles/engraving.ts
```

- [ ] **Step 3: Shrink the roster**

In `src/views/renderStyle.ts`, remove the three imports and reduce `STYLES` to:

```ts
/** Every registered style, photoreal first. `pixelArt` is the only remaining
 * post-process skin — it becomes the `pixel` Look's pass in the Look roster. */
export const STYLES: RenderStyle[] = [
  photorealStyle,
  pixelArtStyle,
];
```

- [ ] **Step 4: Run the typecheck to find the fallout**

Run: `npm run build`
Expected: PASS. If it fails, it names an unremoved import — fix and re-run.

- [ ] **Step 5: Run the unit tests**

Run: `npm test`
Expected: PASS. If a test asserted a style count, update the expected number to 2.

- [ ] **Step 6: Update the e2e style roster test**

`e2e/smoke.spec.ts` iterates `[data-style]` buttons and screenshots each. It reads the roster from the DOM rather than hard-coding it, so it should pass unchanged — verify rather than assume.

Run: `npm run e2e`
Expected: PASS. If a test hard-codes five style ids, reduce the list to `photoreal` and `pixel-art`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(the-console): delete the cel, watercolor and engraving skins

Three of the five post-process skins earned no keep-decision in the
Console spec. photoreal and pixelArt survive; pixelArt becomes the
pixel Look's pass."
```

---

## Task 2: Delete the terraced and faceted globe styles

`GlobeStyle` shrinks from four variants to two. `quantizeBands` **stays** — the voxel builder shares the terraced banding helper, so removing the style does not remove the function.

**Files:**
- Modify: `src/views/globe.ts:290` (`GlobeStyle` type), `:1312-1345` (`geometryFamilyOf`, `setStyle`), `:480` (`bandM`)
- Modify: `src/ui/hud.ts:14-19` (`GLOBE_STYLES`)
- Modify: `src/ui/hud.test.ts`, `e2e/smoke.spec.ts`
- Leave alone: `src/views/worldMesh.ts` `quantizeBands` and every voxel builder

**Interfaces:**
- Consumes: nothing.
- Produces: `type GlobeStyle = 'smooth' | 'voxel'`. `geometryFamilyOf` returns `'smooth' | 'voxel'`.

- [ ] **Step 1: Confirm what shares the banding helper**

```bash
grep -rn "quantizeBands\|TERRACE_BAND_M\|bandM" src
```

Expected: `quantizeBands` is called by both the terraced path in `buildTileGeometry`/`buildRegionTileGeometry` **and** by `buildVoxelBlocks`. `TERRACE_BAND_M` is read only by `globe.ts`'s `bandM()`. This confirms the helper stays and only the style goes.

- [ ] **Step 2: Narrow the type**

In `src/views/globe.ts:290`:

```ts
export type GlobeStyle = 'smooth' | 'voxel';
```

- [ ] **Step 3: Simplify the two style functions**

Replace `geometryFamilyOf` and `setStyle` (`globe.ts:1312-1345`) with:

```ts
  /** Which geometry a style's tiles are built from. With `terraced` and
   * `faceted` gone the mapping is the identity — kept as a named function
   * because `setStyle` reads it twice and the Look axis may reintroduce a
   * material-only variant later. */
  const geometryFamilyOf = (s: GlobeStyle): 'smooth' | 'voxel' => s;

  function setStyle(style: GlobeStyle): void {
    const prevFamily = geometryFamilyOf(activeStyle);
    activeStyle = style;
    const nextFamily = geometryFamilyOf(activeStyle);
    // Voxel flat-shades: a blocky surface reads as such only without
    // smooth-shaded normals blurring the cliffs. Voxel's own per-cell flat
    // normals already agree with this.
    material.flatShading = activeStyle === 'voxel';
    material.needsUpdate = true;
    // As in `setTrueRelief`: `enqueueRebuildAll` iterates `currentSelected`
    // only, so a mounted-but-RETIRING tile keeps its OLD style for the few
    // frames before disposal. Deliberate and disclosed, not a hole.
    if (prevFamily !== nextFamily) enqueueRebuildAll();
  }
```

- [ ] **Step 4: Retire the terraced band**

`bandM()` (`globe.ts:480`) exists only to feed the terraced style. Replace it with a constant `undefined` and delete `TERRACE_BAND_M`:

```ts
  // No style bands its elevation any more (terraced is gone); the voxel
  // builder does its own banding internally. Kept as a named constant so
  // `buildTileSlot`'s call sites read unchanged.
  const bandM = (): number | undefined => undefined;
```

- [ ] **Step 5: Shrink the HUD roster**

`src/ui/hud.ts:14-19`:

```ts
export const GLOBE_STYLES: Array<{ id: GlobeStyle; label: string }> = [
  { id: 'smooth', label: 'smooth' },
  { id: 'voxel', label: 'voxel' },
];
```

- [ ] **Step 6: Run the gate**

Run: `npm run build && npm test`
Expected: PASS. The typecheck will name any remaining `'terraced'` or `'faceted'` literal — the compiler is doing the search for you.

- [ ] **Step 7: Run e2e**

Run: `npm run e2e`
Expected: PASS. `e2e/smoke.spec.ts:205` iterates the `.hud-style` select's own options, so it adapts. If any test hard-codes `terraced` or `faceted`, delete those cases.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(the-console): delete the terraced and faceted globe styles

GlobeStyle narrows to smooth | voxel. quantizeBands stays — the voxel
builder shares the terraced banding helper, so the style going away
does not take the function with it."
```

---

## Task 3: The Look axis

One axis replaces three. The HUD gets a single labeled Look picker in place of the style button row and both unlabeled dropdowns. This HUD edit is deliberately temporary — Stage 3 deletes `hud.ts` entirely — but it keeps the gate green and the change reviewable.

**Files:**
- Create: `src/views/look.ts`, `src/views/look.test.ts`
- Create: `src/views/stylePipeline.ts` (moved from `renderStyle.ts`)
- Delete: `src/views/renderStyle.ts`, `src/views/renderStyle.test.ts`
- Modify: `src/ui/hud.ts`, `src/ui/hud.test.ts`, `src/main.ts`
- Modify: `e2e/smoke.spec.ts`

**Interfaces:**
- Consumes: `GlobeStyle` from Task 2; `MapStyle` from `src/views/mapView.ts:40`; `pixelArtStyle` from `src/views/styles/pixelArt.ts`.
- Produces:
  - `interface Look { id: string; label: string; globeMesh: GlobeStyle; globeSurface: 'standard' | 'dither'; mapRung: MapStyle; postPasses(tiles: TilesScene): Pass[] }`
  - `const LOOKS: readonly Look[]`
  - `function lookById(id: string): Look` — falls back to `naturalLook`
  - `const naturalLook: Look`
  - `class StylePipeline` (unchanged behaviour) from `src/views/stylePipeline.ts`

- [ ] **Step 1: Write the failing test**

Create `src/views/look.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { LOOKS, lookById, naturalLook } from './look';

describe('the Look roster', () => {
  it('holds exactly the four Looks the Console spec names', () => {
    expect(LOOKS.map((l) => l.id)).toEqual(['natural', 'voxel', 'dither3d', 'pixel']);
  });

  it('gives every Look a unique id', () => {
    expect(new Set(LOOKS.map((l) => l.id)).size).toBe(LOOKS.length);
  });

  it('resolves a known id', () => {
    expect(lookById('voxel').globeMesh).toBe('voxel');
  });

  it('falls back to natural for an unknown id, so a bad URL never crashes', () => {
    expect(lookById('engraving')).toBe(naturalLook);
  });

  it('gives only the pixel Look a post-process pass', () => {
    for (const look of LOOKS) {
      const passCount = look.postPasses({} as never).length;
      expect(passCount).toBe(look.id === 'pixel' ? 1 : 0);
    }
  });

  it('routes each Look to a legal mesh, surface and map rung', () => {
    for (const look of LOOKS) {
      expect(['smooth', 'voxel']).toContain(look.globeMesh);
      expect(['standard', 'dither']).toContain(look.globeSurface);
      expect(['voxel', 'pixel']).toContain(look.mapRung);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/views/look.test.ts`
Expected: FAIL — `Failed to resolve import "./look"`.

- [ ] **Step 3: Move StylePipeline to its own file**

Create `src/views/stylePipeline.ts` holding the `StylePipeline` class copied verbatim from `renderStyle.ts:46-93`, with its imports (`three`, `EffectComposer`, `RenderPass`, `Pass`, `TilesScene`). Change its `setStyle(style: RenderStyle)` signature to take the pass list directly, since `RenderStyle` is going away:

```ts
  /** Rebuild the composer's pass chain: the base RenderPass + `passes`.
   * The last pass renders to screen. An empty list is the identity
   * (photoreal) — the composer renders exactly as a plain
   * `renderer.render(scene, camera)` would. */
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
```

Keep the constructor's opaque-clear comment (`renderStyle.ts:60-67`) verbatim — it documents a bug that cost a black screen.

- [ ] **Step 4: Write the Look module**

Create `src/views/look.ts`:

```ts
/** A LOOK is how the world is drawn — one axis replacing the three the HUD
 * used to expose separately (`RenderStyle`, a post-process chain; `GlobeStyle`,
 * the globe mesh's geometry; `MapStyle`, the map rung's rendering). A viewer
 * has no way to tell those apart, so they are one choice here.
 *
 * Orthogonal to the data LENS (`./lens`), which chooses what data is coloured.
 * Colours and shading are presentation only (decision 0022).
 *
 * Only genuinely Look-specific settings belong in a Look. `waves`, `glint`,
 * `night fill` and the scale controls apply across several Looks, so they are
 * permanent control-registry entries, not Look-contributed ones. */
import type { Pass } from 'three/addons/postprocessing/Pass.js';
import type { TilesScene } from '../sim/scene';
import type { GlobeStyle } from './globe';
import type { MapStyle } from './mapView';
import { pixelArtStyle } from './styles/pixelArt';

export interface Look {
  /** Stable id — the URL codec writes it and the control registry keys on it. */
  id: string;
  label: string;
  /** Which worldMesh build path the globe's tiles use. */
  globeMesh: GlobeStyle;
  /** Which material the globe's surface wears. `dither` arrives in Stage 5;
   * until then every Look is `standard` and the globe ignores the field. */
  globeSurface: 'standard' | 'dither';
  /** How the map rung renders. */
  mapRung: MapStyle;
  /** Screen-space passes over the rendered globe frame. Empty for every Look
   * but `pixel` — the surface-level Looks do their work in the material. */
  postPasses(tiles: TilesScene): Pass[];
}

export const naturalLook: Look = {
  id: 'natural',
  label: 'natural',
  globeMesh: 'smooth',
  globeSurface: 'standard',
  mapRung: 'voxel',
  postPasses: () => [],
};

export const voxelLook: Look = {
  id: 'voxel',
  label: 'voxel',
  globeMesh: 'voxel',
  globeSurface: 'standard',
  mapRung: 'voxel',
  postPasses: () => [],
};

/** Surface-Stable Fractal Dithering. `globeSurface: 'dither'` is inert until
 * Stage 5 builds the material — the Look is registered now so the roster,
 * the URL codec and the picker are all settled before the shader lands. */
export const dither3dLook: Look = {
  id: 'dither3d',
  label: 'dither3d',
  globeMesh: 'smooth',
  globeSurface: 'dither',
  mapRung: 'voxel',
  postPasses: () => [],
};

export const pixelLook: Look = {
  id: 'pixel',
  label: 'pixel',
  globeMesh: 'smooth',
  globeSurface: 'standard',
  mapRung: 'pixel',
  postPasses: (tiles) => pixelArtStyle.passes(tiles),
};

export const LOOKS: readonly Look[] = [naturalLook, voxelLook, dither3dLook, pixelLook];

/** The Look with this id, or `natural` if none matches — a stale link from
 * before a Look was renamed opens the world rather than erroring. */
export function lookById(id: string): Look {
  return LOOKS.find((l) => l.id === id) ?? naturalLook;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/views/look.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Delete renderStyle and route main.ts through the Look**

```bash
git rm src/views/renderStyle.ts
git rm -f src/views/renderStyle.test.ts 2>/dev/null || true
```

In `src/main.ts`: replace the `StylePipeline, styleById` import with `StylePipeline` from `./views/stylePipeline` and `lookById, naturalLook` from `./views/look`. Replace `stylePipeline.setStyle(styleById('photoreal'))` (`main.ts:310`) with `stylePipeline.setPasses(naturalLook.postPasses(tiles))`, and replace the three separate callbacks `onStyle` / `onGlobeStyle` / `onMapStyle` (`main.ts:650-661`) with one:

```ts
    onLook(id) {
      const look = lookById(id);
      stylePipeline.setPasses(look.postPasses(tiles));
      globeView.setStyle(look.globeMesh);
      mapView.setStyle(look.mapRung);
      hud.setLook(look);
    },
```

Replace the three boot-time reflection lines (`main.ts:725-727`) with `hud.setLook(naturalLook);`.

- [ ] **Step 7: Replace three HUD controls with one**

In `src/ui/hud.ts`: delete `GLOBE_STYLES`, `MAP_STYLES`, the `styleRow` block (`:306-314`), `globeStyleSelect` (`:324-332`) and `mapStyleSelect` (`:341-349`). Delete `onStyle` / `onGlobeStyle` / `onMapStyle` from `HudCallbacks` and `setStyle` / `setGlobeStyle` / `setMapStyle` from `Hud`. Add one labeled picker:

```ts
  // One labeled Look picker replaces the style button row and both
  // unlabeled dropdowns. Temporary: Stage 3 deletes this whole module in
  // favour of the registry-driven sheet.
  const lookRow = el('div', 'hud-looks');
  lookRow.append(el('span', 'hud-look-label', 'Look'));
  const lookSelect = el('select', 'hud-look');
  lookSelect.name = 'look-select';
  for (const look of LOOKS) {
    const o = document.createElement('option');
    o.value = look.id;
    o.textContent = look.label;
    lookSelect.appendChild(o);
  }
  lookSelect.addEventListener('change', () => cb.onLook(lookSelect.value));
  lookRow.append(lookSelect);
```

Append `lookRow` to `lensPanel` where `styleRow` used to go, and add `setLook: (look: Look) => { lookSelect.value = look.id; }` to the returned `Hud`.

- [ ] **Step 8: Update the HUD test's noop**

In `src/ui/hud.test.ts`, drop `onStyle`, `onGlobeStyle`, `onMapStyle` from the `noop` object and add `onLook(_: string) {}`. Remove the `photorealStyle`, `GlobeStyle`, `MapStyle`, `GLOBE_STYLES`, `MAP_STYLES` imports. Add:

```ts
  it('the Look picker reports the chosen id', () => {
    const root = document.createElement('div');
    let got: string | null = null;
    buildHud(root, '42', { ...noop, onLook: (id) => { got = id; } });
    const sel = root.querySelector('select[name="look-select"]') as HTMLSelectElement;
    sel.value = 'dither3d';
    sel.dispatchEvent(new Event('change'));
    expect(got).toBe('dither3d');
  });
```

- [ ] **Step 9: Update e2e**

In `e2e/smoke.spec.ts`, replace the two roster tests (`:205` `.hud-style` and `:401` `.hud-map-style`) with one that walks `.hud-look`'s options and asserts each renders a non-blank globe. Replace every other `.hud-style` / `.hud-map-style` / `[data-style]` locator with `.hud-look`.

- [ ] **Step 10: Run the full gate**

Run: `npm test && npm run smoke && npm run build && npm run e2e`
Expected: all four PASS.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat(the-console): one Look axis replaces three style axes

RenderStyle, GlobeStyle and MapStyle were three separate pickers for a
distinction no viewer can see — and two of them were unlabeled
dropdowns. Look is one choice that declares its mesh, its surface and
its map rung. StylePipeline survives as the post-pass host; the
RenderStyle type, STYLES, photorealStyle and styleById are deleted.

The hud.ts edit here is deliberately temporary — Stage 3 deletes the
module — but it keeps the gate green and the diff reviewable."
```

---

# Stage 2 — Registry

## Task 4: Control kinds and the store

Pure data and a pure store. No DOM, no three.js.

**Files:**
- Create: `src/ui/controls/kinds.ts`
- Create: `src/ui/controls/store.ts`, `src/ui/controls/store.test.ts`

**Interfaces:**
- Consumes: `ZoomTarget` from `src/views/zoom.ts`; `TilesScene` from `src/sim/scene.ts`.
- Produces:
  - `type GroupId`, `type Availability`, `type Control`, `interface ControlContext`, `type ControlValue = boolean | string | number`
  - `function defaultValueOf(c: Control): ControlValue | undefined` — `undefined` for actions
  - `class ControlStore` with `get(id)`, `set(id, v)`, `run(id)`, `nonDefaults()`, `subscribe(fn: (changedId: string | null) => void): () => void`, `reset()`

**Why `subscribe` reports which id changed.** The sheet re-renders on a store change, and a full re-render replaces the DOM node that fired the event. For a toggle or a choice that is fine — the click is already over. For a **slider** it is not: replacing the `<input>` mid-drag ends the drag, so a phone user could move a slider exactly one step per touch. Passing the changed id lets the sheet skip the re-render for slider writes, which need no structural change anyway.

- [ ] **Step 1: Write the kinds module**

Create `src/ui/controls/kinds.ts`:

```ts
/** A CONTROL is one thing the viewer can change, described as data rather
 * than wired by hand. Four kinds cover the whole surface; anything that
 * doesn't fit stays bespoke (the day scrubber and the info card, by
 * decision — see the Console spec §1).
 *
 * The point of the indirection is that adding a control costs ONE entry:
 * the sheet renderer, the URL codec and the availability/disabled treatment
 * are all generic over this type. The old HUD threaded each control through
 * four places plus a test edit. */
import type { ZoomTarget } from '../../views/zoom';
import type { TilesScene } from '../../sim/scene';

export type GroupId = 'lens' | 'look' | 'layers' | 'time' | 'world';

/** Why a control cannot be used right now. The reason is shown to the
 * viewer next to the disabled control — never a silently missing control. */
export type Availability = { ok: true } | { ok: false; reason: string };

export const AVAILABLE: Availability = { ok: true };

/** What `available()` gets to decide on. */
export interface ControlContext {
  rung: ZoomTarget;
  tiles: TilesScene;
  lookId: string;
}

export type ControlValue = boolean | string | number;

interface ControlBase {
  /** Stable. The URL codec writes it, e2e addresses it, the DOM carries it
   * as `data-control`. One name, three consumers — never rename casually. */
  id: string;
  label: string;
  group: GroupId;
  /** Caption shown beneath the control. */
  help?: string;
  /** Absent means always available. */
  available?(ctx: ControlContext): Availability;
}

export interface Toggle extends ControlBase {
  kind: 'toggle';
  default: boolean;
  apply(v: boolean): void;
}

export interface Choice extends ControlBase {
  kind: 'choice';
  options: Array<{ id: string; label: string }>;
  default: string;
  apply(v: string): void;
}

export interface Slider extends ControlBase {
  kind: 'slider';
  min: number;
  max: number;
  step: number;
  default: number;
  apply(v: number): void;
  /** How the current value reads next to the label. Defaults to the raw number. */
  format?(v: number): string;
}

export interface Action extends ControlBase {
  kind: 'action';
  run(): void;
}

export type Control = Toggle | Choice | Slider | Action;

/** An action has no value; everything else does. */
export function defaultValueOf(c: Control): ControlValue | undefined {
  return c.kind === 'action' ? undefined : c.default;
}

/** Whether `c` may be used under `ctx`. Controls with no predicate are
 * always available. */
export function availabilityOf(c: Control, ctx: ControlContext): Availability {
  return c.available ? c.available(ctx) : AVAILABLE;
}
```

- [ ] **Step 2: Write the failing store test**

Create `src/ui/controls/store.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { Control } from './kinds';
import { ControlStore } from './store';

function fixture(applied: string[] = []): Control[] {
  return [
    { kind: 'toggle', id: 'winds', label: 'winds', group: 'layers', default: false,
      apply: (v) => { applied.push(`winds:${v}`); } },
    { kind: 'choice', id: 'look', label: 'Look', group: 'look',
      options: [{ id: 'natural', label: 'natural' }, { id: 'voxel', label: 'voxel' }],
      default: 'natural', apply: (v) => { applied.push(`look:${v}`); } },
    { kind: 'slider', id: 'dot-scale', label: 'dot scale', group: 'look',
      min: 0.5, max: 4, step: 0.1, default: 1, apply: (v) => { applied.push(`dot:${v}`); } },
    { kind: 'action', id: 'reroll', label: 'reroll', group: 'world', run: () => {} },
  ];
}

describe('ControlStore', () => {
  it('starts every control at its default', () => {
    const store = new ControlStore(fixture());
    expect(store.get('winds')).toBe(false);
    expect(store.get('look')).toBe('natural');
    expect(store.get('dot-scale')).toBe(1);
  });

  it('holds no value for an action', () => {
    const store = new ControlStore(fixture());
    expect(store.get('reroll')).toBeUndefined();
  });

  it('calls the control apply on set', () => {
    const applied: string[] = [];
    const store = new ControlStore(fixture(applied));
    store.set('winds', true);
    expect(applied).toEqual(['winds:true']);
    expect(store.get('winds')).toBe(true);
  });

  it('notifies subscribers with the changed id, and stops after unsubscribe', () => {
    const store = new ControlStore(fixture());
    const seen = vi.fn();
    const off = store.subscribe(seen);
    store.set('winds', true);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenLastCalledWith('winds');
    off();
    store.set('winds', false);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('notifies with null on reset, since no single control changed', () => {
    const store = new ControlStore(fixture());
    const seen = vi.fn();
    store.subscribe(seen);
    store.reset();
    expect(seen).toHaveBeenLastCalledWith(null);
  });

  it('reports only the values that differ from their default', () => {
    const store = new ControlStore(fixture());
    expect(store.nonDefaults()).toEqual({});
    store.set('winds', true);
    store.set('dot-scale', 2.5);
    expect(store.nonDefaults()).toEqual({ winds: true, 'dot-scale': 2.5 });
  });

  it('drops a value back out of nonDefaults when it returns to its default', () => {
    const store = new ControlStore(fixture());
    store.set('winds', true);
    store.set('winds', false);
    expect(store.nonDefaults()).toEqual({});
  });

  it('ignores a set for an unknown id rather than throwing', () => {
    const store = new ControlStore(fixture());
    expect(() => store.set('no-such-control', true)).not.toThrow();
    expect(store.get('no-such-control')).toBeUndefined();
  });

  it('reset restores every default and re-applies', () => {
    const applied: string[] = [];
    const store = new ControlStore(fixture(applied));
    store.set('winds', true);
    applied.length = 0;
    store.reset();
    expect(store.get('winds')).toBe(false);
    expect(applied).toContain('winds:false');
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run src/ui/controls/store.test.ts`
Expected: FAIL — `Failed to resolve import "./store"`.

- [ ] **Step 4: Write the store**

Create `src/ui/controls/store.ts`:

```ts
/** Holds every control's current value and calls its `apply` when it
 * changes. No DOM: the sheet renderer subscribes, it is not consulted.
 *
 * Values for controls that are not currently RENDERED are still held here —
 * a Look's own settings persist while another Look is showing, so switching
 * away and back restores them, and a shared link carries them. */
import type { Control, ControlValue } from './kinds';
import { defaultValueOf } from './kinds';

export class ControlStore {
  private readonly byId = new Map<string, Control>();
  private readonly values = new Map<string, ControlValue>();
  private readonly listeners = new Set<(changedId: string | null) => void>();

  constructor(controls: readonly Control[]) {
    for (const c of controls) {
      this.byId.set(c.id, c);
      const d = defaultValueOf(c);
      if (d !== undefined) this.values.set(c.id, d);
    }
  }

  get(id: string): ControlValue | undefined {
    return this.values.get(id);
  }

  /** Set `id` to `v`, run its side effect, notify. An unknown id is ignored
   * rather than fatal — the same tolerance the URL codec relies on. */
  set(id: string, v: ControlValue): void {
    const c = this.byId.get(id);
    if (!c || c.kind === 'action') return;
    this.values.set(id, v);
    applyTo(c, v);
    this.notify(id);
  }

  /** Run an action's side effect. Actions hold no value, so this notifies
   * nothing — whatever the action changed reports itself. */
  run(id: string): void {
    const c = this.byId.get(id);
    if (c?.kind === 'action') c.run();
  }

  /** Only what differs from the defaults — what the codec serializes, so a
   * plain link stays plain. */
  nonDefaults(): Record<string, ControlValue> {
    const out: Record<string, ControlValue> = {};
    for (const [id, v] of this.values) {
      const c = this.byId.get(id)!;
      if (v !== defaultValueOf(c)) out[id] = v;
    }
    return out;
  }

  reset(): void {
    for (const [id, c] of this.byId) {
      const d = defaultValueOf(c);
      if (d === undefined) continue;
      this.values.set(id, d);
      applyTo(c, d);
    }
    this.notify(null);
  }

  /** `fn` receives the id that changed, or null when many did (a reset).
   * Subscribers that rebuild DOM use it to avoid replacing the very element
   * that is mid-interaction — see the sheet's slider guard. */
  subscribe(fn: (changedId: string | null) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private notify(changedId: string | null): void {
    for (const fn of this.listeners) fn(changedId);
  }
}

/** Narrow `v` to the kind's own parameter type. The store's map is typed on
 * the union, so each branch needs its own cast — one place, not per call site. */
function applyTo(c: Control, v: ControlValue): void {
  if (c.kind === 'toggle') c.apply(v as boolean);
  else if (c.kind === 'choice') c.apply(v as string);
  else if (c.kind === 'slider') c.apply(v as number);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/ui/controls/store.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Run the gate**

Run: `npm test && npm run build`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(the-console): control kinds and the control store

Four kinds cover the whole surface. The store holds values (including
for controls not currently rendered, so a Look's settings survive
switching away) and calls apply on change. Pure: no DOM, no three."
```

---

## Task 5: The codec

Encode non-defaults compactly; decode tolerantly. The tolerance IS the versioning story — an unknown id is ignored, an out-of-range number clamps, so renaming or deleting a control degrades an old link instead of breaking it.

**Files:**
- Create: `src/ui/controls/codec.ts`, `src/ui/controls/codec.test.ts`

**Interfaces:**
- Consumes: `Control`, `ControlValue` from `./kinds`.
- Produces:
  - `function encodeControls(nonDefaults: Record<string, ControlValue>): string` — `''` when empty
  - `function decodeControls(encoded: string, controls: readonly Control[]): Record<string, ControlValue>`

**Encoding:** `id:value` pairs joined by `,`. Booleans are `1`/`0`, numbers are decimal trimmed to 4 places, strings verbatim. Ids and choice values are restricted to `[a-z0-9-]` by the registry test in Task 8, so no escaping is needed — the codec asserts nothing about that and simply drops a pair it cannot parse.

- [ ] **Step 1: Write the failing test**

Create `src/ui/controls/codec.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Control } from './kinds';
import { decodeControls, encodeControls } from './codec';

const CONTROLS: Control[] = [
  { kind: 'toggle', id: 'winds', label: 'winds', group: 'layers', default: false, apply: () => {} },
  { kind: 'toggle', id: 'glint', label: 'glint', group: 'look', default: true, apply: () => {} },
  { kind: 'choice', id: 'look', label: 'Look', group: 'look',
    options: [{ id: 'natural', label: 'natural' }, { id: 'dither3d', label: 'dither3d' }],
    default: 'natural', apply: () => {} },
  { kind: 'slider', id: 'dot-scale', label: 'dot scale', group: 'look',
    min: 0.5, max: 4, step: 0.1, default: 1, apply: () => {} },
  { kind: 'action', id: 'reroll', label: 'reroll', group: 'world', run: () => {} },
];

describe('the control codec', () => {
  it('encodes nothing when everything is at its default', () => {
    expect(encodeControls({})).toBe('');
  });

  it('round-trips a mixed set', () => {
    const values = { winds: true, glint: false, look: 'dither3d', 'dot-scale': 2.5 };
    expect(decodeControls(encodeControls(values), CONTROLS)).toEqual(values);
  });

  it('writes booleans as 1 and 0', () => {
    expect(encodeControls({ winds: true, glint: false })).toBe('winds:1,glint:0');
  });

  it('decodes an empty string to an empty set', () => {
    expect(decodeControls('', CONTROLS)).toEqual({});
  });

  it('ignores an unknown id rather than failing — a renamed control degrades an old link', () => {
    expect(decodeControls('engraving:1,winds:1', CONTROLS)).toEqual({ winds: true });
  });

  it('ignores a malformed pair', () => {
    expect(decodeControls('winds,glint:0', CONTROLS)).toEqual({ glint: false });
  });

  it('clamps a slider value outside its range', () => {
    expect(decodeControls('dot-scale:99', CONTROLS)).toEqual({ 'dot-scale': 4 });
    expect(decodeControls('dot-scale:-5', CONTROLS)).toEqual({ 'dot-scale': 0.5 });
  });

  it('drops a non-numeric slider value', () => {
    expect(decodeControls('dot-scale:huge', CONTROLS)).toEqual({});
  });

  it('drops a choice value that is not one of its options', () => {
    expect(decodeControls('look:watercolor', CONTROLS)).toEqual({});
  });

  it('drops a value for an action, which holds none', () => {
    expect(decodeControls('reroll:1', CONTROLS)).toEqual({});
  });

  it('keeps a shared link short by trimming trailing zeros', () => {
    expect(encodeControls({ 'dot-scale': 2.5 })).toBe('dot-scale:2.5');
    expect(encodeControls({ 'dot-scale': 2 })).toBe('dot-scale:2');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/ui/controls/codec.test.ts`
Expected: FAIL — `Failed to resolve import "./codec"`.

- [ ] **Step 3: Write the codec**

Create `src/ui/controls/codec.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/ui/controls/codec.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Run the gate**

Run: `npm test && npm run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(the-console): the control codec

Encodes only non-defaults so a plain link stays plain. Decode is
forgiving on purpose: unknown ids ignored, sliders clamped, bad
choices dropped — that tolerance is the versioning story, so a
renamed control degrades an old link instead of breaking it."
```

---

# Stage 3 — Surface

## Task 6: The generic sheet renderer

Renders groups of controls from a registry it knows nothing about. Its test uses a **fake** registry deliberately, so adding a real control never edits this test — the opposite of today's `hud.test.ts`.

**Files:**
- Create: `src/ui/sheet.ts`, `src/ui/sheet.test.ts`

**Interfaces:**
- Consumes: `Control`, `ControlContext`, `GroupId`, `availabilityOf` from `./controls/kinds`; `ControlStore` from `./controls/store`.
- Produces:
  - `interface SheetTab { group: GroupId; label: string }`
  - `interface Sheet { render(ctx: ControlContext): void; setTab(group: GroupId): void; activeTab(): GroupId; element: HTMLElement }`
  - `function buildSheet(opts: { controls: readonly Control[]; store: ControlStore; tabs: readonly SheetTab[] }): Sheet`

**DOM contract** (Task 10's e2e depends on it exactly):
- Root `<div class="sheet">`, containing `<div class="sheet-tabs">` then `<div class="sheet-body">`.
- Each tab button: `<button class="sheet-tab" data-tab="<group>">`, active one also carries `class="active"`.
- Each control's wrapper: `<div class="control" data-control="<id>">`.
- Toggle → one `<button>`; choice → one `<button>` per option carrying `data-option="<optionId>"`; slider → one `<input type="range">`; action → one `<button>`.
- An unavailable control's wrapper gains `class="unavailable"`, its inputs are `disabled`, and a `<div class="control-reason">` holds the reason text.

- [ ] **Step 1: Write the failing test**

Create `src/ui/sheet.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Control, ControlContext } from './controls/kinds';
import { ControlStore } from './controls/store';
import { buildSheet } from './sheet';

/** A FAKE registry. The point of the sheet is that it is generic over the
 * control list, so this test must never need editing when a real control is
 * added — if it does, the renderer has grown a special case. */
function fakeControls(log: string[] = []): Control[] {
  return [
    { kind: 'toggle', id: 'alpha', label: 'Alpha', group: 'layers', default: false,
      apply: (v) => { log.push(`alpha:${v}`); } },
    { kind: 'toggle', id: 'beta', label: 'Beta', group: 'layers', default: false,
      help: 'the second one',
      available: (ctx) => ctx.rung === 'globe' ? { ok: true } : { ok: false, reason: 'globe only' },
      apply: () => {} },
    { kind: 'choice', id: 'gamma', label: 'Gamma', group: 'look',
      options: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }],
      default: 'one', apply: (v) => { log.push(`gamma:${v}`); } },
    { kind: 'slider', id: 'delta', label: 'Delta', group: 'look',
      min: 0, max: 10, step: 1, default: 5, apply: (v) => { log.push(`delta:${v}`); } },
    { kind: 'action', id: 'epsilon', label: 'Epsilon', group: 'world',
      run: () => { log.push('epsilon'); } },
  ];
}

const TABS = [
  { group: 'layers' as const, label: 'Layers' },
  { group: 'look' as const, label: 'Look' },
];

const GLOBE: ControlContext = { rung: 'globe', tiles: {} as never, lookId: 'natural' };
const SYSTEM: ControlContext = { rung: 'system', tiles: {} as never, lookId: 'natural' };

function mount(log: string[] = [], ctx = GLOBE) {
  const controls = fakeControls(log);
  const store = new ControlStore(controls);
  const sheet = buildSheet({ controls, store, tabs: TABS });
  sheet.render(ctx);
  return { sheet, store, el: sheet.element };
}

describe('the sheet renderer', () => {
  it('renders one tab button per tab', () => {
    const { el } = mount();
    expect([...el.querySelectorAll('.sheet-tab')].map((t) => t.getAttribute('data-tab')))
      .toEqual(['layers', 'look']);
  });

  it('shows only the active tab group', () => {
    const { el } = mount();
    expect(el.querySelector('[data-control="alpha"]')).not.toBeNull();
    expect(el.querySelector('[data-control="gamma"]')).toBeNull();
  });

  it('switches groups when a tab is clicked', () => {
    const { el, sheet } = mount();
    (el.querySelector('.sheet-tab[data-tab="look"]') as HTMLButtonElement).click();
    expect(sheet.activeTab()).toBe('look');
    expect(el.querySelector('[data-control="gamma"]')).not.toBeNull();
    expect(el.querySelector('[data-control="alpha"]')).toBeNull();
  });

  it('marks the active tab', () => {
    const { el } = mount();
    const active = [...el.querySelectorAll('.sheet-tab.active')];
    expect(active.length).toBe(1);
    expect(active[0]!.getAttribute('data-tab')).toBe('layers');
  });

  it('a toggle click writes through the store to the control', () => {
    const log: string[] = [];
    const { el, store } = mount(log);
    (el.querySelector('[data-control="alpha"] button') as HTMLButtonElement).click();
    expect(store.get('alpha')).toBe(true);
    expect(log).toEqual(['alpha:true']);
  });

  it('a choice renders one button per option and reports the chosen id', () => {
    const log: string[] = [];
    const { el, sheet, store } = mount(log);
    sheet.setTab('look');
    const opts = [...el.querySelectorAll('[data-control="gamma"] [data-option]')];
    expect(opts.map((o) => o.getAttribute('data-option'))).toEqual(['one', 'two']);
    (opts[1] as HTMLButtonElement).click();
    expect(store.get('gamma')).toBe('two');
    expect(log).toEqual(['gamma:two']);
  });

  it('a slider reports its numeric value', () => {
    const log: string[] = [];
    const { el, sheet, store } = mount(log);
    sheet.setTab('look');
    const input = el.querySelector('[data-control="delta"] input') as HTMLInputElement;
    expect(input.value).toBe('5');
    input.value = '8';
    input.dispatchEvent(new Event('input'));
    expect(store.get('delta')).toBe(8);
    expect(log).toEqual(['delta:8']);
  });

  it('does NOT replace the slider element on a slider write — a re-render mid-drag would end the drag', () => {
    const { el, sheet } = mount();
    sheet.setTab('look');
    const before = el.querySelector('[data-control="delta"] input') as HTMLInputElement;
    before.value = '8';
    before.dispatchEvent(new Event('input'));
    const after = el.querySelector('[data-control="delta"] input');
    expect(after).toBe(before);
    expect(el.querySelector('[data-control="delta"] .control-value')!.textContent).toBe('8');
  });

  it('DOES re-render on a choice write, so the newly active option is marked', () => {
    const { el, sheet } = mount();
    sheet.setTab('look');
    (el.querySelector('[data-control="gamma"] [data-option="two"]') as HTMLButtonElement).click();
    const active = el.querySelectorAll('[data-control="gamma"] .control-option.active');
    expect(active.length).toBe(1);
    expect(active[0]!.getAttribute('data-option')).toBe('two');
  });

  it('an unavailable control is disabled and says why', () => {
    const { el } = mount([], SYSTEM);
    const beta = el.querySelector('[data-control="beta"]')!;
    expect(beta.classList.contains('unavailable')).toBe(true);
    expect((beta.querySelector('button') as HTMLButtonElement).disabled).toBe(true);
    expect(beta.querySelector('.control-reason')!.textContent).toBe('globe only');
  });

  it('an available control carries no reason', () => {
    const { el } = mount();
    const beta = el.querySelector('[data-control="beta"]')!;
    expect(beta.classList.contains('unavailable')).toBe(false);
    expect(beta.querySelector('.control-reason')).toBeNull();
  });

  it('renders a controls help text as its caption', () => {
    const { el } = mount();
    expect(el.querySelector('[data-control="beta"] .control-help')!.textContent)
      .toBe('the second one');
  });

  it('re-render reflects a context change without losing the active tab', () => {
    const { el, sheet } = mount([], GLOBE);
    sheet.setTab('layers');
    sheet.render(SYSTEM);
    expect(sheet.activeTab()).toBe('layers');
    expect(el.querySelector('[data-control="beta"]')!.classList.contains('unavailable')).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/ui/sheet.test.ts`
Expected: FAIL — `Failed to resolve import "./sheet"`.

- [ ] **Step 3: Write the sheet renderer**

Create `src/ui/sheet.ts`:

```ts
/** Renders the control registry as a tabbed sheet. Knows NOTHING about any
 * individual control — it walks `controls`, groups by `group`, and asks each
 * one's `available()` whether to disable it. That is the whole point: adding
 * a control edits the registry, not this file and not its test. */
import type { Control, ControlContext, GroupId } from './controls/kinds';
import { availabilityOf } from './controls/kinds';
import type { ControlStore } from './controls/store';

export interface SheetTab {
  group: GroupId;
  label: string;
}

export interface Sheet {
  element: HTMLElement;
  /** Rebuild the body for `ctx` (availability depends on it). Keeps the tab. */
  render(ctx: ControlContext): void;
  setTab(group: GroupId): void;
  activeTab(): GroupId;
}

export function buildSheet(opts: {
  controls: readonly Control[];
  store: ControlStore;
  tabs: readonly SheetTab[];
}): Sheet {
  const { controls, store, tabs } = opts;
  const element = el('div', 'sheet');
  const grabber = el('div', 'sheet-grabber');
  const tabRow = el('div', 'sheet-tabs');
  const body = el('div', 'sheet-body');
  element.append(grabber, tabRow, body);

  let active: GroupId = tabs[0]!.group;
  let lastCtx: ControlContext | null = null;

  for (const tab of tabs) {
    const b = el('button', 'sheet-tab');
    b.dataset.tab = tab.group;
    b.textContent = tab.label;
    b.addEventListener('click', () => { setTab(tab.group); });
    tabRow.appendChild(b);
  }

  function markTabs(): void {
    for (const b of tabRow.querySelectorAll('.sheet-tab')) {
      b.classList.toggle('active', (b as HTMLElement).dataset.tab === active);
    }
  }

  function render(ctx: ControlContext): void {
    lastCtx = ctx;
    markTabs();
    body.replaceChildren();
    for (const c of controls) {
      if (c.group !== active) continue;
      body.appendChild(renderControl(c, ctx, store));
    }
  }

  function setTab(group: GroupId): void {
    active = group;
    if (lastCtx) render(lastCtx);
    else markTabs();
  }

  // Most store changes may alter what should be displayed — a Look switch
  // changes which settings are available, a toggle flips its own active
  // class — so they re-render the visible group.
  //
  // A SLIDER write must not. A re-render replaces the <input> that is
  // currently under the user's finger, which ends the drag: the slider would
  // move exactly one step per touch. A slider write needs no structural
  // change anyway (its readout is updated locally), so it is skipped.
  const sliderIds = new Set(controls.filter((c) => c.kind === 'slider').map((c) => c.id));
  store.subscribe((changedId) => {
    if (changedId !== null && sliderIds.has(changedId)) return;
    if (lastCtx) render(lastCtx);
  });

  return { element, render, setTab, activeTab: () => active };
}

function renderControl(c: Control, ctx: ControlContext, store: ControlStore): HTMLElement {
  const wrap = el('div', 'control');
  wrap.dataset.control = c.id;
  const avail = availabilityOf(c, ctx);
  const disabled = !avail.ok;
  if (disabled) wrap.classList.add('unavailable');

  const label = el('div', 'control-label');
  label.textContent = c.label;
  wrap.appendChild(label);

  if (c.kind === 'toggle') {
    const b = el('button', 'control-toggle');
    b.textContent = c.label;
    b.disabled = disabled;
    b.classList.toggle('active', store.get(c.id) === true);
    b.addEventListener('click', () => { store.set(c.id, store.get(c.id) !== true); });
    wrap.appendChild(b);
  } else if (c.kind === 'choice') {
    const row = el('div', 'control-options');
    for (const o of c.options) {
      const b = el('button', 'control-option');
      b.dataset.option = o.id;
      b.textContent = o.label;
      b.disabled = disabled;
      b.classList.toggle('active', store.get(c.id) === o.id);
      b.addEventListener('click', () => { store.set(c.id, o.id); });
      row.appendChild(b);
    }
    wrap.appendChild(row);
  } else if (c.kind === 'slider') {
    const input = document.createElement('input');
    input.type = 'range';
    input.className = 'control-slider';
    input.min = String(c.min);
    input.max = String(c.max);
    input.step = String(c.step);
    input.value = String(store.get(c.id) ?? c.default);
    input.disabled = disabled;
    const readout = el('span', 'control-value');
    const show = (v: number): void => { readout.textContent = c.format ? c.format(v) : String(v); };
    show(Number(input.value));
    input.addEventListener('input', () => {
      const v = Number(input.value);
      show(v);
      store.set(c.id, v);
    });
    const row = el('div', 'control-slider-row');
    row.append(input, readout);
    wrap.appendChild(row);
  } else {
    const b = el('button', 'control-action');
    b.textContent = c.label;
    b.disabled = disabled;
    b.addEventListener('click', () => { store.run(c.id); });
    wrap.appendChild(b);
  }

  if (c.help !== undefined) {
    const help = el('div', 'control-help');
    help.textContent = c.help;
    wrap.appendChild(help);
  }
  if (!avail.ok) {
    const reason = el('div', 'control-reason');
    reason.textContent = avail.reason;
    wrap.appendChild(reason);
  }
  return wrap;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/ui/sheet.test.ts`
Expected: PASS, 13 tests.

If the "does NOT replace the slider element" test fails, the slider guard is missing or `subscribe` is not passing the changed id — go back to Task 4's store before patching the sheet.

- [ ] **Step 5: Run the gate**

Run: `npm test && npm run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(the-console): the generic sheet renderer

Walks the control registry and groups by tab. Knows nothing about any
individual control; availability, disabling and the reason text are all
generic. Its test uses a FAKE registry on purpose, so adding a real
control never edits it — the opposite of hud.test.ts's per-callback noop."
```

---

## Task 7: The status bar and the transport

The two pieces of persistent chrome. The transport owns the day scrubber, which stays bespoke by decision — it carries eclipse marks and must distinguish a user drag from autoplay driving it.

**Files:**
- Create: `src/ui/statusBar.ts`, `src/ui/statusBar.test.ts`
- Create: `src/ui/transport.ts`, `src/ui/transport.test.ts`

**Interfaces:**
- Consumes: `ZoomTarget` from `src/views/zoom.ts`; `EclipseEvent` from `src/sim/scene.ts`; `eclipseMarkPositions` from `./eclipseMarks`.
- Produces:
  - `interface StatusBar { element: HTMLElement; setRung(v: ZoomTarget): void; setDate(s: string): void; setLens(label: string): void; setSeed(seed: string): void; flashShared(): void }`
  - `function buildStatusBar(cb: { onRung(v: ZoomTarget): void; onOverflow(): void; onLensChip(): void; onDateChip(): void }): StatusBar`
  - `interface Transport { element: HTMLElement; setPaused(p: boolean): void; setDay(day: number): void; setDayRange(maxDay: number): void; setRateLabel(s: string): void; setEclipses(events: EclipseEvent[], maxDay: number): void }`
  - `function buildTransport(cb: { onPlayPause(): void; onScrub(day: number): void; onEclipseMark(e: EclipseEvent): void; onRateChip(): void }): Transport`

- [ ] **Step 1: Write the failing status-bar test**

Create `src/ui/statusBar.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildStatusBar } from './statusBar';
import type { ZoomTarget } from '../views/zoom';

const noop = { onRung(_: ZoomTarget) {}, onOverflow() {}, onLensChip() {}, onDateChip() {} };

describe('the status bar', () => {
  it('offers all three rungs', () => {
    const bar = buildStatusBar(noop);
    expect([...bar.element.querySelectorAll('[data-rung]')].map((b) => b.getAttribute('data-rung')))
      .toEqual(['system', 'globe', 'map']);
  });

  it('reports the rung the viewer picked', () => {
    let got: ZoomTarget | null = null;
    const bar = buildStatusBar({ ...noop, onRung: (v) => { got = v; } });
    (bar.element.querySelector('[data-rung="map"]') as HTMLButtonElement).click();
    expect(got).toBe('map');
  });

  it('setRung marks the active rung without firing onRung', () => {
    let fired = 0;
    const bar = buildStatusBar({ ...noop, onRung: () => { fired++; } });
    bar.setRung('globe');
    const active = [...bar.element.querySelectorAll('[data-rung].active')];
    expect(active.map((b) => b.getAttribute('data-rung'))).toEqual(['globe']);
    expect(fired).toBe(0);
  });

  it('shows the date and the active lens', () => {
    const bar = buildStatusBar(noop);
    bar.setDate('Year 3, day 214');
    bar.setLens('temperature');
    expect(bar.element.querySelector('[data-status="date"]')!.textContent).toBe('Year 3, day 214');
    expect(bar.element.querySelector('[data-status="lens"]')!.textContent).toBe('temperature');
  });

  it('flashShared confirms then restores the seed line', () => {
    const bar = buildStatusBar(noop);
    bar.setSeed('42');
    const seed = bar.element.querySelector('[data-status="seed"]')!;
    expect(seed.textContent).toBe('seed 42');
    bar.flashShared();
    expect(seed.textContent).toBe('copied ✓');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/ui/statusBar.test.ts`
Expected: FAIL — `Failed to resolve import "./statusBar"`.

- [ ] **Step 3: Write the status bar**

Create `src/ui/statusBar.ts`:

```ts
/** The persistent top chrome: which rung is showing, the active lens, the
 * date, the seed, and an overflow button for the `world` control group
 * (seed / reroll / share — they have no tab of their own).
 *
 * The lens chip and the date are tappable shortcuts to their tabs; the bar
 * never changes state on its own, exactly like the old HUD's trueScale
 * button — the caller owns the state and drives it back through the setters. */
import type { ZoomTarget } from '../views/zoom';

export interface StatusBar {
  element: HTMLElement;
  setRung(v: ZoomTarget): void;
  setDate(s: string): void;
  setLens(label: string): void;
  setSeed(seed: string): void;
  flashShared(): void;
}

const RUNGS: Array<{ id: ZoomTarget; label: string }> = [
  { id: 'system', label: 'System' },
  { id: 'globe', label: 'Globe' },
  { id: 'map', label: 'Map' },
];

export function buildStatusBar(cb: {
  onRung(v: ZoomTarget): void;
  onOverflow(): void;
  onLensChip(): void;
  onDateChip(): void;
}): StatusBar {
  const element = el('div', 'status-bar');

  const seg = el('div', 'rung-segmented');
  const rungButtons = new Map<ZoomTarget, HTMLButtonElement>();
  for (const r of RUNGS) {
    const b = el('button', 'rung');
    b.dataset.rung = r.id;
    b.textContent = r.label;
    b.addEventListener('click', () => cb.onRung(r.id));
    rungButtons.set(r.id, b);
    seg.appendChild(b);
  }

  const lens = el('button', 'status-chip');
  lens.dataset.status = 'lens';
  lens.addEventListener('click', () => cb.onLensChip());

  const spacer = el('div', 'status-spacer');

  const date = el('button', 'status-chip');
  date.dataset.status = 'date';
  date.textContent = '—';
  date.addEventListener('click', () => cb.onDateChip());

  const seed = el('span', 'status-seed');
  seed.dataset.status = 'seed';

  const overflow = el('button', 'status-overflow');
  overflow.textContent = '⋯';
  overflow.setAttribute('aria-label', 'more');
  overflow.addEventListener('click', () => cb.onOverflow());

  element.append(seg, lens, spacer, date, seed, overflow);

  let seedText = '';
  return {
    element,
    setRung: (v) => {
      for (const [id, b] of rungButtons) b.classList.toggle('active', id === v);
    },
    setDate: (s) => { date.textContent = s; },
    setLens: (label) => { lens.textContent = label; },
    setSeed: (s) => { seedText = `seed ${s}`; seed.textContent = seedText; },
    flashShared: () => {
      seed.textContent = 'copied ✓';
      setTimeout(() => { seed.textContent = seedText; }, 1500);
    },
  };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}
```

- [ ] **Step 4: Run the status-bar test**

Run: `npx vitest run src/ui/statusBar.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Write the failing transport test**

Create `src/ui/transport.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildTransport } from './transport';
import type { EclipseEvent } from '../sim/scene';

const noop = { onPlayPause() {}, onScrub(_: number) {}, onEclipseMark(_: EclipseEvent) {}, onRateChip() {} };

describe('the transport', () => {
  it('reports play/pause and reflects the paused state', () => {
    let fired = 0;
    const t = buildTransport({ ...noop, onPlayPause: () => { fired++; } });
    const btn = t.element.querySelector('[data-transport="play"]') as HTMLButtonElement;
    btn.click();
    expect(fired).toBe(1);
    t.setPaused(true);
    expect(btn.textContent).toBe('▶');
    t.setPaused(false);
    expect(btn.textContent).toBe('⏸');
  });

  it('reports a scrub', () => {
    let got: number | null = null;
    const t = buildTransport({ ...noop, onScrub: (d) => { got = d; } });
    const scrub = t.element.querySelector('input[type="range"]') as HTMLInputElement;
    scrub.value = '120.5';
    scrub.dispatchEvent(new Event('input'));
    expect(got).toBe(120.5);
  });

  it('setDay moves the scrubber without firing onScrub', () => {
    let fired = 0;
    const t = buildTransport({ ...noop, onScrub: () => { fired++; } });
    t.setDayRange(365);
    t.setDay(200);
    const scrub = t.element.querySelector('input[type="range"]') as HTMLInputElement;
    expect(scrub.value).toBe('200');
    expect(fired).toBe(0);
  });

  it('places one eclipse mark per event and reports a click', () => {
    const events: EclipseEvent[] = [
      { day: 50, body: 'moon-0', kind: 'solar' } as unknown as EclipseEvent,
      { day: 300, body: 'moon-0', kind: 'lunar' } as unknown as EclipseEvent,
    ];
    let got: EclipseEvent | null = null;
    const t = buildTransport({ ...noop, onEclipseMark: (e) => { got = e; } });
    t.setEclipses(events, 365);
    const marks = [...t.element.querySelectorAll('.eclipse-mark')] as HTMLButtonElement[];
    expect(marks.length).toBe(2);
    marks[1]!.click();
    expect(got).toBe(events[1]);
  });

  it('shows the current rate as a chip', () => {
    const t = buildTransport(noop);
    t.setRateLabel('1 hr/s');
    expect(t.element.querySelector('[data-transport="rate"]')!.textContent).toBe('1 hr/s');
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run src/ui/transport.test.ts`
Expected: FAIL — `Failed to resolve import "./transport"`.

- [ ] **Step 7: Write the transport**

Create `src/ui/transport.ts`, porting the scrubber and eclipse-mark logic from `hud.ts:262-286` and `hud.ts:459-468`:

```ts
/** The persistent bottom chrome — play/pause, the day scrubber with its
 * eclipse marks, and the current rate as a read-only chip (tapping it opens
 * the Time tab, which owns the rate picker).
 *
 * The scrubber stays BESPOKE rather than becoming a registry slider, by
 * decision (Console spec §1): it carries the eclipse-mark overlay and must
 * distinguish a user drag (fires onScrub) from autoplay driving it
 * (setDay, silent). Neither fits the generic slider contract. */
import type { EclipseEvent } from '../sim/scene';
import { eclipseMarkPositions } from './eclipseMarks';

export interface Transport {
  element: HTMLElement;
  setPaused(p: boolean): void;
  setDay(day: number): void;
  setDayRange(maxDay: number): void;
  setRateLabel(s: string): void;
  setEclipses(events: EclipseEvent[], maxDay: number): void;
}

export function buildTransport(cb: {
  onPlayPause(): void;
  onScrub(day: number): void;
  onEclipseMark(e: EclipseEvent): void;
  onRateChip(): void;
}): Transport {
  const element = el('div', 'transport');

  const play = el('button', 'transport-play');
  play.dataset.transport = 'play';
  play.textContent = '⏸';
  play.setAttribute('aria-label', 'play or pause');
  play.addEventListener('click', () => cb.onPlayPause());

  // The marks overlay MUST be a child of this positioned track wrapper —
  // an absolutely-positioned child needs a positioned ancestor or it is both
  // invisible AND unclickable (a real past regression, caught only by a
  // visual pass, not by the DOM tests).
  const track = el('div', 'transport-track');
  const scrub = document.createElement('input');
  scrub.type = 'range';
  scrub.name = 'day-scrubber';
  scrub.min = '0';
  scrub.max = '1000'; // placeholder — setDayRange sets the real extent once a world loads
  scrub.step = '0.01';
  scrub.value = '0';
  scrub.addEventListener('input', () => cb.onScrub(Number(scrub.value)));
  const marks = el('div', 'eclipse-marks');
  track.append(scrub, marks);

  const rate = el('button', 'transport-rate');
  rate.dataset.transport = 'rate';
  rate.textContent = '1×';
  rate.addEventListener('click', () => cb.onRateChip());

  element.append(play, track, rate);

  return {
    element,
    setPaused: (p) => { play.textContent = p ? '▶' : '⏸'; },
    setDay: (day) => { scrub.value = String(day); },
    setDayRange: (maxDay) => { scrub.max = String(maxDay); },
    setRateLabel: (s) => { rate.textContent = s; },
    setEclipses: (events, maxDay) => {
      marks.replaceChildren();
      for (const mark of eclipseMarkPositions(events, maxDay)) {
        const m = el('button', `eclipse-mark eclipse-${mark.body} eclipse-${mark.kind}`);
        m.style.left = `${mark.leftFraction * 100}%`;
        m.title = `${mark.body} ${mark.kind} eclipse — day ${mark.event.day.toFixed(1)}`;
        m.addEventListener('click', () => cb.onEclipseMark(mark.event));
        marks.appendChild(m);
      }
    },
  };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}
```

- [ ] **Step 8: Run the transport test**

Run: `npx vitest run src/ui/transport.test.ts`
Expected: PASS, 5 tests. If `eclipseMarkPositions` rejects the cast fixtures, read `src/ui/eclipseMarks.ts` and build real `EclipseEvent` objects matching its actual field names.

- [ ] **Step 9: Run the gate**

Run: `npm test && npm run build`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(the-console): the status bar and the transport

The two pieces of persistent chrome. The day scrubber stays bespoke by
decision: it carries the eclipse-mark overlay and distinguishes a user
drag from autoplay driving it, neither of which fits a registry slider."
```

---

## Task 8: The real registry, and the end of hud.ts

Build the actual control list, wire it into `main.ts`, delete the HUD.

**Files:**
- Create: `src/ui/controls/registry.ts`, `src/ui/controls/registry.test.ts`
- Create: `src/ui/consoleUi.ts` (assembles status bar + sheet + transport)
- Delete: `src/ui/hud.ts`, `src/ui/hud.test.ts`
- Modify: `src/main.ts`

**Interfaces:**
- Consumes: everything from Tasks 3–7.
- Produces:
  - `interface RegistryDeps` — the view handles each `apply` closes over
  - `function buildRegistry(deps: RegistryDeps): Control[]`
  - `const SHEET_TABS: readonly SheetTab[]`
  - `interface ConsoleUi { element: HTMLElement; statusBar: StatusBar; transport: Transport; sheet: Sheet; refresh(ctx: ControlContext): void }`
  - `function buildConsoleUi(opts): ConsoleUi`

**Named `ConsoleUi`, not `Console`, and the file is `consoleUi.ts`.** `console` is a global, and `main.ts` calls `console.log` at module scope on line 43 — a local `const console = ...` would shadow it and break that call. Do not shorten the name.

- [ ] **Step 1: Write the failing registry test**

Create `src/ui/controls/registry.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildRegistry, SHEET_TABS, type RegistryDeps } from './registry';
import { LENSES } from '../../views/lens';
import { LOOKS } from '../../views/look';
import type { Control } from './kinds';

/** Every dep is a no-op recorder: the registry test cares about the SHAPE of
 * the control list, not what any apply does. */
function deps(): RegistryDeps {
  const nop = () => {};
  return {
    setLens: nop, setLook: nop, setWinds: nop, setCurrents: nop, setClouds: nop,
    setWaves: nop, setGlint: nop, setNightFill: nop, setTrueRelief: nop,
    setTrueDistance: nop, setHoldSpin: nop, setHoldSeason: nop, setRate: nop,
    reroll: nop, share: nop,
    lookSettings: () => [],
  };
}

function ids(controls: Control[]): string[] { return controls.map((c) => c.id); }

describe('the control registry', () => {
  it('gives every control a unique id', () => {
    const r = buildRegistry(deps());
    expect(new Set(ids(r)).size).toBe(r.length);
  });

  it('uses only URL-safe ids, since the codec writes them into the hash', () => {
    for (const c of buildRegistry(deps())) {
      expect(c.id).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it('puts every control in a group that has a tab or is the world group', () => {
    const tabbed = new Set(SHEET_TABS.map((t) => t.group));
    for (const c of buildRegistry(deps())) {
      expect(tabbed.has(c.group) || c.group === 'world').toBe(true);
    }
  });

  it('gives every choice a default that is one of its own options', () => {
    for (const c of buildRegistry(deps())) {
      if (c.kind === 'choice') {
        expect(c.options.map((o) => o.id)).toContain(c.default);
      }
    }
  });

  it('gives every slider a default inside its own range', () => {
    for (const c of buildRegistry(deps())) {
      if (c.kind === 'slider') {
        expect(c.default).toBeGreaterThanOrEqual(c.min);
        expect(c.default).toBeLessThanOrEqual(c.max);
        expect(c.step).toBeGreaterThan(0);
      }
    }
  });

  it('offers every registered lens and every registered Look', () => {
    const r = buildRegistry(deps());
    const lens = r.find((c) => c.id === 'lens')!;
    const look = r.find((c) => c.id === 'look')!;
    expect(lens.kind).toBe('choice');
    expect(look.kind).toBe('choice');
    if (lens.kind === 'choice') expect(lens.options.map((o) => o.id)).toEqual(LENSES.map((l) => l.id));
    if (look.kind === 'choice') expect(look.options.map((o) => o.id)).toEqual(LOOKS.map((l) => l.id));
  });

  it('merges the active Looks own settings into the list', () => {
    const withSetting = {
      ...deps(),
      lookSettings: () => ([{
        kind: 'slider', id: 'dot-scale', label: 'dot scale', group: 'look',
        min: 0.5, max: 4, step: 0.1, default: 1, apply: () => {},
      }] as Control[]),
    };
    expect(ids(buildRegistry(withSetting))).toContain('dot-scale');
  });

  it('gates relief to the globe rung and distance to the system rung', () => {
    const r = buildRegistry(deps());
    const relief = r.find((c) => c.id === 'relief')!;
    const distance = r.find((c) => c.id === 'distance')!;
    const ctx = (rung: 'system' | 'globe' | 'map') => ({ rung, tiles: {} as never, lookId: 'natural' });
    expect(relief.available!(ctx('globe')).ok).toBe(true);
    expect(relief.available!(ctx('system')).ok).toBe(false);
    expect(distance.available!(ctx('system')).ok).toBe(true);
    expect(distance.available!(ctx('globe')).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/ui/controls/registry.test.ts`
Expected: FAIL — `Failed to resolve import "./registry"`.

- [ ] **Step 3: Write the registry**

Create `src/ui/controls/registry.ts`. This is the ONE place that knows both "there is a control called night fill" and "it calls `globeView.setNightFill`".

```ts
/** THE registry: every control the Console offers, as data.
 *
 * This is the only module that knows both what a control is called and what
 * it does. The sheet renders it, the codec serializes it, e2e addresses it —
 * none of them know what any single entry means.
 *
 * Adding a control costs ONE entry here. No renderer edit, no callback
 * interface, no test file. That is the whole point of the indirection. */
import type { Control, ControlContext } from './kinds';
import { AVAILABLE } from './kinds';
import type { SheetTab } from '../sheet';
import { LENSES } from '../../views/lens';
import { LOOKS } from '../../views/look';
import { RELIEF_EXAGGERATION } from '../../views/globe';
import { SPEED_STEPS } from '../../time/speedPolicy';

export const SHEET_TABS: readonly SheetTab[] = [
  { group: 'lens', label: 'Lens' },
  { group: 'look', label: 'Look' },
  { group: 'layers', label: 'Layers' },
  { group: 'time', label: 'Time' },
];

/** The view handles each `apply` closes over. `main.ts` supplies them; the
 * registry never reaches for a view itself. */
export interface RegistryDeps {
  setLens(id: string): void;
  setLook(id: string): void;
  setWinds(on: boolean): void;
  setCurrents(on: boolean): void;
  setClouds(on: boolean): void;
  setWaves(on: boolean): void;
  setGlint(on: boolean): void;
  setNightFill(on: boolean): void;
  setTrueRelief(on: boolean): void;
  setTrueDistance(on: boolean): void;
  setHoldSpin(on: boolean): void;
  setHoldSeason(on: boolean): void;
  setRate(mult: number): void;
  reroll(): void;
  share(): void;
  /** The active Look's own settings, merged in at build time. Empty until
   * Stage 5 gives dither3d its seven. */
  lookSettings(): Control[];
}

const globeOnly = (ctx: ControlContext) =>
  ctx.rung === 'globe' ? AVAILABLE : { ok: false as const, reason: 'the globe rung only' };
const systemOnly = (ctx: ControlContext) =>
  ctx.rung === 'system' ? AVAILABLE : { ok: false as const, reason: 'the system rung only' };

export function buildRegistry(d: RegistryDeps): Control[] {
  return [
    // ---- Lens -------------------------------------------------------------
    {
      kind: 'choice', id: 'lens', label: 'Lens', group: 'lens',
      options: LENSES.map((l) => ({ id: l.id, label: l.label })),
      default: 'natural',
      apply: (v) => d.setLens(v),
    },

    // ---- Look -------------------------------------------------------------
    {
      kind: 'choice', id: 'look', label: 'Look', group: 'look',
      options: LOOKS.map((l) => ({ id: l.id, label: l.label })),
      default: 'natural',
      apply: (v) => d.setLook(v),
    },
    ...d.lookSettings(),
    {
      kind: 'choice', id: 'relief', label: 'Relief', group: 'look',
      help: `Schematic exaggerates relief ${RELIEF_EXAGGERATION}× so mountains read on a rendered sphere at all. True is the honest render — the mountains are down there, the sphere just does not show them at this size.`,
      options: [
        { id: 'schematic', label: `×${RELIEF_EXAGGERATION}` },
        { id: 'true', label: 'true' },
      ],
      default: 'schematic',
      available: globeOnly,
      apply: (v) => d.setTrueRelief(v === 'true'),
    },
    {
      kind: 'choice', id: 'distance', label: 'Orbit distance', group: 'look',
      help: 'Schematic compresses moon orbits onto even rungs for legibility. True is to the documents — the bodies all but vanish against the orbit’s sweep.',
      options: [{ id: 'schematic', label: 'schematic' }, { id: 'true', label: 'true' }],
      default: 'schematic',
      available: systemOnly,
      apply: (v) => d.setTrueDistance(v === 'true'),
    },
    {
      kind: 'toggle', id: 'waves', label: 'Waves', group: 'look',
      default: true, available: globeOnly, apply: (v) => d.setWaves(v),
    },
    {
      kind: 'toggle', id: 'glint', label: 'Sun glint', group: 'look',
      default: true, available: globeOnly, apply: (v) => d.setGlint(v),
    },
    {
      kind: 'toggle', id: 'night-fill', label: 'Night fill', group: 'look',
      help: 'Brighten the unlit far side so its terrain and temperature stay readable, instead of the default honest dark terminator.',
      default: false, available: globeOnly, apply: (v) => d.setNightFill(v),
    },

    // ---- Layers -----------------------------------------------------------
    {
      kind: 'toggle', id: 'winds', label: 'Winds', group: 'layers',
      default: false,
      available: (ctx) => ctx.tiles.circulationBands !== null
        ? AVAILABLE
        : { ok: false, reason: 'no circulation bands: this world is tidally locked' },
      apply: (v) => d.setWinds(v),
    },
    {
      kind: 'toggle', id: 'currents', label: 'Ocean currents', group: 'layers',
      default: false,
      available: (ctx) =>
        ctx.tiles.currentEast.some((v) => v !== 0) || ctx.tiles.currentNorth.some((v) => v !== 0)
          ? AVAILABLE
          : { ok: false, reason: 'no ocean-current data: this world is tidally locked' },
      apply: (v) => d.setCurrents(v),
    },
    {
      kind: 'toggle', id: 'clouds', label: 'Clouds', group: 'layers',
      default: false,
      available: (ctx) => ctx.tiles.cloudType.some((t) => t > 0)
        ? AVAILABLE
        : { ok: false, reason: 'no clouds: every tile reports a clear sky' },
      apply: (v) => d.setClouds(v),
    },

    // ---- Time -------------------------------------------------------------
    {
      kind: 'choice', id: 'rate', label: 'Rate', group: 'time',
      options: SPEED_STEPS.map((s) => ({ id: rateId(s.mult), label: s.label })),
      default: rateId(1),
      apply: (v) => d.setRate(Number(v.replace(/^x/, ''))),
    },
    {
      kind: 'toggle', id: 'hold-spin', label: 'Hold the spin — watch the year', group: 'time',
      help: 'Freeze the daily rotation so a year’s seasons and ice sweep past on a still globe. Held automatically above 1 day/s.',
      default: false, apply: (v) => d.setHoldSpin(v),
    },
    {
      kind: 'toggle', id: 'hold-season', label: 'Hold the season — watch a day', group: 'time',
      help: 'Pin the season so the day/night temperature pulse is watchable on its own. Composes with holding the spin — they freeze different things.',
      default: false, apply: (v) => d.setHoldSeason(v),
    },

    // ---- World (no tab — the status bar's overflow) -------------------------
    { kind: 'action', id: 'reroll', label: 'Reroll', group: 'world', run: () => d.reroll() },
    { kind: 'action', id: 'share', label: 'Share', group: 'world', run: () => d.share() },
  ];
}

/** Speed multipliers are numbers, but a choice option id must be a URL-safe
 * string — `x86400` rather than `86400` so it never reads as a bare number
 * in the hash. */
function rateId(mult: number): string {
  return `x${mult}`;
}
```

**Note:** `SPEED_STEPS` currently lives in `src/ui/hud.ts`, which this task deletes. Move the constant verbatim into `src/time/speedPolicy.ts` (it is time policy, not HUD chrome) and export it from there, updating any import.

- [ ] **Step 4: Run the registry test**

Run: `npx vitest run src/ui/controls/registry.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Assemble the console**

Create `src/ui/consoleUi.ts`:

```ts
/** Assembles the three pieces of the control surface — status bar, sheet,
 * transport — and keeps them consistent. Owns no state of its own: it
 * forwards to the store and re-renders on a context change. */
import type { Control, ControlContext } from './controls/kinds';
import type { ControlStore } from './controls/store';
import { buildSheet, type Sheet, type SheetTab } from './sheet';
import { buildStatusBar, type StatusBar } from './statusBar';
import { buildTransport, type Transport } from './transport';
import type { ZoomTarget } from '../views/zoom';
import type { EclipseEvent } from '../sim/scene';

export interface ConsoleUi {
  element: HTMLElement;
  statusBar: StatusBar;
  sheet: Sheet;
  transport: Transport;
  /** Re-evaluate every control's availability and repaint the visible group. */
  refresh(ctx: ControlContext): void;
}

export function buildConsoleUi(opts: {
  controls: readonly Control[];
  store: ControlStore;
  tabs: readonly SheetTab[];
  onRung(v: ZoomTarget): void;
  onPlayPause(): void;
  onScrub(day: number): void;
  onEclipseMark(e: EclipseEvent): void;
}): ConsoleUi {
  const sheet = buildSheet({ controls: opts.controls, store: opts.store, tabs: opts.tabs });
  const statusBar = buildStatusBar({
    onRung: opts.onRung,
    // `world` is a GroupId with no tab of its own — `setTab` accepts it and
    // `markTabs` simply matches no tab button, so the overflow renders the
    // world group (seed / reroll / share) with every tab unmarked.
    onOverflow: () => { sheet.setTab('world'); },
    onLensChip: () => sheet.setTab('lens'),
    onDateChip: () => sheet.setTab('time'),
  });
  const transport = buildTransport({
    onPlayPause: opts.onPlayPause,
    onScrub: opts.onScrub,
    onEclipseMark: opts.onEclipseMark,
    onRateChip: () => sheet.setTab('time'),
  });

  const element = document.createElement('div');
  element.className = 'console';
  // The sheet's collapsed state IS the transport strip, so the transport
  // lives inside the sheet's own container rather than beside it — that is
  // what keeps it from moving when the sheet is dragged open.
  const dock = document.createElement('div');
  dock.className = 'console-dock';
  dock.append(sheet.element, transport.element);
  element.append(statusBar.element, dock);

  return {
    element, statusBar, sheet, transport,
    refresh: (ctx) => sheet.render(ctx),
  };
}
```

**Note on the overflow:** `setTab` takes a `GroupId`, and `world` is one, so no cast is needed. `markTabs` finds no `.sheet-tab[data-tab="world"]` and leaves every tab unmarked — which is the right presentation for a group reached from the status bar rather than the tab row.

- [ ] **Step 6: Rewire main.ts and delete the HUD**

In `src/main.ts`:
- Replace the `buildHud` / `HudCallbacks` import with `buildRegistry`, `SHEET_TABS`, `ControlStore`, `buildConsole`.
- Build the registry from the existing view handles, replacing the `cb: HudCallbacks` object wholesale. Each former callback body becomes a `RegistryDeps` method — e.g. `setWinds: (on) => globeView.setWinds(on)`. The `windsOn` / `currentsOn` / `cloudsOn` / `wavesOn` / `glintOn` / `nightFillOn` / `spinFrozenByUser` / `dayHoldOn` local flags all go: the store holds those values now.
- Bind the result as `const consoleUi = buildConsoleUi({...})` — never `console`, which would shadow the global (see the naming note above).
- Replace every `hud.setX(...)` call with the matching `consoleUi.statusBar` / `consoleUi.transport` call, or a `store.set(...)`.
- Add a `ctx()` helper returning the live `ControlContext`: `() => ({ rung: view, tiles, lookId: String(store.get('look') ?? 'natural') })`. Availability predicates read it, so it must be recomputed rather than captured.
- Call `consoleUi.refresh(ctx())` from `applyView` (the rung changed, so availability changed) and once at boot.
- `app.append(consoleUi.element)` in place of `hudRoot`.

```bash
git rm src/ui/hud.ts src/ui/hud.test.ts
```

- [ ] **Step 7: Run the typecheck, repeatedly, until clean**

Run: `npm run build`
Expected: initially many errors naming each stale `hud.` reference. Work through them; the compiler is the checklist.

- [ ] **Step 8: Run the unit tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(the-console): the real registry, and the end of hud.ts

One module now knows both what a control is called and what it does.
hud.ts (486 lines) and HudCallbacks (20 methods) are deleted; the
per-control setXActive/setXAvailable trios go with them.

Adding a control now costs one registry entry."
```

---

## Task 9: Mobile-first CSS

**Files:**
- Modify: `index.html` (the viewport meta)
- Rewrite: `src/styles.css`

- [ ] **Step 1: Fix the viewport meta**

`index.html:5`:

```html
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
```

`viewport-fit=cover` is what makes `env(safe-area-inset-*)` report non-zero on a notched iPhone.

- [ ] **Step 2: Rewrite the stylesheet**

Replace `src/styles.css` wholesale. Keep the existing `.body-label`, `.scale-caption`, `.status`, `.view-stage`, `.view-canvas`, `.error-*` and `.info-card` rules verbatim — they are not part of the control surface — and replace every `.hud*` rule with:

```css
:root {
  --ink: #cfd8e3;
  --dim: #9fb0c8;
  --panel: rgba(8, 12, 24, 0.94);
  --edge: #2a3350;
  --chip: #141c33;
  --on: #3350a0;
  --tap: 44px;               /* minimum touch target, both dimensions */
  --safe-b: env(safe-area-inset-bottom, 0px);
  --safe-t: env(safe-area-inset-top, 0px);
}

/* 100dvh, not 100% — iOS Safari's collapsing toolbar makes a percentage
   height taller than the visible viewport, pushing the bottom chrome under
   the browser UI where it cannot be reached. That is the single biggest
   reason the old HUD was unusable on a phone. */
html, body, #app { width: 100%; height: 100dvh; overflow: hidden; background: #05070f; }
body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--ink);
  font-size: 13px; line-height: 1.45; -webkit-text-size-adjust: 100%; }
canvas { display: block; touch-action: none; }   /* a globe drag must never scroll the page */

.console { position: absolute; inset: 0; pointer-events: none; }
.console > * { pointer-events: auto; }

/* ---- status bar ---- */
.status-bar { position: absolute; top: 0; left: 0; right: 0; display: flex; align-items: center;
  gap: 6px; padding: calc(6px + var(--safe-t)) 10px 6px; background: rgba(6, 10, 22, 0.85);
  border-bottom: 1px solid #222c46; user-select: none; }
.status-spacer { flex: 1; }
.rung-segmented { display: flex; border: 1px solid #2f3a58; border-radius: 999px; overflow: hidden; }
.rung { min-height: var(--tap); padding: 0 12px; background: var(--chip); color: inherit;
  border: none; font: inherit; cursor: pointer; }
.rung.active { background: var(--on); }
.status-chip { min-height: var(--tap); padding: 0 10px; background: var(--chip); color: inherit;
  border: 1px solid #2f3a58; border-radius: 999px; font: inherit; cursor: pointer; white-space: nowrap; }
.status-seed { color: var(--dim); white-space: nowrap; }
.status-overflow { min-width: var(--tap); min-height: var(--tap); background: var(--chip);
  color: inherit; border: 1px solid #2f3a58; border-radius: 10px; font: inherit; cursor: pointer; }

/* ---- the dock: sheet + transport ---- */
.console-dock { position: absolute; left: 0; right: 0; bottom: 0; background: var(--panel);
  border-top: 1px solid var(--edge); border-radius: 16px 16px 0 0;
  padding: 6px 10px calc(8px + var(--safe-b)); max-height: 72dvh;
  display: flex; flex-direction: column; }
.sheet { display: flex; flex-direction: column; min-height: 0; }
.sheet-grabber { width: 34px; height: 4px; border-radius: 2px; background: #3a4463;
  margin: 2px auto 8px; flex: none; }
.sheet-tabs { display: flex; gap: 4px; flex: none; }
.sheet-tab { flex: 1; min-height: var(--tap); background: var(--chip); color: inherit;
  border: 1px solid #2f3a58; border-radius: 8px; font: inherit; cursor: pointer; }
.sheet-tab.active { background: var(--on); border-color: #4a6ac0; }
.sheet-body { overflow-y: auto; -webkit-overflow-scrolling: touch; padding: 8px 0 4px; min-height: 0; }

/* ---- controls ---- */
.control { margin-bottom: 10px; }
.control-label { font-size: 11px; letter-spacing: 0.09em; text-transform: uppercase;
  color: #7d8ba8; margin-bottom: 4px; }
.control-toggle, .control-option, .control-action { min-height: var(--tap); padding: 0 12px;
  background: var(--chip); color: inherit; border: 1px solid #2f3a58; border-radius: 8px;
  font: inherit; cursor: pointer; }
.control-toggle.active, .control-option.active { background: var(--on); border-color: #4a6ac0; }
.control-toggle:disabled, .control-option:disabled, .control-action:disabled { opacity: 0.35; cursor: default; }
.control-options { display: flex; gap: 5px; flex-wrap: wrap; }
.control-slider-row { display: flex; align-items: center; gap: 8px; }
/* A range input's default hit area is ~20px tall; the thumb needs the full
   target or a thumb-drag on a phone misses more often than it lands. */
.control-slider { flex: 1; min-height: var(--tap); }
.control-value { min-width: 3.2em; text-align: right; color: var(--dim); }
.control-help { font-size: 11px; color: var(--dim); margin-top: 4px; }
.control-reason { font-size: 11px; color: #7d8ba8; margin-top: 4px; }
.control.unavailable .control-label { opacity: 0.5; }

/* ---- transport (the sheet's collapsed state; never moves) ---- */
.transport { display: flex; align-items: center; gap: 8px; flex: none;
  padding-top: 6px; border-top: 1px solid #1c2540; }
.transport-play, .transport-rate { min-width: var(--tap); min-height: var(--tap);
  background: var(--chip); color: inherit; border: 1px solid #2f3a58; border-radius: 10px;
  font: inherit; cursor: pointer; }
.transport-track { position: relative; flex: 1; display: flex; align-items: center; }
.transport-track input[type="range"] { flex: 1; min-height: var(--tap); }
/* The marks overlay is absolutely positioned and REQUIRES this positioned
   parent — a loose sibling is both invisible and unclickable. */
.eclipse-marks { position: absolute; left: 8px; right: 8px; top: 50%; height: 0; pointer-events: none; }
.eclipse-mark { position: absolute; top: 0; transform: translate(-50%, -50%);
  width: 14px; height: 14px; border-radius: 50%; padding: 0; border: 1px solid #a97a1e;
  pointer-events: auto; cursor: pointer; }
.eclipse-solar { background: #e8b34a; border-color: #a97a1e; }
.eclipse-lunar { background: #7d8fc7; border-color: #4a5a91; }
.eclipse-annular { box-shadow: inset 0 0 0 2px rgba(5, 8, 18, 0.85); }

/* ---- desktop: the dock becomes a left column ---- */
@media (min-width: 760px) {
  .console-dock { top: 52px; right: auto; width: 260px; bottom: 0;
    border-radius: 0 12px 0 0; border-right: 1px solid var(--edge); border-top: none;
    max-height: none; }
  .sheet-body { padding-bottom: 12px; }
}
```

- [ ] **Step 3: Look at it**

Run: `npm run dev`, then open the app and use the browser's device emulation at an iPhone-sized viewport (390×844).

Verify by eye: nothing clipped, nothing under the home indicator, the transport reachable, the sheet scrolls, no horizontal scrollbar, a globe drag does not scroll the page. Fix what is wrong before committing.

- [ ] **Step 4: Run the gate**

Run: `npm test && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(the-console): mobile-first stylesheet

100dvh instead of 100% — iOS Safari's collapsing toolbar made a
percentage height taller than the visible viewport, pushing the bottom
chrome under the browser UI. Plus safe-area insets, 44px targets,
touch-action:none on the canvases, and a 13px type floor.

Desktop is one breakpoint: the dock becomes a left column."
```

---

## Task 10: e2e migration, and the CLAUDE.md rewrite

**Files:**
- Modify: `e2e/smoke.spec.ts`, `e2e/perf-harness.spec.ts`, `e2e/stutter-probe.spec.ts`
- Create: `e2e/mobile.spec.ts`
- Modify: `playwright.config.ts` (add the mobile project)
- Modify: `CLAUDE.md`

- [ ] **Step 1: Inventory the dead selectors**

```bash
grep -rn "hud-" e2e
```

Every hit must go. The mapping:

| Old | New |
|---|---|
| `.hud-top-left` (seed text) | `[data-status="seed"]` |
| `.hud-view` (select) | `.rung[data-rung="<id>"]` (click, not selectOption) |
| `.hud-lenses button` | `[data-control="lens"] [data-option="<id>"]` |
| `.hud-look` / `.hud-style` / `.hud-map-style` | `[data-control="look"] [data-option="<id>"]` |
| `.hud-bottom button` (play) | `[data-transport="play"]` |
| `.hud-caption` | `[data-control="lens"] .control-help` |

- [ ] **Step 2: Rewrite the boot wait**

Every spec starts by waiting for the seed to appear. Replace:

```ts
await expect(page.locator('.hud-top-left')).toContainText('seed 42', { timeout: 150_000 });
```

with:

```ts
await expect(page.locator('[data-status="seed"]')).toContainText('seed 42', { timeout: 150_000 });
```

Note that reaching a control now needs its tab open first. Add a helper at the top of `smoke.spec.ts`:

```ts
/** Open the sheet tab that holds `group`, then return the control's root. */
async function control(page: Page, group: string, id: string) {
  await page.locator(`.sheet-tab[data-tab="${group}"]`).click();
  return page.locator(`[data-control="${id}"]`);
}
```

- [ ] **Step 3: Replace the two roster tests with one**

The old `.hud-style` and `.hud-map-style` roster tests become one Look roster test:

```ts
test('every Look renders the globe non-blank', async ({ page }) => {
  await bootSeed42(page);                       // whatever the file's existing boot helper is called
  await page.locator('.rung[data-rung="globe"]').click();
  await waitForGlobeIdle(page);
  const look = await control(page, 'look', 'look');
  for (const id of ['natural', 'voxel', 'dither3d', 'pixel']) {
    await look.locator(`[data-option="${id}"]`).click();
    await waitForGlobeIdle(page);
    const shot = await page.screenshot();
    expect(shot.length).toBeGreaterThan(5000);  // a blank frame compresses to almost nothing
  }
});
```

Keep whatever non-blank assertion the existing roster test used — copy it rather than inventing one.

- [ ] **Step 4: Write the mobile spec**

Create `e2e/mobile.spec.ts`:

```ts
import { devices, expect, test } from '@playwright/test';

test.use({ ...devices['iPhone 13'] });

const TAP = 44;

test('the console is usable at an iPhone viewport', async ({ page }) => {
  await page.goto('/#seed=42');
  await expect(page.locator('[data-status="seed"]')).toContainText('seed 42', { timeout: 150_000 });

  // The page never scrolls sideways.
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  // Every tab is reachable, and every visible control clears the touch target.
  for (const tab of ['lens', 'look', 'layers', 'time']) {
    await page.locator(`.sheet-tab[data-tab="${tab}"]`).click();
    await expect(page.locator(`.sheet-tab[data-tab="${tab}"]`)).toHaveClass(/active/);

    const targets = page.locator(
      '.sheet-body button, .sheet-body input[type="range"], .sheet-tab, .transport button, .rung',
    );
    const n = await targets.count();
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) {
      const box = await targets.nth(i).boundingBox();
      if (!box) continue;                       // not laid out (inside a collapsed group)
      expect.soft(box.height, `control ${i} on the ${tab} tab is too short`)
        .toBeGreaterThanOrEqual(TAP - 1);       // -1 for sub-pixel layout rounding
    }
  }

  // The transport stays on screen with the sheet open — it must not slide
  // under the home indicator.
  const play = await page.locator('[data-transport="play"]').boundingBox();
  const viewport = page.viewportSize()!;
  expect(play).not.toBeNull();
  expect(play!.y + play!.height).toBeLessThanOrEqual(viewport.height);
});
```

- [ ] **Step 5: Register the mobile project**

In `playwright.config.ts`, add a project entry so `e2e/mobile.spec.ts` runs under the iPhone device profile. Follow whatever `projects` shape the file already uses; if it has none, `test.use` in the spec is sufficient and no config change is needed — check before editing.

- [ ] **Step 6: Run e2e**

Run: `npm run e2e`
Expected: PASS. Fix real failures; a soft assertion that fires is a real CSS bug in Task 9, not a test to loosen.

- [ ] **Step 7: Rewrite the stale CLAUDE.md sections**

`CLAUDE.md`'s "The two patterns you'll reuse" is now false — both patterns describe a HUD that no longer exists. Replace that section with:

```markdown
## The two patterns you'll reuse

**Adding a control** costs *one entry* in `src/ui/controls/registry.ts`: an
`id`, a `label`, a `group`, an `apply`, and optionally an `available()`
predicate that names its own reason for being unavailable. The sheet renders
it, the codec persists it to the URL and localStorage, and e2e addresses it by
`data-control="<id>"` — none of them need editing. `sheet.test.ts` renders from
a *fake* registry precisely so a real control never touches it.

**Adding a lens** still costs *one file* (`src/views/lens.ts`): its own
colormap, legend, and caption. The registry builds the lens picker's options
from `LENSES`, so there is no picker edit either.

**Adding a Look** costs one entry in `src/views/look.ts` — declaring its globe
mesh, its surface material, its map rung, and its post passes — plus its own
settings as `Control` entries if it has any.
```

Also update the "Module map" to name `src/ui/controls/`, `sheet.ts`, `statusBar.ts`, `transport.ts`, `consoleUi.ts`, and `src/views/look.ts`, and to drop `hud.ts` and `renderStyle.ts`.

- [ ] **Step 8: Run the whole gate**

Run: `npm test && npm run smoke && npm run build && npm run e2e`
Expected: all four PASS.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "test(the-console): move e2e onto data-control, add the iPhone spec

Selectors now use the same ids the codec writes and the registry
declares — one naming scheme, three consumers. The new mobile spec
pins the thing that was actually broken: touch targets, no sideways
overflow, and a transport that stays above the home indicator.

CLAUDE.md's 'two patterns you'll reuse' described a HUD that no longer
exists; rewritten for the registry."
```

---

# Stage 4 — Persistence

## Task 11: URL and localStorage

**Files:**
- Modify: `src/state/url.ts`, `src/state/url.test.ts`
- Create: `src/state/persist.ts`, `src/state/persist.test.ts`
- Modify: `src/main.ts`

**Interfaces:**
- Consumes: `encodeControls` / `decodeControls` from `src/ui/controls/codec.ts`.
- Produces:
  - `AppState` gains `controls: string` (the encoded blob, `''` when empty)
  - `function loadLocalControls(): string` and `function saveLocalControls(encoded: string): void` in `persist.ts`

- [ ] **Step 1: Extend the AppState test**

In `src/state/url.test.ts`, add:

```ts
it('round-trips an encoded control blob', () => {
  const hash = serializeAppState({ seed: '42', view: 'globe', day: 0, controls: 'look:dither3d,winds:1' });
  expect(parseAppState(hash)!.controls).toBe('look:dither3d,winds:1');
});

it('omits the control param when nothing differs from default', () => {
  expect(serializeAppState({ seed: '42', view: 'system', day: 0, controls: '' })).toBe('#seed=42');
});

it('defaults controls to empty when the param is absent', () => {
  expect(parseAppState('#seed=42')!.controls).toBe('');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/state/url.test.ts`
Expected: FAIL — `controls` is not a property of `AppState`.

- [ ] **Step 3: Extend AppState**

In `src/state/url.ts`, add `controls: string;` to the interface, `controls: ''` to `defaultAppState`, a read in `parseAppState`:

```ts
  s.controls = params.get('c') ?? '';
```

and a write in `serializeAppState`, after the `day` line:

```ts
  // The control blob. `c` rather than `controls` purely to keep a shared
  // link short — this is presentation state (decision 0022), not a
  // documented contract anyone else parses.
  if (s.controls !== '') parts.push(`c=${s.controls}`);
```

- [ ] **Step 4: Run the url test**

Run: `npx vitest run src/state/url.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing persist test**

Create `src/state/persist.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadLocalControls, saveLocalControls } from './persist';

describe('local control persistence', () => {
  beforeEach(() => { localStorage.clear(); });

  it('round-trips', () => {
    saveLocalControls('winds:1');
    expect(loadLocalControls()).toBe('winds:1');
  });

  it('returns empty when nothing is stored', () => {
    expect(loadLocalControls()).toBe('');
  });

  it('returns empty rather than throwing when storage is unavailable', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError: storage is disabled');
    });
    expect(loadLocalControls()).toBe('');
    spy.mockRestore();
  });

  it('swallows a write failure rather than breaking the app', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => saveLocalControls('winds:1')).not.toThrow();
    spy.mockRestore();
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run src/state/persist.test.ts`
Expected: FAIL — `Failed to resolve import "./persist"`.

- [ ] **Step 7: Write persist.ts**

```ts
/** Remembers the viewer's control settings per browser, so a fresh visit
 * reopens how they left it. Same payload the URL carries — the URL WINS when
 * present; this only fills in when it does not.
 *
 * Every access is guarded: Safari in private mode and a storage-disabled
 * browser both throw on plain `localStorage` access, and a planetarium
 * failing to boot because a preference could not be read would be absurd. */
const KEY = 'orrery.controls.v1';

export function loadLocalControls(): string {
  try {
    return localStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveLocalControls(encoded: string): void {
  try {
    if (encoded === '') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, encoded);
  } catch {
    /* storage unavailable — the session still works, it just won't be remembered */
  }
}
```

- [ ] **Step 8: Run the persist test**

Run: `npx vitest run src/state/persist.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 9: Wire both into main.ts**

In `mountViews`, after the store is built:

```ts
  // URL first, local as the fallback — a shared link must show the sender's
  // view, not the recipient's saved preferences.
  const fromUrl = decodeControls(state.controls, controls);
  const restored = state.controls !== ''
    ? fromUrl
    : decodeControls(loadLocalControls(), controls);
  for (const [id, v] of Object.entries(restored)) store.set(id, v);
```

Then subscribe to persist on change:

```ts
  store.subscribe(() => {
    const encoded = encodeControls(store.nonDefaults());
    saveLocalControls(encoded);
    state.controls = encoded;
    syncUrl(true);   // a control change is a discrete user action, not autoplay
  });
```

and include `controls: state.controls` in `syncUrl`'s `serializeAppState` call.

- [ ] **Step 10: Verify by hand**

Run: `npm run dev`. Change the Look and a couple of toggles; confirm the hash grows a `c=` param. Copy the URL into a new tab and confirm it opens in the same state. Then clear the hash to just `#seed=42` and reload — confirm your settings come back from localStorage.

- [ ] **Step 11: Run the whole gate**

Run: `npm test && npm run smoke && npm run build && npm run e2e`
Expected: all four PASS.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "feat(the-console): persist controls to the URL and localStorage

Share now sends what you were actually looking at. URL wins over local
so a shared link shows the SENDER's view, not the recipient's saved
preferences. Every storage access is guarded — Safari private mode
throws on plain localStorage, and a planetarium that won't boot
because a preference couldn't be read would be absurd."
```

---

# Stage 5 — Dither3D

## Task 12: Face-space tile UVs

The load-bearing task. Surface-stability comes from screen-space derivatives of the UV, so a tile refining from level 2 to level 5 as the Cascade delivers its patch **must not** change dot density. Face-space UVs guarantee it; per-tile `[0,1]` UVs would both reset density at every tile boundary and re-scale it on every refine.

**Files:**
- Modify: `src/views/worldMesh.ts` (`buildGridGeometry`, `buildTileGeometry`, `buildRegionTileGeometry`)
- Modify: `src/views/worldMesh.test.ts`

**Interfaces:**
- Consumes: `TileId` from `src/views/cubeSphere.ts`; `RegionScene` (which carries `face`, `level`, `ix`, `iy` — verified) from `src/sim/scene.ts`.
- Produces: every geometry from `buildTileGeometry` and `buildRegionTileGeometry` carries a `uv` attribute, itemSize 2. `buildGridGeometry` gains a required `uvAt: (i: number) => readonly [number, number]` parameter after `radiusAtLatLon`.

**The formula.** `tileGrid` is row-major over `iy` (b) then `ix` (a) — index `i = row * n + col`, `n = TILE_QUADS + 1`. For a tile at `(level, ix, iy)`:

```
u = (ix + col / (n - 1)) / 2^level
v = (iy + row / (n - 1)) / 2^level
```

`param()` subdivides a fixed `[0,1]` domain, so this is level-independent by construction: the same surface point yields the same `(u, v)` at every level.

- [ ] **Step 1: Write the failing invariant test**

Add to `src/views/worldMesh.test.ts`:

```ts
import { faceSpaceUv } from './worldMesh';

describe('face-space tile UVs', () => {
  const N = TILE_QUADS + 1;

  // `faceSpaceUv` takes only { level, ix, iy } — a fresh object literal
  // carrying `face` too would trip TypeScript's excess-property check, so
  // these literals omit it. Passing a whole TileId or RegionScene (as the
  // builders do) is fine: excess-property checking applies to literals only.
  it('spans [0,1] across a whole face at level 0', () => {
    expect(faceSpaceUv({ level: 0, ix: 0, iy: 0 }, 0, N)).toEqual([0, 0]);
    expect(faceSpaceUv({ level: 0, ix: 0, iy: 0 }, N * N - 1, N)).toEqual([1, 1]);
  });

  it('gives adjacent same-level tiles a shared edge value, so density never resets at a tile boundary', () => {
    // right edge of tile (level 1, ix 0) === left edge of tile (level 1, ix 1)
    const rightEdge = faceSpaceUv({ level: 1, ix: 0, iy: 0 }, N - 1, N);
    const leftEdge = faceSpaceUv({ level: 1, ix: 1, iy: 0 }, 0, N);
    expect(rightEdge[0]).toBe(leftEdge[0]);
  });

  it('THE INVARIANT: the same surface point carries the same UV at every level', () => {
    // The face's centre. At level 1 it is tile (1,1)'s corner (0,0);
    // at level 2 it is tile (2,2)'s corner (0,0); at level 3, tile (4,4)'s.
    for (const level of [1, 2, 3, 4]) {
      const half = 1 << (level - 1);
      const uv = faceSpaceUv({ level, ix: half, iy: half }, 0, N);
      expect(uv).toEqual([0.5, 0.5]);
    }
  });

  it('a refined child re-derives its parent’s own corner UV exactly', () => {
    const parent = faceSpaceUv({ level: 2, ix: 1, iy: 3 }, 0, N);
    const child = faceSpaceUv({ level: 3, ix: 2, iy: 6 }, 0, N);
    expect(child).toEqual(parent);
  });

  it('builds a uv attribute onto a tile geometry, one per position', () => {
    const geom = buildTileGeometry(TILES, { face: 0, level: 1, ix: 0, iy: 0 }, 1, 0, () => [0, 0, 0], 0);
    const uv = geom.getAttribute('uv');
    expect(uv).toBeDefined();
    expect(uv.itemSize).toBe(2);
    expect(uv.count).toBe(geom.getAttribute('position').count);
  });
});
```

`TILES` stands in for whatever tiles fixture `worldMesh.test.ts` already builds, and `TILE_QUADS` / `buildTileGeometry` are likely already imported there. Read the top of the file and reuse both rather than adding a second fixture.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/views/worldMesh.test.ts`
Expected: FAIL — `faceSpaceUv` is not exported.

- [ ] **Step 3: Add the UV function**

In `src/views/worldMesh.ts`, next to `quantizeBands`:

```ts
/** A tile grid vertex's UV in CUBE-SPHERE FACE SPACE — `[0,1]²` across the
 * whole face, NOT `[0,1]²` across this tile.
 *
 * This distinction is load-bearing for Surface-Stable Fractal Dithering
 * (`./styles/dither3d`). The dither's dot density is derived from the
 * screen-space derivative of the UV, so when the Cascade delivers a patch and
 * a tile refines from level 2 to level 5, the density MUST NOT change.
 * Face-space UVs guarantee that: the same surface point carries the same UV
 * at every level, because `param()` subdivides a fixed [0,1] domain. Per-tile
 * [0,1] UVs would reset density at every tile boundary AND re-scale it on
 * every refine — visibly.
 *
 * Seams remain only at the 12 cube edges, where the face parametrization
 * itself is discontinuous.
 *
 * `i` indexes `tileGrid`'s row-major (iy, then ix) grid; `n` is its side
 * length (`TILE_QUADS + 1` for a tiles-export tile, `samples + 1` for a
 * region patch). */
export function faceSpaceUv(
  tile: { level: number; ix: number; iy: number },
  i: number,
  n: number,
): [number, number] {
  const q = n - 1;
  const col = i % n;
  const row = Math.floor(i / n);
  const span = 1 / (1 << tile.level);
  return [(tile.ix + col / q) * span, (tile.iy + row / q) * span];
}
```

- [ ] **Step 4: Thread it through buildGridGeometry**

Add the parameter after `radiusAtLatLon`:

```ts
  radiusAtLatLon: (lat: number, lon: number) => number,
  uvAt: (i: number) => readonly [number, number],
  hasData?: (lat: number, lon: number) => boolean,
```

Collect UVs in the surface loop, alongside `pos`/`col`/`nrmArr`:

```ts
  const uvArr: number[] = [];
  // …inside the `for (let i = 0; i < n * n; i++)` loop:
    const [tu, tv] = uvAt(i);
    uvArr.push(tu, tv);
```

In the skirt loop, copy each skirt vertex's UV from its source edge vertex — exactly as the colours are copied — so the apron carries the surface's own parametrization rather than a discontinuity:

```ts
      for (const v of e) {
        // …existing pos/col pushes…
        uvArr.push(uvArr[2 * v]!, uvArr[2 * v + 1]!);
      }
```

And set the attribute beside the others:

```ts
  geom.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvArr), 2));
```

- [ ] **Step 5: Pass the UV function from both builders**

In `buildTileGeometry`, after the `radiusAtLatLon` argument:

```ts
    (i) => faceSpaceUv(tile, i, n),
```

In `buildRegionTileGeometry` — `RegionScene` carries `level`, `ix`, `iy` (verified against `src/sim/scene.ts:171-178`), so the same formula applies with the patch's own grid size. This call already passes a trailing `hasData` argument, so `uvAt` goes **between** `radiusAtLatLon` and it:

```ts
    radiusAtLatLon,
    (i) => faceSpaceUv(region, i, n),
    // The patch's own bounds: outside them `sampleRegionElevationBilinear`
    // clamps, so the normal probe must step inward instead of reading a
    // flat-lie. See `analyticNormal`.
    (lat, lon) => regionContains(region, lat, lon),
  );
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run src/views/worldMesh.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the whole gate**

Run: `npm test && npm run smoke && npm run build && npm run e2e`
Expected: all four PASS. The globe renders identically — nothing reads `uv` yet.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(the-console): face-space UVs on every tile geometry

Not per-tile [0,1] UVs: face-space, so the same surface point carries
the same UV at every level. That is what will let the dither's dot
density survive a Cascade refine from level 2 to level 5 — per-tile UVs
would reset density at every tile boundary and re-scale it on every
refine. Skirt vertices copy their edge vertex's UV, as the colours do.

Nothing reads the attribute yet; the globe renders identically."
```

---

## Task 13: The fractal Bayer 3D texture

**Files:**
- Create: `src/views/styles/ditherTexture.ts`, `src/views/styles/ditherTexture.test.ts`

**Interfaces:**
- Produces:
  - `const DITHER_LEVELS = 4` (1×1, 2×2, 4×4, 8×8)
  - `const DITHER_RES = 8` (the common slice side, the finest level's size)
  - `function bayerMatrix(level: number): number[]` — the raw integer matrix, row-major, side `2^level`
  - `function bayerValue(level: number, x: number, y: number): number` — the *centered* normalization `(M + 0.5) / size²`
  - `function buildDitherData(): Uint8Array` — `DITHER_RES² × DITHER_LEVELS` bytes, slice-major
  - `function createDitherTexture(): THREE.Data3DTexture`

**The self-similarity property, and why centering matters.** The recursive Bayer construction is `M_{2n}(2y+dy, 2x+dx) = 4·M_n(y,x) + offset[dy][dx]` with `offset = [[0,2],[3,1]]`. With the *plain* normalization `M / size²` the 2×2 block average of level `k+1` overshoots level `k` by a constant `1.5/(4n²)`. With the **centered** normalization `(M + 0.5) / size²` it is exact:

```
avg = ((4M+0.5) + (4M+2.5) + (4M+3.5) + (4M+1.5)) / 4 / (4n²)
    = (16M + 8) / 16n²  =  (M + 0.5) / n²
```

That exactness is the fractal property the technique needs — dots only appear or only disappear as you zoom, never both at once — and it is what the property test pins.

- [ ] **Step 1: Write the failing test**

Create `src/views/styles/ditherTexture.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  DITHER_LEVELS, DITHER_RES, bayerMatrix, bayerValue, buildDitherData,
} from './ditherTexture';

describe('the Bayer matrices', () => {
  it('is a single zero at level 0', () => {
    expect(bayerMatrix(0)).toEqual([0]);
  });

  it('is the canonical 2x2 at level 1', () => {
    expect(bayerMatrix(1)).toEqual([0, 2, 3, 1]);
  });

  it('is a permutation of 0..size^2-1 at every level', () => {
    for (let level = 0; level < DITHER_LEVELS; level++) {
      const m = bayerMatrix(level);
      const size = 1 << level;
      expect(m.length).toBe(size * size);
      expect([...m].sort((a, b) => a - b)).toEqual([...Array(size * size).keys()]);
    }
  });
});

describe('the fractal property', () => {
  it('THE PROPERTY: each 2x2 block of level k+1 averages exactly to level k', () => {
    for (let level = 0; level < DITHER_LEVELS - 1; level++) {
      const size = 1 << level;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const avg = (
            bayerValue(level + 1, 2 * x, 2 * y) +
            bayerValue(level + 1, 2 * x + 1, 2 * y) +
            bayerValue(level + 1, 2 * x, 2 * y + 1) +
            bayerValue(level + 1, 2 * x + 1, 2 * y + 1)
          ) / 4;
          expect(avg).toBeCloseTo(bayerValue(level, x, y), 12);
        }
      }
    }
  });

  it('keeps every value strictly inside (0,1), so no dot is ever unconditionally on or off', () => {
    for (let level = 0; level < DITHER_LEVELS; level++) {
      const size = 1 << level;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const v = bayerValue(level, x, y);
          expect(v).toBeGreaterThan(0);
          expect(v).toBeLessThan(1);
        }
      }
    }
  });

  it('centres the single level-0 value at one half', () => {
    expect(bayerValue(0, 0, 0)).toBe(0.5);
  });
});

describe('the packed 3D data', () => {
  it('is one byte per texel, RES^2 per slice, one slice per level', () => {
    expect(buildDitherData().length).toBe(DITHER_RES * DITHER_RES * DITHER_LEVELS);
  });

  it('block-replicates a coarse level up to the common slice resolution', () => {
    const data = buildDitherData();
    // Level 0 is a single value, so its whole slice is uniform.
    const slice0 = data.subarray(0, DITHER_RES * DITHER_RES);
    expect(new Set(slice0).size).toBe(1);
  });

  it('gives the finest level as many distinct values as it has cells', () => {
    const data = buildDitherData();
    const last = DITHER_LEVELS - 1;
    const slice = data.subarray(last * DITHER_RES * DITHER_RES, (last + 1) * DITHER_RES * DITHER_RES);
    expect(new Set(slice).size).toBe(DITHER_RES * DITHER_RES);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/views/styles/ditherTexture.test.ts`
Expected: FAIL — `Failed to resolve import "./ditherTexture"`.

- [ ] **Step 3: Write the generator**

Create `src/views/styles/ditherTexture.ts`:

```ts
/** The 3D dither texture behind Surface-Stable Fractal Dithering
 * (runevision.com/tech/dither3d, MPL-2.0 — this is an independent
 * implementation of the published technique, not a port).
 *
 * Each z-slice holds a Bayer matrix at a different resolution (1×1, 2×2,
 * 4×4, 8×8), block-replicated up to a common side so all slices share
 * dimensions and the sampler can interpolate BETWEEN them. That interpolation
 * is the whole trick: as a surface approaches the camera the shader walks up
 * the slices, and because the levels are self-similar, dots only ever appear —
 * never appear and disappear at once, which is what reads as swimming.
 *
 * Generated at runtime rather than shipped as an asset: it is ~50 lines, and
 * a generator is a PURE function, so the self-similarity that makes the
 * technique work is a property test rather than a snapshot nobody can check. */
import * as THREE from 'three';

/** Slices: Bayer at 1×1, 2×2, 4×4, 8×8. */
export const DITHER_LEVELS = 4;

/** Common slice side — the finest level's own size. */
export const DITHER_RES = 1 << (DITHER_LEVELS - 1);

/** The raw integer Bayer matrix at `level`, row-major, side `2^level`.
 * Built by the standard recurrence
 * `M_2n(2y+dy, 2x+dx) = 4·M_n(y,x) + offset[dy][dx]`. */
export function bayerMatrix(level: number): number[] {
  let m = [0];
  let size = 1;
  for (let k = 0; k < level; k++) {
    const next = new Array<number>(size * size * 4);
    const nextSize = size * 2;
    // offset[dy][dx] — the canonical 2×2 ordering.
    const offset = [
      [0, 2],
      [3, 1],
    ];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const base = 4 * m[y * size + x]!;
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            next[(2 * y + dy) * nextSize + (2 * x + dx)] = base + offset[dy]![dx]!;
          }
        }
      }
    }
    m = next;
    size = nextSize;
  }
  return m;
}

/** The CENTERED normalization, `(M + 0.5) / size²`.
 *
 * The centering is not cosmetic. With the plain `M / size²` the 2×2 block
 * average of level k+1 overshoots level k by a constant `1.5/(4n²)`, and the
 * levels stop being self-similar — dots would both appear and disappear
 * across a zoom. Centered, the average is exactly level k:
 *
 *   ((4M+0.5)+(4M+2.5)+(4M+3.5)+(4M+1.5)) / 4 / (4n²) = (M+0.5)/n²
 *
 * It also keeps every value strictly inside (0,1), so no dot is
 * unconditionally on or off. */
export function bayerValue(level: number, x: number, y: number): number {
  const size = 1 << level;
  return (bayerMatrix(level)[y * size + x]! + 0.5) / (size * size);
}

/** All slices packed slice-major, one byte per texel, block-replicated to
 * `DITHER_RES²`. */
export function buildDitherData(): Uint8Array {
  const sliceTexels = DITHER_RES * DITHER_RES;
  const data = new Uint8Array(sliceTexels * DITHER_LEVELS);
  for (let level = 0; level < DITHER_LEVELS; level++) {
    const size = 1 << level;
    const scale = DITHER_RES / size; // block-replication factor
    for (let y = 0; y < DITHER_RES; y++) {
      for (let x = 0; x < DITHER_RES; x++) {
        const v = bayerValue(level, Math.floor(x / scale), Math.floor(y / scale));
        // 0..255 with the same centering the float carries — v is strictly
        // inside (0,1), so this never lands on 0 or 255 spuriously.
        data[level * sliceTexels + y * DITHER_RES + x] = Math.round(v * 255);
      }
    }
  }
  return data;
}

/** The `Data3DTexture` the dither material samples. WebGL2 only — three's
 * default renderer is WebGL2, so this is safe here.
 *
 * `LinearFilter` on all three axes is required: the interpolation BETWEEN
 * slices is what makes the dot count blend continuously as the camera moves,
 * and nearest filtering would step. */
export function createDitherTexture(): THREE.Data3DTexture {
  const tex = new THREE.Data3DTexture(buildDitherData(), DITHER_RES, DITHER_RES, DITHER_LEVELS);
  tex.format = THREE.RedFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  // Depth must CLAMP, not repeat — the finest slice must not wrap around to
  // the coarsest as the camera closes in.
  tex.wrapR = THREE.ClampToEdgeWrapping;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/views/styles/ditherTexture.test.ts`
Expected: PASS, 8 tests. In particular the fractal-property test must pass at 12 decimal places — if it does not, the centering is wrong.

- [ ] **Step 5: Run the gate**

Run: `npm test && npm run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(the-console): the fractal Bayer 3D dither texture

Generated at runtime, so the self-similarity that makes the technique
work is a property test rather than a snapshot nobody can check: each
2x2 block of level k+1 averages EXACTLY to level k. That exactness
needs the centered normalization (M+0.5)/size^2 — with plain M/size^2
the levels drift apart by a constant and dots would both appear and
disappear across a zoom, which is the swimming the technique exists
to prevent."
```

---

## Task 14: The dither material

**Files:**
- Create: `src/views/styles/dither3d.ts`, `src/views/styles/dither3d.test.ts`
- Modify: `src/views/globe.ts`

**Interfaces:**
- Consumes: `createDitherTexture`, `DITHER_LEVELS` from `./ditherTexture`.
- Produces:
  - `interface DitherSettings { colourMode: 'colour' | 'grayscale'; dotScale: number; contrast: number; variability: number; stretch: number; invert: boolean; radialCompensation: boolean }`
  - `const DITHER_DEFAULTS: DitherSettings`
  - `function createDitherMaterial(): { material: THREE.MeshStandardMaterial; setSettings(s: Partial<DitherSettings>): void }`
- Produces in `globe.ts`: `setSurface(surface: 'standard' | 'dither'): void` and `setDitherSettings(s: Partial<DitherSettings>): void` on `GlobeView`.

- [ ] **Step 1: Write the failing test**

Create `src/views/styles/dither3d.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/views/styles/dither3d.test.ts`
Expected: FAIL — `Failed to resolve import "./dither3d"`.

- [ ] **Step 3: Write the material**

Create `src/views/styles/dither3d.ts`:

```ts
/** Surface-Stable Fractal Dithering as a MATERIAL, not a post-process.
 *
 * Every other skin this app has had was an EffectComposer pass over the
 * finished frame. This one cannot be: the dots stick to the SURFACE, which
 * means the shader needs the surface's own UV and its screen-space
 * derivatives. That is the entire reason `worldMesh` grew a face-space `uv`
 * attribute.
 *
 * The injection lands AFTER lighting, so it quantizes the LIT colour. That is
 * what preserves the honest terminator (spec §4½): the terminator's falloff
 * becomes the dot-density gradient rather than being flattened away.
 *
 * GLSL ES 3.00 reserved words (`flat`, `sample`, `smooth`, `layout`, `patch`,
 * `filter`, `input`) must never name a variable — a collision silently fails
 * the whole compile and blacks the screen. Locals below are deliberately
 * named around that: `lum`, `dotUv`, `ink`, `lvl`, `tone`, `bias`. */
import * as THREE from 'three';
import { DITHER_LEVELS, createDitherTexture } from './ditherTexture';

export interface DitherSettings {
  /** Colour keeps the lens readable; grayscale is the stronger image and
   * makes five of the seven lenses indistinguishable. Colour is the default
   * for that reason — see the Console spec §4. */
  colourMode: 'colour' | 'grayscale';
  dotScale: number;
  contrast: number;
  /** 0 = Bayer-style (vary the dot COUNT), 1 = halftone-style (vary the dot SIZE). */
  variability: number;
  /** Anisotropic smoothing where the surface is stretched relative to screen. */
  stretch: number;
  invert: boolean;
  radialCompensation: boolean;
}

export const DITHER_DEFAULTS: DitherSettings = {
  colourMode: 'colour',
  dotScale: 1,
  contrast: 1,
  variability: 0,
  stretch: 0.5,
  invert: false,
  radialCompensation: true,
};

const DITHER_CHUNK = /* glsl */ `
  // Screen-space footprint of one UV unit — the derivative that makes the
  // dots surface-stable: as the surface nears the camera this shrinks, the
  // level index rises, and the pattern subdivides into MORE dots rather
  // than bigger ones.
  vec2 duv = vec2(length(dFdx(vDitherUv)), length(dFdy(vDitherUv)));
  float footprint = max(max(duv.x, duv.y), 1e-8);
  // Which fractal level this pixel sits at. log2 of the footprint, so a
  // doubling of distance steps exactly one slice.
  float lvl = clamp(-log2(footprint * uDotScale) , 0.0, float(DITHER_LEVELS_C) - 1.0);
  float sliceT = lvl / max(float(DITHER_LEVELS_C) - 1.0, 1.0);

  // Anisotropy: where the surface is stretched (a grazing angle), soften
  // along the stretched axis so dots smear rather than alias.
  float aniso = duv.x / max(duv.y, 1e-8);
  float bias = mix(1.0, clamp(aniso, 0.25, 4.0), uStretch);

  vec2 dotUv = vDitherUv * exp2(floor(lvl)) * bias;
  float threshold = texture(uDither, vec3(fract(dotUv), sliceT)).r;
  if (uInvert > 0.5) threshold = 1.0 - threshold;

  // Radial compensation: the perceived density falls off toward the screen
  // edge under a perspective projection; nudge the threshold back.
  if (uRadial > 0.5) {
    vec2 ndc = gl_FragCoord.xy / uViewport * 2.0 - 1.0;
    threshold -= 0.06 * dot(ndc, ndc);
  }

  vec3 tone = gl_FragColor.rgb;
  float lum = dot(tone, vec3(0.299, 0.587, 0.114));
  float ink;
  if (uGrayscale > 0.5) {
    ink = clamp((lum - 0.5) * uContrast + 0.5, 0.0, 1.0);
    // uVariability blends dot-COUNT shading (hard step) toward dot-SIZE
    // shading (a soft ramp around the threshold).
    float hard = step(threshold, ink);
    float soft = smoothstep(threshold - 0.25, threshold + 0.25, ink);
    gl_FragColor.rgb = vec3(mix(hard, soft, uVariability));
  } else {
    // Per-channel against the SAME threshold, so hue survives and the lens
    // stays readable. Two levels per channel is the palette collapse this
    // look is for.
    vec3 c = clamp((tone - 0.5) * uContrast + 0.5, 0.0, 1.0);
    vec3 hard = step(vec3(threshold), c);
    vec3 soft = smoothstep(vec3(threshold - 0.25), vec3(threshold + 0.25), c);
    gl_FragColor.rgb = mix(hard, soft, uVariability);
  }
`;

export function createDitherMaterial(): {
  material: THREE.MeshStandardMaterial;
  setSettings(s: Partial<DitherSettings>): void;
} {
  const uniforms = {
    uDither: { value: createDitherTexture() },
    uDotScale: { value: DITHER_DEFAULTS.dotScale },
    uContrast: { value: DITHER_DEFAULTS.contrast },
    uVariability: { value: DITHER_DEFAULTS.variability },
    uStretch: { value: DITHER_DEFAULTS.stretch },
    uInvert: { value: DITHER_DEFAULTS.invert ? 1 : 0 },
    uRadial: { value: DITHER_DEFAULTS.radialCompensation ? 1 : 0 },
    uGrayscale: { value: DITHER_DEFAULTS.colourMode === 'grayscale' ? 1 : 0 },
    uViewport: { value: new THREE.Vector2(1, 1) },
  };

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 1,
    metalness: 0,
  });

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vDitherUv;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvDitherUv = uv;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         #define DITHER_LEVELS_C ${DITHER_LEVELS}
         precision highp sampler3D;
         uniform sampler3D uDither;
         uniform float uDotScale, uContrast, uVariability, uStretch, uInvert, uRadial, uGrayscale;
         uniform vec2 uViewport;
         varying vec2 vDitherUv;`,
      )
      // AFTER lighting and tonemapping: quantize the LIT colour, so the
      // terminator's falloff becomes the dot-density gradient.
      .replace('#include <dithering_fragment>', `#include <dithering_fragment>\n${DITHER_CHUNK}`);
  };
  // Force a recompile the first time this material is used, since
  // onBeforeCompile was assigned after construction.
  material.needsUpdate = true;

  // Exposed for the tests and for `globe.ts`'s per-frame viewport update.
  material.userData.ditherUniforms = uniforms;
  material.userData.ditherChunk = DITHER_CHUNK;

  return {
    material,
    setSettings(s) {
      if (s.colourMode !== undefined) uniforms.uGrayscale.value = s.colourMode === 'grayscale' ? 1 : 0;
      if (s.dotScale !== undefined) uniforms.uDotScale.value = s.dotScale;
      if (s.contrast !== undefined) uniforms.uContrast.value = s.contrast;
      if (s.variability !== undefined) uniforms.uVariability.value = s.variability;
      if (s.stretch !== undefined) uniforms.uStretch.value = s.stretch;
      if (s.invert !== undefined) uniforms.uInvert.value = s.invert ? 1 : 0;
      if (s.radialCompensation !== undefined) uniforms.uRadial.value = s.radialCompensation ? 1 : 0;
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/views/styles/dither3d.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Give the globe a second material**

In `src/views/globe.ts`, beside the existing shared `material` (`:464`):

```ts
  // Two materials, swapped by reference — NOT one material whose
  // onBeforeCompile is mutated. Mutating it would force a shader recompile on
  // every Look switch, and this repo has spent real effort amortizing hitches
  // (see `drainBuildQueue`). Both are built up front; the swap is a pointer.
  const standardMaterial = material;
  const dither = createDitherMaterial();
  let activeSurface: 'standard' | 'dither' = 'standard';
  const surfaceMaterial = (): THREE.MeshStandardMaterial =>
    activeSurface === 'dither' ? dither.material : standardMaterial;

  /** Swap which material every mounted tile wears. No geometry rebuild: the
   * `uv` attribute is built unconditionally (see `faceSpaceUv`) precisely so
   * this switch costs nothing but a pointer per mesh. */
  function setSurface(surface: 'standard' | 'dither'): void {
    if (surface === activeSurface) return;
    activeSurface = surface;
    const m = surfaceMaterial();
    for (const slot of tileSlots.values()) slot.mesh.material = m;
  }

  function setDitherSettings(s: Partial<DitherSettings>): void {
    dither.setSettings(s);
  }
```

In `buildTileSlot` (`:667`), replace `new THREE.Mesh(geom, material)` with `new THREE.Mesh(geom, surfaceMaterial())`.

In `update(day, camera)`, keep the dither's viewport uniform current:

```ts
    // The radial-compensation term reads gl_FragCoord against the viewport.
    const uniforms = dither.material.userData.ditherUniforms as { uViewport: { value: THREE.Vector2 } };
    uniforms.uViewport.value.set(window.innerWidth, window.innerHeight);
```

Add `setSurface` and `setDitherSettings` to the returned `GlobeView` and to its interface (`:360` area).

- [ ] **Step 6: Route the Look's surface**

In `src/main.ts`, in the registry's `setLook`:

```ts
    setLook: (id) => {
      const look = lookById(id);
      stylePipeline.setPasses(look.postPasses(tiles));
      globeView.setStyle(look.globeMesh);
      globeView.setSurface(look.globeSurface);
      mapView.setStyle(look.mapRung);
      // The Look's own settings become available/unavailable with it, so the
      // sheet must re-evaluate — `ctx()` reads the live rung, tiles and lookId.
      consoleUi.refresh(ctx());
    },
```

- [ ] **Step 7: Look at it**

Run: `npm run dev`. Switch to the Globe rung, pick the `dither3d` Look.

Verify by eye: the globe is dithered, not black. A black globe means the shader failed to compile — open the console, read the GLSL error, and check for a reserved-word collision first.

- [ ] **Step 8: Run the whole gate**

Run: `npm test && npm run smoke && npm run build && npm run e2e`
Expected: all four PASS, including the "every Look renders non-blank" test — which now genuinely exercises the dither path.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(the-console): the dither3d surface material

A material, not a post-process — the dots stick to the surface, so the
shader needs the surface's own UV and its screen-space derivatives.
The injection lands after lighting so it quantizes the LIT colour,
which is what keeps the honest terminator: its falloff becomes the
dot-density gradient instead of being flattened away.

Two materials swapped by reference rather than one material with a
mutated onBeforeCompile — the latter recompiles the shader on every
Look switch, and this repo has spent real effort amortizing hitches."
```

---

## Task 15: The dither settings, and the zoom-stability check

The payoff: seven controls arrive with **zero** edits to the sheet renderer, the codec, or any of their tests. If any of those need touching, the registry abstraction failed and that is the finding.

**Files:**
- Modify: `src/views/look.ts` (give `dither3dLook` its settings)
- Modify: `src/ui/controls/registry.ts` (`lookSettings` wiring)
- Modify: `src/main.ts`
- Modify: `src/views/look.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/views/look.test.ts`:

```ts
import { ditherSettingControls } from './look';

describe('the dither Looks settings', () => {
  it('offers all seven', () => {
    const ids = ditherSettingControls(() => {}).map((c) => c.id);
    expect(ids).toEqual([
      'dither-colour', 'dither-dot-scale', 'dither-contrast',
      'dither-variability', 'dither-stretch', 'dither-invert', 'dither-radial',
    ]);
  });

  it('puts every one in the look group, so they render under the Look picker', () => {
    for (const c of ditherSettingControls(() => {})) expect(c.group).toBe('look');
  });

  it('defaults colour mode to colour, so the lens survives', () => {
    const mode = ditherSettingControls(() => {}).find((c) => c.id === 'dither-colour')!;
    expect(mode.kind).toBe('choice');
    if (mode.kind === 'choice') expect(mode.default).toBe('colour');
  });

  it('reports each change as a partial settings patch', () => {
    const seen: unknown[] = [];
    const controls = ditherSettingControls((s) => seen.push(s));
    const dot = controls.find((c) => c.id === 'dither-dot-scale')!;
    if (dot.kind === 'slider') dot.apply(2.5);
    expect(seen).toEqual([{ dotScale: 2.5 }]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/views/look.test.ts`
Expected: FAIL — `ditherSettingControls` is not exported.

- [ ] **Step 3: Add the settings**

In `src/views/look.ts`:

```ts
import type { Control } from '../ui/controls/kinds';
import type { DitherSettings } from './styles/dither3d';
import { DITHER_DEFAULTS } from './styles/dither3d';

/** The dither Look's own seven controls. Handed a sink so the Look module
 * stays free of any view handle — `main.ts` connects it to
 * `globeView.setDitherSettings`.
 *
 * Seven entries, and the sheet renderer, the codec and their tests need no
 * edit at all. That is the registry earning its keep. */
export function ditherSettingControls(onChange: (s: Partial<DitherSettings>) => void): Control[] {
  return [
    {
      kind: 'choice', id: 'dither-colour', label: 'Colour mode', group: 'look',
      help: 'Grayscale is the stronger image, and it makes temperature, moisture, precip, unrest and plates indistinguishable. Colour dithers each channel against the same pattern, so the lens still reads.',
      options: [{ id: 'colour', label: 'colour' }, { id: 'grayscale', label: 'grayscale' }],
      default: DITHER_DEFAULTS.colourMode,
      apply: (v) => onChange({ colourMode: v as DitherSettings['colourMode'] }),
    },
    {
      kind: 'slider', id: 'dither-dot-scale', label: 'Dot scale', group: 'look',
      min: 0.25, max: 4, step: 0.05, default: DITHER_DEFAULTS.dotScale,
      format: (v) => `${v.toFixed(2)}×`,
      apply: (v) => onChange({ dotScale: v }),
    },
    {
      kind: 'slider', id: 'dither-contrast', label: 'Contrast', group: 'look',
      min: 0.4, max: 3, step: 0.05, default: DITHER_DEFAULTS.contrast,
      format: (v) => v.toFixed(2),
      apply: (v) => onChange({ contrast: v }),
    },
    {
      kind: 'slider', id: 'dither-variability', label: 'Dot size variability', group: 'look',
      help: '0 shades by dot COUNT (Bayer); 1 shades by dot SIZE (halftone).',
      min: 0, max: 1, step: 0.05, default: DITHER_DEFAULTS.variability,
      format: (v) => v.toFixed(2),
      apply: (v) => onChange({ variability: v }),
    },
    {
      kind: 'slider', id: 'dither-stretch', label: 'Stretch smoothness', group: 'look',
      help: 'Softens dots along the stretched axis at a grazing angle.',
      min: 0, max: 1, step: 0.05, default: DITHER_DEFAULTS.stretch,
      format: (v) => v.toFixed(2),
      apply: (v) => onChange({ stretch: v }),
    },
    {
      kind: 'toggle', id: 'dither-invert', label: 'Invert dots', group: 'look',
      default: DITHER_DEFAULTS.invert,
      apply: (v) => onChange({ invert: v }),
    },
    {
      kind: 'toggle', id: 'dither-radial', label: 'Radial compensation', group: 'look',
      help: 'Counteracts the density falloff toward the screen edge under a perspective projection.',
      default: DITHER_DEFAULTS.radialCompensation,
      apply: (v) => onChange({ radialCompensation: v }),
    },
  ];
}
```

- [ ] **Step 4: Run the look test**

Run: `npx vitest run src/views/look.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the settings into the registry**

In `src/main.ts`, supply `lookSettings` so it returns the active Look's settings:

```ts
  // Only the active Look's settings are RENDERED, but the store holds every
  // known control's value — so switching away and back restores the dot
  // scale, and a shared link carries it either way (see ControlStore).
  lookSettings: () => ditherSettingControls((s) => globeView.setDitherSettings(s)),
```

Note this returns the dither controls unconditionally; their *rendering* is gated by giving each an `available()` that checks `ctx.lookId`. Add to each of the seven, in `ditherSettingControls`:

```ts
      available: (ctx) => ctx.lookId === 'dither3d'
        ? { ok: true }
        : { ok: false, reason: 'the dither3d Look only' },
```

`main.ts`'s `ctx()` helper (Task 8) already carries the live `lookId`, so this needs no new plumbing — only the `consoleUi.refresh(ctx())` call in `setLook`, added in Task 14 step 6.

- [ ] **Step 6: Confirm nothing generic needed editing**

```bash
git status --short
```

Expected: only `src/views/look.ts`, `src/views/look.test.ts`, `src/ui/controls/registry.ts` and `src/main.ts`. **If `src/ui/sheet.ts`, `src/ui/sheet.test.ts`, `src/ui/controls/codec.ts` or `src/ui/controls/store.ts` appear in that list, stop and record why** — the registry was supposed to make this free, and a needed edit there is a finding worth writing down, not silently absorbing.

- [ ] **Step 7: The zoom-stability visual check**

This is a deliverable, not a formality. The unit test pins that the *UV* is level-independent; only an eye can confirm the *dots* are.

Run: `npm run dev`. Globe rung, `dither3d` Look, and:

1. Turn on `freeze spin` (hold the spin) so the surface is still.
2. Zoom slowly from the default distance all the way to the minimum.
3. Watch a fixed patch of surface as the Cascade refines it from level 2 through level 5.

Expected: dot size and spacing stay roughly constant on screen; new dots *appear* as you approach, and none disappear at the same moment. What would be wrong: density visibly jumping at a refine, dots swimming across the surface, or a grid discontinuity at a tile boundary.

If density jumps at a refine, the UV is not reaching the shader unchanged — check that `buildRegionTileGeometry` passes `faceSpaceUv(region, …)` and not a per-tile UV.

Record the outcome in the commit message. If it fails, do **not** commit a pass — open the finding.

- [ ] **Step 8: Run the whole gate**

Run: `npm test && npm run smoke && npm run build && npm run e2e`
Expected: all four PASS.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(the-console): the dither Look's seven settings

Seven controls arrived with zero edits to the sheet renderer, the
codec, the store, or any of their tests — which is the registry
earning the indirection it cost.

Zoom stability verified by eye from the default distance to minimum
through a Cascade refine (level 2 -> 5): dot size and spacing hold,
dots appear on approach without any disappearing, no discontinuity at
tile boundaries."
```

- [ ] **Step 10: Close out the campaign**

Update `CLAUDE.md`'s "LOD status" section to note that tile geometry now carries face-space UVs and why (dither dot-density stability across a refine). Add a line to the "Rendering conventions worth knowing" section about the two-material surface swap.

```bash
git add CLAUDE.md
git commit -m "docs(the-console): fold the face-space UVs into the LOD notes"
```

---

## Self-review notes

**Spec coverage.** Every numbered spec section maps to tasks: §1 the control model → Tasks 4, 5, 8; §2 the layout → Tasks 6, 7, 8, 9; §3 the Look axis → Tasks 1, 2, 3; §4 dither3d → Tasks 12, 13, 14, 15; §5 testing → carried inside each task plus Task 10; §6 sequencing → the stage headers; §7 risks → e2e churn is Task 10, the UV invariant is Task 12 step 1 plus Task 15 step 7, the sheet-drag-on-iOS risk is Task 9 step 3.

**Known deviation from the spec.** The spec describes a draggable sheet with three snap points (collapsed / half / full). This plan builds the sheet as a fixed-height dock with a scrolling body and a grabber that is currently decorative. The drag gesture is deliberately deferred: it is the one piece the spec itself flags as needing an early prototype against `touch-action: none`, and the surface is fully usable without it. Add it as a follow-up task once the rest is on a phone and you can feel whether it is needed.

**Two things a subagent will need to look up rather than take from this plan.** `waitForGlobeIdle` and the boot helper in `e2e/smoke.spec.ts` are referenced by name in Task 10 — read the file for their real names and signatures. And `main.ts`'s rewiring in Task 8 is described rather than transcribed, because it is a 150-line mechanical translation of an existing callback object; the typecheck is the checklist there.
