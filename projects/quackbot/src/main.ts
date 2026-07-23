import { createApp } from './slack/app';
import { registerHandlers } from './slack/handlers';
import { closeBrowser } from './slack/screenshot';
import { closePool } from './store/pg';
import * as cl from './core/controllog';

/**
 * Entrypoint: env validation → controllog init → Socket Mode start.
 * Conversation state lives in Postgres and context in MotherDuck, so the
 * process itself is stateless — safe to restart mid-thread.
 */

// Best-effort .env load; in containers the environment is already populated.
try {
  process.loadEnvFile('.env');
} catch {
  /* no .env file — rely on the ambient environment */
}

const REQUIRED_ENV = [
  'SLACK_BOT_TOKEN',
  'SLACK_APP_TOKEN',
  'MOTHERDUCK_TOKEN',
  'OPENROUTER_API_KEY',
  'DATABASE_URL',
] as const;

const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(
    `Missing required environment variables: ${missing.join(', ')}\n` +
      'Copy .env.example to .env and fill them in.',
  );
  process.exit(1);
}

try {
  cl.init('quackbot', 'logs');
} catch {
  /* already initialized */
}

const app = createApp();
registerHandlers(app);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[quackbot] ${signal} — shutting down`);
  try {
    await app.stop();
  } catch (err) {
    console.warn('[quackbot] app.stop failed:', err);
  }
  try {
    await closeBrowser();
  } catch (err) {
    console.warn('[quackbot] browser close failed:', err);
  }
  try {
    await closePool();
  } catch (err) {
    console.warn('[quackbot] pool close failed:', err);
  }
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.start();
console.log('[quackbot] running (Socket Mode)');
