---
name: swimlane
description: Author swimlane / sequence-style diagrams and render them to SVG, PNG, or ASCII via the swimlane MCP server. Use whenever the user wants to draw, generate, sketch, or export a swimlane diagram, sequence diagram, process/flow diagram, message-passing diagram, or "who-does-what" lane diagram — phrases like "draw a swimlane of X", "diagram this flow", "show the request/response sequence", "make a swimlane for the login process", "render this as ASCII", or any request to turn a described process into lanes-and-arrows. This skill carries the full DSL; consult it before writing diagram source.
---

# Swimlane diagrams

Render swimlane diagrams from a line-oriented DSL using the `swimlane` MCP
server. Boxes live in their **sender's** lane; arrows route to the target
lane. Time flows left-to-right (horizontal) or top-to-bottom (vertical).

## Tools

The MCP server exposes three tools (prefixed `mcp__swimlane__`):

- **`render_swimlane`** — `{ source, orientation?, format?, scale?, save_path? }`
  - **Inline view:** this tool is an *MCP App*. In hosts that support MCP Apps (e.g. Claude Desktop) the diagram is drawn automatically as an interactive inline SVG view — you don't do anything to trigger it; just call the tool.
  - `format`: `"svg"`, `"png"`, `"ascii"`, or `"all"`. This controls the *content blocks* the tool returns (text the model reads / a terminal shows), **not** the inline view. **Defaults to `ascii`** — the format that shows inline as text in a plain terminal. `png`/`svg` are export formats: request them, normally with `save_path`, when the user wants an image or vector file. A returned PNG/`image` block does **not** render inline in Claude Desktop chat (only the MCP App view does), so never rely on a PNG block as the on-screen diagram.
  - `orientation`: `"horizontal"` (default) or `"vertical"`. ASCII is always horizontal.
  - `scale`: PNG raster factor (default 2).
  - `save_path`: absolute path to write to. For `"all"` it is a basename and `.svg`/`.png`/`.txt` are written.
- **`validate_swimlane`** — `{ source }` → lanes, counts, and parse errors. Cheap syntax check.
- **`swimlane_syntax`** — the DSL cheat-sheet (this skill already contains it below).

If the server is not registered, see "Setup" at the bottom.

## Workflow

1. Turn the user's process into DSL using the reference below. Put each
   actor/system in its own lane; each step is a box in the lane of whoever
   performs it. **Prefer a connected flow** — see below.
2. For anything non-trivial, call `validate_swimlane` first to confirm the
   lanes and catch unparseable lines.
3. Call `render_swimlane` and **leave `format` unset** — it defaults to `ascii`,
   which displays inline in chat on every host. Set `format` only to export a
   file the user asked for: `png` (raster) or `svg` (vector), normally with
   `save_path`; `all` to write every format to disk.
4. If the user wants a file, pass `save_path` (absolute).

**Always render — never just describe.** The rendered diagram is the
deliverable; a prose walk-through of the lanes is not a substitute and does not
count as producing the diagram. Always call `render_swimlane`.

- In an **MCP App host (Claude Desktop)** the inline SVG view appears on its
  own once the tool runs — that *is* the diagram; you needn't echo anything.
- In a **plain terminal (no MCP App)** reproduce the returned ASCII inside a
  fenced ```` ``` ```` code block in your reply so it displays inline and stays
  monospaced — don't rely on the collapsed tool-result panel.

Keep any commentary short and put it after the diagram, not instead of it.

## Prefer connected flows (preferred form)

Write the steps so each arrow lands on the **next box**, giving one
continuous chain rather than arrows that stop in empty lane space. The rule:

> **The actor a message is sent TO should be the actor the NEXT message is
> sent FROM.**

Each box is owned by its *sender*, and a cross-lane arrow connects to the
next box in its *target* lane. So when the target of one step is the sender
of the next, the arrow lands on that box and the diagram reads as a single
connected path (`A -> B`, then `B -> C`, then `C -> ...`).

Connected (preferred) — every arrow lands on a box:

```
Customer -> Barista: Place order
Barista  -> Machine: Brew coffee
Machine  -> Barista: Ready
Barista  -> Customer: Serve coffee
```

Disconnected (avoid) — the target lane has no follow-up box, so the arrow
dangles into empty space:

```
Customer -> Barista: Place order
Customer -> Barista: Pay
```

If the next real step genuinely starts from the same actor again, keep them
in that actor's lane with a same-lane step (`Barista -> Barista: Grind beans`)
so the chain stays visibly linked. Only let an arrow point into an empty
lane when the flow truly ends at that actor (e.g. a final hand-off back to
the user). This matters most for `ascii` output, where a connected chain is
far more readable than scattered arrowheads.

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
insert line breaks except in notes (`\n`).

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
