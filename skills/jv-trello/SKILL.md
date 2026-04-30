---
name: jv-trello
description: Use when an agent needs to work with Trello boards via this MCP server. Covers session setup, board config parsing, worktree management, comment discipline, tool selection, response shapes, and patterns for efficient multi-step workflows.
---

# Trello MCP Agent Skill

Use this skill whenever you are operating against the Trello MCP server to ensure you pick the right tool variant, leave structured comments, and keep token usage low.

---

## Session setup

### 1 — Read board config

At the start of every session call:

```json
{ "name": "jv_get_active_board_info", "arguments": {} }
```

Parse the `desc` field of the response. If it contains a JSON block with the key `worktrees` or `autoCommit`, extract and apply it. Strip JS comments (`//`) before parsing. If absent or malformed, fall back to defaults.

```js
{
  worktrees: {
    create: 'always',   // 'always' | 'ask' | 'never'  — default: 'ask'
    path: '.worktrees',
    format: `${path}/${featureName}`,
    branchFormat: `feature/${featureName}`
  },
  autoCommit: false,    // default: false
  createPr: false       // default: false
}
```

### 2 — Apply worktree config

| `worktrees.create` | Action |
|---|---|
| `'always'` | Create `.worktrees/<featureName>` with branch `feature/<featureName>` |
| `'ask'` (default) | Ask the user before creating |
| `'never'` | Work in current branch |

`featureName` = kebab-case slug from the card/task name, max 40 chars. Command:

```bash
git worktree add .worktrees/<featureName> -b feature/<featureName>
```

**One session = one worktree.** Subagents never create new worktrees — they inherit the parent's `cwd`.

### 3 — Initialise lifecycle labels

Fetch the board's labels and build a name→ID map:

```json
{ "name": "jv_get_board_labels", "arguments": {} }
```

Check that all four lifecycle labels exist: `AI_READY`, `AI_WORKING`, `IN_REVIEW`, `BLOCKED`. For any that are missing, create them now using the default colors below:

| Label | Color |
|---|---|
| `AI_READY` | `lime` |
| `AI_WORKING` | `sky` |
| `IN_REVIEW` | `orange` |
| `BLOCKED` | `red` |

```json
{ "name": "jv_create_label", "arguments": { "name": "AI_WORKING", "color": "sky" } }
```

After creating, re-fetch labels and rebuild the map so all IDs are current. Store as `labelMap: Record<string, string>` (label name → label ID) for use throughout the session.

### 4 — Verify board prefix

Call `jv_list_board_prefixes` and check that a prefix is registered for the active board. If none is registered, ask the user for a prefix before proceeding — **do not create any cards without a prefix**.

```json
{ "name": "jv_list_board_prefixes", "arguments": {} }
```

Store the active board's prefix as `boardPrefix` for use in all `jv_add_card_to_list` calls this session.

### 5 — Cache mandatory columns

Call `jv_get_lists` and find the four mandatory columns by name (case-insensitive match):

```json
{ "name": "jv_get_lists", "arguments": {} }
```

Build a `listMap`:

| Key | Trello list name |
|---|---|
| `backlog` | Backlog |
| `inProgress` | In Progress |
| `blocked` | Blocked |
| `done` | Done |

If any mandatory list is missing, post a `[NOTE]` warning on the first card you work on and skip that column move silently. Never create lists automatically. Use other available columns (e.g. "Todo", "In Review") only when the user explicitly asks.

### 5 — Auto-commit and PR

| Flag | Behaviour |
|---|---|
| `autoCommit: true` | Commit after each logical unit of work |
| `autoCommit: false` | Never commit without explicit user instruction |
| `createPr: true` | Open a PR when all mutations are done |
| `createPr: false` | Never open a PR without explicit user instruction |

---

## Comment discipline

Leave a structured comment on every card you act on. Prefix every comment with a type tag.

| Tag | When |
|---|---|
| `[PLAN]` | Before starting — what steps you will take and why |
| `[DECISION]` | At the moment you make a non-trivial judgment call |
| `[RESULT]` | What was done, what changed, deliverable or answer |
| `[NOTE]` | Context: worktree path, session info, admin notes |
| `[QUESTION]` | User input needed — blocks progress |

**A diff with zero `[DECISION]` comments is a process failure.**

Format:

```
[PLAN]
## Goal
{what we're solving and why}
## Steps
1. …
## Non-goals
{what we're explicitly NOT doing}
```

```
[DECISION] {one-line: choice made and why}
```

```
[RESULT]
## Changes
- {what moved / updated / created}
## Follow-ups
- {deferred items or open questions}
```

`jv_add_comment` returns `{ id }` only — do not try to read the comment back.

---

## Card lifecycle

Every lifecycle event updates **both** the column and labels in one step. Use `listMap` (from session setup step 4) for column moves and `labelMap` (step 3) for label updates.

| Event | Column | Label: Remove | Label: Add |
|---|---|---|---|
| Agent picks up card | → `inProgress` | `AI_READY` | `AI_WORKING` |
| Agent posts `[PLAN]` | — | — | — |
| Agent finishes | → `done` | `AI_WORKING` | `IN_REVIEW` |
| Agent blocked | → `blocked` | — | `BLOCKED` |
| Agent unblocked / resumes | → `inProgress` | `BLOCKED`, `IN_REVIEW` | `AI_WORKING` |
| Human approves (review handoff) | — | `IN_REVIEW` | — |

