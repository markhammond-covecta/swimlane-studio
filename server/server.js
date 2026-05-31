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
//   render_swimlane   - DSL -> SVG / PNG / ASCII (optionally written to disk)
//   validate_swimlane - parse only; report lanes, counts, and errors
//   swimlane_syntax   - return the DSL cheat-sheet

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Resvg } from "@resvg/resvg-js";

import {
  parse,
  solveLayout,
  render,
  renderAscii,
} from "../lib/swimlane-core.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Pick a default output format from the host environment. Claude Code injects
// CLAUDECODE=1 into every subprocess it spawns; other MCP clients (Claude
// Desktop, etc.) do not. A terminal renders text well, so default to inline
// ASCII there; a GUI client renders images, so default to an inline PNG.
const IN_TERMINAL = process.env.CLAUDECODE === "1";
const DEFAULT_FORMAT = IN_TERMINAL ? "ascii" : "png";

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
  Bob >-> Alice: Reply            Counter-pair reply sharing a column.
  Alice <: Done                   Backward-only terminal box.
  Alice: Read output              Standalone box (no arrow of its own).
  [ Section name ]                Section banner over the columns that follow.
  note Alice: Inspect logs        Note attached to one lane.
  note Alice, Bob: Window\\n2s      Multi-lane note (\\n = line break).
  # comment   // comment          Comment lines.

Arrow captions: end a message with <...> to caption the arrow itself, e.g.
  Browser -> Server: Send request <http POST>
renders a "Send request" box with "http POST" beside the arrow.

Orientation: "horizontal" (lanes stacked, time L->R) or "vertical" (lanes
side-by-side, time top->down). ASCII output is always horizontal.`;

const server = new McpServer(
  { name: "swimlane", version: "0.1.0" },
  {
    instructions:
      `Renders swimlane / sequence-style diagrams from a line-oriented DSL.\n` +
      `Call render_swimlane with the DSL in "source"; pick format "svg", ` +
      `"png", "ascii", or "all". If you omit format it defaults to ` +
      `"${DEFAULT_FORMAT}" (chosen for this host: inline ASCII in a terminal, ` +
      `an inline PNG image in a GUI client). Use validate_swimlane to check ` +
      `syntax cheaply, and swimlane_syntax for the full grammar.\n\n` +
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

server.registerTool(
  "render_swimlane",
  {
    title: "Render swimlane diagram",
    description:
      "Render a swimlane diagram from the Swimlane DSL. Returns SVG text, a " +
      "PNG image, ASCII art, or all three. Optionally writes the result to " +
      "disk. Call swimlane_syntax if you are unsure of the DSL.",
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
          "Output format. 'all' returns SVG text + PNG image + ASCII. If " +
          `omitted, defaults to '${DEFAULT_FORMAT}' for this host (ASCII in a ` +
          "terminal, PNG in a GUI client).",
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
  },
  async ({ source, orientation, format, scale, save_path }) => {
    const fmt = format ?? DEFAULT_FORMAT;
    const out = {};
    let dims = null;

    if (fmt === "svg" || fmt === "png" || fmt === "all") {
      const { svg } = renderSvg(source, orientation);
      out.svg = svg;
      dims = svgDims(svg);
      if (fmt === "png" || fmt === "all") out.png = svgToPng(svg, scale);
    }
    if (fmt === "ascii" || fmt === "all") {
      out.ascii = renderAscii(parse(source));
    }

    const parsed = parse(source);
    const content = [];
    const structured = {
      format: fmt,
      orientation,
      lanes: parsed.lanes,
      events: parsed.events.length,
      parseErrors: parsed.errors,
    };

    if (out.svg != null && dims) structured.svg = { ...dims };

    // Carry the rendered text inside structuredContent as well. Some MCP
    // clients surface structuredContent in preference to the content blocks,
    // which would otherwise hide an ASCII/SVG render behind bare metadata.
    if (out.ascii != null) structured.ascii = out.ascii;
    if (out.svg != null && fmt !== "png") structured.svgText = out.svg;

    if (save_path) {
      const written = await writeOut(save_path, fmt, out);
      structured.written = written;
      content.push({ type: "text", text: `Wrote: ${written.join(", ")}` });
    }

    if (out.ascii != null) {
      content.push({ type: "text", text: out.ascii });
    }
    if (out.png != null) {
      content.push({
        type: "image",
        data: out.png.toString("base64"),
        mimeType: "image/png",
      });
    }
    if (out.svg != null && fmt !== "png") {
      // Include raw SVG text so the client can embed/save it verbatim.
      content.push({ type: "text", text: out.svg });
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
