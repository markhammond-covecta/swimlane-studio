#!/usr/bin/env node
// Smoke test: spawn server.js over stdio via the MCP client SDK and exercise
// every tool. Run with `node smoke.js` (or `npm run smoke`).

import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import os from "node:os";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
// The engine itself, for geometry assertions the rendered output can't
// express as cheaply (e.g. whether an incoming arrow was built at all).
import {
  parse as parseCore,
  solveLayout as solveLayoutCore,
  layoutMetrics as layoutMetricsCore,
} from "../lib/swimlane-core.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SOURCE = `title: Login flow
User -> Browser: Enter search <string>
Browser -> Server: Send request <http POST>
Server --> Browser: Send response <html>
Browser -> Browser: Render HTML
Browser -> User: Display output
User: Read output`;

let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? "  ok  " : " FAIL "} ${msg}`);
  if (!cond) failures++;
};

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(__dirname, "server.js")],
});
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log("Tools:", tools.map((t) => t.name).join(", "));
check(tools.length === 4, "exposes 4 tools");

// MCP App wiring: render_swimlane references the UI resource, which lists and
// reads as a self-contained HTML view with the MCP App MIME type.
const renderTool = tools.find((t) => t.name === "render_swimlane");
check(renderTool?._meta?.ui?.resourceUri === "ui://swimlane/app.html", "render_swimlane carries ui.resourceUri meta");
const { resources } = await client.listResources();
const uiRes = resources.find((r) => r.uri === "ui://swimlane/app.html");
check(uiRes?.mimeType === "text/html;profile=mcp-app", "UI resource listed with mcp-app MIME type");
const uiRead = await client.readResource({ uri: "ui://swimlane/app.html" });
const uiHtml = uiRead.contents?.[0]?.text || "";
check(uiHtml.includes("<script>") && !/src="https?:/.test(uiHtml), "UI resource is self-contained HTML");

// 1. swimlane_syntax
const syn = await client.callTool({ name: "swimlane_syntax", arguments: {} });
check(/Swimlane DSL/.test(syn.content[0].text), "swimlane_syntax returns the cheat-sheet");

// 2. validate_swimlane (good + bad)
const okv = await client.callTool({ name: "validate_swimlane", arguments: { source: SOURCE } });
check(okv.structuredContent.ok === true, "validate: clean source ok");
check(okv.structuredContent.lanes.join(",") === "User,Browser,Server", "validate: lanes detected in order");

const badv = await client.callTool({ name: "validate_swimlane", arguments: { source: "this is nonsense ((" } });
check(badv.isError === true, "validate: nonsense flagged as error");

// 2b. generate_swimlane_script (return + save; no diagram)
const gen = await client.callTool({ name: "generate_swimlane_script", arguments: { source: SOURCE } });
check(gen.structuredContent.script === SOURCE, "generate script: returns the source verbatim");
check(gen.structuredContent.ok === true, "generate script: clean source ok");
check(!gen.content.some((c) => c.type === "image" || /<svg/.test(c.text || "")), "generate script: no diagram in output");
const genDir = await fs.mkdtemp(path.join(os.tmpdir(), "swimlane-"));
const scriptPath = path.join(genDir, "diagram.swml");
const genSaved = await client.callTool({ name: "generate_swimlane_script", arguments: { source: SOURCE, save_path: scriptPath } });
check((genSaved.structuredContent.written || [])[0] === scriptPath, "generate script: reports written path");
check((await fs.readFile(scriptPath, "utf8")) === SOURCE, "generate script: file written verbatim");
await fs.rm(genDir, { recursive: true, force: true });

// 2c. dashed incoming links. A dash styles the arrow LEAVING a box, so
// "<-->" is what dashes the arrow ARRIVING at one; "<--:" does the same for
// a backward-only box. Asserted on the solved geometry plus the SVG.
{
  // C's previous box sends CROSS-lane, so it owns no forward link into this
  // box and the incoming arrow is drawn (the same shape as a real diagram).
  const IN = `A -> C: first
C --> A: cross
C <--> C: dashed inbound <why>`;
  const m = parseCore(IN);
  solveLayoutCore(m);
  const ev = m.events.find((e) => e.text === "dashed inbound");
  check(ev.dashedIn === true, "dashed-in: <--> sets dashedIn");
  check(!!ev.arrowPathIn, "dashed-in: incoming arrow is built");
  const svg = await client.callTool({ name: "render_swimlane", arguments: { source: IN, format: "svg" } });
  const svgText = svg.content.find((c) => c.type === "text" && /<svg/.test(c.text)).text;
  const paths = (svgText.match(/<path[^>]*\/>/g) || []).filter((p) => p.includes(`data-line="${ev.lineNo}"`));
  check(paths.length === 2, "dashed-in: both links drawn");
  // Only the INCOMING link dashes; the outgoing trail stays solid.
  check(paths.filter((p) => p.includes("stroke-dasharray")).length === 1, "dashed-in: exactly one link dashed");
  check(ev.dashed === false, "dashed-in: <--> leaves the outgoing trail solid");
  // The caption rides the INCOMING arrow, not the outgoing one: its anchor
  // must sit within the incoming arrow's span, well above the outgoing trail.
  check(/why/.test(svgText), "dashed-in: caption rendered");
  const inPts = ev.arrowPathIn;
  const capM = svgText.match(/<text x="([\d.]+)" y="([\d.]+)"[^>]*font-style="italic"/);
  check(!!capM, "dashed-in: caption is an italic label");
  if (capM) {
    const cx = parseFloat(capM[1]);
    const lo = Math.min(inPts[0].x, inPts[inPts.length - 1].x) - 40;
    const hi = Math.max(inPts[0].x, inPts[inPts.length - 1].x) + 40;
    check(cx >= lo && cx <= hi, "dashed-in: caption sits on the incoming arrow");
  }

  // The gap before the box must GROW to fit the caption, or the label is
  // clipped by the box it points at. Compare against a caption-free control.
  {
    const long_ = parseCore(`A -> C: first\nC --> A: cross\nC <--> C: box <a rather long caption>`);
    solveLayoutCore(long_);
    const none = parseCore(`A -> C: first\nC --> A: cross\nC <--> C: box`);
    solveLayoutCore(none);
    const span = (mm) => {
      const e = mm.events.find((x) => x.text === "box");
      return Math.abs(e.arrowPathIn[1].x - e.arrowPathIn[0].x);
    };
    check(span(long_) > span(none), "dashed-in: incoming arrow grows for a long caption");
  }

  // Solid "<->" stays solid, and "<:" keeps its undashed default.
  const solid = parseCore(`A -> C: first\nC --> A: cross\nC <-> C: solid inbound`);
  solveLayoutCore(solid);
  check(solid.events.find((e) => e.text === "solid inbound").dashedIn === false, "dashed-in: <-> stays solid");
  const back = parseCore(`A -> C: first\nC --> A: cross\nC <--: terminal`);
  solveLayoutCore(back);
  const bev = back.events.find((e) => e.text === "terminal");
  check(bev.incomingOnly === true && bev.dashedIn === true, "dashed-in: <--: parses as dashed backward-only");
  const back2 = parseCore(`A -> B: first\nB <: plain`);
  check(back2.events.find((e) => e.text === "plain").dashedIn === false, "dashed-in: <: stays solid");
}

// 3. render svg
const svg = await client.callTool({ name: "render_swimlane", arguments: { source: SOURCE, format: "svg" } });
const svgText = svg.content.find((c) => c.type === "text" && /<svg/.test(c.text));
check(!!svgText, "render svg: returns SVG text");
check(svg.structuredContent.svg?.width > 0, "render svg: reports width");

// 4. render png
const png = await client.callTool({ name: "render_swimlane", arguments: { source: SOURCE, format: "png", scale: 2 } });
const img = png.content.find((c) => c.type === "image");
check(!!img && img.mimeType === "image/png", "render png: returns PNG image");
check(img && Buffer.from(img.data, "base64").length > 1000, "render png: non-trivial PNG bytes");

// 5. render ascii
const ascii = await client.callTool({ name: "render_swimlane", arguments: { source: SOURCE, format: "ascii" } });
const asciiText = ascii.content.find((c) => c.type === "text" && /[┌┐└┘│─]/.test(c.text));
check(!!asciiText, "render ascii: returns box-drawing art");
check(/[┌┐└┘│─]/.test(ascii.structuredContent.ascii || ""), "render ascii: art also carried in structuredContent");

// 6. render all + save to disk
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "swimlane-"));
const base = path.join(dir, "diagram");
const all = await client.callTool({ name: "render_swimlane", arguments: { source: SOURCE, format: "all", save_path: base } });
const wrote = all.structuredContent.written || [];
check(wrote.length === 3, "render all: wrote 3 files");
for (const ext of ["svg", "png", "txt"]) {
  const p = `${base}.${ext}`;
  const stat = await fs.stat(p).catch(() => null);
  check(stat && stat.size > 0, `render all: ${ext} written (${stat ? stat.size : 0} bytes)`);
}
await fs.rm(dir, { recursive: true, force: true });

// 7. default render (no format): ASCII content blocks + SVG for the inline view
const def = await client.callTool({ name: "render_swimlane", arguments: { source: SOURCE } });
check(def.structuredContent.format === "ascii", "render default: format is ascii");
check(/[┌┐└┘│─]/.test(def.content.find((c) => c.type === "text")?.text || ""), "render default: ASCII in content");
check(/<svg/.test(def.structuredContent.svgText || ""), "render default: SVG carried for inline view");

await client.close();
console.log(failures ? `\n${failures} FAILURE(S)` : "\nAll smoke checks passed.");
process.exit(failures ? 1 : 0);
