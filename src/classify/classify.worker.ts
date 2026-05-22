import Anthropic from '@anthropic-ai/sdk';
import { audit } from '../audit/log.js';
import { sql } from '../shared/db.js';
import { env } from '../shared/env.js';
import { newId } from '../shared/ids.js';
import { logger } from '../shared/log.js';
import { makeWorker, queues } from '../shared/queue.js';
import type { MessageRow } from '../shared/types.js';
import { heuristicClassifyFromRow } from './heuristic.js';
import { classifierSystemPrompt } from './prompts.js';
import { ClassificationSchema, PROMPT_VERSION, type Classification } from './schema.js';

let anthropic: Anthropic | null = null;
function getAnthropic(): Anthropic | null {
  if (!env.ANTHROPIC_API_KEY) return null;
  if (!anthropic) anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return anthropic;
}

function buildUserPrompt(row: MessageRow): string {
  return `Classify the following message.

From: ${row.from_name ?? ''} <${row.from_email}>
Subject: ${row.subject}
Auth: ${JSON.stringify(row.auth_results)}

<incoming_message untrusted="true">
${(row.text_body ?? '').slice(0, 16000)}
</incoming_message>

Respond ONLY with a single JSON object matching the schema. No prose, no fences.`;
}

function tryExtractJson(text: string): unknown {
  // First try direct parse
  try {
    return JSON.parse(text);
  } catch {
    // ignore
  }
  // Try to pull JSON out of fences
  const fenced = text.match(/```(?:json)?\s*([\s\S]+?)```/);
  if (fenced && fenced[1]) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      // ignore
    }
  }
  // Try the first {...} block
  const match = text.match(/\{[\s\S]+\}/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch {
      // ignore
    }
  }
  return null;
}

async function callClaude(row: MessageRow, strict = false): Promise<Classification | null> {
  const client = getAnthropic();
  if (!client) return null;
  const systemPrompt = classifierSystemPrompt({
    ownerName: env.OWNER_NAME,
    ownerEmail: env.OWNER_EMAIL,
    nowIso: new Date().toISOString(),
  });
  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: strict
        ? buildUserPrompt(row) + '\n\nReminder: you must produce valid JSON only.'
        : buildUserPrompt(row),
    },
  ];
  const res = await client.messages.create({
    model: env.CLAUDE_MODEL_CLASSIFIER,
    max_tokens: 1024,
    system: systemPrompt,
    messages,
  });
  const text = res.content
    .filter((c): c is Anthropic.TextBlock => c.type === 'text')
    .map((c) => c.text)
    .join('');
  const parsed = tryExtractJson(text);
  if (!parsed) return null;
  const result = ClassificationSchema.safeParse(parsed);
  if (!result.success) {
    logger.warn({ err: result.error.flatten(), text }, 'classifier returned invalid schema');
    return null;
  }
  return result.data;
}

export async function classifyMessage(messageId: string): Promise<Classification | null> {
  const rows = await sql<MessageRow[]>`
    SELECT * FROM messages WHERE id = ${messageId} LIMIT 1
  `;
  const msg = rows[0];
  if (!msg) {
    logger.warn({ messageId }, 'classify: message not found');
    return null;
  }

  let classification: Classification | null = null;
  let modelUsed = 'heuristic';

  // Try Claude up to twice if schema invalid
  if (getAnthropic()) {
    try {
      classification = await callClaude(msg);
      if (!classification) classification = await callClaude(msg, true);
      if (classification) modelUsed = env.CLAUDE_MODEL_CLASSIFIER;
    } catch (err) {
      logger.warn({ err }, 'classifier call errored, falling back to heuristic');
    }
  }

  if (!classification) {
    classification = heuristicClassifyFromRow(msg);
    modelUsed = 'heuristic';
  }

  // Persist
  await sql`
    INSERT INTO classifications (
      id, message_id, trust, sender_class, intent, urgency, recommended_lane,
      entities, reasoning, model, prompt_version
    ) VALUES (
      ${newId()},
      ${messageId},
      ${classification.trust},
      ${classification.sender_class},
      ${classification.intent},
      ${classification.urgency},
      ${classification.recommended_lane},
      ${sql.json(classification.entities)},
      ${classification.reasoning},
      ${modelUsed},
      ${PROMPT_VERSION}
    )
    ON CONFLICT (message_id) DO UPDATE SET
      trust = EXCLUDED.trust,
      sender_class = EXCLUDED.sender_class,
      intent = EXCLUDED.intent,
      urgency = EXCLUDED.urgency,
      recommended_lane = EXCLUDED.recommended_lane,
      entities = EXCLUDED.entities,
      reasoning = EXCLUDED.reasoning,
      model = EXCLUDED.model,
      prompt_version = EXCLUDED.prompt_version
  `;

  await audit({
    actor: 'agent',
    action: 'classify',
    messageId,
    threadId: msg.thread_id,
    payload: { ...classification, model: modelUsed },
    outcome: 'ok',
  });

  // Enqueue routing
  await queues.route.add('route', { messageId });
  logger.info(
    {
      messageId,
      lane: classification.recommended_lane,
      trust: classification.trust,
      senderClass: classification.sender_class,
      model: modelUsed,
    },
    'classified',
  );
  return classification;
}

export function startClassifyWorker() {
  return makeWorker<{ messageId: string }>('classify', async (job) => {
    await classifyMessage(job.data.messageId);
  });
}
