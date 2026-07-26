// mdkr64-shell.js — browser launcher for the mdkr64 WebGPU/wasm engine.
//
// Flow: feature-detect WebGPU -> let the user pick their .z64 (validated and
// byte-order-normalised by rom-id.js, which index.html loads first) ->
// instantiate the wasm module -> mount IDBFS at /rom (ROM persists across
// reloads) and /save (EEPROM persists) -> write the ROM into MEMFS/IDBFS ->
// callMain(--rom ...).
// The engine reads the whole ROM at boot (rom_io.c) and drives its own frame
// loop, suspending to requestAnimationFrame via Asyncify at each frame boundary.
//
// No ROM is distributed with this page; the user supplies their own. Everything
// stays in the browser — there is no server to upload to.

"use strict";

// The ROM is always written here in canonical .z64 order — validateRom() below
// converts a .v64/.n64 pick in place before it is persisted, so the name is
// accurate rather than aspirational. Size and revision live in rom-id.js.
const ROM_PATH = "/rom/baserom.us.v80.z64";
const $ = (id) => document.getElementById(id);

let romBytes = null;     // freshly-picked ROM bytes (null once written to FS)
let module = null;       // the instantiated engine Module
let booted = false;
let savedOnce = false;

// ---- Browser regression bridge -------------------------------------------
// A CDP test can install this object with Page.addScriptToEvaluateOnNewDocument
// before any page code runs. Nothing is read from the URL and no test asset is
// shipped: the fixture text remains in the test process and is written into the
// module's private MEMFS only after the user-supplied ROM has passed the normal
// picker/identity gate. Ordinary visitors never create this object, so this path
// is inert in production.
const testConfig = (() => {
  const value = globalThis.__mdkrTestConfig;
  return value && typeof value === "object" ? value : null;
})();
const testState = testConfig ? {
  phase: "shell-loaded",
  exitCode: null,
  abortReason: null,
  errors: [],
  storage: null,
  module: null,
} : null;
if (testState) globalThis.__mdkrTestState = testState;

function testMark(phase) {
  if (testState) testState.phase = phase;
}

function testError(value) {
  if (!testState) return;
  const text = String(value == null ? "" : value);
  testState.errors.push(text.slice(0, 1000));
  if (testState.errors.length > 32) testState.errors.shift();
}

// FNV-1a is not a security hash; it is a compact reload oracle for the 512-byte
// EEPROM. Never fingerprint the ROM here: the browser check only records that
// the expected private file exists and has the legal 12 MiB size.
function testFileInfo(path, includeHash) {
  if (!module || !module.FS) return { exists: false, size: 0, hash: null };
  try {
    const bytes = module.FS.readFile(path);
    let hash = null;
    if (includeHash) {
      let value = 0x811c9dc5;
      for (const byte of bytes) {
        value ^= byte;
        value = Math.imul(value, 0x01000193) >>> 0;
      }
      hash = value.toString(16).padStart(8, "0");
    }
    return { exists: true, size: bytes.length, hash };
  } catch (e) {
    return { exists: false, size: 0, hash: null };
  }
}

function testAudioInfo() {
  const audio = module && module.mdkrAudio;
  if (!audio) return null;
  return {
    ready: audio.ready === true,
    failed: audio.failed === true,
    posted: Number(audio.posted) || 0,
    ring: Number(audio.statRing) || 0,
    underflows: Number(audio.under) || 0,
    contextState: audio.ctx ? String(audio.ctx.state) : "missing",
  };
}

function testRefreshExitState() {
  if (!testState || !module || testState.phase !== "main-started") return;
  if (Number.isInteger(module.__mdkrExitCode)) {
    testState.exitCode = module.__mdkrExitCode;
    testMark("exited");
  }
}

if (testState) {
  globalThis.__mdkrTestSnapshot = () => {
    testRefreshExitState();
    return {
      phase: testState.phase,
      exitCode: testState.exitCode,
      abortReason: testState.abortReason,
      errors: testState.errors.slice(),
      frames: module && Number.isFinite(module.__mdkrFrames)
        ? module.__mdkrFrames : 0,
      rom: testFileInfo(ROM_PATH, false),
      save: testFileInfo("/save/eeprom.bin", true),
      audio: testAudioInfo(),
    };
  };
}

