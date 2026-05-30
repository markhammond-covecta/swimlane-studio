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
  - `format`: `"svg"` (default), `"png"`, `"ascii"`, or `"all"`.
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
3. Call `render_swimlane`. Default to `svg`; use `png` when the user wants an
   image to drop into a doc/chat, `ascii` for inline terminal/markdown output,
   `all` when unsure or when saving to disk.
4. If the user wants a file, pass `save_path` (absolute).

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
long-running process, no network). Register it once with:

```sh
claude mcp add swimlane -- node /Users/mark/code/swimlane/server/server.js
```

(Run `npm install` in `server/` first if dependencies are missing.) Tools
then appear as `mcp__swimlane__*`.
