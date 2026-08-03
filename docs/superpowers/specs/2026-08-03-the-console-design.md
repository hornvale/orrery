# The Console — a phone-first control surface, one Look axis, and surface-stable dithering

**Status**: design approved, not yet planned
**Date**: 2026-08-03

## Why

Three complaints, one root cause.

1. **The Orrery is unusable on a phone.** Not slow, not crashing — the controls
   are the problem. Absolutely-positioned corner panels, 0.65 rem type, buttons
   below any reasonable touch target, a 220 px lens column with its own
   scrollbar, and `height: 100%` fighting iOS Safari's collapsing toolbar.
2. **Most of the "skins" don't earn their place.** Of the eleven entries spread
   across three style axes, two are worth keeping — `photoreal` and `voxel`.
3. **Two unlabeled dropdowns.** `style-select` and `map-style-select` sit side
   by side with no label, on axes a viewer has no way to distinguish.

The root cause of all three is that the HUD grew one control at a time, each
threaded by hand through four places. `CLAUDE.md` documents this honestly as a
pattern to copy: *"a `View` method → a `GlobeView` forwarder → a HUD callback +
active-class setter → `main.ts` state + wiring"*, plus a new `noop` in
`hud.test.ts`. Followed thirty times, that pattern produces exactly what exists:
`hud.ts` at 486 lines, a `HudCallbacks` interface with twenty methods, and no
layer that knows what the control *set* is — so nothing can lay it out, persist
it, or gate it generically.

Nathan's framing, which governs the whole design: *"I imagine we'll add a lot
more controls, so any design work done with that idea in mind is probably going
to pay dividends."* This spec optimizes for the thirty-first control, not the
thirtieth.

## What this is not

Not a performance change. The three stacked full-screen `WebGLRenderer`s at
`devicePixelRatio` 2 are left exactly as they are — confirmed as *not* the
phone problem. They stay on the watch list, out of scope.

Not a producer-side change. Nothing here asks `hornvale/windows/scene` for a
field it does not ship. Decision 0022 holds: this is presentation, and
presentation here is deliberately non-deterministic.

---

## 1. The control model

Four kinds, defined once in `src/ui/controls/kinds.ts`:

```ts
type GroupId = 'lens' | 'look' | 'layers' | 'time' | 'world';

type Availability = { ok: true } | { ok: false; reason: string };

interface ControlBase {
  /** Stable. The URL codec writes it, e2e addresses it, the DOM carries it
   *  as data-control. One name, three consumers. */
  id: string;
  label: string;
  group: GroupId;
  /** Caption shown under the control. */
  help?: string;
  /** Absent means always available. */
  available?(ctx: ControlContext): Availability;
}

interface Toggle extends ControlBase {
  kind: 'toggle'; default: boolean; apply(v: boolean): void;
}
interface Choice extends ControlBase {
  kind: 'choice'; options: { id: string; label: string }[];
  default: string; apply(v: string): void;
}
interface Slider extends ControlBase {
  kind: 'slider'; min: number; max: number; step: number;
  default: number; apply(v: number): void; format?(v: number): string;
}
interface Action extends ControlBase { kind: 'action'; run(): void; }

type Control = Toggle | Choice | Slider | Action;

interface ControlContext {
  rung: ZoomTarget;
  tiles: TilesScene;
  lookId: string;
}
```

`available()` is the piece that pays for the abstraction on day one. Today each
gated control costs a matched trio — `setWindsAvailable(available, reason)`,
`setWindsActive(on)`, `onWinds()` — written out verbatim three times for winds,
currents and clouds. One predicate returning a reason replaces all nine
members, and the renderer disables the control and prints the reason without
knowing what a circulation band is.

It is also how per-rung controls stop lying. `true scale` is one stateless
button whose label and meaning change depending on which rung is showing; its
own source comments explain that it must never flip its own active class
because "with two independent semantic toggles sharing this one button, an
internal flip desyncs from whichever toggle isn't currently in view." Under the
registry it becomes two controls that each declare where they apply, and the
desync is structurally impossible rather than commented around.

### The three modules

- **`src/ui/controls/kinds.ts`** — the types above. No behaviour.
- **`src/ui/controls/store.ts`** — `Map<id, value>` plus subscribe. Setting a
  value calls that control's `apply()` and notifies subscribers. No DOM.