The card ends in the `done` column with no lifecycle labels. `IN_REVIEW` signals that the agent finished but the human hasn't verified yet — the column is already Done.

Only use columns outside the mandatory four (`Backlog`, `In Progress`, `Blocked`, `Done`) when the user explicitly requests it.

**How to execute a lifecycle step:**

1. `jv_get_card` (lightweight) → current `labels[].id` + current `idList`
2. Compute new label set: remove outgoing IDs, add incoming IDs from `labelMap`
3. `jv_move_card(cardId, listMap.targetColumn)` — if column changes
4. `jv_update_card_details(cardId, { labels: [...] })` — if labels change

### Review handoff (human-triggered)

When the user says something like "reviewed", "approved", "looks good", or "I've reviewed it":

1. Remove `IN_REVIEW` label from the card (card stays in `done`)
2. Post `[NOTE] Review approved. Cleaning up worktree.` on the card
3. Remove the worktree: `git worktree remove .worktrees/<featureName>`

Do **not** remove the worktree at any other point — always wait for the review handoff signal.

---

## Tool selection

### Reading cards

| Goal | Tool | Notes |
|---|---|---|
| Resolve a short ID like `JVT-4` | `jv_find_card_by_short_id` | Fastest — single `/search` call |
| Search by name or text | `jv_search_cards` | Slim fields; no list fetch needed |
| Search by label | `jv_search_cards` with `query: "label:LABEL_NAME"` | e.g. `"label:AI_READY"` |
| Get my open cards | `jv_get_my_cards` | Defaults to open + slim fields |
| Quick lookup (no comments/checklists) | `jv_get_card` with `lightweight: true` | ~90% smaller payload |
| Full details (comments, checklists, attachments) | `jv_get_card` with `lightweight: false` | Use sparingly — large payload |

`jv_get_lists` returns `id` and `name` only by default. Pass `fields` if you need more.

### Mutation response shapes

Every mutation returns a minimal confirmation. Never read card state from a mutation — call `jv_get_card` if you need it.

| Tool | Returns |
|---|---|
| `jv_add_comment` | `{ id }` |
| `jv_move_card` | `{ id, idList }` |
| `jv_update_card_details` | `{ id }` |
| `jv_archive_card` | `{ id, closed: true }` |
| `jv_add_card_to_list` | `{ id, name, shortLink, url }` + `shortId` if `boardPrefix` was given |
| `jv_list_boards` | `[{ id, name, closed }]` |
| `jv_get_lists` | `[{ id, name }]` by default |

---

## Tool ordering rules

- **Before creating:** always `jv_search_cards` first to check for duplicates
- **Every card creation:** always pass `boardPrefix` — **creating a card without a short ID is an error**
- **Before moving or archiving:** always resolve the card (`jv_find_card_by_short_id` or `jv_search_cards`) first
- **Before moving:** always `jv_get_lists` to get the target list ID unless already cached this session

---

## Short ID system

**Every card created by an agent must have a short ID.** Always pass `boardPrefix` to `jv_add_card_to_list`. Never omit it. If the prefix isn't known, check `jv_list_board_prefixes` or ask the user — but do not skip it.

Cards get a human-readable ID like `JVT-4` appended to their name as `[JVT-4]` at creation time.

### First-time setup

```
1. jv_list_boards                    → board IDs + names
2. jv_setup_board_prefixes(mappings) → register prefix per board
3. jv_list_board_prefixes            → confirm the registry
```

Prefixes are stored as uppercase. Registered values persist to `~/.trello-mcp/config.json` and survive restarts. No restart needed after registering via a tool call.

### Create a card with a short ID

```json
{ "name": "jv_add_card_to_list", "arguments": { "listId": "list-id", "name": "Fix auth bug", "boardPrefix": "JVT" } }
```

Response: `{ id, name: "Fix auth bug [JVT-42]", shortLink, url, shortId: "JVT-42" }`.

The prefix does not need to be in the registry for creation — only for `jv_find_card_by_short_id` auto-resolve.

### Resolve a short ID

```json
{ "name": "jv_find_card_by_short_id", "arguments": { "shortId": "JVT-42" } }
```

`boardId` is auto-resolved from the registry. Falls back to all boards if the prefix isn't registered.

### Add a new board later

```json
{ "name": "jv_register_board_prefix", "arguments": { "prefix": "PROJ", "boardId": "boardId3" } }
```

---

## Efficient workflow patterns

### Triage: find and move a card

```
1. jv_find_card_by_short_id("JVT-4")   → card.id + card.idList
2. jv_get_lists()                       → target list id
3. jv_add_comment(card.id, "[PLAN]…")
4. jv_move_card(card.id, listId)        → { id, idList }
5. jv_add_comment(card.id, "[RESULT]…")
```

### Search by label

```json
{ "name": "jv_search_cards", "arguments": { "query": "label:AI_READY", "boardIds": ["board-id"], "limit": 20 } }
```

### Bulk comment loop

`jv_add_comment` costs ~200 tokens in + ~20 tokens out per call. At 300 req/10s the bottleneck is the API rate limit, not the payload.

### jv_get_my_cards

```json
{ "name": "jv_get_my_cards", "arguments": { "filter": "open", "fields": "name,idShort,idBoard,idList,labels,due,dueComplete" } }
```

`filter` options: `open` (default), `closed`, `all`, `visible`, `none`.
