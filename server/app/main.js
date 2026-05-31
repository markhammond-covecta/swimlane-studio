// Browser-side MCP App for the swimlane server.
//
// Runs inside the host's iframe (e.g. Claude Desktop). Connects to the host over
// the MCP Apps postMessage bridge, receives the render tool's result, and shows
// the rendered SVG in an interactive viewer: fit-to-width by default, wheel /
// buttons to zoom, drag to pan, and a fullscreen toggle (via requestDisplayMode).
//
// The diagram is rendered server-side (we already produce SVG); this app is a
// viewer, not a renderer. It sizes the inline panel to the diagram so wide or
// many-lane diagrams stay readable through zoom/pan rather than being squashed.

import { App, PostMessageTransport } from "@modelcontextprotocol/ext-apps";

const root = document.getElementById("root");

const MIN_SCALE = 0.05;
const MAX_SCALE = 16;
const MAX_FIT = 4; // never auto-upscale a tiny diagram beyond this
const INLINE_MIN_H = 180;
const INLINE_MAX_H = 560;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const state = {
  svgW: 0,
  svgH: 0,
  scale: 1,
  tx: 0,
  ty: 0,
  mode: "inline", // "inline" | "fullscreen" | "pip"
  userZoomed: false, // once true, stop auto-refitting on resize
  lastWidth: 0,
};

let viewport = null;
let canvas = null;
let svgEl = null;
let fullBtn = null;

function showMessage(text) {
  root.innerHTML = "";
  const p = document.createElement("pre");
  p.className = "msg";
  p.textContent = text;
  root.appendChild(p);
  viewport = canvas = svgEl = fullBtn = null;
}

function apply() {
  if (!canvas) return;
  // Pan with a translate (cheap, no rasterisation). Apply the zoom by resizing
  // the SVG element itself: it has a viewBox, so the SVG renderer redraws the
  // vectors crisply at the new size. Scaling via transform would rasterise the
  // SVG at 1x and stretch the bitmap, which looks pixelly when zoomed in.
  canvas.style.transform = "translate(" + state.tx + "px," + state.ty + "px)";
  if (svgEl) {
    svgEl.style.width = state.svgW * state.scale + "px";
    svgEl.style.height = state.svgH * state.scale + "px";
  }
}

function zoomAt(cx, cy, factor) {
  const next = clamp(state.scale * factor, MIN_SCALE, MAX_SCALE);
  const k = next / state.scale;
  state.tx = cx - (cx - state.tx) * k;
  state.ty = cy - (cy - state.ty) * k;
  state.scale = next;
  state.userZoomed = true;
  apply();
}

// Fit the diagram to the panel width and size the inline panel to match. Wide
// diagrams get a short panel; tall ones are capped and pannable vertically.
function fitWidth() {
  const vw = viewport.clientWidth || 600;
  const s = clamp(vw / state.svgW, MIN_SCALE, MAX_FIT);
  state.scale = s;
  if (state.mode !== "fullscreen") {
    const dispH = state.svgH * s;
    viewport.style.height = clamp(dispH, INLINE_MIN_H, INLINE_MAX_H) + "px";
  }
  const vh = viewport.clientHeight;
  state.tx = Math.max(0, (vw - state.svgW * s) / 2);
  state.ty = Math.max(0, (vh - state.svgH * s) / 2);
  state.userZoomed = false;
  apply();
}

// Fullscreen: scale up to FILL the viewport (cover), so the diagram uses the
// whole space rather than sitting small with whitespace. The long axis overflows
// and is reached by panning. Clear the inline height first so the 100vh CSS for
// fullscreen actually governs (an inline style would otherwise override it).
function fitFill() {
  viewport.style.height = "";
  const vw = viewport.clientWidth || 600;
  const vh = viewport.clientHeight || 400;
  const s = clamp(Math.max(vw / state.svgW, vh / state.svgH), MIN_SCALE, MAX_FIT);
  state.scale = s;
  state.tx = (vw - state.svgW * s) / 2;
  state.ty = (vh - state.svgH * s) / 2;
  state.userZoomed = false;
  apply();
}

