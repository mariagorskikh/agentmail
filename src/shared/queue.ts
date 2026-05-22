import { Queue, Worker, type JobsOptions, type WorkerOptions } from 'bullmq';
import IORedis from 'ioredis';
import { env } from './env.js';
import { logger } from './log.js';

export const connection = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

export const QUEUE_NAMES = {
  ingest: 'ingest',
  classify: 'classify',
  route: 'route',
  draft: 'draft',
  outbound: 'outbound',
  autoAction: 'auto-action',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

const DEFAULT_JOB_OPTS: JobsOptions = {
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 1000 },
  attempts: 5,
  backoff: { type: 'exponential', delay: 2000 },
};

const queueCache = new Map<string, Queue>();

export function getQueue(name: QueueName): Queue {
  let q = queueCache.get(name);
  if (!q) {
    q = new Queue(name, { connection, defaultJobOptions: DEFAULT_JOB_OPTS });
    queueCache.set(name, q);
  }
  return q;
}

export const queues = {
  get ingest() {
    return getQueue(QUEUE_NAMES.ingest);
  },
  get classify() {
    return getQueue(QUEUE_NAMES.classify);
  },
  get route() {
    return getQueue(QUEUE_NAMES.route);
  },
  get draft() {
    return getQueue(QUEUE_NAMES.draft);
  },
  get outbound() {
    return getQueue(QUEUE_NAMES.outbound);
  },
  get autoAction() {
    return getQueue(QUEUE_NAMES.autoAction);
  },
};

export function makeWorker<T = unknown>(
  name: QueueName,
  processor: (job: { data: T; id?: string; name: string }) => Promise<unknown>,
  opts?: Partial<WorkerOptions>,
): Worker {
  const w = new Worker(
    name,
    async (job) => {
      logger.info({ queue: name, jobId: job.id, jobName: job.name }, 'job start');
      try {
        const result = await processor({ data: job.data as T, id: job.id, name: job.name });
        logger.info({ queue: name, jobId: job.id }, 'job ok');
        return result;
      } catch (err) {
        logger.error({ queue: name, jobId: job.id, err }, 'job fail');
        throw err;
      }
    },
    { connection, concurrency: 4, ...opts },
  );
  w.on('failed', (job, err) => {
    logger.error({ queue: name, jobId: job?.id, err: err?.message }, 'worker failure event');
  });
  return w;
}

export async function closeAll(): Promise<void> {
  for (const q of queueCache.values()) {
    await q.close();
  }
  await connection.quit();
}