// ---- WebGPU capability gate ------------------------------------------------
// A real adapter request (not just navigator.gpu presence): some browsers expose
// the API but have no usable GPU, which would boot to a permanently black canvas.
async function gate() {
  if (!("gpu" in navigator)) {
    return "This build needs WebGPU. Use Chrome / Edge 113+ (or a WebGPU-enabled Firefox / Safari).";
  }
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      return "Your browser exposes WebGPU but no usable GPU adapter was found (it may be blocklisted or disabled).";
    }
  } catch (e) {
    return "WebGPU adapter request failed: " + (e && e.message ? e.message : e);
  }
  return null;
}

// ---- Client-side ROM check -------------------------------------------------
// The whole gate lives in rom-id.js, which is the browser mirror of
// platform/rom_id.c: size -> byte order (converted IN PLACE to .z64 here, so the
// copy persisted to IDBFS is canonical) -> which DKR revision this actually is.
//
// It used to be size + magic only. That accepted .v64/.n64 without converting
// anything (the engine converted, so it worked, but this side did not know it)
// and — the real hole — accepted EVERY DKR revision, because all five are 12 MB
// with the same magic. A European or Japanese cart passed and booted into
// garbage. rom-id.js says exactly which revision it is instead.
//
// Returns an error string to show the user, or null to accept. Mutates `bytes`
// into .z64 order on success.
function validateRom(bytes, name) {
  if (typeof dkrValidateRom !== "function") {
    return "rom-id.js failed to load, so this page cannot check your ROM. Reload the page.";
  }
  const res = dkrValidateRom(bytes, name);
  if (res.error) return res.error;
  if (res.warning) console.warn("[ROM] " + res.warning);
  if (res.order && res.order !== "z64") {
    console.info(`[ROM] .${res.order} image converted to big-endian .z64 order.`);
  }
  return null;
}

// ---- Presentation preferences ---------------------------------------------
// Remembered across sessions so a chosen mode survives a reload, and reflected
// from the URL so a shared link opens on the same settings.
const PREF_MODE = "mdkr64.mode";
const PREF_SCALE = "mdkr64.scale";
function initQualityControls() {
  const qsp = new URLSearchParams(location.search);
  const mode = $("mode");
  const scale = $("scale");
  if (!mode || !scale) return;
  try {
    const m = qsp.get("mode") || localStorage.getItem(PREF_MODE);
    const s = qsp.get("scale") || localStorage.getItem(PREF_SCALE);
    if (m && [...mode.options].some((o) => o.value === m)) mode.value = m;
    if (s !== null && [...scale.options].some((o) => o.value === s)) scale.value = s;
  } catch (_) { /* private mode: fall back to the defaults in the markup */ }
  const save = () => {
    try {
      localStorage.setItem(PREF_MODE, mode.value);
      localStorage.setItem(PREF_SCALE, scale.value);
    } catch (_) { /* nothing to do if storage is unavailable */ }
  };
  mode.addEventListener("change", save);
  scale.addEventListener("change", save);
}

// ---- Engine factory (loads mdkr64_web.js, which defines createMDKR64) -------
function loadEngineFactory() {
  if (window.createMDKR64) return Promise.resolve(window.createMDKR64);
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "mdkr64_web.js";
    s.onload = () => window.createMDKR64
      ? resolve(window.createMDKR64)
      : reject(new Error("mdkr64_web.js loaded but did not define createMDKR64"));
    s.onerror = () => reject(new Error("failed to load mdkr64_web.js"));
    document.head.appendChild(s);
  });
}

