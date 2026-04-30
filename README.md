# MCP Server Trello

## Custom performance improvements

This fork adds response-size optimizations and new tools that significantly reduce token usage in agentic workflows. All changes are backwards-compatible — existing tool calls work without modification.

### What changed and why

During a 152-comment card migration job the original server was generating 3–5 KB per mutation call. Seven targeted changes cut that down:

| Change                            | Before                            | After                                        | Why                                            |
| --------------------------------- | --------------------------------- | -------------------------------------------- | ---------------------------------------------- |
| `jv_add_comment` response         | Full Trello action object (~4 KB) | `{ id }`                                     | Agent only needs confirmation                  |
| `jv_move_card` response           | Full card object                  | `{ id, idList }`                             | Agent only needs the new location              |
| `jv_update_card_details` response | Full card object                  | `{ id }`                                     | Agent only needs confirmation                  |
| `jv_get_my_cards`                 | All fields, all statuses          | Slim fields, open cards only (configurable)  | Dramatically smaller list responses            |
| `jv_get_lists`                    | All list fields                   | `id, name` only (configurable)               | Agents almost never need more                  |
| `jv_get_card`                     | Always fetches everything         | `lightweight` param for slim lookups         | Full mode still available when needed          |
| `jv_search_cards`                 | Did not exist                     | New tool hitting `/search` directly          | Find cards without fetching an entire list     |
| Short ID system                   | Did not exist                     | `[PREFIX-N]` suffix on card names + resolver | Human-readable card references across sessions |
| `jv_archive_card` response        | Full card object (~850 tokens)    | `{ id, closed: true }`                       | Agent only needs confirmation                  |

### Benchmark — `trello` vs `trello-jv`

Real-world session moving 9 cards across lists with comments and an archive step.

#### Session-level results

| Metric                   | `trello` (original) | `trello-jv` (optimized) | Delta    |
| ------------------------ | ------------------- | ----------------------- | -------- |
| **Total session tokens** | 30,216              | 20,886                  | **−31%** |
| **Duration**             | 102,029 ms          | 71,732 ms               | **−30%** |
| Trello API calls         | 9                   | 9                       | —        |

#### Per-call payload breakdown

| #   | Step               | `trello` tokens | `trello-jv` tokens | Reduction |
| --- | ------------------ | --------------- | ------------------ | --------- |
| 1   | `list_boards`      | ~8,500          | ~90                | **−99%**  |
| 2   | `get_lists`        | ~120            | ~30                | −75%      |
| 3   | `add_card_to_list` | ~950            | ~35                | **−96%**  |
| 4   | `add_comment`      | ~750            | ~10                | **−99%**  |
| 5   | `move_card`        | ~850            | ~15                | **−98%**  |
| 6   | `add_comment`      | ~750            | ~10                | **−99%**  |
| 7   | `move_card`        | ~850            | ~15                | **−98%**  |
| 8   | `add_comment`      | ~750            | ~10                | **−99%**  |
| 9   | `archive_card`     | ~850            | ~10                | **−99%**  |
|     | **Total**          | **~14,370**     | **~225**           | **−98%**  |

The dominant waste in the original server is `list_boards` alone — 59% of all output tokens from a single discovery call. Every mutation (add, move, comment, archive) returns a full card or action object even though the agent only needs to know "did it work?"

`trello-jv` shapes every response for agent consumers, not UI renders: mutations return confirmation fields only, discovery calls return identification fields only.

> **Note on duration:** the 30% wall-clock improvement reflects both leaner payloads and normal run-to-run variance. More runs would be needed to isolate the pure payload effect. The 98% payload reduction is structural and reproducible.

### Setup and prerequisites

**Required:**

