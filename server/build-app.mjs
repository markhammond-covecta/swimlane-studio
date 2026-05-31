// Build the MCP App viewer into a single self-contained dist/app.html.
//
// The server serves this file as the `ui://swimlane/app.html` resource. It must
// be standalone (no external script/style requests) because it runs inside the
// host's sandboxed iframe. We bundle app/main.js (which imports the ext-apps
// browser SDK) into one IIFE and inline it into app/template.html.

import { build } from "esbuild";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));

const result = await build({
  entryPoints: [path.join(dir, "app", "main.js")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2020"],
  minify: true,
  write: false,
});

const js = result.outputFiles[0].text;
const template = await fs.readFile(path.join(dir, "app", "template.html"), "utf8");

// Inline the bundle. Guard against the (vanishingly unlikely) literal token
// appearing in the bundle by replacing only the placeholder comment.
const html = template.replace("/*__BUNDLE__*/", () => js);

const outDir = path.join(dir, "dist");
await fs.mkdir(outDir, { recursive: true });
const outPath = path.join(outDir, "app.html");
await fs.writeFile(outPath, html);

console.log(`Wrote ${outPath} (${(html.length / 1024).toFixed(1)} KB)`);