// ---- Persist saves (IDBFS -> IndexedDB) ------------------------------------
// FS.syncfs is not reentrant, and there used to be TWO independent coalescers in
// this page: this one, and the engine's own EM_ASM after every EEPROM write
// (platform/stubs_dkr.c), which guarded on Module.__mdkrSyncing. Neither knew
// about the other, so the 5-second timer below could start a sync while an
// EEPROM-write sync was still in flight. There is now exactly ONE: this
// function is installed as Module.__mdkrPersist and the engine calls it, so
// every sync in the page — timer, pagehide, EEPROM write, save wipe — queues
// behind the same flag and reports errors in the same place.
let syncing = false, syncAgain = false, persistError = null;
let persistWaiters = [];

function finishPersistWaiters(err) {
  const waiters = persistWaiters;
  persistWaiters = [];
  for (const done of waiters) {
    try { done(err || null); } catch (e) {}
  }
}

function persist(done) {
  if (done) persistWaiters.push(done);
  if (!module || !module.FS) { finishPersistWaiters(null); return; }
  if (syncing) { syncAgain = true; return; }
  syncing = true;
  try {
    module.FS.syncfs(false, (err) => {
      syncing = false;
      if (err) {
        persistError = persistError || err;
        $("save-banner").hidden = false;
      }
      else { savedOnce = true; }
      if (syncAgain) {
        syncAgain = false;
        persist();
        return;
      }
      const finalError = persistError;
      persistError = null;
      finishPersistWaiters(finalError);
    });
  } catch (e) {
    syncing = false;
    syncAgain = false;
    persistError = null;
    finishPersistWaiters(e);
  }
}

// ---- Resume the AudioContext on a user gesture (autoplay policy) -----------
function resumeAudio() {
  try {
    const ctx = module && module.SDL2 && module.SDL2.audioContext;
    if (ctx && ctx.state !== "running") ctx.resume().catch(() => {});
  } catch (e) {}
}

// ---- Canvas sizing ---------------------------------------------------------
// The engine now samples the canvas backing store every frame. Fill the browser
// viewport at its real aspect, keep CSS pixels and GPU pixels separate for HiDPI,
// and resize live (including fullscreen/orientation changes). The long-edge and
// pixel-budget caps prevent a 5K/8K display from allocating several full-resolution
// WebGPU post-processing targets while retaining the exact host aspect.
const MAX_EDGE = 2560;
const MAX_PIXELS = 2560 * 1440;

function sizeCanvas() {
  const canvas = $("canvas");
  const vw = Math.max(320, window.innerWidth);
  const vh = Math.max(240, window.innerHeight);
  const cssW = vw, cssH = vh;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let bw = Math.round(cssW * dpr), bh = Math.round(cssH * dpr);
  const edgeScale = Math.min(1, MAX_EDGE / Math.max(bw, bh));
  const pixelScale = Math.min(1, Math.sqrt(MAX_PIXELS / Math.max(1, bw * bh)));
  const scale = Math.min(edgeScale, pixelScale);
  // Apply one scale to both axes. Independent minimums would subtly change the
  // backing-store aspect in very wide or very short browser windows, leaving
  // CSS to stretch the otherwise-correct engine output.
  bw = Math.max(1, Math.round(bw * scale));
  bh = Math.max(1, Math.round(bh * scale));

  if (canvas.width !== bw) canvas.width = bw;
  if (canvas.height !== bh) canvas.height = bh;
  canvas.style.width = cssW + "px";
  canvas.style.height = cssH + "px";
  return { bw, bh, cssW, cssH };
}

let canvasResizeFrame = 0;
let canvasResizeObserver = null;
function scheduleCanvasResize() {
  if (canvasResizeFrame) return;
  canvasResizeFrame = requestAnimationFrame(() => {
    canvasResizeFrame = 0;
    const dim = sizeCanvas();
    if (module) {
      module.__mdkrCanvasSize = [dim.bw, dim.bh];
    }
  });
}

function wireCanvasResize() {
  addEventListener("resize", scheduleCanvasResize, { passive: true });
  addEventListener("orientationchange", scheduleCanvasResize, { passive: true });
  document.addEventListener("fullscreenchange", scheduleCanvasResize);
  if (typeof ResizeObserver !== "undefined") {
    // Retain the observer for the lifetime of the page. Relying on the browser's
    // target-registration internals to keep an otherwise-unreferenced observer
    // alive makes resize behavior GC-dependent.
    canvasResizeObserver = new ResizeObserver(scheduleCanvasResize);
    canvasResizeObserver.observe($("stage"));
  }
}

