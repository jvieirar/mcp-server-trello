export {};

import * as fs from 'fs/promises';
import path from 'path';
import { LOGS_DIR } from './paths.js';

const DEFAULT_MODEL = 'claude-sonnet-4-6';

function agentLogFile(cardId: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(LOGS_DIR, `agent-${cardId}-${ts}.log`);
}

function buildPrompt(cardId: string, cardName: string, logFile: string): string {
  return `\
You are a Trello task agent. A card has just been marked AI_READY and needs your attention.

Card ID  : ${cardId}
Card name: ${cardName}
Session log: ${logFile}

Steps:
1. Invoke the jv-trello skill to set up your session (board config, labels, lists, prefix).
2. Immediately post this [NOTE] comment on card ${cardId} so future agents and the user can find this session:

   [NOTE] Agent session started.
   Model: ${process.env.AGENT_MODEL ?? DEFAULT_MODEL}
   Log  : ${logFile}

3. Work through the card following the full jv-trello workflow:
   - Move card → In Progress, swap AI_READY → AI_WORKING label
   - Post [PLAN] before touching anything
   - Post [DECISION] for every non-trivial judgment call
   - Post [RESULT] when done, move card → Done, swap AI_WORKING → IN_REVIEW
4. If you need user input at any point:
   - Post a [QUESTION] comment
   - Move card → Blocked, add BLOCKED label
   - Stop — do not continue until the user responds

All prior comments and the full card description are available via jv_get_card — use them as context, \
especially if another agent has already worked on this card (look for previous [NOTE] session log entries).
`;
}

// Parse stream-json events into readable log lines
function formatEvent(raw: string): string | null {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return raw.trim() || null;
  }

  const type = event.type as string;

  if (type === 'assistant') {
    const msg = event.message as { content?: unknown[] } | undefined;
    const parts = (msg?.content ?? []) as Array<{ type: string; text?: string; name?: string; input?: unknown }>;
    const lines: string[] = [];
    for (const part of parts) {
      if (part.type === 'text' && part.text?.trim()) {
        lines.push(`[assistant] ${part.text.trim()}`);
      } else if (part.type === 'tool_use') {
        const input = JSON.stringify(part.input ?? {});
        const preview = input.length > 120 ? input.slice(0, 120) + '…' : input;
        lines.push(`[tool_use ] ${part.name}  ${preview}`);
      }
    }
    return lines.join('\n') || null;
  }

  if (type === 'user') {
    const msg = event.message as { content?: unknown[] } | undefined;
    const parts = (msg?.content ?? []) as Array<{ type: string; content?: unknown; is_error?: boolean }>;
    for (const part of parts) {
      if (part.type === 'tool_result') {
        const content = typeof part.content === 'string'
          ? part.content.slice(0, 200)
          : JSON.stringify(part.content ?? '').slice(0, 200);
        const tag = part.is_error ? '[tool_err ]' : '[tool_res ]';
        return `${tag} ${content}${content.length >= 200 ? '…' : ''}`;
      }
    }
    return null;
  }

  if (type === 'result') {
    const sub = event.subtype as string;
    const cost = (event.total_cost_usd as number | undefined)?.toFixed(4) ?? '?';
    const turns = event.num_turns as number | undefined;
    if (sub === 'success') return `[result    ] ✓ done  turns=${turns}  cost=$${cost}`;
    return `[result    ] ✗ ${sub}  turns=${turns}  cost=$${cost}`;
  }

  return null;
}

async function streamToLog(stream: ReadableStream<Uint8Array>, logFile: string): Promise<void> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const formatted = formatEvent(line);
      if (formatted) await fs.appendFile(logFile, formatted + '\n');
    }
  }

  if (buffer.trim()) {
    const formatted = formatEvent(buffer);
    if (formatted) await fs.appendFile(logFile, formatted + '\n');
  }
}

export async function spawnAgent(cardId: string, cardName: string): Promise<void> {
  const model = process.env.AGENT_MODEL ?? DEFAULT_MODEL;
  const maxTurns = process.env.AGENT_MAX_TURNS ? Number(process.env.AGENT_MAX_TURNS) : null;
  const logFile = agentLogFile(cardId);

  await fs.mkdir(LOGS_DIR, { recursive: true });
  await fs.writeFile(
    logFile,
    `[agent] started  : ${new Date().toISOString()}\n` +
    `[agent] card     : ${cardName} (${cardId})\n` +
    `[agent] model    : ${model}  max-turns: ${maxTurns ?? 'unlimited'}\n` +
    `${'─'.repeat(60)}\n`
  );

  console.error(`[agent] spawning for card ${cardId}`);
  console.error(`[agent] log → ${logFile}`);

  const args = [
    'claude', '-p', buildPrompt(cardId, cardName, logFile),
    '--model', model,
    '--output-format', 'stream-json',
    '--verbose',
    '--allowedTools', 'mcp__jv-trello__*',
  ];
  if (maxTurns !== null) args.push('--max-turns', String(maxTurns));

  const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' });

  // stderr (errors, warnings) goes straight to log unformatted
  async function pipeStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await fs.appendFile(logFile, value);
    }
  }

  // Wait in background — webhook response is already sent
  Promise.all([streamToLog(proc.stdout, logFile), pipeStderr(proc.stderr), proc.exited]).then(
    async ([,, code]) => {
      const footer =
        `${'─'.repeat(60)}\n` +
        `[agent] finished : ${new Date().toISOString()}  exit: ${code}\n`;
      await fs.appendFile(logFile, footer);
      console.error(`[agent] card ${cardId} done (exit ${code}) — ${logFile}`);
    }
  );
}
