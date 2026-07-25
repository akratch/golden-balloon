// mdkr64-shell.js — browser launcher for the mdkr64 WebGPU/wasm engine.
//
// Flow: feature-detect WebGPU -> let the user pick their .z64 -> instantiate the
// wasm module -> mount IDBFS at /rom (ROM persists across reloads) and /save
// (EEPROM persists) -> write the ROM into MEMFS/IDBFS -> callMain(--rom ...).
// The engine reads the whole ROM at boot (rom_io.c) and drives its own frame
// loop, suspending to requestAnimationFrame via Asyncify at each frame boundary.
//
// No ROM is distributed with this page; the user supplies their own. Everything
// stays in the browser — there is no server to upload to.

"use strict";

const ROM_PATH = "/rom/baserom.us.v80.z64";
const ROM_SIZE = 12 * 1024 * 1024; // DKR US 1.1 = 0xC00000 bytes
const $ = (id) => document.getElementById(id);

let romBytes = null;     // freshly-picked ROM bytes (null once written to FS)
let module = null;       // the instantiated engine Module
let booted = false;
let savedOnce = false;

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

// ---- Client-side ROM sanity check (mirrors rom_io.c) -----------------------
// Accepts .z64 (80 37 12 40), byteswapped .v64 (37 80..), or .n64 (40 12..).
function validateRom(bytes) {
  if (!bytes || bytes.length !== ROM_SIZE) {
    return `That file is ${bytes ? (bytes.length / 1048576).toFixed(1) : 0} MB; the ROM must be exactly 12 MB (US 1.1 .z64).`;
  }
  const b0 = bytes[0], b1 = bytes[1], b2 = bytes[2], b3 = bytes[3];
  const z64 = b0 === 0x80 && b1 === 0x37 && b2 === 0x12 && b3 === 0x40;
  const v64 = b0 === 0x37 && b1 === 0x80 && b2 === 0x40 && b3 === 0x12;
  const n64 = b0 === 0x40 && b1 === 0x12 && b2 === 0x37 && b3 === 0x80;
  if (!z64 && !v64 && !n64) {
    return "That file isn't an N64 ROM (bad header). Expected a Diddy Kong Racing .z64/.v64/.n64 dump.";
  }
  return null;
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
// FS.syncfs is not reentrant; serialize and never overlap two syncs.
let syncing = false, syncAgain = false;
function persist() {
  if (!module || !module.FS) return;
  if (syncing) { syncAgain = true; return; }
  syncing = true;
  try {
    module.FS.syncfs(false, (err) => {
      syncing = false;
      if (err) { $("save-banner").hidden = false; }
      else { savedOnce = true; }
      if (syncAgain) { syncAgain = false; persist(); }
    });
  } catch (e) { syncing = false; }
}

// ---- Resume the AudioContext on a user gesture (autoplay policy) -----------
function resumeAudio() {
  try {
    const ctx = module && module.SDL2 && module.SDL2.audioContext;
    if (ctx && ctx.state !== "running") ctx.resume().catch(() => {});
  } catch (e) {}
}

// ---- Canvas sizing ---------------------------------------------------------
// MUST run before callMain: main_pc.c reads platform_sdl_drawable_size() once at
// gfx_init and calls gfx_set_dimensions() with it, so the engine renders NATIVELY
// at whatever the canvas backing store is when it boots. The canvas used to stay
// at its 640x480 intrinsic size with CSS `width:auto`, so nothing ever scaled it
// up and the game drew in a tiny box in the middle of the page.
//
// Fit a 4:3 box to the viewport, multiply by devicePixelRatio for crispness on
// HiDPI, and cap the long edge so a 4K display does not ask the HLE for a
// framebuffer far larger than the game ever needs.
const ASPECT = 4 / 3;
const MAX_EDGE = 1920;

function sizeCanvasForBoot() {
  const canvas = $("canvas");
  const vw = Math.max(320, window.innerWidth);
  const vh = Math.max(240, window.innerHeight);

  // Letterbox: fit 4:3 inside the viewport.
  let cssW = vw, cssH = Math.round(vw / ASPECT);
  if (cssH > vh) { cssH = vh; cssW = Math.round(vh * ASPECT); }

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let bw = Math.round(cssW * dpr), bh = Math.round(cssH * dpr);
  if (bw > MAX_EDGE) { bw = MAX_EDGE; bh = Math.round(MAX_EDGE / ASPECT); }

  canvas.width = bw;
  canvas.height = bh;
  canvas.style.width = cssW + "px";
  canvas.style.height = cssH + "px";
  return { bw, bh, cssW, cssH };
}

// ---- Boot ------------------------------------------------------------------
async function boot() {
  if (booted) return;
  booted = true;
  const canvas = $("canvas");
  const status = $("gate-msg");
  status.textContent = "Downloading engine…";

  // Size the surface first, then reveal the stage, so the engine's one-shot
  // dimension read sees the real size.
  const dim = sizeCanvasForBoot();
  console.log("[shell] canvas backing store " + dim.bw + "x" + dim.bh +
              " (css " + dim.cssW + "x" + dim.cssH + ")");

  let createMDKR64;
  try {
    createMDKR64 = await loadEngineFactory();
  } catch (e) {
    booted = false;
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

  module = await createMDKR64({
    canvas,
    noInitialRun: true,
    // preRun runs BEFORE the createMDKR64 promise resolves, so `module` is still
    // null here — take the Module from the callback argument instead.
    preRun: [function (m) {
      if (traceLevel && m && m.ENV) {
        try { m.ENV.MDKR_TRACE = String(traceLevel); } catch (e) {}
      }
    }],
    printErr: (t) => console.error(t),
    onExit: (code) => {
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
    onAbort: () => {
      status.textContent = "The engine crashed — reload to continue from your last save.";
      persist();
    },
  });

  status.textContent = "Preparing storage…";
  // IDBFS-backed ROM + save dirs. syncfs(true) pulls any persisted copies in.
  try {
    module.FS.mkdir("/rom");  module.FS.mount(module.IDBFS, {}, "/rom");
    module.FS.mkdir("/save"); module.FS.mount(module.IDBFS, {}, "/save");
    await new Promise((res) => module.FS.syncfs(true, () => res()));
  } catch (e) {
    console.warn("IDBFS mount/sync failed; running from memory only:", e);
  }

  // Write the freshly-picked ROM (if any) and persist it for next visit.
  if (romBytes) {
    module.FS.writeFile(ROM_PATH, romBytes);
    romBytes = null;
    try { await new Promise((res) => module.FS.syncfs(false, () => res())); } catch (e) {}
  }

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
  module.callMain(["--rom", ROM_PATH]);
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
    const err = validateRom(buf);
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

  $("forget").addEventListener("click", async () => {
    try {
      const m = module || (await loadEngineFactory().then((f) => f({ noInitialRun: true })));
      // Best-effort: remove the persisted ROM.
      try { m.FS.unlink(ROM_PATH); } catch (e) {}
      try { m.FS.syncfs(false, () => {}); } catch (e) {}
    } catch (e) {}
    $("forget").hidden = true;
    $("rom-status").textContent = "Stored ROM forgotten. Pick a file to play.";
    $("play").disabled = true;
  });
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

  // ALWAYS reveal the launcher UI. It used to be hidden behind the WebGPU gate,
  // which meant a browser without a usable adapter showed nothing but an error
  // line -- no picker, no controls, no explanation of what the page even is, and
  // no way to get as far as trying. The gate now only blocks the Play ACTION.
  $("rom-ui").hidden = false;

  const err = await gate();
  const msg = $("gate-msg");
  if (err) {
    msg.className = "status-line err";
    msg.textContent = err;
    const play = $("play");
    play.disabled = true;
    play.dataset.blocked = "1";     // keep it disabled even after a valid ROM
    play.title = err;
    return;
  }
  msg.className = "status-line";
  msg.textContent = "";
})();