// ---- Boot ------------------------------------------------------------------
async function boot() {
  if (booted) return;
  booted = true;
  testMark("boot-started");
  const canvas = $("canvas");
  const status = $("gate-msg");
  status.textContent = "Downloading engine…";

  // Size the surface first so SDL and the first WebGPU configure agree.
  const dim = sizeCanvas();
  console.log("[shell] canvas backing store " + dim.bw + "x" + dim.bh +
              " (css " + dim.cssW + "x" + dim.cssH + ")");

  let createMDKR64;
  try {
    createMDKR64 = await loadEngineFactory();
    testMark("factory-loaded");
  } catch (e) {
    booted = false;
    testError(e && e.message ? e.message : e);
    testMark("factory-failed");
    status.textContent = "Couldn't load the engine (" + e.message + "). Reload to retry.";
    $("play").disabled = false;
    return;
  }

  status.textContent = "Starting engine…";

  // ?trace=1 turns on the engine's own [PACE] trace, which prints the real
  // per-frame time (dtms) and the updateRate the game is using (R=). That is the
  // decisive diagnostic for "is the game running too fast?" -- a healthy 60 Hz run
  // shows dtms~16.7 with R=1. ?trace=2 adds the display-list opcode trace.
  const qs = new URLSearchParams(location.search);
  const traceLevel = qs.get("trace");
  // ?objcoll=legacy restores the pre-wave-"objcoll" behaviour, where
  // func_80017A18 returned 0 and every collision-meshed object was intangible.
  // It is the same A/B arm tests/check_door_blocks.py drives natively, exposed
  // here so a human can compare the two builds without rebuilding: with it set,
  // a locked hub door can be driven through; without it, the door blocks.
  const objCollValue = qs.get("objcoll");
  const objColl = objCollValue === "legacy" || objCollValue === "trace"
    ? objCollValue : null;
  // ?track=<levelId>[:<vehicle>] RETARGETS the next race -- it does NOT boot
  // straight in. You still navigate the menus and start a race normally (Tracks
  // or Time Trial, any track); mdkr_force_track() then rewrites gTrackIdToLoad
  // so <levelId> loads instead of the one you picked. Menu backgrounds and the
  // track-select preview are deliberately left alone.
  //
  // Useful because saves are per-ORIGIN: a test server on another port cannot
  // see your real progress, and reaching a boss legitimately costs four world
  // balloons. 38 = Tricky's volcano, 5 = Ancient Lake, 12 = Dino Domain lobby.
  // Optional vehicle: 0 = car, 1 = hovercraft, 2 = plane.
  const loadTrackValue = qs.get("track");
  const loadTrack = /^(?:[0-9]|[1-5][0-9]|6[0-5])(?::[0-2])?$/.test(
    loadTrackValue || ""
  ) ? loadTrackValue : null;

  module = await createMDKR64({
    canvas,
    noInitialRun: true,
    // preRun runs BEFORE the createMDKR64 promise resolves, so `module` is still
    // null here — take the Module from the callback argument instead.
    preRun: [function (m) {
      if (traceLevel && m && m.ENV) {
        try { m.ENV.MDKR_TRACE = String(traceLevel); } catch (e) {}
      }
      if (objColl && m && m.ENV) {
        try { m.ENV.MDKR_OBJCOLL = objColl; } catch (e) {}
      }
      if (loadTrack && m && m.ENV) {
        try { m.ENV.MDKR_LOAD_TRACK = loadTrack; } catch (e) {}
      }
      if (testConfig && testConfig.env && m && m.ENV) {
        for (const [key, value] of Object.entries(testConfig.env)) {
          if (/^MDKR_[A-Z0-9_]+$/.test(key)) {
            try { m.ENV[key] = String(value).slice(0, 256); } catch (e) {}
          }
        }
      }
    }],
    printErr: (t) => {
      testError(t);
      console.error(t);
    },
    onExit: (code) => {
      if (testState) {
        testState.exitCode = Number(code);
        testMark("exited");
      }
      // The engine's main() returns nonzero when rom_io.c refuses the ROM.
      if (code && code !== 0) {
        $("gate").hidden = false;
        $("stage").hidden = true;
        $("rom-status").className = "err";
        $("rom-status").textContent =
          "The engine refused this ROM (exit " + code + "). Try a different file.";
        $("play").disabled = false;
        booted = false;
      }
    },
    onAbort: (reason) => {
      if (testState) {
        testState.abortReason = String(reason == null ? "abort" : reason);
        testMark("aborted");
      }
      status.textContent = "The engine crashed — reload to continue from your last save.";
      persist();
    },
  });
  if (testState) testState.module = module;
  testMark("module-ready");

  status.textContent = "Preparing storage…";
  // IDBFS-backed ROM + save dirs. syncfs(true) pulls any persisted copies in.
  let storageMounted = false;
  try {
    module.FS.mkdir("/rom");  module.FS.mount(module.IDBFS, {}, "/rom");
    module.FS.mkdir("/save"); module.FS.mount(module.IDBFS, {}, "/save");
    await new Promise((resolve, reject) => module.FS.syncfs(
      true, (err) => err ? reject(err) : resolve()
    ));
    storageMounted = true;
  } catch (e) {
    testError("IDBFS mount/sync failed: " + (e && e.message ? e.message : e));
    console.warn("IDBFS mount/sync failed; running from memory only:", e);
  }

  const storedRomBeforeWrite = testFileInfo(ROM_PATH, false);
  const saveBeforeMain = testFileInfo("/save/eeprom.bin", true);

  // Write the freshly-picked ROM (if any) and persist it for next visit.
  let pickedRomWritten = false;
  if (romBytes) {
    module.FS.writeFile(ROM_PATH, romBytes);
    romBytes = null;
    pickedRomWritten = true;
    try {
      await new Promise((resolve, reject) => module.FS.syncfs(
        false, (err) => err ? reject(err) : resolve()
      ));
    } catch (e) {
      testError("ROM persistence failed: " + (e && e.message ? e.message : e));
    }
  }

  // The engine's post-EEPROM-write sync calls this, so the whole page shares one
  // in-flight sync (see the comment on persist()).
  module.__mdkrPersist = () => persist();

  // Arm persistence + audio-resume gestures (once).
  setInterval(persist, 5000);
  addEventListener("pagehide", persist);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") persist();
    else resumeAudio();
  });
  addEventListener("keydown", resumeAudio, true);
  addEventListener("pointerdown", resumeAudio);

  // Show the game view and run.
  $("gate").hidden = true;
  $("stage").hidden = false;
  canvas.focus();
  status.textContent = "";
  const mainArgs = ["--rom", ROM_PATH];

  // Presentation mode + supersampling. The picker persists the choice; a URL
  // parameter overrides it so a comparison can be linked directly
  // (?mode=restored&scale=4). Anything unrecognised is ignored rather than
  // passed through -- an unknown --video-set key makes the engine exit 2.
  const MODES = ["pure", "restored", "remastered"];
  const modeSel = $("mode");
  const scaleSel = $("scale");
  let mode = (qs.get("mode") || (modeSel && modeSel.value) || "").toLowerCase();
  let scale = qs.get("scale") || (scaleSel && scaleSel.value) || "";
  if (MODES.includes(mode)) mainArgs.push("--" + mode);
  if (/^[1-4]$/.test(scale)) mainArgs.push("--video-set", "Video.RenderScale=" + scale);

  const aspect = qs.get("aspect");
  const fov = qs.get("fov");
  const maxHfov = qs.get("maxHfov");
  const widescreen = qs.get("widescreen");
  if (aspect) mainArgs.push("--aspect", aspect);
  if (fov) mainArgs.push("--fov", fov);
  if (maxHfov) mainArgs.push("--max-hfov", maxHfov);
  if (widescreen === "0" || widescreen === "off") mainArgs.push("--legacy-stretch");

  // The browser regression installs only in-memory fixture text. Keep limits
  // tight and fail the test loudly if its configuration is malformed.
  if (testConfig) {
    if (typeof testConfig.inputScript === "string") {
      if (testConfig.inputScript.length > 1024 * 1024) {
        throw new Error("browser test input script exceeds 1 MiB");
      }
      const inputPath = "/tmp/mdkr-browser-input.txt";
      module.FS.writeFile(inputPath, testConfig.inputScript);
      mainArgs.push("--input-script", inputPath);
    }
    const frames = Number(testConfig.headlessFrames);
    if (Number.isInteger(frames) && frames > 0 && frames <= 100000) {
      mainArgs.push("--headless-frames", String(frames));
    }
    testState.storage = {
      mounted: storageMounted,
      pickedRomWritten,
      storedRomBeforeWrite,
      romBeforeMain: testFileInfo(ROM_PATH, false),
      saveBeforeMain,
    };
  }
  testMark("main-started");
  try {
    const result = module.callMain(mainArgs);
    if (result && typeof result.then === "function") await result;
    // With Asyncify, callMain() returns when the first rAF unwinds, not when C
    // main exits. platform_frame_sync publishes the real finite-run exit below.
    testRefreshExitState();
  } catch (e) {
    testError(e && e.stack ? e.stack : e);
    testMark("main-threw");
    throw e;
  }
}

