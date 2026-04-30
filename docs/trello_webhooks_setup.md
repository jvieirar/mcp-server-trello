# Trello Webhooks Setup

Trello webhooks push events to your machine in real time — no polling needed. A single **member-level** webhook covers all your boards.

---

## Client Setup (MCP registration)

Register the MCP server with your AI client before configuring webhooks.

### Gemini CLI

Gemini CLI stores MCP servers in `~/.gemini/settings.json`. Run the setup script (reads credentials from `.env` / `.env.local`):

```bash
bun scripts/setup-mcp-client.ts --gemini
```

Or the equivalent one-liner (replace values):

```bash
gemini mcp add jv-trello bun \
  --scope user \
  -e TRELLO_API_KEY=YOUR_KEY \
  -e TRELLO_TOKEN=YOUR_TOKEN \
  run /path/to/mcp-server-trello/src/index.ts
```

Restart Gemini CLI and run `/mcp` to verify the server appears.

> **Note:** `gemini mcp list` may show no output even when servers are configured — this appears to be a display bug. Check `~/.gemini/settings.json` directly to confirm the entry is there.

### Claude Code

Credentials go in `~/.claude/settings.json` (env block). The MCP server itself is added via Claude Desktop's settings GUI (`Settings → Developer → Edit Config`).

```bash
bun scripts/setup-mcp-client.ts --claude-code
```

Claude Desktop config entry (add to `mcpServers` block):

```json
"jv-trello": {
  "command": "bun",
  "args": ["run", "/path/to/mcp-server-trello/src/index.ts"]
}
```

### Both at once

```bash
bun scripts/setup-mcp-client.ts --all
```

---

## Prerequisites (webhooks)

- Trello API key and token (same ones used by the MCP server)
- A publicly reachable HTTPS URL pointing to port `8899` on your machine
  - Recommended: [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) (free, no account limits)
  - The webhook server is built into the MCP server — it starts automatically on port `8899`

---

## 1. Expose port 8899 publicly

Install and start Tailscale:

```bash
brew install --formula tailscale
sudo brew services start tailscale
sudo tailscale up
```

In the [Tailscale admin panel](https://login.tailscale.com/admin/dns):
- Enable **MagicDNS**
- Enable **HTTPS**

Then start the funnel:

```bash
sudo tailscale funnel --bg 8899
tailscale funnel status   # confirm it's active
```

Your public URL will be something like:
```
https://<your-machine>.tail6b8168.ts.net
```

Verify it responds before registering (with the MCP server running):

```bash
curl -I https://<your-machine>.tail6b8168.ts.net/webhook
# Expect: HTTP/2 200
```

> **The MCP server must be running** for that `200` to come back. Trello verifies the URL before accepting the registration — if the server is down you'll get a `502` and registration will fail.

---

## 2. Configure .env

Copy `example.env` to `.env` (or `.env.local`) and fill in:

```env
TRELLO_API_KEY=your-api-key
TRELLO_TOKEN=your-token

# Webhook
WEBHOOK_URL=https://<your-machine>.tail6b8168.ts.net/webhook
TRELLO_MEMBER_ID=          # optional — leave blank to auto-fetch on first run
WEBHOOK_PORT=8899          # default, change if needed
```

---

## 3. Start the MCP server

The webhook HTTP server runs on port `8899` as part of the MCP server process. Start it however you normally would (e.g. via Claude Desktop's MCP config), or directly:

```bash
bun run src/index.ts
```

Confirm it's listening:

```bash
curl -I https://<your-machine>.tail6b8168.ts.net/webhook
# HTTP/2 200
```

---

## 4. Register the webhook

With the server running:

```bash
bun scripts/register-webhook.ts
```

On first run (no `TRELLO_MEMBER_ID` in `.env`), the script fetches your member ID and prints a tip to cache it. On success:

```
Webhook registered successfully.
  Webhook ID: 69f2c128da0025827480786c

Trello will POST events to https://<your-machine>.tail6b8168.ts.net/webhook.
```

Save the webhook ID somewhere — you'll need it if you ever want to delete the registration via the Trello API.

---

## Verifying events

Trigger any action in Trello (move a card, add a label). The MCP server logs all incoming payloads to stderr:

```
[webhook] 2026-04-30T12:00:00.000Z
{
  "action": {
    "type": "updateCard",
    ...
  }
}
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `502` during registration | MCP server not running | Start the server first, then re-run the script |
| `400 VALIDATOR_URL_RETURNED_ERROR` | Trello couldn't reach your URL | Check Tailscale Funnel is active and server is up |
| Registration succeeds but no events arrive | Funnel or server went down | Restart both; re-register if needed |
| Duplicate webhook error | Already registered | List webhooks via `GET /1/members/me/tokens` or just re-use the existing ID |