- **`src/ui/controls/codec.ts`** — encode the values that differ from their
  default; decode tolerantly.

`main.ts` builds the registry once, closing each `apply()` over the view handles
it needs. The registry is the single place that knows both *"there is a control
called night fill"* and *"it calls `globeView.setNightFill`"*. `HudCallbacks`
is deleted.

### Persistence

Decode is deliberately forgiving, and that tolerance **is** the versioning
story: an unknown id is ignored rather than fatal, and an out-of-range number
clamps. Renaming or removing a control degrades an old link instead of breaking
it, so no schema-version negotiation is needed.

- **URL hash** carries the compact encoding alongside today's `seed`/`view`/
  `day`, so `share` sends what you were actually looking at.
- **localStorage**, versioned key, carries the same payload so a fresh visit
  reopens how you left it.
- **URL wins** when present; local fills in the rest; defaults fill in the
  remainder.

Look-contributed settings are only *rendered* while their Look is active, but
their values are **retained in the store regardless** and serialized by the
codec whether or not that Look is showing. Switching to `voxel` and back to
`dither3d` restores the dot scale you had set, and a shared link carries a
Look's settings even though only one Look's settings are visible at a time.

Two controls do not fit the four kinds and stay bespoke, stated here so it is a
decision rather than a discovery: the **day scrubber** (it carries eclipse
marks and distinguishes a drag from autoplay driving it) and the **info card**.

---

## 2. The layout

One UI, phone-first, expanding at a single CSS breakpoint. There is no second
layout to keep in sync.

### Persistent chrome

- **Status bar** (top): rung segmented control (System / Globe / Map), the
  active lens as a chip, the date, and an overflow menu for seed / reroll /
  share. Tapping the date jumps to the Time tab.
- **Transport strip** (bottom): play/pause, the day scrubber with its eclipse
  marks, the current rate. This is the sheet's collapsed state and never moves
  out from under the thumb.

### The sheet

Draggable, three snap points (collapsed / half / full), four tabs:

| Tab | Contents |
|---|---|
| **Lens** | The seven lenses (`natural`, `topographic`, `temperature`, `moisture`, `precip`, `unrest`, `plates`), with the legend and caption reunited beside them — the legend is a detached box today. |
| **Look** | The Look picker (`natural`, `voxel`, `dither3d`, `pixel`); the active Look's own settings below it; **Scale**; **Surface** (`waves`, `glint`, `night fill`). |
| **Layers** | The three genuine data overlays: `winds`, `currents`, `clouds` — each disabled-with-a-reason when the world lacks the data. |
| **Time** | The full rate picker; the two holds; a single tappable date field. |

The `world` group (seed, reroll, share) has no tab — it renders into the status
bar's overflow menu. The transport strip shows the *current* rate as a
read-only indicator; the Time tab holds the picker that changes it.

### What happened to the controls on the block