// ---- Stored data: talk to IndexedDB directly, NOT through the engine -------
// This is the recovery path, so it must work when the engine does NOT. A save
// that the engine crashes on lives in IndexedDB and comes back on every reload;
// if wiping it required booting the engine to get an FS, the one state that
// needs wiping would be the one state you could not wipe from. So these helpers
// go straight at the IDBFS backing store.
//
// IDBFS names the database after the mount point ("/rom", "/save") and keeps
// every file in one object store, "FILE_DATA", keyed by absolute path. Opening
// with no explicit version joins whatever version is already there instead of
// fighting IDBFS's own; clearing the store inside a plain readwrite transaction
// works even while the engine holds an open connection, which deleteDatabase()
// does not (it would sit in onblocked).
const IDB_STORE = "FILE_DATA";

function idbOpen(dbName) {
  return new Promise((resolve) => {
    let req;
    try { req = indexedDB.open(dbName); } catch (e) { resolve(null); return; }
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

// Number of files IDBFS has stored for a mount (0 when the store does not exist).
// indexedDB.databases() first, so a first-ever visit does not create an empty
// database just to be told it is empty.
async function idbCount(dbName) {
  try {
    if (indexedDB.databases) {
      const names = (await indexedDB.databases()).map((d) => d.name);
      if (!names.includes(dbName)) return 0;
    }
  } catch (e) { /* fall through to open() */ }
  const db = await idbOpen(dbName);
  if (!db) return 0;
  if (!db.objectStoreNames.contains(IDB_STORE)) { db.close(); return 0; }
  return new Promise((resolve) => {
    let n = 0;
    try {
      const req = db.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE).count();
      req.onsuccess = () => { n = req.result | 0; db.close(); resolve(n); };
      req.onerror = () => { db.close(); resolve(0); };
    } catch (e) { db.close(); resolve(0); }
  });
}

async function idbClear(dbName) {
  const db = await idbOpen(dbName);
  if (!db) return false;
  if (!db.objectStoreNames.contains(IDB_STORE)) { db.close(); return true; }
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).clear();
      tx.oncomplete = () => { db.close(); resolve(true); };
      tx.onerror = () => { db.close(); resolve(false); };
      tx.onabort = () => { db.close(); resolve(false); };
    } catch (e) { db.close(); resolve(false); }
  });
}

