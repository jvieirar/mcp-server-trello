/// <reference types="node" />
/// <reference types="bun" />

export {};

/**
 * Registers the jv-trello MCP server in one or more AI client configs.
 *
 * Usage:
 *   bun scripts/setup-mcp-client.ts [--gemini] [--claude-code] [--all]
 *
 * Reads credentials from:
 *   - TRELLO_API_KEY / TRELLO_TOKEN env vars
 *   - .env or .env.local file in the current directory (Bun built-in loading)
 */

import * as fs from 'fs/promises';
import * as path from 'path';

const SERVER_DIR = path.resolve(import.meta.dir, '..');
const SERVER_ENTRY = path.join(SERVER_DIR, 'src', 'index.ts');
const HOME = process.env.HOME || process.env.USERPROFILE || '.';

async function readJson(filePath: string, fallback: Record<string, unknown> = {}) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as Record<string, unknown>;
  } catch {
    return fallback;
  }
}

function serverEntry(apiKey: string, token: string) {
  return {
    command: 'bun',
    args: ['run', SERVER_ENTRY],
    env: { TRELLO_API_KEY: apiKey, TRELLO_TOKEN: token },
  };
}

// Gemini CLI: uses a wrapper script so credentials are loaded from .env/.env.local
// rather than relying on Gemini to pass env vars (which it may not do reliably).
async function setupGemini(_apiKey: string, _token: string) {
  const wrapperScript = path.join(SERVER_DIR, 'scripts', 'start-mcp.sh');

  // Remove existing entry first (ignore failure if not registered)
  const remove = Bun.spawn(['gemini', 'mcp', 'remove', 'jv-trello'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  await remove.exited;

  const proc = Bun.spawn(['gemini', 'mcp', 'add', 'jv-trello', wrapperScript, '--scope', 'user'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  await proc.exited;
  const settingsFile = path.join(HOME, '.gemini', 'settings.json');
  console.log(`✓ Gemini CLI  →  ${settingsFile}`);
  console.log('  Wrapper: scripts/start-mcp.sh (loads credentials from .env / .env.local)');
  console.log('  Restart Gemini CLI and run /mcp to verify.');
}

// Claude Code: credentials in ~/.claude/settings.json env block + allow list
// The MCP server itself must be added via Claude Desktop GUI or .claude/claude_desktop_config.json
async function setupClaudeCode(apiKey: string, token: string) {
  const filePath = path.join(HOME, '.claude', 'settings.json');
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  const config = await readJson(filePath, {});

  if (!config.env || typeof config.env !== 'object') config.env = {};
  (config.env as Record<string, string>)['TRELLO_API_KEY'] = apiKey;
  (config.env as Record<string, string>)['TRELLO_TOKEN'] = token;

  const perms = (config.permissions ?? { allow: [] }) as { allow?: string[] };
  if (!perms.allow) perms.allow = [];
  if (!perms.allow.includes('mcp__jv-trello__*')) perms.allow.push('mcp__jv-trello__*');
  config.permissions = perms;

  await fs.writeFile(filePath, JSON.stringify(config, null, 2) + '\n');
  console.log(`✓ Claude Code →  ${filePath}`);
  console.log('  Also add the MCP server to Claude Desktop: Settings → Developer → Edit Config');
  console.log(`  Entry: { "command": "bun", "args": ["run", "${SERVER_ENTRY}"] }`);
}

async function main() {
  const args = process.argv.slice(2);
  const runAll = args.includes('--all') || args.length === 0;
  const doGemini = runAll || args.includes('--gemini');
  const doClaudeCode = runAll || args.includes('--claude-code');

  const apiKey = process.env.TRELLO_API_KEY;
  const token = process.env.TRELLO_TOKEN;

  if (!apiKey || !token) {
    console.error('Error: TRELLO_API_KEY and TRELLO_TOKEN must be set in env or .env / .env.local');
    process.exit(1);
  }

  console.log(`\njv-trello MCP client setup`);
  console.log(`Server: ${SERVER_ENTRY}\n`);

  if (doGemini) await setupGemini(apiKey, token);
  if (doClaudeCode) await setupClaudeCode(apiKey, token);

  console.log('\nDone. Restart your AI client to pick up the new MCP server.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
