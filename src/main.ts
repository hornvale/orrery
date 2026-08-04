// Boots genesis in a worker, resolves the shared URL state (seed/view/day
// — src/state/url.ts), then mounts BOTH views for good: the system view
// (the 3D orrery, Task 8) and the globe view (the planet itself, Task 9)
// live on two stacked canvases that cross-fade via CSS opacity, while the
// system camera dollies toward the world's own position as the zoom
// (src/views/zoom.ts) eases between them. One shared rAF loop owns `day`.
// Deep links round-trip through `history.replaceState` (no reload, no
// scroll-jack) — the one exception is a changed `#seed=` (hand-edited or
// rerolled), which deliberately reloads the page: genesis is a fresh boot.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ArcballControls } from 'three/addons/controls/ArcballControls.js';
import './styles.css';
import { buildConsoleUi } from './ui/consoleUi';
import { buildRegistry, rateId, rateLabel, SHEET_TABS } from './ui/controls/registry';
import { ControlStore } from './ui/controls/store';
import { decodeControls, encodeControls } from './ui/controls/codec';
import type { ControlContext } from './ui/controls/kinds';
import { mountInfoCard } from './ui/infoCard';
import { eclipseInfo, moonInfo, namedTarget, siteInfo, starInfo, worldInfo } from './ui/inspect';
import { clockToDay } from './time/clock';
import { dayToRawDate, formatRawDate, rawDateToDay } from './time/calendar';
import { buildDateField } from './ui/dateField';
import { createSystemView } from './views/system';
import { createGlobeView, GLOBE_RADIUS, RELIEF_EXAGGERATION, seasonalSpinZ, type GlobeView } from './views/globe';
import {
  containingTile,
  LOD_CDLOD_MAX_LEVEL,
  LOD_SPLIT_FACTOR,
  TILE_QUADS,
  tileEdgeLenM,
  tileKey,
  type TileId,
} from './views/cubeSphere';
import { createMapView } from './views/mapView';
import { lensById, naturalLens, type Lens } from './views/lens';
import { StylePipeline } from './views/stylePipeline';
import { ditherSettingControls, lookById, naturalLook } from './views/look';
import { ZoomController, dollyLookAt, dollyPosition, type ZoomTarget } from './views/zoom';
import { DayHoldCoupling, SPEED_POLICY, SpeedMemory, clampMult } from './time/speedPolicy';
import type { EclipsesScene, MoonsScene, NeighborsScene, RegionScene, SystemScene, TilesScene } from './sim/scene';
import { defaultAppState, parseAppState, seedError, serializeAppState, type AppState } from './state/url';
import { loadLocalControls, resolveControls, saveLocalControls } from './state/persist';
import { debounce } from './state/debounce';
import { randomSeed } from './ui/seed';
import type { WorkerErrorKind } from './sim/worker';

// Build stamp (vite.config.ts `define`) — the first line in the console on every
// load, so a rebuilt bundle is unmistakable through layered caching. If this
// time is stale, you're seeing a cached build, not the rebuild.
console.log(`%c[orrery] build ${__BUILD_STAMP__}`, 'font-weight:bold;color:#7aa2c8');

const app = document.getElementById('app')!;

const SPACE_CAPTION =
  'schematic scale: the world’s orbit is to true AU scale, but moon orbits are compressed onto even rungs for legibility — not to true distance.';
const ICE_CAPTION =
  'sea ice and snow are a client derivation from the temperature layers — the season’s freeze line, not simulated ice.';
const GROUND_CAPTION = `relief is exaggerated ${RELIEF_EXAGGERATION}× over true scale so mountains and trenches read on a rendered sphere at all — not to true height. ${ICE_CAPTION}`;
const TRUE_SPACE_CAPTION =
  'true scale: distances are true to the documents; body sizes use reference radii (Earth/Sol/Luna) — the documents carry no absolute radii. The bodies all but vanish against the orbit’s sweep; zoom in and find them.';
const TRUE_GROUND_CAPTION = `relief at true scale (1×): the mountains are down there — the sphere just doesn’t show them at this size. That’s the honest render. ${ICE_CAPTION}`;
const SEASONAL_HOLD_CAPTION =
  'holding the daily spin — watching the year: the sub-solar latitude and ice line keep advancing with the season while the globe holds a face.';
const DAY_HOLD_CAPTION = 'holding the season — watch a day';
const MAP_CAPTION = 'the flat map: a region, drawn.';

/** The pre-Task-8 globe speed cap (`SPEED_POLICY`'s old `maxMult`, still the
 * threshold above which the daily spin is a blur, not the current one —
 * Task 8 raised the cap itself, this crosses it) — the active clock mult
 * crossing it engages the seasonal hold (Task 9). */
const SEASONAL_HOLD_MULT = 86400;

/** How long the control-persistence write (localStorage + `syncUrl`) waits
 * for quiet before it runs. A slider's `input` event fires on every drag
 * tick — Stage 5 adds the first ones — and without this, a two-second drag
 * at 60fps clears Safari's ~100-`history.replaceState`-calls-per-30s limit
 * easily. Debounced on the PERSISTENCE side only: the control's own `apply`
 * (the render) still runs at full rate on every `store.set`, unthrottled. */
const CONTROL_PERSIST_DEBOUNCE_MS = 250;

/** The plain "still generating" state — replaced by either a mounted world
 * or one of `renderError`'s distinct failure screens. */