// If a module happens to be live (a boot that bounced back to the launcher), keep
// its in-memory FS in step so it cannot write the old bytes back out.
function fsUnlinkAll(dir) {
  if (!module || !module.FS) return;
  try {
    for (const name of module.FS.readdir(dir)) {
      if (name === "." || name === "..") continue;
      try { module.FS.unlink(dir + "/" + name); } catch (e) {}
    }
  } catch (e) {}
}

// ---- ROM picker + Forget ---------------------------------------------------
function wireRomUi() {
  const input = $("rom-input");
  const play = $("play");
  const romStatus = $("rom-status");

  // One handler for both the file input and a drop, so the two paths cannot
  // drift apart.
  async function acceptFile(file) {
    if (!file) return;
    romStatus.className = "";
    romStatus.textContent = "Reading " + file.name + "…";
    let buf;
    try {
      buf = new Uint8Array(await file.arrayBuffer());
    } catch (e) {
      romStatus.className = "err";
      romStatus.textContent = "Couldn't read that file (" + (e.message || e) + ").";
      return;
    }
    const err = validateRom(buf, file.name);
    if (err) {
      romStatus.className = "err";
      romStatus.textContent = err;
      play.disabled = true;
      return;
    }
    romBytes = buf;
    romStatus.className = "ok";
    if (play.dataset.blocked) {
      // Valid ROM, but this browser can't run the engine. Say so here too, since
      // this is where the user is looking.
      romStatus.textContent = "✓ " + file.name +
        " looks good — but this browser can't run WebGPU (see above).";
      return;
    }
    romStatus.textContent = "✓ " + file.name + " looks good — press Play.";
    play.disabled = false;
    play.focus();
  }

  input.addEventListener("change", () => acceptFile(input.files && input.files[0]));

  // ---- drop zone: click, keyboard, and drag-and-drop ----
  const drop = $("drop");
  if (drop) {
    drop.addEventListener("click", () => input.click());
    drop.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); }
    });
    // dragover must be prevented or the browser navigates to the file instead.
    ["dragenter", "dragover"].forEach((ev) =>
      drop.addEventListener(ev, (e) => {
        e.preventDefault(); e.stopPropagation(); drop.classList.add("over");
      }));
    ["dragleave", "dragend"].forEach((ev) =>
      drop.addEventListener(ev, () => drop.classList.remove("over")));
    drop.addEventListener("drop", (e) => {
      e.preventDefault(); e.stopPropagation(); drop.classList.remove("over");
      const dt = e.dataTransfer;
      acceptFile(dt && dt.files && dt.files[0]);
    });
  }
  // Swallow stray drops on the page so a mis-aimed drop never navigates away
  // from a half-configured launcher.
  ["dragover", "drop"].forEach((ev) =>
    window.addEventListener(ev, (e) => { e.preventDefault(); }));

  play.addEventListener("click", () => {
    play.disabled = true;
    if (!romBytes) {
      // Boot from the ROM already persisted in IDBFS (checked at boot time).
      boot();
      return;
    }
    boot();
  });

  // Forget the stored ROM. This used to instantiate a SECOND engine module just to
  // get an FS, never mount IDBFS on it, and then unlink a path that did not exist
  // there — so it downloaded the whole engine and deleted nothing. It also had no
  // code path that ever un-hid the button, so it was unreachable as well as
  // ineffective. Both are fixed: it clears the "/rom" store directly.
  $("forget").addEventListener("click", async () => {
    const btn = $("forget");
    btn.disabled = true;
    fsUnlinkAll("/rom");
    const ok = await idbClear("/rom");
    persist();
    romBytes = null;
    btn.disabled = false;
    btn.hidden = true;
    $("rom-status").className = ok ? "" : "err";
    $("rom-status").textContent = ok
      ? "Stored ROM forgotten. Pick a file to play."
      : "Couldn't clear the stored ROM — clear this site's data in your browser settings.";
    $("play").disabled = true;
  });

  // ---- Erase saved progress -------------------------------------------------
  // Deliberately separate from the ROM control and separately confirmed: this is
  // the only thing that can recover a browser whose stored save makes the engine
  // misbehave on boot, and it is also the only thing that destroys lap records.
  const clearSave = $("clear-save");
  if (clearSave) {
    clearSave.addEventListener("click", async () => {
      const status = $("save-status");
      const n = await idbCount("/save");
      if (n === 0) {
        status.className = "";
        status.textContent = "There is no saved progress stored for this site.";
        return;
      }
      if (!confirm(
            "Erase all saved progress for this page?\n\n" +
            "This deletes your Adventure files, lap records and options. " +
            "It cannot be undone, and it does not touch your ROM.")) {
        return;
      }
      clearSave.disabled = true;
      status.className = "";
      status.textContent = "Erasing…";
      fsUnlinkAll("/save");
      const ok = await idbClear("/save");
      persist();
      clearSave.disabled = false;
      status.className = ok ? "ok" : "err";
      status.textContent = ok
        ? "Saved progress erased. Reload the page to start fresh."
        : "Couldn't erase it here — clear this site's data in your browser settings.";
    });
  }
}

