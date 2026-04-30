import path from 'path';

export const JV_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.jv-trello');
export const CONFIG_FILE = path.join(JV_DIR, 'config.json');
export const LOGS_DIR = path.join(JV_DIR, 'logs');

// Legacy path — migrated automatically on first load
export const LEGACY_CONFIG_FILE = path.join(
  process.env.HOME || process.env.USERPROFILE || '.',
  '.trello-mcp',
  'config.json'
);
