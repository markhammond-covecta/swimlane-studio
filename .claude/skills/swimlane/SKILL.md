---
name: swimlane
description: Author swimlane / sequence-style diagrams and render them to SVG, PNG, or ASCII via the swimlane MCP server — or return the DSL script itself instead of a rendered diagram. Use whenever the user wants to draw, generate, sketch, or export a swimlane diagram, sequence diagram, process/flow diagram, message-passing diagram, or "who-does-what" lane diagram — phrases like "draw a swimlane of X", "diagram this flow", "show the request/response sequence", "make a swimlane for the login process", "render this as ASCII", or any request to turn a described process into lanes-and-arrows. Also use when the user wants the swimlane DSL/script/source as the output rather than the diagram — "give me the DSL", "just the script", "don't render it", "output as DSL". This skill carries the full DSL; consult it before writing diagram source.
---

# Swimlane diagrams

Render swimlane diagrams from a line-oriented DSL using the `swimlane` MCP
server. Boxes live in their **sender's** lane; arrows route to the target
lane. Time flows left-to-right (horizontal) or top-to-bottom (vertical).

## Tools

The MCP server exposes four tools (prefixed `mcp__swimlane__`):

- **`render_swimlane`** — `{ source, orientation?, format?, scale?, save_path? }`
  - **Inline view:** this tool is an *MCP App*. In hosts that support MCP Apps (e.g. Claude Desktop) the diagram is drawn automatically as an interactive inline SVG view — you don't do anything to trigger it; just call the tool.
  - `format`: `"svg"`, `"png"`, `"ascii"`, or `"all"`. This controls the *content blocks* the tool returns (text the model reads / a terminal shows), **not** the inline view. **Defaults to `ascii`** — the format that shows inline as text in a plain terminal. `png`/`svg` are export formats: request them, normally with `save_path`, when the user wants an image or vector file. A returned PNG/`image` block does **not** render inline in Claude Desktop chat (only the MCP App view does), so never rely on a PNG block as the on-screen diagram.
  - `orientation`: `"horizontal"` (default) or `"vertical"`. ASCII is always horizontal.
  - `scale`: PNG raster factor (default 2).
  - `save_path`: absolute path to write to. For `"all"` it is a basename and `.svg`/`.png`/`.txt` are written.
- **`generate_swimlane_script`** — `{ source, save_path? }` → returns the DSL script text (and writes it verbatim to `save_path` if given). **No diagram is rendered.** Use this when the user wants the DSL source itself — e.g. an `.swml` file — rather than an SVG/PNG/ASCII diagram.
- **`validate_swimlane`** — `{ source }` → lanes, counts, and parse errors. Cheap syntax check.
- **`swimlane_syntax`** — the DSL cheat-sheet (this skill already contains it below).

If the server is not registered, see "Setup" at the bottom.

## Workflow

1. Turn the user's process into DSL using the reference below. Put each
   actor/system in its own lane; each step is a box in the lane of whoever
   performs it. **Prefer a connected flow** — see below. You author the DSL
   from the natural-language request; the server does not do that step.
2. For anything non-trivial, call `validate_swimlane` first to confirm the
   lanes and catch unparseable lines.
3. **Decide what the user asked for — the diagram, or the DSL script itself:**
   - **A diagram (the default):** call `render_swimlane` and **leave `format`
     unset** — it defaults to `ascii`, which displays inline in chat on every
     host. Set `format` only to export a file the user asked for: `png`
     (raster) or `svg` (vector), normally with `save_path`; `all` to write
     every format to disk.
   - **The DSL script only (no diagram):** call `generate_swimlane_script`
     with the `source` you authored. It validates the DSL and returns the
     script text without rendering anything. Reproduce that script in a fenced
     code block in your reply. Trigger this whenever the user asks for the
     "DSL", "script", "source", "the text", "just the code", "don't render",
     "output as DSL", and so on.
4. If the user wants a file, pass `save_path` (absolute) — to `render_swimlane`
   for a diagram file, or to `generate_swimlane_script` to save the DSL itself
   (e.g. an `.swml` file).

**Always produce the deliverable — never just describe it.** The rendered
diagram (or, when the DSL is what was asked for, the script) is the deliverable;
a prose walk-through of the lanes is not a substitute. Always call
`render_swimlane` (or `generate_swimlane_script` for the DSL path).

- In an **MCP App host (Claude Desktop)** the inline SVG view appears on its
  own once the tool runs — that *is* the diagram; you needn't echo anything.
