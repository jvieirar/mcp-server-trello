---
name: trello-mcp-agent
description: Use when an agent needs to work with Trello boards via this MCP server. Covers which tools to prefer, how to configure the short ID system, and patterns for efficient multi-step Trello workflows.
---

# Trello MCP Agent Skill

Use this skill whenever you are operating against the Trello MCP server to ensure you pick the right tool variant and keep token usage low.

## Tool selection guide

### Reading cards

| Goal | Tool | Notes |
|------|------|-------|
| Resolve a short ID like "JVT-4" to a card | `find_card_by_short_id` | Fastest — hits `/search` with one call |
| Search cards by name/text | `search_cards` | Returns slim fields; no list fetch needed |
| Get my open cards | `get_my_cards` | Defaults to open + slim fields |
| Quick card lookup (no comments/checklists) | `get_card` with `lightweight: true` | ~90% smaller payload |
| Full card details (comments, checklists, attachments) | `get_card` with `lightweight: false` (default) | Use sparingly — large payload |

### Reading lists

`get_lists` returns `id` and `name` only by default. Pass `fields` if you need more.

### Mutating cards

Mutation tools return **minimal confirmations**, not full card objects:
- `add_comment` → `{ id }`
- `move_card` → `{ id, idList }`
- `update_card_details` → `{ id }`

Don't try to read updated card state from mutation responses — call `get_card` if you need it.

## Short ID system

Cards can be given human-readable IDs like `JVT-4` at creation time. These are appended to the card name as `[JVT-4]` and searchable.

### Prerequisites

Set the `BOARD_PREFIXES` env var in your MCP server config. Format:

```
BOARD_PREFIXES=JVT:boardId1,TATA:boardId2
```

`boardId` is the Trello board ID (e.g. from `list_boards`). `JVT` is the prefix you choose for that board.

### Creating a card with a short ID

```json
{
  "name": "add_card_to_list",
  "arguments": {
    "listId": "your-list-id",
    "name": "Fix auth bug",
    "boardPrefix": "JVT"
  }
}
```

Response includes `shortId: "JVT-42"` and the card name becomes `"Fix auth bug [JVT-42]"`.

### Resolving a short ID

```json
{
  "name": "find_card_by_short_id",
  "arguments": {
    "shortId": "JVT-42"
  }
}
```

If `BOARD_PREFIXES` is configured, `boardId` is auto-resolved from the prefix — you don't need to pass it.

### Manual boardId override

```json
{
  "name": "find_card_by_short_id",
  "arguments": {
    "shortId": "JVT-42",
    "boardId": "explicit-board-id"
  }
}
```

## Efficient workflow patterns

### Triage: find and move a card

```
1. find_card_by_short_id("JVT-4")       → get card.id + card.idList
2. get_lists()                           → get target list id
3. move_card(cardId, listId)             → confirm with { id, idList }
```

### Bulk comment loop

Call `add_comment` per card. Each call costs ~200 tokens in + ~20 tokens out (returns `{ id }` only). At 300 req/10s the bottleneck is the API rate limit, not the payload.

### Searching before creating

Always `search_cards` first to avoid duplicates:

```json
{
  "name": "search_cards",
  "arguments": {
    "query": "Fix auth bug",
    "boardIds": ["your-board-id"],
    "limit": 5
  }
}
```

## get_my_cards params

```json
{
  "name": "get_my_cards",
  "arguments": {
    "filter": "open",
    "fields": "name,idShort,idBoard,idList,labels,due,dueComplete"
  }
}
```

`filter` options: `open` (default), `closed`, `all`, `visible`, `none`.
`fields` is a comma-separated list of Trello card fields.
