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
import './styles.css';
import { buildHud, type HudCallbacks } from './ui/hud';
import { mountInfoCard } from './ui/infoCard';
import { moonInfo, namedTarget, siteInfo, starInfo, worldInfo } from './ui/inspect';
import { clockToDay } from './time/clock';
import { dayToRawDate, formatRawDate, rawDateToDay } from './time/calendar';
import { createSystemView } from './views/system';
import { createGlobeView, RELIEF_EXAGGERATION } from './views/globe';
import { lensById, naturalLens } from './views/lens';
import { ZoomController, dollyLookAt, dollyPosition, wheelHandoff, type ZoomTarget } from './views/zoom';
import { SPEED_POLICY, SpeedMemory, clampMult } from './time/speedPolicy';
import type { MoonsScene, SystemScene, TilesScene } from './sim/scene';
import { defaultAppState, parseAppState, seedError, serializeAppState, type AppState } from './state/url';
import { randomSeed } from './ui/seed';
import type { WorkerErrorKind } from './sim/worker';

const app = document.getElementById('app')!;

const SPACE_CAPTION =
  'schematic scale: the world’s orbit is to true AU scale, but moon orbits are compressed onto even rungs for legibility — not to true distance.';
const ICE_CAPTION =
  'sea ice and snow are a client derivation from the temperature layers — the season’s freeze line, not simulated ice.';
const GROUND_CAPTION = `relief is exaggerated ${RELIEF_EXAGGERATION}× over true scale so mountains and trenches read on a rendered sphere at all — not to true height. ${ICE_CAPTION}`;
const TRUE_SPACE_CAPTION =
  'true scale: distances are true to the documents; body sizes use reference radii (Earth/Sol/Luna) — the documents carry no absolute radii. The bodies all but vanish against the orbit’s sweep; zoom in and find them.';
const TRUE_GROUND_CAPTION = `relief at true scale (1×): the mountains are down there — the sphere just doesn’t show them at this size. That’s the honest render. ${ICE_CAPTION}`;

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

  worker.onmessage = (ev: MessageEvent) => {
    const msg = ev.data;
    if (msg.type === 'world') {
      mountViews(msg.system, msg.moons, msg.tiles, state);
    } else if (msg.type === 'error') {
      const kind = msg.kind as WorkerErrorKind;
      renderError(kind, titleFor(kind), msg.message, state.seed);
    }
  };

  worker.postMessage({ type: 'generate', seed: state.seed, tilesWidth: 512 });
}