// ---- Is there already a ROM in IndexedDB? ----------------------------------
// Without this the persisted ROM was unreachable: #play stayed disabled and
// #forget stayed hidden until a file was picked, so "the ROM persists across
// reloads" was true of the storage and false of the UI.
async function probeStoredRom() {
  if ((await idbCount("/rom")) === 0) return;
  $("forget").hidden = false;
  const play = $("play");
  if (!play.dataset.blocked) {
    play.disabled = false;
    $("rom-status").className = "ok";
    $("rom-status").textContent = "✓ Using the ROM stored in this browser — press Play.";
  }
}

// ---- Frame-rate readout ----------------------------------------------------
// The engine suspends to requestAnimationFrame once per frame, so counting rAF
// callbacks measures the ENGINE's frame rate, not just the display refresh. If this
// reads ~120 on a 120 Hz panel while the game feels double speed, the pacing floor
// is not holding; if it reads ~60 and the game still feels fast, the problem is
// upstream of pacing. Toggle with F3.
function wireFpsReadout() {
  const el = $("fps");
  if (!el) return;
  let frames = 0, since = performance.now(), shown = false;
  const rawRAF = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = function (cb) {
    frames++;
    return rawRAF(cb);
  };
  setInterval(() => {
    const now = performance.now();
    const dt = now - since;
    if (dt >= 500) {
      const fps = (frames * 1000) / dt;
      el.textContent = fps.toFixed(0) + " fps  ·  " + (1000 / Math.max(fps, 0.001)).toFixed(1) + " ms";
      frames = 0; since = now;
    }
  }, 500);
  addEventListener("keydown", (e) => {
    if (e.key === "F3") { shown = !shown; el.hidden = !shown; }
  });
}

