import { BuzzAdapter } from './adapters/buzz/adapter.js';
import { CliAdapter } from './adapters/cli.js';
import type { ChatAdapter } from './adapters/types.js';
import { loadConfig, type Config } from './config.js';
import { Gwen } from './gwen.js';
import { log, errText } from './log.js';

/** Every chat platform Gwen can run on. A new platform is one entry here. */
const ADAPTERS: Record<string, (cfg: Config) => ChatAdapter> = {
  cli: (cfg) => new CliAdapter(cfg.ownerName),
  // loadConfig fills cfg.buzz whenever the buzz adapter is enabled.
  buzz: (cfg) => new BuzzAdapter(cfg.buzz!, cfg.ownerName),
};

function createAdapter(name: string, cfg: Config): ChatAdapter {
  const create = ADAPTERS[name];
  if (!create) throw new Error(`unknown adapter ${JSON.stringify(name)}; known: ${Object.keys(ADAPTERS).join(', ')}`);
  return create(cfg);
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const gwen = new Gwen(cfg);
  const adapters = cfg.adapters.map((name) => createAdapter(name, cfg));

  for (const adapter of adapters) {
    gwen.register(adapter);
    await adapter.start((message) => gwen.onMessage(adapter, message));
  }
  log.info('gwen started', {
    adapters: adapters.map((a) => a.name),
    frontModel: cfg.front.model,
    researchModel: cfg.research.model,
    memory: cfg.memory.key !== '',
  });
  gwen.recover();

  let stopping = false;
  const shutdown = async (why: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log.info('gwen stopping', { why });
    await Promise.allSettled(adapters.map((a) => a.stop()));
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // An adapter with a finite input (the terminal, when piped) ends the process
  // once every message is answered and every research job has reported.
  const finite = adapters.flatMap((a) => (a.ended ? [a.ended()] : []));
  if (finite.length === adapters.length) {
    await Promise.all(finite);
    await gwen.idle();
    await shutdown('input ended');
  }
}

main().catch((e) => {
  log.error('fatal', { error: errText(e) });
  process.exit(1);
});
