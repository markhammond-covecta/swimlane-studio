#!/usr/bin/env node
// Build a self-contained, single-file Swimlane Studio that runs straight from
// a file:// URL — just open it from Finder/Explorer, no web server needed.
//
// Two things stop the normal index.html from opening off disk:
//   1. It loads the engine with `import ... from "./lib/swimlane-core.js"`,
//      and browsers won't fetch that module over file://.
//   2. Chrome won't execute *any* ES module script (even inline ones) on a
//      file:// document, because the origin is opaque.
//
// So this build inlines the engine AND drops ES modules entirely: it emits two
// classic <script> blocks, each wrapped in an IIFE (preserving the module-style
// private scope and strict mode). The engine exposes its API on a global
// (globalThis.__swimlaneCore) that the app block reads from. Classic scripts
// always run locally, so the result opens straight from disk.
//
// Usage:
//   node build.mjs [output.html]      (default: swimlane-studio.html)

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.join(root, "index.html");
const corePath = path.join(root, "lib", "swimlane-core.js");
const outPath = path.resolve(root, process.argv[2] || "swimlane-studio.html");

const BRIDGE = "globalThis.__swimlaneCore";
const APP_OPEN = '<script type="module">';
const SCRIPT_CLOSE = "</script>";
// Keep an embedded "</script>" from closing our wrapper script tag early.
const guard = js => js.replace(/<\/script>/gi, "<\\/script>");

const html = await readFile(htmlPath, "utf8");
let core = await readFile(corePath, "utf8");

// --- Engine block ---------------------------------------------------------
// `export { a, b }` and `return { a, b }` share the same syntax, so turning the
// engine's single export block into a return lets us wrap the whole file in an
// IIFE that yields the API object.
if (!/^export \{/m.test(core)) {
  throw new Error("build: could not find the `export { ... }` block in lib/swimlane-core.js");
}
core = core.replace(/^export \{/m, "return {");
if (/^\s*export[\s{]/m.test(core)) {
  throw new Error("build: unexpected leftover `export` in engine after inlining");
}
const engineBlock =
  "<script>\n" +
  '"use strict";\n' +
  `${BRIDGE} = (function () {\n` +
  guard(core) +
  "\n})();\n" +
  SCRIPT_CLOSE;

// --- App block ------------------------------------------------------------
// Lift the app's module body out, swap its engine import for a destructure
// from the bridge global, and re-wrap it as a classic IIFE script.
const appOpenIdx = html.indexOf(APP_OPEN);
if (appOpenIdx === -1) throw new Error(`build: could not find ${APP_OPEN} in index.html`);
const appCloseIdx = html.indexOf(SCRIPT_CLOSE, appOpenIdx);
if (appCloseIdx === -1) throw new Error("build: could not find the app script's closing tag");

let appBody = html.slice(appOpenIdx + APP_OPEN.length, appCloseIdx);
const importRe = /^import \{([^}]*)\} from "\.\/lib\/swimlane-core\.js";[^\n]*$/m;
if (!importRe.test(appBody)) {
  throw new Error("build: could not find the engine import in the app script");
}
appBody = appBody.replace(
  importRe,
  (_, names) => `// Engine inlined by build.mjs; see the block above.\nconst {${names.trim()}} = ${BRIDGE};`
);
const appBlock =
  "<script>\n" +
  "(function () {\n" +
  '"use strict";\n' +
  appBody +
  "\n})();\n" +
  SCRIPT_CLOSE;

// --- Assemble -------------------------------------------------------------
let out =
  html.slice(0, appOpenIdx) +
  engineBlock + "\n" + appBlock +
  html.slice(appCloseIdx + SCRIPT_CLOSE.length);

out = out.replace(
  /<head>/,
  "<head>\n  <!-- Self-contained build produced by build.mjs — engine inlined, no ES modules; opens directly from disk (file://). -->"
);

await writeFile(outPath, out, "utf8");
const kb = (Buffer.byteLength(out, "utf8") / 1024).toFixed(1);
console.log(`Wrote ${path.relative(root, outPath) || outPath} (${kb} KB)`);
console.log("Open it directly in a browser — no server required.");
