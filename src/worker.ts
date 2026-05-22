import { startClassifyWorker } from './classify/classify.worker.js';
import { startDraftWorker } from './draft/draft.worker.js';
import { startIngestWorker } from './ingest/ingest.worker.js';
import { startOutboundWorker } from './outbound/outbound.worker.js';
import { syncPoliciesToDb } from './policy/rules.js';
import { startRouteWorker } from './route/route.worker.js';
import { makeWorker } from './shared/queue.js';
import { logger } from './shared/log.js';

async function main(): Promise<void> {
  await syncPoliciesToDb();

  const workers = [
    startIngestWorker(),
    startClassifyWorker(),
    startRouteWorker(),
    startDraftWorker(),
    startOutboundWorker(),
    // Stub for lane 3 auto-action
    makeWorker<{ messageId: string; threadId: string; kind: string }>(
      'auto-action',
      async (job) => {
        logger.info(
          { messageId: job.data.messageId, kind: job.data.kind },
          'auto-action stub (no-op for now)',
        );
      },
    ),
  ];

  logger.info({ count: workers.length }, 'worker ready');

  const shutdown = async () => {
    logger.info('worker shutting down');
    await Promise.all(workers.map((w) => w.close()));
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.error({ err }, 'worker failed to start');
  process.exit(1);
});