function renderStatus(message: string): void {
  app.innerHTML = '';
  const pre = document.createElement('pre');
  pre.className = 'status';
  pre.textContent = message;
  app.append(pre);
}

/** One of this app's honest-error surfaces: a full-screen, named, styled
 * state — never a silent blank canvas. `kind` picks the heading and the
 * `.error-<kind>` accent color; `message` is the underlying reason
 * verbatim (the sim's genesis-refusal text, or the wasm URL, or both
 * schema strings, depending on `kind` — see src/sim/worker.ts). */
function renderError(kind: WorkerErrorKind | 'seed-parse', title: string, message: string, seed?: string): void {
  app.innerHTML = '';
  const el = document.createElement('div');
  el.className = `error-screen error-${kind}`;
  const heading = document.createElement('h1');
  heading.textContent = title;
  el.append(heading);
  if (seed !== undefined) {
    const seedLine = document.createElement('p');
    seedLine.className = 'error-seed';
    seedLine.textContent = `seed ${seed}`;
    el.append(seedLine);
  }
  const body = document.createElement('pre');
  body.textContent = message;
  el.append(body);
  app.append(el);
}

function titleFor(kind: WorkerErrorKind): string {
  switch (kind) {
    case 'catalog-fetch':
      return 'catalog unavailable';
    case 'genesis':
      return 'genesis refused this seed';
    case 'schema':
      return 'scene document mismatch';
    case 'unknown':
    default:
      return 'unexpected error';
  }
}

/** What `mountViews` hands back to `boot`: the globe itself, plus the two
 * routers that carry the worker's region replies into it. */
interface MountedViews {
  globe: GlobeView;
  deliverRegion: (key: string, region: RegionScene) => void;
  deliverRegionError: (key: string) => void;
}

/** Resolves the app's starting `AppState` from the URL hash and boots
 * genesis for it — or, if the hash names an unparseable seed, shows that
 * parse error instead of ever touching the worker. */
function boot(): void {
  const hashSeedError = seedError(location.hash);
  if (hashSeedError) {
    renderError('seed-parse', 'invalid seed in URL', hashSeedError);
    return;
  }
  const state = parseAppState(location.hash) ?? defaultAppState(randomSeed());
  // Canonicalize immediately (leading zeros stripped, defaults omitted) so
  // the address bar reflects exactly what's about to render, even before
  // genesis lands — a link copied while generating is already correct.
  history.replaceState(null, '', serializeAppState(state));

  renderStatus('generating…');

  const worker = new Worker(new URL('./sim/worker.ts', import.meta.url), { type: 'module' });

  // The mounted globe, captured so region-tile replies (LOD stage 4) route to
  // it — the worker serves those from the persisted post-genesis catalog.
  let globe: GlobeView | null = null;
  // The mounted views' region router (also feeds the map rung's placeholder
  // quad, Task 4) — set alongside `globe` the moment `mountViews` returns.
  let views: MountedViews | null = null;
  worker.onmessage = (ev: MessageEvent) => {
    const msg = ev.data;
    if (msg.type === 'world') {
      views = mountViews(msg.system, msg.moons, msg.neighbors, msg.tiles, msg.eclipses, state, worker);
      globe = views.globe;
    } else if (msg.type === 'region') {
      views?.deliverRegion(msg.key, msg.region);
    } else if (msg.type === 'region-error') {
      // Non-fatal: the tile keeps its interpolated form. The failure is still
      // routed to the views — the globe's request scheduler must free the
      // in-flight slot this request was holding, or the cap leaks a slot
      // permanently. The tile is then re-offered by the globe's per-frame
      // re-submit (`dealRegionRequests`) until `CASCADE_MAX_ATTEMPTS` retires
      // it (see `cascade.settle`), so a persistently-failing region costs a
      // handful of requests rather than one per rebuild — or, worse, none.
      console.warn(`region ${msg.key} failed: ${msg.message}`);
      views?.deliverRegionError(msg.key);
    } else if (msg.type === 'error') {
      const kind = msg.kind as WorkerErrorKind;
      renderError(kind, titleFor(kind), msg.message, state.seed);
    }
  };

  worker.postMessage({ type: 'generate', seed: state.seed });
}

