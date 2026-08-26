#!/usr/bin/env node
// Swimlane MCP server.
//
// A local, stdio-only MCP server: the client (e.g. Claude Code) spawns this
// process on demand, exchanges JSON-RPC over stdin/stdout, and shuts it down
// afterwards. Nothing listens on a network socket. It reuses the exact
// parse -> solveLayout -> render pipeline from ../lib/swimlane-core.js that
// drives the Swimlane Studio web app, so diagrams render identically.
//
// Tools:
//   render_swimlane          - DSL -> SVG / PNG / ASCII (optionally written to disk)
//   generate_swimlane_script - validate DSL and return/save the script; no diagram
//   validate_swimlane        - parse only; report lanes, counts, and errors
//   swimlane_syntax          - return the DSL cheat-sheet

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { Resvg } from "@resvg/resvg-js";

import {
  parse,
  solveLayout,
  render,
  renderAscii,
} from "../lib/swimlane-core.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// MCP App: render_swimlane references this UI resource via _meta.ui.resourceUri.
// Hosts that support MCP Apps (e.g. Claude Desktop) fetch the HTML and render it
// in an inline iframe, handing it the tool result; the app draws the SVG. Hosts
// that don't (e.g. a terminal) ignore the metadata and just show the tool's
// content blocks. dist/app.html is built from app/ by `npm run build:app`.
const UI_RESOURCE_URI = "ui://swimlane/app.html";
const APP_HTML_PATH = path.join(__dirname, "dist", "app.html");

// Default output format for the tool's *content blocks*. ASCII is the format
// that shows inline as text on every host (a terminal prints it; the model can
// echo it in a code block). Independently, every render also carries the SVG in
// structuredContent.svgText so the MCP App iframe can draw the diagram visually
// in GUI hosts. PNG/SVG remain explicit export formats (usually with save_path).
const DEFAULT_FORMAT = "ascii";

// --- DSL reference, shared between the swimlane_syntax tool and the server
//     instructions so syntax-less MCP clients can still author diagrams. ---
const SYNTAX = `Swimlane DSL quick reference
============================

Boxes live in their SENDER's lane; arrows route to the target lane.

  title: Order processing        Diagram title.
  order: Customer, API, DB        Force lane order (else first-seen order).
  Alice -> Bob: Send order        Cross-lane message (solid arrow).
  Alice --> Bob: ACK              Cross-lane message (dashed, e.g. a reply).
  Alice -> Alice: Validate        Same-lane step; trails to next Alice box.
  Alice <-> Bob: Sync             Bidirectional arrow.
  Alice <--> Alice: Process       Bidirectional, dashed: BOTH the forward trail
                                  and the backward link. Use it to dash an
                                  arrow arriving AT a box (a dash on "->"
                                  styles the arrow leaving its own box).
  Bob >-> Alice: Reply            Counter-pair reply sharing a column.
  Alice <: Done                   Backward-only terminal box.
  Alice <--: Done                 Backward-only box, incoming link dashed.
  Alice: Read output              Standalone box (no arrow of its own).
  [1] Alice -> Bob: Start         Tag this box "1" (the tag is not drawn).
  Carol -> [1]: Retry             Loop back to the box tagged "1".
  [ Section name ]                Section banner over the columns that follow.
  note Alice: Inspect logs        Note attached to one lane.
  note Alice, Bob: Window\\n2s      Multi-lane note (\\n or /n = line break).
  # comment   // comment          Comment lines.

Arrow captions: end a message with <...> to caption the arrow itself, e.g.
  Browser -> Server: Send request <http POST>
renders a "Send request" box with "http POST" beside the arrow.

Loop-backs: prefix a line with "[tag] " to label the box it creates, then
target "[tag]" from a later statement to draw a backward arc to that box.
The tag is never displayed. A same-lane loop stays within its lane; a
cross-lane loop routes through a channel above the lanes (or to the side in
vertical orientation). The arc never crosses a box, and breaks where it
crosses another connector so it reads as passing underneath.

Orientation: "horizontal" (lanes stacked, time L->R) or "vertical" (lanes
side-by-side, time top->down). ASCII output is always horizontal.`;

const server = new McpServer(
  { name: "swimlane", version: "0.1.0" },
  {
    instructions:
      `Renders swimlane / sequence-style diagrams from a line-oriented DSL.\n` +
      `Call render_swimlane with the DSL in "source". In MCP App hosts (e.g. ` +
      `Claude Desktop) the diagram is drawn inline as an interactive SVG view ` +
      `automatically. The tool result also returns content blocks in the ` +
      `chosen format, default "${DEFAULT_FORMAT}" — in a plain terminal, ` +
      `reproduce that ASCII in a code block so the user sees it. Request ` +
      `"png", "svg", or "all" to export an image/vector (usually with ` +
      `save_path). Use generate_swimlane_script when the user wants the DSL ` +
      `script itself rather than a diagram, validate_swimlane to check syntax ` +
      `cheaply, and swimlane_syntax for the full grammar.\n\n` +
      SYNTAX,
  },
);