function refit() {
  if (state.mode === "fullscreen") fitFill();
  else fitWidth();
}

function setMode(mode) {
  state.mode = mode;
  document.documentElement.classList.toggle("fullscreen", mode === "fullscreen");
  if (fullBtn) fullBtn.textContent = mode === "fullscreen" ? "✕" : "⛶";
  refit();
}

async function toggleFullscreen(app) {
  const target = state.mode === "fullscreen" ? "inline" : "fullscreen";
  try {
    const res = await app.requestDisplayMode({ mode: target });
    setMode(res && res.mode ? res.mode : target);
  } catch {
    setMode(target); // optimistic if the host doesn't answer
  }
}

// Copy icon: two overlapping rounded squares (Feather "copy"). Uses
// currentColor so it follows the button's theme colour.
const COPY_ICON =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" ' +
  'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
  'stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/>' +
  '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

function flash(btn, label) {
  if (!btn) return;
  if (btn.dataset.orig == null) btn.dataset.orig = btn.innerHTML;
  btn.textContent = label;
  setTimeout(() => {
    btn.innerHTML = btn.dataset.orig || "";
    delete btn.dataset.orig;
  }, 1200);
}

// Rasterise the diagram's SVG to a PNG and put it on the clipboard. Rendered at
// 2x natural size for sharpness, on a white background, independent of the
// current on-screen zoom. Needs the host to have granted clipboard-write (see
// the resource permissions in server.js).
async function copyPng(btn, app) {
  if (!svgEl) return;
  try {
    const clone = svgEl.cloneNode(true);
    clone.setAttribute("width", state.svgW);
    clone.setAttribute("height", state.svgH);
    clone.removeAttribute("style");
    if (!clone.getAttribute("xmlns")) clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    const svgStr = new XMLSerializer().serializeToString(clone);
    const url = URL.createObjectURL(new Blob([svgStr], { type: "image/svg+xml;charset=utf-8" }));
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = rej;
      img.src = url;
    });
    const scale = 2;
    const c = document.createElement("canvas");
    c.width = Math.round(state.svgW * scale);
    c.height = Math.round(state.svgH * scale);
    const cx = c.getContext("2d");
    cx.fillStyle = "#ffffff";
    cx.fillRect(0, 0, c.width, c.height);
    cx.drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(url);
    const blob = await new Promise((r) => c.toBlob(r, "image/png"));
    if (!blob) throw new Error("PNG encode failed");
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    flash(btn, "✓");
  } catch (err) {
    flash(btn, "✕");
    if (app && app.sendLog) {
      app.sendLog({ level: "warning", data: "Copy PNG failed: " + (err && err.message) }).catch(() => {});
    }
  }
}

function svgDims(el) {
  const vb = el.viewBox && el.viewBox.baseVal;
  let w = vb && vb.width ? vb.width : parseFloat(el.getAttribute("width"));
  let h = vb && vb.height ? vb.height : parseFloat(el.getAttribute("height"));
  if (!w || !h) {
    try {
      const b = el.getBBox();
      w = w || b.width;
      h = h || b.height;
    } catch {
      /* getBBox can throw if not laid out yet */
    }
  }
  return { w: w || 600, h: h || 400 };
}

