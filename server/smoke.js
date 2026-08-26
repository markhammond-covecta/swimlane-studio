#!/usr/bin/env node
// Smoke test: spawn server.js over stdio via the MCP client SDK and exercise
// every tool. Run with `node smoke.js` (or `npm run smoke`).

import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import os from "node:os";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

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