- [Bun](https://bun.sh) v1.0+
- A Trello API key and token (see [Configuration](#configuration))

**For the short ID system** — the prefix registry is managed at runtime. No restart is ever needed.

**MCP config — with explicit env vars:**

```json
{
  "mcpServers": {
    "trello-jv": {
      "command": "bun",
      "args": [
        "run",
        "/Users/juanvieira/development/codebases/tools/mcp-server-trello/src/index.ts"
      ],
      "env": {
        "TRELLO_API_KEY": "your-api-key",
        "TRELLO_TOKEN": "your-token"
      }
    }
  }
}
```

```bash
claude mcp add trello-jv -e TRELLO_API_KEY=your-key -e TRELLO_TOKEN=your-token -- bun run /Users/juanvieira/development/codebases/tools/mcp-server-trello/src/index.ts
```

Note: server name must come before `-e` flags.

**Optional: seed prefixes from the env var** (useful for CI/scripted setups):

```json
"BOARD_PREFIXES": "JVT:boardId1,TATA:boardId2"
```

Env var values are merged with the persisted registry at startup. Env wins on conflict.

### After installation — board prefix setup

Once the MCP server is connected, run these three tool calls in Claude to map your boards to short prefixes:

**Step 1 — List your boards to get their IDs:**

```json
{ "name": "jv_list_boards", "arguments": {} }
```

**Step 2 — Register your chosen prefixes:**

```json
{
  "name": "jv_setup_board_prefixes",
  "arguments": {
    "mappings": [
      { "prefix": "JVT", "boardId": "<id from step 1>" },
      { "prefix": "TATA", "boardId": "<id from step 1>" }
    ]
  }
}
```

**Step 3 — Confirm the registry:**

```json
{ "name": "jv_list_board_prefixes", "arguments": {} }
```

Registered prefixes are written to `~/.trello-mcp/config.json` and survive restarts. To add a new board later, one call is enough — no config file edit, no restart:

```json
{
  "name": "jv_register_board_prefix",
  "arguments": { "prefix": "PROJ", "boardId": "your-board-id" }
}
```

### Agent skill

A Claude Code agent skill is included at [`skills/jv-trello/SKILL.md`](skills/jv-trello/SKILL.md). When active, it governs the agent's full workflow: how it reads board configuration, sets up worktrees, selects tools, and leaves structured comments on cards.

Install the skill once:

```sh
# Claude Code
cp -r ./skills/jv-trello ~/.claude/skills/

# Other agents (generic path)
cp -r ./skills/jv-trello ~/.agents/skills/
```

---

### How the agent works

#### Agent state machine

```mermaid
stateDiagram-v2
    [*] --> Setup
    Setup --> Discovery : board config parsed
    Discovery --> Planning : cards / lists fetched
    Planning --> Mutation : [PLAN] comment posted on card
    Mutation --> Mutation : more mutations remain
    Mutation --> Done : all mutations complete
    Done --> [*]

    Setup : Read jv_get_active_board_info Parse board desc config Set up worktree if needed
    Discovery : jv_search_cards / jv_get_lists jv_find_card_by_short_id
    Planning : Decide steps Post [PLAN] comment
    Mutation : jv_move_card / jv_add_comment jv_archive_card / jv_update_card_details
    Done : Post [RESULT] / [NOTE] Commit if autoCommit = true
```

#### Board config (in the board's Description field)

The agent reads the board's `desc` field at session start and applies the config it finds there. Add this JSON block to the **Description** field of your Trello board to configure behaviour:

```js
{
  worktrees: {
    create: 'always',   // 'always' | 'ask' | 'never'
    path: '.worktrees',
    format: `${path}/${featureName}`,
    branchFormat: `feature/${featureName}`
  },
  autoCommit: false,
  createPr: false
}
```

If no config is found the agent defaults to `create: 'ask'`, `autoCommit: false`, `createPr: false`.

**Worktree decision:**

```mermaid
flowchart TD
    A[Read board desc] --> B{Config present?}
    B -- no --> C[Default: ask user]
    B -- yes --> D{worktrees.create}
    D -- always --> E[git worktree add .worktrees/featureName -b feature/featureName]
    D -- ask --> F[Ask user before creating]
    D -- never --> G[Work in current branch]
    C --> F
```

One session = one worktree. Subagents always inherit the parent's `cwd` and never create their own.

#### Comment discipline

The agent leaves structured comments on cards throughout its work. Every comment is prefixed with a type tag so you always know what the agent is doing and why.

| Tag          | When the agent posts it                                                       |
| ------------ | ----------------------------------------------------------------------------- |
| `[PLAN]`     | Before starting — the steps it will take and what it is explicitly not doing  |
| `[DECISION]` | At the moment it makes a non-trivial judgment call                            |
| `[RESULT]`   | After finishing — what changed, what files were touched, any follow-ups       |
| `[NOTE]`     | Context that isn't a plan or result: worktree path, session info, admin notes |
| `[QUESTION]` | When it needs user input to continue                                          |

Example `[RESULT]` comment on a card:

```
[RESULT]
## Changes
- Moved card from "In Progress" to "Done"
- Added label "REVIEWED"
## Follow-ups
- PR link once branch is pushed
```

#### Mutation response shapes

Every mutation tool returns a minimal confirmation — the agent never reads card state back from a mutation response. If it needs the updated card, it calls `jv_get_card` separately.

| Tool                     | Returns                                  |
| ------------------------ | ---------------------------------------- |
| `jv_add_comment`         | `{ id }`                                 |
| `jv_move_card`           | `{ id, idList }`                         |
| `jv_update_card_details` | `{ id }`                                 |
| `jv_archive_card`        | `{ id, closed: true }`                   |
| `jv_add_card_to_list`    | `{ id, name, shortLink, url, shortId? }` |
| `jv_list_boards`         | `[{ id, name, closed }]`                 |
| `jv_get_lists`           | `[{ id, name }]` by default              |

#### Tool ordering rules

```mermaid
flowchart LR
    A[User intent] --> B{Creating?}
    B -- yes --> C[jv_search_cards check duplicates]
    C --> D[jv_add_card_to_list]
    B -- no --> E{Moving?}
    E -- yes --> F[jv_find_card_by_short_id or jv_search_cards]
    F --> G[jv_get_lists]
    G --> H[jv_move_card]
    E -- no --> I{Archiving?}
    I -- yes --> J[jv_find_card_by_short_id]
    J --> K[jv_archive_card]
```

#### Labels — lifecycle and search

The agent manages four labels automatically. **You don't need to create them manually** — the agent creates any missing lifecycle labels during session setup.

| Label | Set by | Color | Meaning |
|---|---|---|---|
| `AI_READY` | Human | lime | Card has enough context for the agent to act without asking questions |
| `AI_WORKING` | Agent | sky | Agent is actively working on this card |
| `IN_REVIEW` | Agent | orange | Agent finished — waiting for human review |
| `BLOCKED` | Agent | red | Hard external blocker (third party, missing credential, infra issue) |

**Lifecycle — columns and labels move together:**

| Event | Column | Label: Remove | Label: Add |
|---|---|---|---|
| Agent picks up card | → In Progress | `AI_READY` | `AI_WORKING` |
| Agent finishes | → Done | `AI_WORKING` | `IN_REVIEW` |
| Agent blocked | → Blocked | — | `BLOCKED` |
| Agent unblocked / resumes | → In Progress | `BLOCKED`, `IN_REVIEW` | `AI_WORKING` |
| Human approves | — (stays in Done) | `IN_REVIEW` | — |

The card ends in Done with no lifecycle labels. `IN_REVIEW` is the signal that the agent finished but you haven't verified yet — the column is already Done.

All boards are expected to have at minimum: **Backlog, In Progress, Blocked, Done**. The agent only moves cards to other columns (e.g. "Todo", "In Review") if you explicitly ask for it.

**Review handoff — how to close the loop:**

When you're happy with the agent's work, tell it "reviewed", "approved", or "looks good". The agent will:
1. Remove the `IN_REVIEW` label (card stays in Done)
2. Post a `[NOTE]` confirming cleanup
3. Run `git worktree remove .worktrees/<featureName>`

The worktree is never deleted automatically — it always waits for your review signal.

You can also use any custom labels for filtering — tag cards `URGENT` or `Q2` and ask the agent to work only on those.

Find everything ready for the agent:

```json
{ "name": "jv_search_cards", "arguments": { "query": "label:AI_READY", "boardIds": ["your-board-id"], "limit": 20 } }
```

#### Short ID system

Cards can be given human-readable IDs like `JVT-4` at creation time. The ID is appended to the card name as `[JVT-4]` and is searchable. See [After installation — board prefix setup](#after-installation--board-prefix-setup) for the first-time setup flow.

Quick reference:

```json
// Create a card with a short ID (name becomes "Fix auth bug [JVT-42]")
{ "name": "jv_add_card_to_list", "arguments": { "listId": "list-id", "name": "Fix auth bug", "boardPrefix": "JVT" } }

// Resolve a short ID to a card (boardId auto-resolved from registry)
{ "name": "jv_find_card_by_short_id", "arguments": { "shortId": "JVT-42" } }

// Search by label
{ "name": "jv_search_cards", "arguments": { "query": "label:AI_READY", "limit": 20 } }

// Lightweight card lookup (no comments/checklists — ~90% smaller payload)
{ "name": "jv_get_card", "arguments": { "cardId": "abc123", "lightweight": true } }

// Slim open cards assigned to me
{ "name": "jv_get_my_cards", "arguments": { "filter": "open", "fields": "name,idShort,idList,labels,due" } }
```

---

[![Verified on MseeP](https://mseep.ai/badge.svg)](https://mseep.ai/app/27359682-7632-4ba7-981d-7dfecadf1c4b)
[![MCP Registry](https://img.shields.io/badge/MCP-Registry-blue)](https://registry.modelcontextprotocol.io/servers/io.github.delorenj/mcp-server-trello)
[![npm version](https://badge.fury.io/js/%40delorenj%2Fmcp-server-trello.svg)](https://badge.fury.io/js/%40delorenj%2Fmcp-server-trello)

<a href="https://glama.ai/mcp/servers/klqkamy7wt"><img width="380" height="200" src="https://glama.ai/mcp/servers/klqkamy7wt/badge" alt="Server Trello MCP server" /></a>

A Model Context Protocol (MCP) server that provides tools for interacting with Trello boards. This server enables seamless integration with Trello's API while handling rate limiting, type safety, and error handling automatically.

## 🎉 New in v1.5.0: Now Powered by Bun! ⚡

**This project is now powered by Bun!** 🚀 We've migrated the entire project to the Bun runtime, resulting in a 2.8-4.4x performance boost. All existing `npx`, `pnpx`, and `npm` commands will **continue to work perfectly**.

### ✨ New in This Release:

- 🚀 **Performance Boost**: Enjoy a faster, more responsive server.
- BUN **Bun-Powered**: The project now runs on the lightning-fast Bun runtime.
- 📖 **Comprehensive Examples**: A new `examples` directory with detailed implementations in JavaScript, Python, and TypeScript.

**Plus:** Modern MCP SDK architecture, enhanced type safety, and comprehensive documentation!

## Changelog

For a detailed list of changes, please refer to the [CHANGELOG.md](CHANGELOG.md) file.

## Features

- **Full Trello Board Integration**: Interact with cards, lists, and board activities
- **🆕 Complete Card Data Extraction**: Fetch all card details including checklists, attachments, labels, members, and comments
- **💬 Comment Management**: Add, update, delete, and retrieve comments on cards
- **File Attachments**: Attach any type of file to cards (PDFs, documents, videos, images, etc.) from URLs
- **Built-in Rate Limiting**: Respects Trello's API limits (300 requests/10s per API key, 100 requests/10s per token)
- **Type-Safe Implementation**: Written in TypeScript with comprehensive type definitions
- **Input Validation**: Robust validation for all API inputs
- **Error Handling**: Graceful error handling with informative messages
- **Dynamic Board Selection**: Switch between boards and workspaces without restarting
- **Markdown Formatting**: Export card data in human-readable markdown format

## Installation

### 🚀 Install from MCP Registry (Recommended)

The MCP Server Trello is now available in the official MCP Registry\! MCP clients can automatically discover and install this server.

For clients that support the MCP Registry:

1.  Search for "mcp-server-trello" or "io.github.delorenj/mcp-server-trello"
2.  Install directly from the registry
3.  Configure with your Trello credentials

### 🚀 Quick Start with Bun (Fastest)

If you have [Bun](https://bun.sh) installed, using `bunx` is the fastest way to run the server:

```json
{
  "mcpServers": {
    "trello": {
      "command": "bunx",
      "args": ["@delorenj/mcp-server-trello"],
      "env": {
        "TRELLO_API_KEY": "your-api-key",
        "TRELLO_TOKEN": "your-token"
      }
    }
  }
}
```

### Quick Start with npx / pnpx / bunx

You can still use `npx` or `pnpx`. This doesn't require a global install and will work just fine, though `bunx` (above) is faster.

```json
{
  "mcpServers": {
    "trello": {
      "command": "bunx",
      "args": ["@delorenj/mcp-server-trello"],
      "env": {
        "TRELLO_API_KEY": "your-api-key",
        "TRELLO_TOKEN": "your-token"
      }
    }
  }
}
```

Or if you're using mise, you can explicitly execute `bunx` with `mise exec`:

```json
{
  "mcpServers": {
    "trello": {
      "command": "mise",
      "args": ["x", "--", "bunx", "@delorenj/mcp-server-trello"],
      "env": {
        "TRELLO_API_KEY": "your-api-key",
        "TRELLO_TOKEN": "your-token"
      }
    }
  }
}
```

To connect a Trello workspace, you'll need to manually retrieve a `TRELLO_TOKEN` once per workspace. After setting up your Trello Power-Up, visit the following URL:

```
https://trello.com/1/authorize?expiration=never&name=YOUR_APP_NAME&scope=read,write&response_type=token&key=YOUR_API_KEY
```

Replace:

- `YOUR_APP_NAME` with a name for your application (e.g., "My Trello Integration"). This name is shown to the user on the Trello authorization screen.
- `YOUR_API_KEY` with the API key for your Trello Power-Up

This will generate the token required for integration.

> [\!NOTE]
> The `expiration=never` parameter creates a token that does not expire. For enhanced security, consider using `expiration=30days` and renewing the token periodically if your setup allows for it.

#### Don't have Bun?

The simplest way to get `bun` (and thus `bunx`) is through [mise](https://mise.jdx.dev/):

```bash
# Install mise (if you don't have it)
curl https://mise.run | sh

# Install bun and make the @latest version your system default
mise use bun@latest -g

# Or just run `mise install` from the project directory to install Bun locally
cd /path/to/mcp-server-trello
mise install
```

### Installing via npm

If you prefer using `npm` directly:

```bash
npm install -g @delorenj/mcp-server-trello
```

_(A fast alternative is `bun add -g @delorenj/mcp-server-trello`)_

Then use `npx mcp-server-trello` as the command in your MCP configuration.

### Installing via Smithery

To install Trello Server for Claude Desktop automatically via [Smithery](https://smithery.ai/server/@delorenj/mcp-server-trello):

```bash
# Using bunx (recommended)
bunx -y @smithery/cli install @delorenj/mcp-server-trello --client claude

# Using npx
npx -y @smithery/cli install @delorenj/mcp-server-trello --client claude
```

### Docker Installation

For containerized environments:

1.  Clone the repository:

<!-- end list -->

```bash
git clone https://github.com/delorenj/mcp-server-trello
cd mcp-server-trello
```

2.  Copy the environment template and fill in your Trello credentials:

<!-- end list -->

```bash
cp .env.template .env
```

3.  Build and run with Docker Compose:

<!-- end list -->

```bash
docker compose up --build
```

## Configuration

### Environment Variables

The server can be configured using environment variables. Create a `.env` file in the root directory with the following variables:

```env
# Required: Your Trello API credentials
TRELLO_API_KEY=your-api-key
TRELLO_TOKEN=your-token

# Optional (Deprecated): Default board ID (can be changed later using set_active_board)
TRELLO_BOARD_ID=your-board-id

# Optional: Initial workspace ID (can be changed later using set_active_workspace)
TRELLO_WORKSPACE_ID=your-workspace-id

# Optional: HTTPS proxy URL (for corporate proxies or restricted networks)
https_proxy=http://your-proxy:8080
```

> **Proxy Support:** If you're behind a corporate proxy or in an environment that routes traffic through a proxy, set the `https_proxy` or `HTTPS_PROXY` environment variable. The server will automatically route all Trello API requests through the specified proxy.

You can get these values from:

- API Key: [https://trello.com/app-key](https://trello.com/app-key)
- Token: Generate using your API key
- Board ID (optional, deprecated): Found in the board URL (e.g., [suspicious link removed])
- Workspace ID: Found in workspace settings or using `list_workspaces` tool

### Board and Workspace Management

Starting with version 0.3.0, the MCP server supports multiple ways to work with boards:

1.  **Multi-board support**: All methods now accept an optional `boardId` parameter
       - Omit `TRELLO_BOARD_ID` and provide `boardId` in each API call
       - Set `TRELLO_BOARD_ID` as default and optionally override with `boardId` parameter

2.  **Dynamic board selection**: Use workspace management tools
       - The `TRELLO_BOARD_ID` in your `.env` file is used as the initial/default board ID
       - You can change the active board at any time using the `set_active_board` tool
       - The selected board persists between server restarts (stored in `~/.trello-mcp/config.json`)
       - Similarly, you can set and persist an active workspace using `set_active_workspace`

This allows you to work with multiple boards and workspaces without restarting the server.

#### Example Workflow

1.  Start by listing available boards:

<!-- end list -->

```typescript
{
  name: 'list_boards',
  arguments: {}
}
```

2.  Set your active board:

<!-- end list -->

```typescript
{
  name: 'set_active_board',
  arguments: {
    boardId: "abc123"  // ID from list_boards response
  }
}
```

3.  List workspaces if needed:

<!-- end list -->

```typescript
{
  name: 'list_workspaces',
  arguments: {}
}
```

4.  Set active workspace if needed:

<!-- end list -->

```typescript
{
  name: 'set_active_workspace',
  arguments: {
    workspaceId: "xyz789"  // ID from list_workspaces response
  }
}
```

5.  Check current active board info:

<!-- end list -->

```typescript
{
  name: 'get_active_board_info',
  arguments: {}
}
```

## Date Format Guidelines

When working with dates in the Trello MCP server, please note the different format requirements:

- **Due Date (`dueDate`)**: Accepts full ISO 8601 format with time (e.g., `2023-12-31T12:00:00Z`)
- **Start Date (`start`)**: Accepts date only in YYYY-MM-DD format (e.g., `2025-08-05`)

This distinction follows Trello's API conventions where start dates are day-based markers while due dates can include specific times.

## Available Tools

### Checklist Management Tools 🆕

#### get_checklist_items

Get all items from a checklist by name.

```typescript
{
  name: 'get_checklist_items',
  arguments: {
    name: string,        // Name of the checklist to retrieve items from
    boardId?: string     // Optional: ID of the board (uses default if not provided)
  }
}
```

#### add_checklist_item

Add a new item to an existing checklist.

```typescript
{
  name: 'add_checklist_item',
  arguments: {
    text: string,           // Text content of the checklist item
    checkListName: string,  // Name of the checklist to add the item to
    boardId?: string        // Optional: ID of the board (uses default if not provided)
  }
}
```

#### find_checklist_items_by_description

Search for checklist items containing specific text.

```typescript
{
nbsp; name: 'find_checklist_items_by_description',
  arguments: {
    description: string,  // Text to search for in checklist item descriptions
    boardId?: string      // Optional: ID of the board (uses default if not provided)
nbsp; }
}
```

#### get_acceptance_criteria

Get all items from the "Acceptance Criteria" checklist.

```typescript
{
  name: 'get_acceptance_criteria',
  arguments: {
    boardId?: string  // Optional: ID of the board (uses default if not provided)
  }
}
```

#### get_checklist_by_name

Get a complete checklist with all items and completion percentage.

```typescript
{
  name: 'get_checklist_by_name',
  arguments: {
    name: string,     // Name of the checklist to retrieve
    boardId?: string  // Optional: ID of the board (uses default if not provided)
  }
}
```

**Returns:** `CheckList` object with:

- `id`: Checklist identifier
- `name`: Checklist name
- `items`: Array of `CheckListItem` objects
- `percentComplete`: Completion percentage (0-100)

#### update_checklist_item

Update an existing checklist item.

```typescript
{
  name: 'update_checklist_item',
  arguments: {
    cardId: string,                          // ID of the card containing the checklist item
    checkItemId: string,                     // ID of the checklist item to update
    name?: string,                           // Optional: new checklist item text
    state?: 'complete' | 'incomplete',       // Optional: new checklist item state
    pos?: number | 'top' | 'bottom',         // Optional: new checklist item position
    due?: string | null,                     // Optional: ISO 8601 due date, or null to clear it
    dueReminder?: number | null,             // Optional: reminder offset in minutes, or null to clear it
    idMember?: string | null                 // Optional: member ID to assign, or null to clear it
  }
}
```

#### delete_checklist_item

Delete an existing checklist item.

```typescript
{
  name: 'delete_checklist_item',
  arguments: {
    cardId: string,       // ID of the card containing the checklist item
    checkItemId: string   // ID of the checklist item to delete
  }
}
```

### get_card 🆕

Get comprehensive details of a specific Trello card with human-level parity.

```typescript
{
  name: 'get_card',
  arguments: {
    cardId: string,          // ID of the Trello card (short ID like 'FdhbArbK' or full ID)
    includeMarkdown?: boolean // Return formatted markdown instead of JSON (default: false)
  }
}
```

**Returns:** Complete card data including:

- ✅ Checklists with item states and assignments
- 📎 Attachments with previews and metadata
- 🏷️ Labels with names and colors
- 👥 Assigned members
- 💬 Comments and activity
- 📊 Statistics (badges)
- 🎨 Cover images
- 📍 Board and list context

### get_cards_by_list_id

Fetch all cards from a specific list.

```typescript
{
  name: 'get_cards_by_list_id',
  arguments: {
    boardId?: string, // Optional: ID of the board (uses default if not provided)
    listId: string    // ID of the Trello list
  }
}
```

### get_lists

Retrieve all lists from a board.

```typescript
{
  name: 'get_lists',
  arguments: {
    boardId?: string  // Optional: ID of the board (uses default if not provided)
  }
}
```

### get_recent_activity

Fetch recent activity on a board.

```typescript
{
  name: 'get_recent_activity',
  arguments: {
    boardId?: string, // Optional: ID of the board (uses default if not provided)
    limit?: number    // Optional: Number of activities to fetch (default: 10)
  }
}
```

### add_card_to_list

Add a new card to a specified list.

```typescript
{
  name: 'add_card_to_list',
  arguments: {
    boardId?: string,     // Optional: ID of the board (uses default if not provided)
    listId: string,       // ID of the list to add the card to
    name: string,         // Name of the card
    description?: string, // Optional: Description of the card
  mbs; dueDate?: string,     // Optional: Due date (ISO 8601 format with time)
    start?: string,       // Optional: Start date (YYYY-MM-DD format, date only)
    labels?: string[]     // Optional: Array of label IDs
  }
}
```

### update_card_details

Update an existing card's details.

```typescript
{
  name: 'update_card_details',
  arguments: {
    boardId?: string,     // Optional: ID of the board (uses default if not provided)
    cardId: string,       // ID of the card to update
    name?: string,        // Optional: New name for the card
    description?: string, // Optional: New description
    dueDate?: string,     // Optional: New due date (ISO 8601 format with time)
    start?: string,       // Optional: New start date (YYYY-MM-DD format, date only)
    dueComplete?: boolean,// Optional: Mark the due date as complete (true) or incomplete (false)
    labels?: string[]     // Optional: New array of label IDs
  }
}
```

### archive_card

Send a card to the archive.

```typescript
{
  name: 'archive_card',
  arguments: {
    boardId?: string, // Optional: ID of the board (uses default if not provided)
    cardId: string    // ID of the card to archive
  }
}
```

### add_list_to_board

Add a new list to a board.

```typescript
{
nbsp; name: 'add_list_to_board',
  arguments: {
    boardId?: string, // Optional: ID of the board (uses default if not provided)
    name: string      // Name of the new list
  }
}
```

### archive_list

Send a list to the archive.

```typescript
{
  name: 'archive_list',
  arguments: {
    boardId?: string, // Optional: ID of the board (uses default if not provided)
    listId: string    // ID of the list to archive
  }
}
```

### update_list_position

Update the position of a list on the board. Trello uses fractional indexing: each list has a float position, and to place a list between two others, use the average of their positions (e.g., between pos 1024 and 2048, use 1536). Use `"top"`/`"bottom"` shortcuts to move to the edges.

```typescript
{
  name: 'update_list_position',
  arguments: {
    listId: string,              // ID of the list to reposition
    position: string             // "top", "bottom", or a positive numeric string (e.g. "1536")
  }
}
```

### get_my_cards

Fetch all cards assigned to the current user.

```typescript
{
  name: 'get_my_cards',
  arguments: {}
}
```

### move_card

Move a card to a different list.

```typescript
{
  name: 'move_card',
  arguments: {
    boardId?: string,  // Optional: ID of the target board (uses default if not provided)
s;   cardId: string,    // ID of the card to move
    listId: string     // ID of the target list
  }
}
```

### attach_image_to_card

Attach an image to a card directly from a URL.

```typescript
{
  name: 'attach_image_to_card',
  arguments: {
    boardId?: string, // Optional: ID of the board (uses default if not provided)
    cardId: string,  nbsp; // ID of the card to attach the image to
    imageUrl: string, // URL of the image to attach
    name?: string     // Optional: Name for the attachment (defaults to "Image Attachment")
  }
}
```

### attach_file_to_card

Attach any type of file to a card from a URL or a local file path (e.g., `file:///path/to/your/file.pdf`).

```typescript
{
  name: 'attach_file_to_card',
nbsp; arguments: {
    boardId?: string,  // Optional: ID of the board (uses default if not provided)
    cardId: string,s;   // ID of the card to attach the file to
    fileUrl: string,   // URL or local file path (using the file:// protocol) of the file to attach
    name?: string,     // Optional: Name for the attachment (defaults to the file name for local files)
    mimeType?: string  // Optional: MIME type (e.g., "application/pdf", "text/plain", "video/mp4")
  }
}
```

### Comment Management Tools

#### add_comment

Add a comment to a Trello card.

```typescript
{
  name: 'add_comment',
  arguments: {
    cardId: string,  // ID of the card to comment on
    text: string     // The text of the comment to add
  }
}
```

#### update_comment

Update an existing comment on a card.

```typescript
{
  name: 'update_comment',
  arguments: {
    commentId: string,  // ID of the comment to change
    text: string        // The new text of the comment
  }
}
```

#### delete_comment

Delete a comment from a card.

```typescript
{
  name: 'delete_comment',
  arguments: {
    commentId: string  // ID of the comment to delete
  }
}
```

#### get_card_comments

Retrieve all comments from a specific card without fetching all card data.

```typescript
{
  name: 'get_card_comments',
  arguments: {
    cardId: string,  // ID of the card to get comments from
    limit?: number   // Optional: Maximum number of comments to retrieve (default: 100)
  }
}
```

### list_boards

List all boards the user has access to.

```typescript
{
  name: 'list_boards',
  arguments: {}
}
```

### set_active_board

Set the active board for future operations.

```typescript
{
  name: 'set_active_board',
  arguments: {
    boardId: string  // ID of the board to set as active
  }
}
```

### list_workspaces

List all workspaces the user has access to.

```typescript
{
s; name: 'list_workspaces',
  arguments: {}
}
```

### set_active_workspace

Set the active workspace for future operations.

```typescript
{
  name: 'set_active_workspace',
  arguments: {
    workspaceId: string  // ID of the workspace to set as active
  }
}
```

### list_boards_in_workspace

List all boards in a specific workspace.

```typescript
{
  name: 'list_boards_in_workspace',
  arguments: {
    workspaceId: string  // ID of the workspace to list boards from
  }
}
```

### get_active_board_info

Get information about the currently active board.

```typescript
{
s; name: 'get_active_board_info',
  arguments: {}
}
```

## Integration Examples

### 🎨 Pairing with Ideogram MCP Server

The Trello MCP server pairs beautifully with [@flowluap/ideogram-mcp-server](https://github.com/flowluap/ideogram-mcp-server) for AI-powered visual content creation. Generate images with Ideogram and attach them directly to your Trello cards\!

#### Example Workflow

1.  **Generate an image with Ideogram:**

<!-- end list -->

```typescript
// Using ideogram-mcp-server
{
  name: 'generate_image',
  arguments: {
    prompt: "A futuristic dashboard design with neon accents",
    aspect_ratio: "16:9"
  }
}
// Returns: { image_url: "https://..." }
```

2.  **Attach the generated image to a Trello card:**

<!-- end list -->

```typescript
// Using trello-mcp-server
{
  name: 'attach_image_to_card',
  arguments: {
    cardId: "your-card-id",
    imageUrl: "https://...", // URL from Ideogram
    name: "Dashboard Mockup v1"
  }
}
```

#### Setting up both servers

Add both servers to your Claude Desktop configuration. Use `bunx` for the fastest startup.

```json
{
  "mcpServers": {
    "trello": {
      "command": "bunx",
      "args": ["@delorenj/mcp-server-trello"],
nbsp;   "env": {
        "TRELLO_API_KEY": "your-trello-api-key",
        "TRELLO_TOKEN": "your-trello-token"
      }
    },
    "ideogram": {
      "command": "bunx",
      "args": ["@flowluap/ideogram-mcp-server"],
      "env": {
        "IDEOGRAM_API_KEY": "your-ideogram-api-key"
      }
    }
  }
}
```

Now you can seamlessly create visual content and organize it in Trello, all within Claude\!

## Rate Limiting

The server implements a token bucket algorithm for rate limiting to comply with Trello's API limits:

- 300 requests per 10 seconds per API key
- 100 requests per 10 seconds per token

Rate limiting is handled automatically, and requests will be queued if limits are reached.

## Error Handling

The server provides detailed error messages for various scenarios:

- Invalid input parameters
- Rate limit exceeded
- API authentication errors
- Network issues
- Invalid board/list/card IDs

## Development

### Prerequisites

- [Bun](https://bun.sh) (v1.0.0 or higher)

### Setup

1.  Clone the repository

<!-- end list -->

```bash
git clone https://github.com/delorenj/mcp-server-trello
cd mcp-server-trello
```

2.  Install dependencies

<!-- end list -->

```bash
bun install
```

3.  Build the project

<!-- end list -->

```bash
bun run build
```

## Running tests

To run the tests, run the following command:

```bash
bun test
```

## Running evals

The evals package loads an mcp client that then runs the index.ts file, so there is no need to rebuild between tests. You can load environment variables by prefixing the `bunx` command. Full documentation can be found [here](https://www.mcpevals.io/docs).

```bash
OPENAI_API_KEY=your-key bunx mcp-eval src/evals/evals.ts src/index.ts
```

## Contributing

Contributions are welcome\!

## License

This project is licensed under the MIT License - see the [LICENSE](https://www.google.com/search?q=LICENSE) file for details.

## Acknowledgments

- Built with the [Model Context Protocol SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- Uses the [Trello REST API](https://developer.atlassian.com/cloud/trello/rest/)