function buildViewer(svg, app) {
  root.innerHTML = "";

  viewport = document.createElement("div");
  viewport.className = "viewport";

  canvas = document.createElement("div");
  canvas.className = "canvas";
  canvas.innerHTML = svg;
  viewport.appendChild(canvas);

  const controls = document.createElement("div");
  controls.className = "controls";
  const mkBtn = (label, title, onClick) => {
    const b = document.createElement("button");
    b.innerHTML = label;
    b.title = title;
    b.addEventListener("click", onClick);
    controls.appendChild(b);
    return b;
  };
  const centre = () => [viewport.clientWidth / 2, viewport.clientHeight / 2];
  mkBtn("−", "Zoom out", () => zoomAt(...centre(), 1 / 1.25));
  mkBtn("+", "Zoom in", () => zoomAt(...centre(), 1.25));
  mkBtn("↻", "Fit", () => refit());
  mkBtn(COPY_ICON, "Copy as PNG", (e) => copyPng(e.currentTarget, app));
  fullBtn = mkBtn("⛶", "Fullscreen", () => toggleFullscreen(app));

  // Hide the fullscreen toggle if the host can't do it.
  const ctx = app.getHostContext();
  const modes = (ctx && ctx.availableDisplayModes) || [];
  if (modes.length && !modes.includes("fullscreen")) fullBtn.hidden = true;

  viewport.appendChild(controls);
  root.appendChild(viewport);

  svgEl = canvas.querySelector("svg");
  svgEl.style.display = "block";
  const d = svgDims(svgEl);
  state.svgW = d.w;
  state.svgH = d.h;
  state.lastWidth = viewport.clientWidth;

  // Wheel to zoom toward the cursor.
  viewport.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const r = viewport.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
    },
    { passive: false },
  );

  // Drag to pan.
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  viewport.addEventListener("pointerdown", (e) => {
    // Don't start a pan (and don't capture the pointer) when the press is on a
    // control button — capturing here would steal the button's click event.
    if (e.target.closest(".controls")) return;
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    viewport.classList.add("dragging");
    viewport.setPointerCapture(e.pointerId);
  });
  viewport.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    state.tx += e.clientX - lastX;
    state.ty += e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    state.userZoomed = true;
    apply();
  });
  const endDrag = (e) => {
    dragging = false;
    viewport.classList.remove("dragging");
    if (e.pointerId != null && viewport.hasPointerCapture(e.pointerId)) {
      viewport.releasePointerCapture(e.pointerId);
    }
  };
  viewport.addEventListener("pointerup", endDrag);
  viewport.addEventListener("pointercancel", endDrag);

  // Re-fit when the panel is resized by the host (e.g. entering fullscreen),
  // unless the user has taken manual control with zoom/pan. A ResizeObserver
  // catches the iframe resize reliably where a window 'resize' event may not.
  // In inline mode fitWidth sets the viewport height itself, so only refit on a
  // width change there to avoid a feedback loop; in fullscreen refit on any
  // change (fitBoth doesn't touch the height).
  const ro = new ResizeObserver(() => {
    if (state.userZoomed) return;
    state.lastWidth = viewport.clientWidth;
    refit();
  });
  ro.observe(viewport);

  setMode((ctx && ctx.displayMode) || "inline");
}

// Pull the SVG out of a tool result (structuredContent.svgText, or any inline
// SVG text content block as a fallback).
function svgFromResult(result) {
  const sc = result && result.structuredContent;
  if (sc && typeof sc.svgText === "string" && sc.svgText.includes("<svg")) {
    return sc.svgText;
  }
  for (const b of (result && result.content) || []) {
    if (b.type === "text" && typeof b.text === "string" && b.text.includes("<svg")) {
      return b.text;
    }
  }
  return null;
}

function render(result, app) {
  const svg = svgFromResult(result);
  if (svg) buildViewer(svg, app);
  else if (result && result.isError) showMessage("Diagram could not be rendered.");
  else showMessage("Waiting for diagram…");
}

function applyTheme(ctx) {
  document.documentElement.classList.toggle("dark", !!(ctx && ctx.theme === "dark"));
}

const app = new App({ name: "swimlane-view", version: "0.1.0" }, {});

app.ontoolresult = (params) => render(params, app);
app.onhostcontextchanged = (ctx) => {
  applyTheme(ctx);
  if (ctx && ctx.displayMode && ctx.displayMode !== state.mode && viewport) {
    setMode(ctx.displayMode);
  }
};

showMessage("Loading diagram…");

app
  .connect(new PostMessageTransport(window.parent, window.parent))
  .then(() => {
    const ctx = app.getHostContext();
    applyTheme(ctx);
    if (ctx && ctx.toolInfo && ctx.toolInfo.result) render(ctx.toolInfo.result, app);
  })
  .catch((err) => {
    showMessage("Could not connect to host: " + (err && err.message ? err.message : String(err)));
  });