function mountViews(system: SystemScene, moons: MoonsScene, tiles: TilesScene, state: AppState): void {
  app.innerHTML = '';

  const stage = document.createElement('div');
  stage.className = 'view-stage';
  const systemCanvas = document.createElement('canvas');
  systemCanvas.className = 'view-canvas';
  const globeCanvas = document.createElement('canvas');
  globeCanvas.className = 'view-canvas';
  stage.append(systemCanvas, globeCanvas);
  app.append(stage);

  const caption = document.createElement('div');
  caption.className = 'scale-caption';
  app.append(caption);

  const systemRenderer = new THREE.WebGLRenderer({ canvas: systemCanvas, antialias: true });
  systemRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  const globeRenderer = new THREE.WebGLRenderer({ canvas: globeCanvas, antialias: true });
  globeRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  // The system view: the schematic AU-scale orrery (Task 8).
  const systemScene = new THREE.Scene();
  systemScene.background = new THREE.Color(0x03050a);
  systemScene.add(new THREE.AmbientLight(0x404050, 1.2));
  const systemView = createSystemView(system, tiles, moons);
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
  const globeView = createGlobeView(tiles, system);
  globeScene.add(globeView.object3d);
  const globeReach = 6;
  const globeCamera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.05, globeReach * 20);
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
  const globeControls = new OrbitControls(globeCamera, globeCanvas);
  globeControls.enableDamping = true;
  globeControls.minDistance = globeReach * 0.38; // just above the 60x relief
  globeControls.maxDistance = globeReach * 2;

  // The zoom itself (src/views/zoom.ts): CLOSE_OFFSET is a small, arbitrary
  // "just arrived" framing for the system camera's dolly target (aesthetic,
  // preview-tuned, not a physical scale) — it lands here as the globe
  // canvas finishes fading in and takes over.
  const CLOSE_OFFSET = new THREE.Vector3(0, 0.3, 0.6);
  const zoom = new ZoomController();
  let view: ZoomTarget = state.view;
  zoom.jumpTo(view); // the initial view from a deep link never animates in

  // Per-rung true-scale state (Task 8): each rung remembers its own toggle
  // independently, so switching rungs re-presents whichever state that rung
  // was left in.
  const trueScaleOn: Record<ZoomTarget, boolean> = { system: false, globe: false };

  // The wind overlay is a single globe-wide toggle (not per-rung like
  // true-scale): it starts hidden, matching `createWinds`'s built geometry.
  let windsOn = false;

  function setCaptionFor(v: ZoomTarget): void {
    caption.textContent =
      v === 'system'
        ? (trueScaleOn.system ? TRUE_SPACE_CAPTION : SPACE_CAPTION)
        : (trueScaleOn.globe ? TRUE_GROUND_CAPTION : GROUND_CAPTION);
  }
  function setViewButtonFor(v: ZoomTarget): void {
    hud.setViewButton(v === 'system' ? 'view: globe' : 'view: system', true);
  }

  /** Applies the current rung's true-scale state to its view, camera limits,
   * and HUD button/caption — called on toggle and on every rung switch (each
   * rung re-presents its own toggle state, button label included). */
  function applyTrueScale(): void {
    const on = trueScaleOn[view];
    if (view === 'system') {
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
    } else {
      globeView.setTrueRelief(on);
    }
    hud.setTrueScaleActive(on);
    hud.setTrueScaleLabel(on ? 'schematic scale' : 'true scale');
    setCaptionFor(view);
  }

  function resize(): void {
    systemRenderer.setSize(window.innerWidth, window.innerHeight);
    globeRenderer.setSize(window.innerWidth, window.innerHeight);
    const aspect = window.innerWidth / window.innerHeight;
    systemCamera.aspect = aspect;
    systemCamera.updateProjectionMatrix();
    globeCamera.aspect = aspect;
    globeCamera.updateProjectionMatrix();
  }
  resize();
  window.addEventListener('resize', resize);

  // Wheel-through: wheeling into a rung's dolly limit is a request to cross
  // the altitude ladder rather than just a zoom (src/views/zoom.ts).
  function maybeHandoff(deltaY: number, controls: OrbitControls): void {
    // Only a rung at rest may hand off: during the 1.5 s transition the
    // inactive rung's controls are disabled and its camera pose is frozen
    // wherever it was parked — evaluating that stale distance would let a
    // continued scroll whipsaw the transition back mid-flight.
    if (!controls.enabled) return;
    const intent = wheelHandoff(view, deltaY, controls.getDistance(), controls.minDistance, controls.maxDistance);
    if (intent) {
      toggleView();
    }
  }
  systemCanvas.addEventListener('wheel', (e) => maybeHandoff(e.deltaY, systemControls), { passive: true });
  globeCanvas.addEventListener('wheel', (e) => maybeHandoff(e.deltaY, globeControls), { passive: true });

  const hudRoot = document.createElement('div');
  app.append(hudRoot);

  const speedMemory = new SpeedMemory();
  let paused = false;
  let daysPerSecond = speedMemory.restore(view) / 86400;
  let playStartMs = performance.now();
  let dayAtPlayStart = state.day;
  let day = state.day;

  /** Rung switch: restore that rung's speed, re-cap the HUD, rebase the
   * play-head. Used by the view toggle, the hashchange path, and (Task 7)
   * the wheel handoff. */
  function applyView(v: ZoomTarget): void {
    view = v;
    zoom.setTarget(view, performance.now());
    const mult = speedMemory.restore(view);
    daysPerSecond = mult / 86400;
    playStartMs = performance.now();
    dayAtPlayStart = day;
    hud.setMaxSpeed(SPEED_POLICY[view].maxMult);
    hud.setActiveSpeed(mult);
    setCaptionFor(view);
    setViewButtonFor(view);
    systemCanvas.style.pointerEvents = v === 'system' ? 'auto' : 'none';
    globeCanvas.style.pointerEvents = v === 'globe' ? 'auto' : 'none';
    applyTrueScale();
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
    const hash = serializeAppState({ seed: state.seed, view, day });
    if (location.hash !== hash) history.replaceState(null, '', hash);
  }

  function toggleView(): void {
    applyView(view === 'system' ? 'globe' : 'system');
    syncUrl(true);
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
      systemCamera.position.copy(dollyPosition(systemFraming, worldPos, CLOSE_OFFSET, z.value));
      systemCamera.lookAt(dollyLookAt(worldPos, z.value));
    }
    globeControls.enabled = z.value === 1;
    if (globeControls.enabled) globeControls.update();
    systemControls.enabled = z.value === 0;

    systemCanvas.style.opacity = String(z.systemOpacity);
    globeCanvas.style.opacity = String(z.globeOpacity);

    systemRenderer.render(systemScene, systemCamera);
    globeRenderer.render(globeScene, globeCamera);
  }

  const cb: HudCallbacks = {
    onPlayPause() {
      paused = !paused;
      if (!paused) {
        // Resuming rebases the play-head so playback continues from
        // wherever the scrubber currently sits, not from the last
        // pre-pause position.
        playStartMs = performance.now();
        dayAtPlayStart = day;
      }
      hud.setPaused(paused);
    },
    onSpeed(mult) {
      const clamped = clampMult(view, mult);
      speedMemory.remember(view, clamped);
      daysPerSecond = clamped / 86400; // SPEED_STEPS mult is sim-s per real s
      playStartMs = performance.now();
      dayAtPlayStart = day;
      hud.setActiveSpeed(clamped); // corrects the button if the click was over-cap
    },
    onTrueScale() {
      trueScaleOn[view] = !trueScaleOn[view];
      applyTrueScale();
      renderFrame();
    },
    onReroll() {
      // A different seed reloads via the hashchange listener below — the
      // one deliberate full-reload path (module doc comment).
      location.hash = serializeAppState(defaultAppState(randomSeed()));
    },
    onShare() {
      navigator.clipboard.writeText(location.href).then(
        () => hud.flashShared(),
        // Clipboard can be denied; the date line carries the notice until
        // the next date repaint (next unpaused frame or discrete jump).
        () => hud.setDate('copy failed — copy the address bar'),
      );
    },
    onDateJump(year, dayOfYear) {
      day = rawDateToDay(year, dayOfYear, system.world.yearDays);
      playStartMs = performance.now();
      dayAtPlayStart = day;
      hud.setDay(day % system.world.yearDays);
      updateDateLine();
      renderFrame();
      syncUrl(true);
    },
    onToggleView: toggleView,
    onScrub(scrubbedDay) {
      day = Math.floor(day / system.world.yearDays) * system.world.yearDays + scrubbedDay;
      playStartMs = performance.now();
      dayAtPlayStart = day;
      updateDateLine();
      renderFrame();
      syncUrl(true);
    },
    onLens(id) {
      const lens = lensById(id);
      globeView.setLens(lens);
      hud.setLens(lens, lens.legend(tiles));
    },
    onWinds() {
      windsOn = !windsOn;
      globeView.setWinds(windsOn);
      hud.setWindsActive(windsOn);
    },
  };

  /** Repaints the calendar text for the current `day`. Every discrete day
   * mutation (jump, scrub, hash edit) calls this directly — autoplay's
   * per-frame update is gated on `!paused`, so without these calls the
   * date line goes stale exactly when the user pauses to look at a date. */
  function updateDateLine(): void {
    hud.setDate(formatRawDate(dayToRawDate(day, system.world.yearDays)));
  }
  const hud = buildHud(hudRoot, state.seed, cb);
  setCaptionFor(view);
  setViewButtonFor(view);
  // Stacked canvases must route input to the visible rung only — mirrors
  // applyView's pointer-events lines for the initial view (hud isn't built
  // yet when zoom.jumpTo(view) runs above, so this can't literally call
  // applyView at that point).
  systemCanvas.style.pointerEvents = view === 'system' ? 'auto' : 'none';
  globeCanvas.style.pointerEvents = view === 'globe' ? 'auto' : 'none';
  hud.setDayRange(system.world.yearDays);
  hud.setMaxSpeed(SPEED_POLICY[view].maxMult);
  hud.setActiveSpeed(speedMemory.restore(view));
  hud.setDay(day % system.world.yearDays);
  updateDateLine();
  hud.setLens(naturalLens, naturalLens.legend(tiles)); // the picker and the globe agree from the first frame
  hud.setWindsAvailable(
    tiles.circulationBands !== null,
    'no circulation bands: this world is tidally locked',
  );

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
      hud.setDay(day % system.world.yearDays);
      updateDateLine();
    }
  });

  function frame(): void {
    if (!paused) {
      day = dayAtPlayStart + clockToDay(performance.now() - playStartMs, daysPerSecond);
      hud.setDay(day % system.world.yearDays);
      updateDateLine();
    }
    renderFrame();
    syncUrl();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

boot();
