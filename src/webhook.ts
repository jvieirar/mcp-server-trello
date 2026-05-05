import * as fs from 'fs/promises';
import * as path from 'path';
import { LOGS_DIR } from './paths.js';
import { spawnAgent } from './agent.js';

const PORT = Number(process.env.WEBHOOK_PORT ?? 8899);
const LOG_RETENTION_DAYS = 30;

function todayLogFile(): string {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return path.join(LOGS_DIR, `webhook-${date}.log`);
}

async function appendLog(entry: string): Promise<void> {
  await fs.mkdir(LOGS_DIR, { recursive: true });
  await fs.appendFile(todayLogFile(), entry + '\n', 'utf8');
}

async function pruneOldLogs(): Promise<void> {
  try {
    const files = await fs.readdir(LOGS_DIR);
    const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const file of files) {
      if (!file.startsWith('webhook-') || !file.endsWith('.log')) continue;
      const filePath = path.join(LOGS_DIR, file);
      const { mtime } = await fs.stat(filePath);
      if (mtime.getTime() < cutoff) await fs.unlink(filePath);
    }
  } catch {
    // Logs dir may not exist yet — ignore
  }
}

interface TrelloAction {
  type: 'addLabelToCard' | 'updateCard' | string;
  display?: { translationKey?: string };
  data?: {
    card?: { id?: string; name?: string };
    label?: { id?: string; name?: string; color?: string };
  };
}

interface TrelloEvent {
  action?: TrelloAction;
}

async function handleEvent(event: TrelloEvent): Promise<void> {
  const action = event.action;
  if (!action) return;

  const key = action.display?.translationKey;
  const label = action.data?.label;
  const card = action.data?.card;

  if (action.type === 'addLabelToCard' && key === 'action_add_label_to_card' && label?.name) {
    if (label.name === 'AI_READY') {
      const cardId = card?.id ?? '';
      const cardName = card?.name ?? 'unknown';
      const runner = process.env.AGENT_RUNNER ?? 'claude';
      const model = process.env.AGENT_MODEL ?? (runner === 'copilot' ? 'claude-haiku-4.5' : 'claude-sonnet-4-6');
      const maxTurns = process.env.AGENT_MAX_TURNS ?? 'unlimited';
      const msg = `[AI_READY] card="${cardName}" id=${cardId} → spawning agent runner=${runner} model=${model} max-turns=${maxTurns}`;
      console.error(msg);
      await appendLog(msg);

      if (cardId) {
        spawnAgent(cardId, cardName).catch((err: unknown) => {
          console.error(`[agent] spawn error for card ${cardId}: ${err}`);
        });
      }
    } else {
      const msg = `[webhook] label added: "${label.name}" on "${card?.name ?? 'unknown'}"`;
      console.error(msg);
      await appendLog(msg);
    }
  }
}

export async function startWebhookServer(): Promise<void> {
  const enabled = process.env.WEBHOOK_ENABLED !== 'false';

  if (!enabled) {
    console.error('[webhook] listener disabled via WEBHOOK_ENABLED=false');
    return;
  }

  await fs.mkdir(LOGS_DIR, { recursive: true });
  await pruneOldLogs();

  try {
    Bun.serve({
      port: PORT,
      async fetch(req) {
        const url = new URL(req.url);

        if (url.pathname !== '/webhook') {
          return new Response('Not found', { status: 404 });
        }

        if (req.method === 'HEAD' || req.method === 'GET') {
          return new Response(null, { status: 200 });
        }

        if (req.method === 'POST') {
          let body: unknown;
          try {
            body = await req.json();
          } catch {
            return new Response('Bad request', { status: 400 });
          }

          const timestamp = new Date().toISOString();
          const entry = `[${timestamp}]\n${JSON.stringify(body, null, 2)}`;

          console.error(`[webhook] ${entry}`);
          await appendLog(entry);
          await handleEvent(body as TrelloEvent);

          return new Response('OK', { status: 200 });
        }

        return new Response('Method not allowed', { status: 405 });
      },
    });

    const logPath = todayLogFile();
    console.error(`[webhook] listening on port ${PORT}`);
    console.error(`[webhook] logging to ${logPath}`);
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      console.error(`[webhook] port ${PORT} already in use — skipping (another MCP instance is the webhook listener)`);
    } else {
      throw err;
    }
  }
}
