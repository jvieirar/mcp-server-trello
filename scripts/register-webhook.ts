#!/usr/bin/env bun
export {};
// Register a Trello member-level webhook pointing to your public callback URL.
// One member-level webhook covers all boards — no per-board registration needed.
//
// Setup:
//   1. Copy example.env to .env (or .env.local) and fill in the values
//   2. Set WEBHOOK_URL to your public endpoint (e.g. your Tailscale Funnel URL)
//   3. Optionally set TRELLO_MEMBER_ID to skip the /members/me lookup
//   4. bun scripts/register-webhook.ts

// Bun automatically loads .env and .env.local — no manual parsing needed.

const { TRELLO_API_KEY, TRELLO_TOKEN, WEBHOOK_URL, WEBHOOK_PORT = '8899' } = process.env;
let { TRELLO_MEMBER_ID } = process.env;

if (!TRELLO_API_KEY) bail('TRELLO_API_KEY is not set. Add it to .env or export it.');
if (!TRELLO_TOKEN) bail('TRELLO_TOKEN is not set. Add it to .env or export it.');
if (!WEBHOOK_URL)
  bail('WEBHOOK_URL is not set. Add it to .env (e.g. https://your-host.ts.net/webhook).');

const auth = `key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`;

if (!TRELLO_MEMBER_ID) {
  console.log('TRELLO_MEMBER_ID not set — fetching from Trello...');
  const res = await fetch(`https://api.trello.com/1/members/me?${auth}&fields=id,username`);
  if (!res.ok) bail(`Failed to fetch member ID: HTTP ${res.status}\n${await res.text()}`);
  const me = (await res.json()) as { id: string; username: string };
  TRELLO_MEMBER_ID = me.id;
  console.log(`  Member ID : ${me.id}`);
  console.log(`  Username  : ${me.username}`);
  console.log(`  Tip: add TRELLO_MEMBER_ID=${me.id} to .env to skip this step next time.\n`);
}

console.log('Registering webhook...');
console.log(`  idModel : ${TRELLO_MEMBER_ID}`);
console.log(`  callback: ${WEBHOOK_URL}\n`);

const body = new URLSearchParams({
  idModel: TRELLO_MEMBER_ID,
  callbackURL: WEBHOOK_URL,
  description: 'jv-trello MCP webhook',
});

const res = await fetch(`https://api.trello.com/1/webhooks/?${auth}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: body.toString(),
});

const text = await res.text();

if (!res.ok) {
  console.error(`Trello returned HTTP ${res.status}:\n${text}\n`);
  console.error('Common causes:');
  console.error(
    '  - Callback URL not reachable (is the MCP server running? is Tailscale Funnel active?)'
  );
  console.error('  - Invalid API key or token');
  console.error('  - Webhook already registered for this idModel + callbackURL');
  process.exit(1);
}

const webhook = JSON.parse(text) as { id: string };
console.log('Webhook registered successfully.');
console.log(`  Webhook ID: ${webhook.id}\n`);
console.log(`Trello will POST events to ${WEBHOOK_URL}.`);
console.log(`Run the MCP server to start receiving them (webhook server on port ${WEBHOOK_PORT}).`);

function bail(msg: string): never {
  console.error(`Error: ${msg}`);
  process.exit(1);
}