// Pull width/height out of a rendered SVG header.
function svgDims(svg) {
  const w = /width="(\d+(?:\.\d+)?)"/.exec(svg);
  const h = /height="(\d+(?:\.\d+)?)"/.exec(svg);
  return { width: w ? Math.round(+w[1]) : null, height: h ? Math.round(+h[1]) : null };
}

function renderSvg(source, orientation) {
  const model = parse(source);
  model.orientation = orientation;
  solveLayout(model);
  return { svg: render(model), model };
}

function svgToPng(svg, scale) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: "zoom", value: scale },
    background: "white",
    font: { loadSystemFonts: true, defaultFontFamily: "Helvetica" },
  });
  return resvg.render().asPng(); // Buffer
}

async function writeOut(savePath, format, { svg, png, ascii }) {
  const written = [];
  if (format === "all") {
    const base = savePath.replace(/\.(svg|png|txt)$/i, "");
    if (svg != null) { await fs.writeFile(`${base}.svg`, svg); written.push(`${base}.svg`); }
    if (png != null) { await fs.writeFile(`${base}.png`, png); written.push(`${base}.png`); }
    if (ascii != null) { await fs.writeFile(`${base}.txt`, ascii); written.push(`${base}.txt`); }
  } else {
    const data = format === "png" ? png : format === "ascii" ? ascii : svg;
    await fs.writeFile(savePath, data);
    written.push(savePath);
  }
  return written;
}

// The HTML viewer resource the render tool drives in MCP App hosts.
registerAppResource(
  server,
  "Swimlane diagram",
  UI_RESOURCE_URI,
  { description: "Inline swimlane diagram viewer." },
  async () => ({
    contents: [
      {
        uri: UI_RESOURCE_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: await fs.readFile(APP_HTML_PATH, "utf8"),
        // Ask the host to grant the iframe clipboard-write so the viewer's
        // "copy as PNG" button can place the image on the clipboard.
        _meta: { ui: { permissions: { clipboardWrite: {} } } },
      },
    ],
  }),
);

registerAppTool(
  server,
  "render_swimlane",
  {
    title: "Render swimlane diagram",
    description:
      "Render a swimlane diagram from the Swimlane DSL. In MCP App hosts the " +
      "diagram is drawn inline as an interactive SVG view; the tool result " +
      "also returns ASCII (the default), or a PNG/SVG/all export. Optionally " +
      "writes the result to disk. Call swimlane_syntax if unsure of the DSL.",
    inputSchema: {
      source: z.string().describe("The swimlane DSL source (see swimlane_syntax)."),
      orientation: z
        .enum(["horizontal", "vertical"])
        .default("horizontal")
        .describe("Lane layout. ASCII output is always horizontal."),
      format: z
        .enum(["svg", "png", "ascii", "all"])
        .optional()
        .describe(
          "Format of the returned content blocks. 'all' returns SVG text + " +
          `PNG image + ASCII. If omitted, defaults to '${DEFAULT_FORMAT}' — ` +
          "the format that shows inline as text on every host. (The inline " +
          "visual view in MCP App hosts is always drawn from the SVG, " +
          "independent of this.) Use 'png'/'svg' to export, usually with " +
          "save_path.",
        ),
      scale: z
        .number()
        .min(0.25)
        .max(8)
        .default(2)
        .describe("PNG raster scale factor (1 = native SVG pixel size)."),
      save_path: z
        .string()
        .optional()
        .describe(
          "Absolute path to write the output to. For format 'all' this is " +
          "treated as a basename and .svg/.png/.txt are written.",
        ),
    },
    _meta: { ui: { resourceUri: UI_RESOURCE_URI } },
  },
  async ({ source, orientation, format, scale, save_path }) => {
    const fmt = format ?? DEFAULT_FORMAT;
    const parsed = parse(source);

    // Always render the SVG: it backs both the inline MCP App view
    // (structuredContent.svgText) and the 'svg'/'png'/'all' export formats.
    const { svg } = renderSvg(source, orientation);
    const dims = svgDims(svg);

    const out = { svg };
    if (fmt === "png" || fmt === "all") out.png = svgToPng(svg, scale);
    // renderAscii reads solver output (column assignment), so the model must
    // go through solveLayout first. ASCII is always laid out horizontally
    // regardless of the SVG's orientation.
    if (fmt === "ascii" || fmt === "all") {
      const am = parse(source);
      am.orientation = "horizontal";
      solveLayout(am);
      out.ascii = renderAscii(am);
    }

    const content = [];
    const structured = {
      format: fmt,
      orientation,
      lanes: parsed.lanes,
      events: parsed.events.length,
      parseErrors: parsed.errors,
      svg: { ...dims },
      // Consumed by the MCP App viewer to draw the diagram inline; also lets
      // structuredContent-only clients recover the vector output.
      svgText: svg,
    };
    if (out.ascii != null) structured.ascii = out.ascii;

    if (save_path) {
      const written = await writeOut(save_path, fmt, out);
      structured.written = written;
      content.push({ type: "text", text: `Wrote: ${written.join(", ")}` });
    }

    // Content blocks follow the requested format (what a non-app host shows).
    // Raw SVG text is only dumped for explicit 'svg'/'all' so it never clutters
    // the default ASCII output.
    if (out.ascii != null) content.push({ type: "text", text: out.ascii });
    if (out.png != null) {
      content.push({
        type: "image",
        data: out.png.toString("base64"),
        mimeType: "image/png",
      });
    }
    if (fmt === "svg" || fmt === "all") {
      content.push({ type: "text", text: svg });
    }
    if (parsed.errors.length) {
      content.push({
        type: "text",
        text: `Parse warnings:\n${parsed.errors.join("\n")}`,
      });
    }
    if (!content.length) content.push({ type: "text", text: "(nothing rendered)" });

    return { content, structuredContent: structured };
  },
);

