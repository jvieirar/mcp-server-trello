---
name: jv-trello
description: Use when an agent needs to work with Trello boards via this MCP server. Covers which tools to prefer, how to configure the short ID system, and patterns for efficient multi-step Trello workflows.
---

# Trello MCP Agent Skill

Use this skill whenever you are operating against the Trello MCP server to ensure you pick the right tool variant and keep token usage low.

## Tool selection guide

### Reading cards

| Goal                                                  | Tool                                              | Notes                                     |
| ----------------------------------------------------- | ------------------------------------------------- | ----------------------------------------- |
| Resolve a short ID like "JVT-4" to a card             | `jv_find_card_by_short_id`                        | Fastest — hits `/search` with one call    |
| Search cards by name/text                             | `jv_search_cards`                                 | Returns slim fields; no list fetch needed |
| Get my open cards                                     | `jv_get_my_cards`                                 | Defaults to open + slim fields            |
| Quick card lookup (no comments/checklists)            | `jv_get_card` with `lightweight: true`            | ~90% smaller payload                      |
| Full card details (comments, checklists, attachments) | `jv_get_card` with `lightweight: false` (default) | Use sparingly — large payload             |

### Reading lists

`jv_get_lists` returns `id` and `name` only by default. Pass `fields` if you need more.

### Mutating cards

Mutation tools return **minimal confirmations**, not full card objects:

- `jv_add_comment` → `{ id }`
- `jv_move_card` → `{ id, idList }`
- `jv_update_card_details` → `{ id }`

Don't try to read updated card state from mutation responses — call `jv_get_card` if you need it.

## Short ID system

Cards can be given human-readable IDs like `JVT-4` at creation time. These are appended to the card name as `[JVT-4]` and are searchable.

### How the prefix registry works

The server maintains a `prefix → boardId` map in memory, persisted to `~/.trello-mcp/config.json`. It merges two sources at startup:

1. **`BOARD_PREFIXES` env var** (optional, for static bootstrap) — set once in your MCP JSON config
2. **Persisted registry** — written to disk whenever you call `jv_register_board_prefix` or `jv_setup_board_prefixes`

Env var values take precedence over the persisted file on conflict. Registered values survive restarts. **No server restart is needed** when you register a new prefix via a tool call — it takes effect immediately.

### First-time setup (recommended flow)

```
1. jv_list_boards                    → get all board IDs + names
2. jv_setup_board_prefixes(mappings) → register chosen prefix for each board
3. jv_list_board_prefixes            → confirm the registry
```

Example `jv_setup_board_prefixes` call:

```json
{
  "name": "jv_setup_board_prefixes",
  "arguments": {
    "mappings": [
      { "prefix": "JVT", "boardId": "boardId1" },
      { "prefix": "TATA", "boardId": "boardId2" }
    ]
  }
}
```

Prefixes are always stored as uppercase (`jvt` → `JVT`).

### Adding a new board later

```json
{
  "name": "jv_register_board_prefix",
  "arguments": {
    "prefix": "PROJ",
    "boardId": "boardId3"
  }
}
```

Takes effect immediately. No restart required.

### Checking current registry

```json
{ "name": "jv_list_board_prefixes", "arguments": {} }
```

Returns the full current map (env + persisted).

### Creating a card with a short ID

```json
{
  "name": "jv_add_card_to_list",
  "arguments": {
    "listId": "your-list-id",
    "name": "Fix auth bug",
    "boardPrefix": "JVT"
  }
}
```

Response includes `shortId: "JVT-42"` and the card name becomes `"Fix auth bug [JVT-42]"`. The prefix does **not** need to be in the registry for card creation — it's used as-is. The registry is only needed for `jv_find_card_by_short_id` auto-resolve.

### Resolving a short ID

```json
{
  "name": "jv_find_card_by_short_id",
  "arguments": {
    "shortId": "JVT-42"
  }
}
```

`boardId` is auto-resolved from the registry by extracting the prefix (`JVT` from `JVT-42`). If the prefix isn't registered, the search falls back to all boards — slower but still works.

### Manual boardId override

```json
{
  "name": "jv_find_card_by_short_id",
  "arguments": {
    "shortId": "JVT-42",
    "boardId": "explicit-board-id"
  }
}
```

## Efficient workflow patterns

### Triage: find and move a card

```
1. jv_find_card_by_short_id("JVT-4")       → get card.id + card.idList
2. jv_get_lists()                           → get target list id
3. jv_move_card(cardId, listId)             → confirm with { id, idList }
```

### Bulk comment loop

Call `jv_add_comment` per card. Each call costs ~200 tokens in + ~20 tokens out (returns `{ id }` only). At 300 req/10s the bottleneck is the API rate limit, not the payload.

### Searching before creating

Always `jv_search_cards` first to avoid duplicates:

```json
{
  "name": "jv_search_cards",
  "arguments": {
    "query": "Fix auth bug",
    "boardIds": ["your-board-id"],
    "limit": 5
  }
}
```

## jv_get_my_cards params

```json
{
  "name": "jv_get_my_cards",
  "arguments": {
    "filter": "open",
    "fields": "name,idShort,idBoard,idList,labels,due,dueComplete"
  }
}
```

`filter` options: `open` (default), `closed`, `all`, `visible`, `none`.
`fields` is a comma-separated list of Trello card fields.