function mountViews(
  system: SystemScene,
  moons: MoonsScene,
  neighbors: NeighborsScene,
  tiles: TilesScene,
  eclipses: EclipsesScene,
  state: AppState,
  worker: Worker,
): MountedViews {
  app.innerHTML = '';

  const stage = document.createElement('div');
  stage.className = 'view-stage';
  const systemCanvas = document.createElement('canvas');
  systemCanvas.className = 'view-canvas';
  const globeCanvas = document.createElement('canvas');
  globeCanvas.className = 'view-canvas';
  const mapCanvas = document.createElement('canvas');
  mapCanvas.className = 'view-canvas';
  stage.append(systemCanvas, globeCanvas, mapCanvas);
  app.append(stage);

  const caption = document.createElement('div');
  caption.className = 'scale-caption';
  app.append(caption);

  const systemRenderer = new THREE.WebGLRenderer({ canvas: systemCanvas, antialias: true });
  systemRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  const globeRenderer = new THREE.WebGLRenderer({ canvas: globeCanvas, antialias: true });
  globeRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  const mapRenderer = new THREE.WebGLRenderer({ canvas: mapCanvas, antialias: true });
  mapRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  // The system view: the schematic AU-scale orrery (Task 8).
  const systemScene = new THREE.Scene();
  systemScene.background = new THREE.Color(0x03050a);
  systemScene.add(new THREE.AmbientLight(0x404050, 1.2));
  const systemView = createSystemView(system, tiles, moons, neighbors);
  systemScene.add(systemView.object3d);
  const systemReach = Math.max(system.world.orbitAu, system.star.hzOuterAu) * 3 + 2;
  let systemFraming = new THREE.Vector3(0, systemReach * 0.6, systemReach);
  const systemCamera = new THREE.PerspectiveCamera(
    50,
    window.innerWidth / window.innerHeight,
    0.05,
    systemReach * 20,
  );
  systemCamera.position.copy(systemFraming);
  systemCamera.lookAt(0, 0, 0);

  // The globe view: the planet itself (Task 9) — real relief, biome/ocean
  // colors, settlement markers, an honest day/night terminator. No ambient
  // light in this scene: the night side is meant to fall dark. That's also
  // why the two views are cross-faded as two whole canvases (CSS opacity)
  // rather than merged into one shared THREE.Scene — a shared scene would
  // permanently leak the system view's ambient wash onto the globe's night
  // side, not just during the ~1.5s transition.
  const globeScene = new THREE.Scene();
  globeScene.background = new THREE.Color(0x000000);
  // Region-tile request bridge (LOD stage 4): the globe (and, since The
  // Excursion, the map's own neighbor ring) ask for a tile's true higher-res
  // patch; the worker serves it from the persisted catalog and the reply
  // routes back via `deliverRegion` below. `samples` is the tile grid
  // resolution (TILE_QUADS), `key` matches reply to request.
  const requestRegion = (tile: TileId): void => {
    worker.postMessage({
      type: 'region',
      face: tile.face,
      level: tile.level,
      ix: tile.ix,
      iy: tile.iy,
      samples: TILE_QUADS,
      key: tileKey(tile),
    });
  };

  // The map view: the flat rung below the globe, backed by a same-face
  // neighbor-tile ring (The Excursion) fetched through the same worker
  // bridge the globe's own region tiles use.
  const mapView = createMapView({ requestRegion, domElement: mapCanvas });

  const globeView = createGlobeView(tiles, system, eclipses.events, requestRegion);
  globeScene.add(globeView.object3d);
  const globeReach = 6;
  /** Near-clip for the globe camera — lowered alongside `globeControls.minDistance`
   * below (The Massing, Task 6): reaching the deeper CDLOD tiles
   * (`LOD_CDLOD_MAX_LEVEL`) means letting the camera get close enough that the
   * old 0.05 near-clip would start slicing into the surface it's approaching.
   * Comfortably under the new minimum altitude (`GLOBE_CLOSE_ALTITUDE`, ~3.7%
   * of `GLOBE_RADIUS`, computed below) even before the usual grazing-angle
   * slack. */
  const GLOBE_NEAR = 0.02;
  const globeCamera = new THREE.PerspectiveCamera(
    50,
    window.innerWidth / window.innerHeight,
    GLOBE_NEAR,
    globeReach * 20,
  );
  globeCamera.position.set(0, globeReach * 0.4, globeReach);
  globeCamera.lookAt(0, 0, 0);

  /** How close the system camera may dolly toward bodies — also the wheel
   * handoff floor (matches CLOSE_OFFSET's arrival distance). */
  const WORLD_CLOSE_DISTANCE = 0.3;

  // The helm: the user owns each camera when its rung is at rest; the
  // 1.5 s scripted dolly owns the system camera only during transitions.
  const systemControls = new OrbitControls(systemCamera, systemCanvas);
  systemControls.enableDamping = true;
  systemControls.minDistance = WORLD_CLOSE_DISTANCE;
  systemControls.maxDistance = systemReach * 2;
  // The globe camera is a free arcball: rotate on all three axes (roll
  // included, unlike OrbitControls' locked up-vector — that lock is why the
  // lit hemisphere used to require twisting the poles horizontal) plus dolly.
  // Pan stays off so the world holds the frame's centre (target at the
  // origin), so orbiting never lets the planet drift out of view. No `scene`
  // is passed, so the arcball gizmo rings are not drawn — a clean globe.
  const globeControls = new ArcballControls(globeCamera, globeCanvas);
  globeControls.enablePan = false;
  // How close the arcball may dolly toward the surface (The Massing, Task 6):
  // `selectTiles` only recurses to `LOD_CDLOD_MAX_LEVEL` once the camera is
  // within `LOD_SPLIT_FACTOR × tileEdgeLenM(LOD_CDLOD_MAX_LEVEL - 1, ...)` of a
  // tile centre — half that margin comfortably clears the threshold (so the
  // deepest tiles are actually reachable, not just theoretically selectable)
  // while still clearing the ~8.5% schematic relief bump most places (see
  // `clouds.ts`'s `SHELL_HEADROOM` comment for that estimate). The very
  // tallest exotic peaks may still graze the camera at minimum distance —
  // Task 7's perf/visual pass is where that trade gets revisited.
  const GLOBE_CLOSE_ALTITUDE = LOD_SPLIT_FACTOR * tileEdgeLenM(LOD_CDLOD_MAX_LEVEL - 1, GLOBE_RADIUS) * 0.5;
  globeControls.minDistance = GLOBE_RADIUS + GLOBE_CLOSE_ALTITUDE;
  globeControls.maxDistance = globeReach * 2;

  // The render-STYLE pipeline (The Idioms, Task 1): screen-space skins over
  // the globe frame, orthogonal to the data lens. Photoreal (the default) is
  // an empty pass chain — an EffectComposer whose only pass is the base
  // RenderPass renders identically to the old direct `renderer.render` call.
  const stylePipeline = new StylePipeline(globeRenderer, globeScene, globeCamera, tiles);
  stylePipeline.setPasses(naturalLook.postPasses(tiles));

  // The zoom itself (src/views/zoom.ts): CLOSE_OFFSET is a small, arbitrary
  // "just arrived" framing for the system camera's dolly target (aesthetic,
  // preview-tuned, not a physical scale) — it lands here as the globe
  // canvas finishes fading in and takes over.
  const CLOSE_OFFSET = new THREE.Vector3(0, 0.3, 0.6);
  const zoom = new ZoomController();
  let view: ZoomTarget = state.view;
  zoom.jumpTo(view); // the initial view from a deep link never animates in
  setCanvasPointerEvents(view); // initial view never passes through applyView

  // Every display toggle the old HUD kept as a local `let` — winds, currents,
  // clouds, waves, glint, night fill, the spin freeze, the day hold, and the
  // two true-scale choices — is now a value in the control STORE. Holding a
  // second copy here would desync the moment one is set without the other,
  // so these read `store.get(...)` where the value is needed.
  //
  // The seasonal hold is the one survivor: it is not a control, it is
  // DERIVED (the `hold-spin` control OR a clock rate above the threshold),
  // so it is computed here.
  let seasonalHoldOn = false;

  function setCaptionFor(v: ZoomTarget): void {
    if (v === 'system') {
      caption.textContent = store.get('distance') === 'true' ? TRUE_SPACE_CAPTION : SPACE_CAPTION;
      return;
    }
    if (v === 'map') {
      caption.textContent = MAP_CAPTION;
      return;
    }
    const base = store.get('relief') === 'true' ? TRUE_GROUND_CAPTION : GROUND_CAPTION;
    const seasonSuffix = seasonalHoldOn ? ` ${SEASONAL_HOLD_CAPTION}` : '';
    const daySuffix = store.get('hold-season') === true ? ` ${DAY_HOLD_CAPTION}` : '';
    caption.textContent = `${base}${seasonSuffix}${daySuffix}`;
  }

  /** Engages/disengages the globe's seasonal hold (Task 9) for the given
   * active clock mult and refreshes the caption — called wherever the mult
   * changes (boot, rung switch, and a direct speed pick), and whenever the
   * `hold-spin` control (the user's override at any rate) is flipped. */
  function applySeasonalHold(mult: number): void {
    seasonalHoldOn = store.get('hold-spin') === true || mult > SEASONAL_HOLD_MULT;
    globeView.setSeasonalHold(seasonalHoldOn);
    setCaptionFor(view);
  }

  /** The system rung's `distance` control: true distance needs a nearer clip
   * plane and a nearer dolly floor to be approachable at all. (The globe's
   * `relief` control is the other half of what one true-scale button used to
   * be; it needs nothing but `globeView.setTrueRelief`.) */
  function applyTrueDistance(on: boolean): void {
    systemView.setTrueScale(on);
    systemControls.minDistance = on ? 5e-4 : WORLD_CLOSE_DISTANCE;
    systemCamera.near = on ? 1e-5 : 0.05;
    systemCamera.updateProjectionMatrix();
    if (!on) {
      // Returning to schematic from a deep true-scale zoom: re-frame
      // OUTSIDE the restored floor ourselves. Left alone, OrbitControls'
      // next update() hard-clamps the camera onto minDistance exactly —
      // which is also the wheel handoff's trigger boundary, so the next
      // inward scroll would descend to the globe as a surprise.
      const offset = systemCamera.position.clone().sub(systemControls.target);
      const comfortable = WORLD_CLOSE_DISTANCE * 1.5;
      if (offset.length() < comfortable) {
        systemCamera.position.copy(systemControls.target).add(offset.setLength(comfortable));
      }
    }
    setCaptionFor(view);
  }

  const drawingBuffer = new THREE.Vector2();
  function resize(): void {
    systemRenderer.setSize(window.innerWidth, window.innerHeight);
    globeRenderer.setSize(window.innerWidth, window.innerHeight);
    mapRenderer.setSize(window.innerWidth, window.innerHeight);
    stylePipeline.setSize(window.innerWidth, window.innerHeight);
    const aspect = window.innerWidth / window.innerHeight;
    systemCamera.aspect = aspect;
    systemCamera.updateProjectionMatrix();
    globeCamera.aspect = aspect;
    globeCamera.updateProjectionMatrix();
    // The dither material's radial term measures `gl_FragCoord` — DEVICE
    // pixels — so it needs the drawing buffer, not the CSS size the three
    // `setSize` calls above take. On a DPR-2 display those differ by 2× and
    // the term blows the frame out to white; ask the renderer rather than
    // re-deriving `min(devicePixelRatio, 2)` here and drifting from it.
    globeRenderer.getDrawingBufferSize(drawingBuffer);
    globeView.setViewport(drawingBuffer.x, drawingBuffer.y);
  }
  resize();
  window.addEventListener('resize', resize);

  /** Requests the map rung's region tile for whatever the globe camera is
   * currently looking at — called on every explicit switch into the map
   * view (the dropdown; the wheel-driven handoff that used to trigger this
   * is retired). Sub-camera point on the globe, in the UNSPUN cube-sphere
   * frame: undo the seasonal spin so the region requested matches the
   * surface actually under the camera's look direction, not its spun-away
   * former position. Never throws: a boot straight into the map rung (the
   * globe never oriented, or its camera parked exactly on the arcball
   * target) falls back to a default tile rather than dividing by a
   * zero-length offset. */
  function enterMapRegion(): void {
    const offset = globeCamera.position.clone().sub(globeControls.target);
    let tile: TileId;
    if (offset.lengthSq() > 1e-12) {
      const dir = offset.normalize();
      const spin = seasonalSpinZ(system, day, seasonalHoldOn);
      dir.applyAxisAngle(new THREE.Vector3(0, 0, 1), -spin);
      tile = containingTile([dir.x, dir.y, dir.z], 3);
    } else {
      tile = containingTile([0, 0, 1], 3);
    }
    mapView.beginRegion(tile); // fetches the whole ring; replies route via boot -> deliverRegion
  }

  const speedMemory = new SpeedMemory();
  let paused = false;
  let daysPerSecond = speedMemory.restore(view) / 86400;
  let playStartMs = performance.now();
  let dayAtPlayStart = state.day;
  let day = state.day;

  /** Rung switch: restore that rung's speed, rebase the play-head, and
   * re-evaluate availability (relief is globe-only, orbit distance is
   * system-only). Used by the rung buttons and the hashchange path. */
  function applyView(v: ZoomTarget): void {
    view = v;
    zoom.setTarget(view, performance.now());
    applyRate(speedMemory.restore(view)); // also rebases, holds, and repaints the caption
    consoleUi.statusBar.setRung(view);
    setCanvasPointerEvents(v);
    // The rung changed, so what is available changed — recomputed, never a
    // captured snapshot.
    consoleUi.refresh(ctx());
    if (v === 'map') enterMapRegion();
  }

  /** Only the active rung's canvas takes pointer input — the others (including
   * the opacity-0, paint-topmost map canvas) must be `pointer-events: none` or
   * they intercept clicks meant for the visible rung underneath. Called from
   * `applyView` on every rung switch AND once at boot (below), since the
   * initial view never passes through `applyView`. */
  function setCanvasPointerEvents(v: ZoomTarget): void {
    systemCanvas.style.pointerEvents = v === 'system' ? 'auto' : 'none';
    globeCanvas.style.pointerEvents = v === 'globe' ? 'auto' : 'none';
    mapCanvas.style.pointerEvents = v === 'map' ? 'auto' : 'none';
  }

  /** Writes `seed`/`view`/`day` back to the URL via `replaceState` — no
   * reload, no scroll-jack. Throttled to ~1/s during autoplay (`force`
   * bypasses that for a discrete user action: toggling the view or
   * scrubbing) so a live playthrough doesn't hammer the History API every
   * frame while still keeping a copied link close to current. */
  let lastUrlSyncMs = 0;
  function syncUrl(force = false): void {
    const now = performance.now();
    if (!force && now - lastUrlSyncMs < 1000) return;
    lastUrlSyncMs = now;
    // TODO(map-rung): a later task persists the map rung in AppState/the URL;
    // until then a deep link into 'map' is represented as 'globe' — this
    // keeps `serializeAppState`'s narrower type total rather than widening
    // the URL contract ahead of that wiring (a reload while on the map rung
    // lands back on the globe, one rung up, rather than erroring).
    const urlView = view === 'map' ? 'globe' : view;
    const hash = serializeAppState({ seed: state.seed, view: urlView, day, controls: state.controls });
    if (location.hash !== hash) history.replaceState(null, '', hash);
  }

  function renderFrame(): void {
    systemView.update(day);
    globeView.update(day, globeCamera);

    const z = zoom.stateAt(performance.now());
    const worldPos = systemView.worldPosition(day);
    if (z.value === 0) {
      // At rest on the system rung the user owns the camera; remember their
      // pose so the next descent dollies from where they actually are.
      systemControls.update();
      systemFraming = systemCamera.position.clone();
    } else {
      // The system<->globe dolly only spans the [0,1] segment of the ladder;
      // on the globe->map segment `value` runs 1->2, and clamping here holds
      // the system camera at its closest (globe-arrival) framing while the
      // map fades in over it, rather than continuing to dolly (nowhere left
      // to go — the system camera has no notion of the map rung at all).
      const systemDollyValue = Math.min(z.value, 1);
      systemCamera.position.copy(dollyPosition(systemFraming, worldPos, CLOSE_OFFSET, systemDollyValue));
      systemCamera.lookAt(dollyLookAt(worldPos, systemDollyValue));
    }
    globeControls.enabled = z.value === 1;
    if (globeControls.enabled) globeControls.update();
    systemControls.enabled = z.value === 0;

    systemCanvas.style.opacity = String(z.systemOpacity);
    globeCanvas.style.opacity = String(z.globeOpacity);
    mapCanvas.style.opacity = String(z.mapOpacity);

    systemRenderer.render(systemScene, systemCamera);
    stylePipeline.render();
    if (z.mapOpacity > 0) mapView.render(mapRenderer);
  }

  /** The live control context. Availability predicates read the CURRENT rung
   * and the CURRENT Look, so this is recomputed on every refresh — a captured
   * snapshot would freeze availability at boot. */
  const ctx = (): ControlContext => ({ rung: view, tiles, lookId: String(store.get('look') ?? 'natural') });

  /** `reconcileDayHold`'s "mark it off" hook. The store owns the day hold
   * now, so the mark IS a store write; guarded on inequality so the write
   * (which re-enters `setHoldSeason`) cannot loop. */
  function syncDayHold(on: boolean): void {
    if (store.get('hold-season') !== on) store.set('hold-season', on);
  }

  /** Shows `lens` on the status chip, and hands its caption to the lens
   * control — that help line is where the old HUD's `.hud-caption` lives. */
  function showLens(lens: Lens): void {
    consoleUi.statusBar.setLens(lens.label);
    lensControl.help = lens.caption;
  }

  /** The one place a clock rate takes effect: clamp to the rung's cap,
   * remember it, rebase the play-head, repaint the rate chip, re-evaluate
   * the seasonal hold. Returns what the rate actually became. */
  function applyRate(mult: number): number {
    const clamped = clampMult(view, mult);
    speedMemory.remember(view, clamped);
    daysPerSecond = clamped / 86400; // SPEED_STEPS mult is sim-s per real s
    playStartMs = performance.now();
    dayAtPlayStart = day;
    consoleUi.transport.setRateLabel(rateLabel(clamped));
    // Corrects the picker when the pick was over the rung's cap (and carries
    // an internally-applied rate back onto it). Guarded on inequality so it
    // terminates: the write re-enters `setRate` -> `applyRate`, which clamps
    // to the same value and finds the store already holding it.
    const picked = rateId(clamped);
    if (store.get('rate') !== picked) store.set('rate', picked);
    applySeasonalHold(clamped);
    return clamped;
  }

  /** The day hold's whole relationship with the clock: engaging it drops a
   * fast rate to a watchable one, and any OTHER rate change reconciles it
   * back off. Both live in one object so the drop cannot cancel itself
   * through `applyRate`'s picker write-back (see `DayHoldCoupling`). */
  const dayHold = new DayHoldCoupling({
    seasonalHoldMult: SEASONAL_HOLD_MULT,
    mult: () => daysPerSecond * 86400,
    watchableMult: () => SPEED_POLICY[view].defaultMult,
    applyRate: (mult) => { applyRate(mult); },
    setDayHold: (on) => globeView.setDayHold(on),
    held: () => store.get('hold-season') === true,
    setHeld: syncDayHold,
  });

  // THE registry: one entry per control, each `apply` closing over the view
  // handle it drives. No callback interface, no per-control HUD setter trio.
  const registry = buildRegistry({
    setLens: (id) => {
      const lens = lensById(id);
      globeView.setLens(lens);
      showLens(lens);
    },
    setLook: (id) => {
      const look = lookById(id);
      stylePipeline.setPasses(look.postPasses(tiles));
      globeView.setStyle(look.globeMesh);
      globeView.setSurface(look.globeSurface);
      mapView.setStyle(look.mapRung);
      // A Look's own settings appear and disappear with it, so availability
      // is re-evaluated against the NEW lookId — the store's own notify
      // would re-render against the context the sheet last saw.
      consoleUi.refresh(ctx());
    },
    setWinds: (on) => globeView.setWinds(on),
    setCurrents: (on) => globeView.setCurrents(on),
    setClouds: (on) => globeView.setClouds(on),
    setWaves: (on) => globeView.setWaves(on),
    setGlint: (on) => globeView.setGlint(on),
    setNightFill: (on) => globeView.setNightFill(on),
    setTrueRelief: (on) => {
      globeView.setTrueRelief(on);
      setCaptionFor(view);
      renderFrame(); // show the swap immediately, even while paused
    },
    setTrueDistance: (on) => {
      applyTrueDistance(on);
      renderFrame();
    },
    setHoldSpin: () => {
      // The store already holds the new value; re-evaluate the hold against
      // the current clock rate (daysPerSecond is the live mult / 86400) so
      // the freeze takes effect immediately.
      applySeasonalHold(daysPerSecond * 86400);
    },
    setHoldSeason: (on) => {
      // Pins the season and, at a fast rate, drops to a watchable pace.
      // `hold-spin` (the user's own explicit freeze choice) is untouched —
      // this holds the season, not the spin, so it composes rather than
      // overriding.
      dayHold.engage(on);
      setCaptionFor(view);
    },
    setRate: (mult) => {
      // Watch-a-day and the fast seasonal-hold regime are mutually exclusive
      // — a fast pick here disengages an active day-hold rather than
      // composing with it (the coupling guards the other direction).
      dayHold.reconcile(applyRate(mult));
    },
    rungDefaultRate: () => SPEED_POLICY[view].defaultMult,
    reroll: () => {
      // A different seed reloads via the hashchange listener below — the
      // one deliberate full-reload path (module doc comment).
      location.hash = serializeAppState(defaultAppState(randomSeed()));
    },
    share: () => {
      navigator.clipboard.writeText(location.href).then(
        () => consoleUi.statusBar.flashShared(),
        // Clipboard can be denied; the date chip carries the notice until
        // the next date repaint (next unpaused frame or discrete jump).
        () => consoleUi.statusBar.setDate('copy failed — copy the address bar'),
      );
    },
    // Only the active Look's settings are RENDERED, but the store holds every
    // known control's value — so switching away and back restores the dot
    // scale, and a shared link carries it either way (see ControlStore).
    lookSettings: () => ditherSettingControls((s) => globeView.setDitherSettings(s)),
    lensLegend: () => lensById(String(store.get('lens') ?? 'natural')).legend(tiles),
  });
  const store = new ControlStore(registry);
  /** The lens entry, kept so its `help` can carry the ACTIVE lens's caption
   * (the one control whose caption is not a fixed string). */
  const lensControl = registry.find((c) => c.id === 'lens')!;

  // The date field is bespoke chrome in the Time tab (Task 8b) — text entry
  // needs parsing and an invalid state, which no control kind models. It must
  // be built before `consoleUi` (it is passed in as the `time` group's
  // extra), so `onJump` cannot close over `consoleUi` directly; it calls the
  // named `jumpToDate` below instead, which is safe because `jumpToDate` is a
  // hoisted function declaration and is only ever invoked after boot, long
  // after `consoleUi` exists.
  const dateField = buildDateField({ onJump: jumpToDate });

  const consoleUi = buildConsoleUi({
    controls: registry,
    store,
    tabs: SHEET_TABS,
    extras: { time: [dateField.element] },
    onRung: (v) => {
      applyView(v);
      syncUrl(true);
    },
    onPlayPause: () => {
      paused = !paused;
      if (!paused) {
        // Resuming rebases the play-head so playback continues from
        // wherever the scrubber currently sits, not from the last
        // pre-pause position.
        playStartMs = performance.now();
        dayAtPlayStart = day;
      }
      consoleUi.transport.setPaused(paused);
    },
    onScrub: (scrubbedDay) => {
      day = Math.floor(day / system.world.yearDays) * system.world.yearDays + scrubbedDay;
      playStartMs = performance.now();
      dayAtPlayStart = day;
      updateDateLine();
      renderFrame();
      syncUrl(true);
    },
    onEclipseMark: (event) => {
      infoCard.show(eclipseInfo(event));
    },
  });
  app.append(consoleUi.element);

  /** Repaints the calendar text for the current `day`. Every discrete day
   * mutation (scrub, hash edit) calls this directly — autoplay's per-frame
   * update is gated on `!paused`, so without these calls the date line goes
   * stale exactly when the user pauses to look at a date. */
  function updateDateLine(): void {
    const raw = dayToRawDate(day, system.world.yearDays);
    consoleUi.statusBar.setDate(formatRawDate(raw));
    // Keeps the date field's displayed value current as the clock advances,
    // not just after a jump — 1-based, mirroring the status line.
    dateField.setDate(raw.year + 1, raw.dayOfYear + 1);
  }

  /** The date field's jump path — the old HUD's `onDateJump`, verbatim:
   * 1-based in from the field, 0-based to the engine. A named function
   * (hoisted), not a closure captured at `dateField`'s construction, because
   * the field is built before `consoleUi` exists. */
  function jumpToDate(year: number, dayOfYear: number): void {
    day = rawDateToDay(year - 1, dayOfYear - 1, system.world.yearDays);
    playStartMs = performance.now();
    dayAtPlayStart = day;
    consoleUi.transport.setDay(day % system.world.yearDays);
    updateDateLine();
    renderFrame();
    syncUrl(true);
  }

  // Stacked canvases must route input to the visible rung only — mirrors
  // applyView's pointer-events lines for the initial view (the console isn't
  // built yet when zoom.jumpTo(view) runs above, so this can't literally call
  // applyView at that point).
  systemCanvas.style.pointerEvents = view === 'system' ? 'auto' : 'none';
  globeCanvas.style.pointerEvents = view === 'globe' ? 'auto' : 'none';
  // The map rung is never the initial view — `state.view` (AppState) is
  // narrower than ZoomTarget and admits only 'system'|'globe' (the map rung
  // isn't yet a deep-linkable URL state, see syncUrl's TODO above) — so this
  // is unconditionally hidden at boot, unlike applyView's ternary which runs
  // after the ladder can actually reach 'map'.
  mapCanvas.style.pointerEvents = 'none';

  consoleUi.statusBar.setSeed(state.seed);
  consoleUi.statusBar.setRung(view);
  showLens(naturalLens); // the picker, the chip and the globe agree from the first frame
  consoleUi.transport.setDayRange(system.world.yearDays);
  consoleUi.transport.setDay(day % system.world.yearDays);
  consoleUi.transport.setEclipses(eclipses.events, system.world.yearDays);
  updateDateLine();

  // Persist every control change: into localStorage always, into the URL as
  // a discrete user action (a control change isn't autoplay, so it bypasses
  // syncUrl's throttle). Subscribing BEFORE restoring means the restore
  // below flows through this same path, so a silent localStorage-only
  // restore still leaves the URL (and thus Share) reflecting what's
  // actually on screen, rather than the address bar catching up only once
  // the viewer touches something.
  //
  // Debounced (see `CONTROL_PERSIST_DEBOUNCE_MS`): `store.set` itself still
  // notifies, and the control's own `apply` still repaints, on every call —
  // only the write below waits for quiet, and it always reads `store`
  // fresh when it finally runs, so a burst's LAST value is what lands, never
  // a stale one from mid-drag.
  const persistControls = debounce(() => {
    const encoded = encodeControls(store.nonDefaults());
    saveLocalControls(encoded);
    state.controls = encoded;
    syncUrl(true);
  }, CONTROL_PERSIST_DEBOUNCE_MS);
  store.subscribe(persistControls);

  // URL first, local as the fallback — `resolveControls` is the one place
  // that rule lives, so it has its own unit test rather than being an inline
  // ternary nobody can exercise in isolation. `decodeControls` is forgiving
  // (unknown ids ignored, sliders clamped, bad choices dropped), so a stale
  // or hand-edited blob degrades gracefully rather than erroring.
  const restored = decodeControls(resolveControls(state.controls, loadLocalControls), registry);
  for (const [id, v] of Object.entries(restored)) store.set(id, v);

  // The store applies nothing at construction, and it does not need to: every
  // default IS the state its view was built in (overlays hidden, waves and
  // glint on, schematic scale, the natural lens and Look, and the rate,
  // whose default now tracks the rung — see `buildRegistry`'s
  // `rungDefaultRate`). A restored rate already ran its own apply above (via
  // `setRate` -> `applyRate`, which also engages the hold and sets the
  // caption); anything else falls back to the rung's own resting pace here.
  if (!('rate' in restored)) applyRate(speedMemory.restore(view));
  consoleUi.refresh(ctx());

  const infoCard = mountInfoCard(app);
  const raycaster = new THREE.Raycaster();

  /** A click (not an orbit-drag): pointerdown/up within 5 px and 500 ms. */
  let downAt: { x: number; y: number; t: number } | null = null;
  function onPointerDown(e: PointerEvent): void {
    downAt = { x: e.clientX, y: e.clientY, t: performance.now() };
  }
  function pick(e: PointerEvent, camera: THREE.PerspectiveCamera, sceneRoot: THREE.Object3D): void {
    if (!downAt) return;
    const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
    const held = performance.now() - downAt.t;
    downAt = null;
    if (moved > 5 || held > 500) return; // that was an orbit, not a click
    const ndc = new THREE.Vector2(
      (e.clientX / window.innerWidth) * 2 - 1,
      -(e.clientY / window.innerHeight) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, camera);
    for (const hit of raycaster.intersectObjects(sceneRoot.children, true)) {
      for (let o: THREE.Object3D | null = hit.object; o; o = o.parent) {
        const target = namedTarget(o.name);
        if (!target) continue;
        // Any non-feature card supersedes a selected site's label.
        if (target.kind !== 'feature') globeView.setSelected(null);
        if (target.kind === 'star') return infoCard.show(starInfo(system));
        if (target.kind === 'world') return infoCard.show(worldInfo(system, day));
        if (target.kind === 'moon') return infoCard.show(moonInfo(system, moons, target.index, day));
        const f = tiles.features.find((x) => x.name === target.name);
        if (f) {
          // The whole site shares the card: every feature on these exact
          // coordinates, the flagship hoisted first (stable otherwise).
          const residents = tiles.features
            .filter((x) => x.latitude === f.latitude && x.longitude === f.longitude)
            .sort((a, b) => Number(b.kind === 'flagship') - Number(a.kind === 'flagship'));
          globeView.setSelected(target.name); // the clicked site wears its label
          return infoCard.show(siteInfo(tiles, residents));
        }
      }
    }
    globeView.setSelected(null);
    infoCard.hide(); // click-away on empty space
  }
  // The card's own Escape handler only hides the card; the site label
  // follows the same dismissal.
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') globeView.setSelected(null); });
  systemCanvas.addEventListener('pointerdown', onPointerDown);
  globeCanvas.addEventListener('pointerdown', onPointerDown);
  systemCanvas.addEventListener('pointerup', (e) => pick(e, systemCamera, systemScene));
  globeCanvas.addEventListener('pointerup', (e) => pick(e, globeCamera, globeScene));

  // Reading the URL happens once at boot (above, via `boot()`'s initial
  // state) plus here on `hashchange` — a user editing the address bar by
  // hand repositions the live view/day in place. A different seed is the
  // one case that reloads (see the module doc comment).
  window.addEventListener('hashchange', () => {
    const hashErr = seedError(location.hash);
    if (hashErr) {
      renderError('seed-parse', 'invalid seed in URL', hashErr);
      return;
    }
    const next = parseAppState(location.hash);
    if (!next) return;
    if (next.seed !== state.seed) {
      location.reload();
      return;
    }
    if (next.view !== view) {
      applyView(next.view);
    }
    if (Math.abs(next.day - day) > 1e-9) {
      day = next.day;
      dayAtPlayStart = day;
      playStartMs = performance.now();
      consoleUi.transport.setDay(day % system.world.yearDays);
      updateDateLine();
    }
  });

  function frame(): void {
    if (!paused) {
      day = dayAtPlayStart + clockToDay(performance.now() - playStartMs, daysPerSecond);
      consoleUi.transport.setDay(day % system.world.yearDays);
      updateDateLine();
    }
    renderFrame();
    syncUrl();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  /** Routes a worker region reply to whichever mounted view(s) are waiting on
   * it: the globe always (its own tile-refinement bookkeeping), and the map
   * whenever the key belongs to a tile its own neighbor ring is tracking —
   * each view now decides internally whether a reply is one it cares about. */
  function deliverRegion(key: string, region: RegionScene): void {
    globeView.onRegion(key, region);
    mapView.onRegion(key, region); // no-ops if `key` isn't one the map's ring is tracking
  }

  /** Routes a worker region FAILURE the same way: only the globe cares — its
   * scheduler is holding an in-flight slot for this key (the map's ring has
   * no such bookkeeping and simply keeps its placeholder). */
  function deliverRegionError(key: string): void {
    globeView.onRegionError(key);
  }

  return { globe: globeView, deliverRegion, deliverRegionError };
}

boot();
