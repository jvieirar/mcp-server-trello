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

### 3 — Cache board labels

Immediately after reading board config, fetch the board's labels and build a name→ID map:

```json
{ "name": "jv_get_board_labels", "arguments": {} }
```

Store the result as `labelMap: Record<string, string>` (label name → label ID). You will use this map throughout the session to apply and remove labels without extra lookups.

### 4 — Auto-commit and PR

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

## Label lifecycle

Use the `labelMap` cached during session setup to apply and remove labels via `jv_update_card_details`. Pass the full intended label ID array — Trello replaces, not appends.

| Event | Remove | Add |
|---|---|---|
| Agent picks up card | `AI_READY` | `AI_WORKING` |
| Agent posts `[PLAN]` | — | — |
| Agent finishes | `AI_WORKING` | `IN_REVIEW` |
| Agent blocked | — | `BLOCKED` |
| Agent unblocked / resumes | `BLOCKED`, `IN_REVIEW` | `AI_WORKING` |

**How to update labels:**

1. Read current label IDs from `jv_get_card` (lightweight) — field `labels[].id`
2. Compute new set: remove outgoing IDs, add incoming IDs from `labelMap`
3. Call `jv_update_card_details` with `labels: [newId1, newId2, ...]`

If a label name isn't in `labelMap` (not created on the board yet), skip that label silently — never error.

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
- **Before moving or archiving:** always resolve the card (`jv_find_card_by_short_id` or `jv_search_cards`) first
- **Before moving:** always `jv_get_lists` to get the target list ID unless already cached this session

---

## Short ID system

Cards can be given human-readable IDs like `JVT-4` at creation time, appended as `[JVT-4]` to the card name.

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