- In a **plain terminal (no MCP App)** reproduce the returned ASCII inside a
  fenced ```` ``` ```` code block in your reply so it displays inline and stays
  monospaced — don't rely on the collapsed tool-result panel.

Keep any commentary short and put it after the diagram, not instead of it.

## Every arrow must terminate at a box

This is a hard requirement, not a stylistic preference: **no arrow may lead
into empty space.** Every arrow — incoming or outgoing — has to start and end
on a box. A diagram with a dangling arrowhead (a `►` or `▼` pointing at
nothing) reads as broken. After rendering, scan the output for any arrowhead
that does not land on a box and fix it before delivering.

There are two ways an arrow ends up dangling, each with a specific fix.

### 1. Target lane has no box for the arrow to land on

Each box is owned by its *sender*, and a cross-lane arrow connects to the
**next box in its target lane**. So the rule for a connected chain:

> **The actor a message is sent TO should be the actor the NEXT message is
> sent FROM.**

When the target of one step is the sender of the next, the arrow lands on
that box and the diagram reads as a single connected path (`A -> B`, then
`B -> C`, then `C -> ...`).

Connected — every arrow lands on a box:

```
Customer -> Barista: Place order
Barista  -> Machine: Brew coffee
Machine  -> Barista: Ready
Barista  -> Customer: Serve coffee
```

Disconnected — the target lane (`Barista`) never sends anything after, so
nothing receives the arrows and they dangle:

```
Customer -> Barista: Place order
Customer -> Barista: Pay
```

This bites hardest with **output / sink lanes** (artefacts, results, an
"Outputs" lane). `Compiler -> Output: write config` puts the box in the
*Compiler* lane and fires an arrow at an empty `Output` lane. To put real
boxes in that lane, make the lane the *sender* — chain the outputs from it:

```
Compiler -> Output: write outputs
Output -> Output: workflow_config.json
Output -> Output: agent_profile.html
Output: build_report + log
```

The first cross-lane arrow now lands on `workflow_config.json`, and the
same-lane chain links the rest.

### 2. The last box in a same-lane chain emits a trailing stub

A same-lane step (`X -> X: ...`) always draws an **outgoing** arrow that
expects a following `X` box to trail into. On the *last* box of the chain
there is no follow-up, so it renders a short arrow into empty space — a
dangling stub even though the box itself is fine.

Fix: make the final box one that has **no outgoing trail**:

- `Lane: label` — a standalone box (no arrow of its own). Best for a plain
  terminal output.
- `Lane <: label` — a backward-only terminal box (incoming link, no outgoing
  trail). Use when the last step is a reply/hand-off.

```
Output -> Output: workflow_config.json   # arrow trails to the next box
Output -> Output: agent_profile.html     # arrow trails to the next box
Output: build_report + log               # standalone: no trailing stub
```

So: end every same-lane chain with a standalone (`Lane:`) or backward-only
(`<:`) box, and give every sink lane its own boxes. This matters most for
`ascii` output, where a stray arrowhead is glaringly visible.

## DSL reference

| Form | Meaning |
| --- | --- |
| `title: Order processing` | Diagram title, centred above the lanes. |
| `order: Customer, API, DB` | Force lane order (else first-seen order). |
| `Alice -> Bob: Send order` | Cross-lane message; box in Alice, solid arrow to Bob. |
| `Alice --> Bob: ACK` | Same, dashed line (typically a response). |
| `Alice -> Alice: Validate` | Same-lane step; box in Alice trailing to the next Alice box. |
| `Alice <-> Bob: Sync call` | Bidirectional: cross-lane arrow plus a same-lane backward link. |
| `Bob >-> Alice: Reply` | Counter-pair reply that shares a column with the prior `Alice -> Bob`. |
| `Alice <: Done` | Backward-only terminal box (incoming link, no outgoing trail). |
| `Alice: Read output` | Standalone box — no arrow of its own. |
| `[1] Alice -> Bob: Start` | Tag this box `1` (free-form name; not drawn). |
| `Carol -> [1]: Retry` | Loop back: backward arc to the box tagged `1`. |
| `[ Section name ]` | Section banner spanning the columns that follow. |
| `note Alice: Inspect logs` | Note attached to one lane. |
| `note Alice, Bob: Window\n2s` | Multi-lane note (`\n` = line break). |
| `# ...` or `// ...` | Comment line. |

**Arrow captions:** end a message with `<...>` to caption the arrow itself
(separate from the box label):

```
Browser -> Server: Send request <http POST>
```

renders a "Send request" box with "http POST" beside the arrow.

**Loop-backs:** prefix a line with `[tag] ` to label the box it creates,
then target `[tag]` later to draw a backward arc to that box (the tag is
never displayed). A same-lane loop stays within its lane; a cross-lane loop
routes through a channel above the lanes. The arc never crosses a box, and
breaks where it crosses another connector so it reads as passing under.

```
[1] First -> Second: Apple
Second -> Third: Orange
Third -> [1]: Lemon
```

**Wrapping:** box and arrow captions wrap automatically; you don't need to
insert line breaks except in notes (`\n`, or `/n` — both work).

## Worked examples

Request/response flow:

```
title: Search
User -> Browser: Enter query <string>
Browser -> Server: GET /search <http>
Server --> Browser: Results <json>
Browser -> Browser: Render
Browser -> User: Show results
```

Order processing with a section and a note:

```
title: Order processing
order: Customer, Storefront, Payments
[ Checkout ]
Customer -> Storefront: Place order
Storefront -> Payments: Charge card <Stripe>
Payments --> Storefront: Authorised
[ Fulfilment ]
Storefront -> Storefront: Reserve stock
Storefront -> Customer: Confirmation email
note Payments: PCI scope
```

## Setup

The server is in `server/` of the swimlane repo and runs over stdio (no
long-running process, no network). First install deps and build the inline-view
bundle:

```sh
cd /Users/mark/code/swimlane/server && npm install && npm run build:app
```

`npm run build:app` produces `server/dist/app.html` — the self-contained MCP App
viewer that hosts render inline. It is committed, so this is only needed after
changing `server/app/`.

**Claude Code** — register over the CLI:

```sh
claude mcp add swimlane -- node /Users/mark/code/swimlane/server/server.js
```

**Claude Desktop** — it doesn't use `claude mcp add`; add an entry to its config
at `~/Library/Application Support/Claude/claude_desktop_config.json` (use an
absolute `node` path, since Desktop launches without your shell `PATH`) and
restart Desktop:

```json
{
  "mcpServers": {
    "swimlane": {
      "command": "/absolute/path/to/node",
      "args": ["/Users/mark/code/swimlane/server/server.js"]
    }
  }
}
```

Tools then appear as `mcp__swimlane__*`. The inline diagram view only renders in
hosts that support MCP Apps (Claude Desktop); elsewhere use the ASCII output.