// ---- Fullscreen ------------------------------------------------------------
function wireFullscreen() {
  const btn = $("fullscreen");
  const stage = $("stage");
  const go = () => {
    if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); }
    else { stage.requestFullscreen().catch(() => {}); }
    // Keep input going to the canvas, not the button.
    setTimeout(() => $("canvas").focus(), 0);
  };
  if (btn) btn.addEventListener("click", go);
  addEventListener("keydown", (e) => {
    if (e.key === "f" || e.key === "F") {
      // Only while playing, and never while the user is typing in a field.
      if (!stage.hidden && !/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) go();
    }
  });
}

// ---- Startup ---------------------------------------------------------------
(async () => {
  wireRomUi();
  wireFullscreen();
  wireFpsReadout();
  wireCanvasResize();

  // ALWAYS reveal the launcher UI. It used to be hidden behind the WebGPU gate,
  // which meant a browser without a usable adapter showed nothing but an error
  // line -- no picker, no controls, no explanation of what the page even is, and
  // no way to get as far as trying. The gate now only blocks the Play ACTION.
  $("rom-ui").hidden = false;
  initQualityControls();

  const err = await gate();
  const msg = $("gate-msg");
  if (err) {
    msg.className = "status-line err";
    msg.textContent = err;
    const play = $("play");
    play.disabled = true;
    play.dataset.blocked = "1";     // keep it disabled even after a valid ROM
    play.title = err;
    await probeStoredRom();         // still show Forget, so storage stays clearable
    return;
  }
  msg.className = "status-line";
  msg.textContent = "";
  await probeStoredRom();
})();