server.registerTool(
  "generate_swimlane_script",
  {
    title: "Generate swimlane script",
    description:
      "Produce the swimlane DSL script itself — no diagram is rendered. " +
      "Validates the source, then returns the script text and, if save_path " +
      "is given, writes it to disk. Use this when the user wants the DSL " +
      "source (e.g. a .swml file) rather than an SVG/PNG/ASCII diagram. Call " +
      "swimlane_syntax if unsure of the DSL.",
    inputSchema: {
      source: z.string().describe("The swimlane DSL source (see swimlane_syntax)."),
      save_path: z
        .string()
        .optional()
        .describe(
          "Absolute path to write the script to (e.g. an .swml or .txt file). " +
          "The source is written verbatim.",
        ),
    },
  },
  async ({ source, save_path }) => {
    const m = parse(source);
    const messages = m.events.filter((e) => e.type === "message").length;
    const notes = m.events.filter((e) => e.type === "note").length;
    const structured = {
      ok: m.errors.length === 0,
      script: source,
      lanes: m.lanes,
      title: m.title || null,
      messages,
      notes,
      sections: m.sections.map((s) => s.label),
      errors: m.errors,
    };

    const content = [];
    if (save_path) {
      await fs.writeFile(save_path, source);
      structured.written = [save_path];
      content.push({ type: "text", text: `Wrote script: ${save_path}` });
    }
    content.push({ type: "text", text: source });
    if (m.errors.length) {
      content.push({
        type: "text",
        text: `Parse warnings:\n${m.errors.join("\n")}`,
      });
    }
    return { content, structuredContent: structured };
  },
);

server.registerTool(
  "validate_swimlane",
  {
    title: "Validate swimlane DSL",
    description:
      "Parse the DSL without rendering. Returns the detected lanes (in " +
      "order), event/section/note counts, and any parse errors. Use this to " +
      "check syntax cheaply before rendering.",
    inputSchema: {
      source: z.string().describe("The swimlane DSL source to validate."),
    },
  },
  async ({ source }) => {
    const m = parse(source);
    const messages = m.events.filter((e) => e.type === "message").length;
    const notes = m.events.filter((e) => e.type === "note").length;
    const summary = {
      ok: m.errors.length === 0,
      lanes: m.lanes,
      title: m.title || null,
      messages,
      notes,
      sections: m.sections.map((s) => s.label),
      errors: m.errors,
    };
    const lines = [
      summary.ok ? "OK — parsed cleanly." : `Parsed with ${m.errors.length} error(s).`,
      `Lanes (${m.lanes.length}): ${m.lanes.join(", ") || "(none)"}`,
      `Messages: ${messages}  Notes: ${notes}  Sections: ${m.sections.length}`,
    ];
    if (m.errors.length) lines.push("", "Errors:", ...m.errors);
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      structuredContent: summary,
      isError: !summary.ok,
    };
  },
);

server.registerTool(
  "swimlane_syntax",
  {
    title: "Swimlane DSL reference",
    description: "Return the swimlane DSL cheat-sheet (syntax, arrows, notes, sections).",
    inputSchema: {},
  },
  async () => ({ content: [{ type: "text", text: SYNTAX }] }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