- **The two holds** keep composing — they are genuinely orthogonal (one freezes
  the mesh's visual spin, the other freezes the season) — but stop being named
  `freeze spin` and `watch a day`. They become *hold the spin — watch the year*
  and *hold the season — watch a day*, with the automatic hold above 1 day/s
  shown as a derived note rather than an invisible rule.
- **`true scale`** splits into two per-rung `choice` controls that name their
  own axis: *relief ×N / true relief* on the Globe rung, *schematic / true
  orbit distance* on the System rung.
- **The date-jump inputs** — two cramped text boxes and a `jump` button
  duplicating the scrubber — collapse into one tappable date field in Time.
- **`waves` / `glint` / `night fill`** move from overlay level into the Look
  tab. They are rendering choices, not data layers, and sitting beside `winds`
  implied otherwise.

### Mobile specifics

`100dvh` rather than `100%` (iOS Safari's collapsing toolbar is very likely a
direct cause of the reported unusability); `env(safe-area-inset-*)` padding;
`touch-action: none` on the canvases so a globe drag never scrolls the page;
44 CSS px minimum touch targets; a 13 px floor on body type against today's
0.65 rem.

### Desktop

The sheet un-collapses into a fixed left column and its tabs become stacked
sections. Same registry, same renderer, one breakpoint.

---

## 3. The Look axis

One axis replaces `RenderStyle` (post-process), `GlobeStyle` (mesh geometry)
and `MapStyle` (map rung rendering).

```ts
interface Look {
  id: string;
  label: string;
  globeMesh: 'smooth' | 'voxel';          // which worldMesh build path
  globeSurface: 'standard' | 'dither';    // which material
  mapRung: 'diorama' | 'pixel';
  postPasses(tiles: TilesScene): Pass[];  // pixel only; empty for the rest
  settings: Control[];                    // merged into the registry while active
}
```

### The roster

| Look | globeMesh | globeSurface | mapRung | post | own settings |
|---|---|---|---|---|---|
| `natural` | smooth | standard | diorama | — | — |
| `voxel` | voxel | standard | diorama | — | — |
| `dither3d` | smooth | dither | diorama | — | 7 (see §4) |
| `pixel` | smooth | standard | pixel | pixelArt | pixel size, palette size |

**Only genuinely Look-specific settings travel with the Look.** `waves`,
`glint`, `night fill` and the scale controls apply across several Looks, so
they are permanent registry entries in the `look` group with `available()`
gating — not contributed by any Look.

`renderStyle.ts` splits rather than dies: the `StylePipeline` class survives
verbatim as the host for `postPasses` (moving to `src/views/stylePipeline.ts`),
while the `RenderStyle` type, the `STYLES` roster, `photorealStyle` and
`styleById` are deleted — `Look` subsumes all four.

### Deleted

`src/views/styles/cel.ts`, `watercolor.ts`, `engraving.ts`; the `terraced` and
`faceted` geometry paths in `globe.ts` / `worldMesh.ts`; `src/ui/hud.ts` and
`HudCallbacks`.

`quantizeBands` **stays** — the voxel style shares the terraced banding, so
deleting the terraced Look does not delete its banding helper.

---

## 4. Dither3D

Runevision's Surface-Stable Fractal Dithering
(<https://runevision.com/tech/dither3d/>, MPL-2.0). The dots stick to the
surface while holding approximately constant screen size as the camera moves.

The decisive fact, which is why this is not a drop-in replacement for
`engraving`: **it is a material shader, not a post-process.** Every existing
skin is an `EffectComposer` `ShaderPass` over the finished frame. This one needs
the surface's own UVs and their screen-space derivatives.

### The 3D dither texture

Generated at runtime into a `Data3DTexture` (three 0.166, WebGL2 renderer —
both available): Bayer matrices at 1×1, 2×2, 4×4 and 8×8 as slices, arranged so
trilinear filtering between slices produces the fractal blend the technique
depends on. Roughly 50 lines, no binary asset committed, and the generator is a
pure function — so self-similarity is a **property test**, not a snapshot: each
level's 2×2 block average must equal the coarser level's value at that
position.

### UVs in face space — the load-bearing decision

The globe's tile geometry today carries only `position`, `normal` and `color`
(`worldMesh.ts:283-285`, `1047-1049`). There is no `uv`.

Tile geometry gains one, in **cube-sphere face space**: a vertex at `(u, v)`
inside tile `(face, level, ix, iy)` maps to

```
uvFace = ( (ix + u) / 2^level , (iy + v) / 2^level )
```

This is the correctness crux, not a convenience. Surface-stability derives from
screen-space derivatives of the UV, so when the Cascade delivers a patch and a
tile refines from level 2 to level 5, the dot density **must not change**.
Face-space UVs guarantee it: the same surface point carries the same UV at
every level. Per-tile `[0,1]` UVs would both reset density at every tile
boundary and re-scale it on every refine. Seams remain only at the 12 cube
edges.

The attribute is built **unconditionally**, not gated on the active Look.
Smooth and dither share a geometry family, so switching between them triggers
no rebuild today; gating the attribute would force a whole-globe re-mesh on
every Look switch to save 2 floats per vertex against the existing 9.

### Materials

The globe shares one `MeshStandardMaterial({ vertexColors: true })`
(`globe.ts:464`); the ocean shell has its own (`ocean.ts:226`).

Rather than mutating `onBeforeCompile` and paying a shader recompile on every
switch, **two materials are built and the reference is swapped**. The dither
injection lands *after* lighting, so it quantizes the lit colour — which is
what preserves the honest terminator (spec §4½): the terminator's falloff
becomes the dot-density gradient instead of being flattened away.

### Settings (the Look's seven)

`colour mode` (choice: colour / grayscale), `dot scale`, `contrast`,
`size variability`, `stretch smoothness`, `invert dots`, `radial compensation`.

**Colour mode defaults to colour**, and that default is a decision about
honesty rather than taste. Dithering quantizes; the lens paints meaning into
colour. Grayscale is the stronger image and the stronger identity, but it makes
`temperature`, `moisture`, `precip`, `unrest` and `plates` mutually
indistinguishable. The lenses are what the Orrery is for, so a Look that
silently blinds five of the seven cannot be the default. Grayscale remains one
tap away.

### Two deliberate limits

- The Look governs the **globe and map rungs only**. The System rung keeps its
  current rendering.
- Dither applies to the **terrain and ocean surfaces**. The overlay layers
  (winds, currents, clouds, ice) draw over it undithered.

---

## 5. Testing

Co-located vitest, matching the existing convention.

| File | What it pins |
|---|---|
| `controls/registry.test.ts` | Ids unique; every default in range or among its options; every control has a group. |
| `controls/store.test.ts` | Set calls `apply`; subscribers notified; reset restores defaults. |
| `controls/codec.test.ts` | Round-trip; only non-defaults serialized; unknown id ignored; out-of-range clamped; URL beats localStorage. |
| `ui/sheet.test.ts` | Renders groups from a **fake** registry; unavailable → disabled + reason; tab switching. |
| `views/look.test.ts` | Roster ids unique; each Look's mesh/surface/map combination valid. |
| `views/ditherTexture.test.ts` | Self-similarity property; dimensions; value range. |
| `views/worldMesh.test.ts` (extended) | The cross-level UV invariant: same surface point, different levels, same UV. |

`sheet.test.ts` renders from a **fake** registry deliberately, so adding a real
control never edits it — the precise opposite of today's `hud.test.ts`, which
needs a new `noop` for every callback added.

**e2e.** Every rendered control carries `data-control="<id>"`, the same id the
codec writes. Today's specs reach into `.hud-view`, `.hud-style`,
`.hud-map-style`, `.hud-lenses`, `.hud-bottom`, `.hud-caption` and
`.hud-top-left`; all of it churns, and this is the largest single chunk of
mechanical work in the job. Retained: *every Look renders non-blank* (one test
replacing the two per-axis ones). New: a full pass at an iPhone 13 viewport —
every tab reachable, every target ≥ 44 CSS px, no horizontal overflow, scrubber
draggable.

The gate is unchanged: `npm test`, `npm run smoke`, `npm run build`,
`npm run e2e`.

---

## 6. Sequencing

Five stages. Each ends with the full gate green and is independently
shippable.

1. **Strip.** Delete cel / watercolor / engraving / terraced / faceted; collapse
   the three axes into `Look` with the four-entry roster — behind the *existing*
   HUD. Shrinks the surface before anything is rebuilt on it.
2. **Registry.** `kinds` / `store` / `codec`, pure, fully tested, no UI yet.
3. **Surface.** Status bar, transport and sheet rendered from the registry;
   `hud.ts` deleted; `styles.css` rewritten mobile-first; e2e moved to
   `data-control`. **`CLAUDE.md`'s "two patterns you'll reuse" section becomes
   false at this point and is rewritten as part of this stage**, not as a
   follow-up.
4. **Persistence.** URL codec wiring plus localStorage.
5. **Dither3D.** UVs → texture → material → settings. The payoff, and the proof
   the registry works: seven controls arrive with zero renderer edits.

## 7. Risks

- **e2e selector churn** is the largest mechanical cost and lands entirely in
  stage 3.
- **The UV invariant** is unit-testable, but *"does it actually look stable
  while zooming through a Cascade refine"* needs a human eye. Stage 5 carries a
  visual check as an explicit deliverable.
- **Sheet drag on iOS** — the drag-to-snap gesture must not fight the globe's
  `touch-action: none` canvas underneath it. Worth prototyping early in stage 3
  rather than discovering late.

## 8. Success criteria

- The Orrery is usable one-handed on an iPhone: every control reachable, every
  target ≥ 44 CSS px, nothing clipped or off-screen.
- No unlabeled control anywhere in the app.
- Adding a control costs **one registry entry** and edits no renderer, no test
  file, and no callback interface.
- A shared link reproduces the sender's lens, Look and settings.
- Dither3D holds dot density constant across a Cascade refine from level 2 to
  level 5.
