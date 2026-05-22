import Anthropic from '@anthropic-ai/sdk';
import type postgres from 'postgres';
import { audit } from '../audit/log.js';
import { checkDraft } from '../policy/engine.js';
import { sql } from '../shared/db.js';
import { env } from '../shared/env.js';
import { newId } from '../shared/ids.js';
import { logger } from '../shared/log.js';
import { makeWorker } from '../shared/queue.js';
import type { MessageRow } from '../shared/types.js';
import { drafterSystemPrompt, drafterUserPrompt } from './prompts.js';
import {
  draftToolDefs,
  dispatchTool,
  loadDraftCtx,
  type DraftCtx,
  type ToolEmission,
} from './tools.js';

let anthropic: Anthropic | null = null;
function getAnthropic(): Anthropic | null {
  if (!env.ANTHROPIC_API_KEY) return null;
  if (!anthropic) anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return anthropic;
}

function buildReplySubject(orig: string): string {
  if (/^re:/i.test(orig.trim())) return orig.trim();
  return `Re: ${orig.trim()}`;
}

interface DrafterRun {
  emission: ToolEmission;
  toolCalls: { name: string; input: unknown }[];
}

async function runDrafterWithClaude(
  msg: MessageRow,
  ctx: DraftCtx,
): Promise<DrafterRun | null> {
  const client = getAnthropic();
  if (!client) return null;

  const system = drafterSystemPrompt({
    ownerName: env.OWNER_NAME,
    ownerEmail: env.OWNER_EMAIL,
  });
  const userPrompt = drafterUserPrompt({
    fromName: msg.from_name,
    fromEmail: msg.from_email,
    subject: msg.subject,
    body: msg.text_body ?? '',
    threadParticipants: ctx.threadParticipants,
  });

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userPrompt }];
  const toolCallLog: { name: string; input: unknown }[] = [];
  let emission: ToolEmission | null = null;

  for (let step = 0; step < 8; step++) {
    const res = await client.messages.create({
      model: env.CLAUDE_MODEL_DRAFTER,
      max_tokens: 4096,
      system,
      tools: draftToolDefs,
      messages,
    });
    if (res.stop_reason === 'end_turn') break;
    if (res.stop_reason !== 'tool_use') break;

    const toolUses = res.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );
    if (toolUses.length === 0) break;

    messages.push({ role: 'assistant', content: res.content });
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      toolCallLog.push({ name: tu.name, input: tu.input });
      const r = await dispatchTool(tu.name, tu.input, ctx);
      if (r.emission) emission = r.emission;
      toolResults.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: JSON.stringify(r.error ? { error: r.error } : r.result),
        is_error: !!r.error,
      });
    }
    messages.push({ role: 'user', content: toolResults });
    if (emission) break;
  }

  if (!emission) return null;
  return { emission, toolCalls: toolCallLog };
}

function fallbackDrafter(msg: MessageRow, ctx: DraftCtx): DrafterRun {
  // Conservative reply when no Claude key is available — used for tests and dev only.
  const firstName = env.OWNER_NAME.split(' ')[0] ?? env.OWNER_NAME;
  const body = `Thanks for your note. I've received it and will get back to you shortly.\n\n${firstName}`;
  return {
    emission: {
      type: 'draft_reply',
      body_text: body,
      to_emails: ctx.threadParticipants,
      cc_emails: [],
      reasoning: 'Fallback drafter (no ANTHROPIC_API_KEY) — acknowledgement reply.',
      confidence: 0.4,
    },
    toolCalls: [],
  };
}

export async function generateDraft(opts: {
  messageId: string;
  threadId: string;
  requiresExtraConfirmation?: boolean;
}): Promise<string | null> {
  const msgRows = await sql<MessageRow[]>`
    SELECT * FROM messages WHERE id = ${opts.messageId} LIMIT 1
  `;
  const msg = msgRows[0];
  if (!msg) {
    logger.warn({ messageId: opts.messageId }, 'draft: message not found');
    return null;
  }
  const ctx = await loadDraftCtx(opts.messageId);
  if (!ctx) {
    logger.warn({ messageId: opts.messageId }, 'draft: ctx not loadable');
    return null;
  }

  let run: DrafterRun | null = null;
  try {
    run = await runDrafterWithClaude(msg, ctx);
  } catch (err) {
    logger.error({ err }, 'drafter Claude call failed; using fallback');
  }
  if (!run) run = fallbackDrafter(msg, ctx);

  // Handle escalation
  if (run.emission.type === 'escalate_to_human') {
    await sql`
      UPDATE threads SET current_lane = 5, status = 'awaiting_reply', updated_at = now()
      WHERE id = ${opts.threadId}
    `;
    await audit({
      actor: 'agent',
      action: 'escalate',
      threadId: opts.threadId,
      messageId: opts.messageId,
      payload: { reason: run.emission.reason, toolCalls: run.toolCalls },
      outcome: 'ok',
    });
    logger.info({ messageId: opts.messageId, reason: run.emission.reason }, 'agent escalated');
    return null;
  }

  // Draft emission — gate through policy
  const check = checkDraft({
    to_emails: run.emission.to_emails,
    cc_emails: run.emission.cc_emails,
    body_text: run.emission.body_text,
    thread_participants: ctx.threadParticipants,
    owner_email: env.OWNER_EMAIL,
  });
  if (!check.ok) {
    await audit({
      actor: 'agent',
      action: 'draft',
      threadId: opts.threadId,
      messageId: opts.messageId,
      payload: { blocked: check.reason, emission: run.emission, toolCalls: run.toolCalls },
      outcome: 'blocked',
    });
    // Mark thread escalated
    await sql`
      UPDATE threads SET current_lane = 5, status = 'awaiting_reply', updated_at = now()
      WHERE id = ${opts.threadId}
    `;
    logger.warn({ messageId: opts.messageId, reason: check.reason }, 'draft blocked by policy');
    return null;
  }

  const draftId = newId();
  const subject = buildReplySubject(msg.subject);
  await sql`
    INSERT INTO drafts (
      id, thread_id, in_reply_to_id, to_emails, cc_emails, subject, body_text,
      status, agent_reasoning, agent_confidence, tool_calls,
      requires_extra_confirmation
    ) VALUES (
      ${draftId},
      ${opts.threadId},
      ${opts.messageId},
      ${run.emission.to_emails},
      ${run.emission.cc_emails},
      ${subject},
      ${run.emission.body_text},
      'pending',
      ${run.emission.reasoning},
      ${run.emission.confidence},
      ${sql.json(run.toolCalls as unknown as postgres.JSONValue)},
      ${opts.requiresExtraConfirmation === true}
    )
  `;

  await audit({
    actor: 'agent',
    action: 'draft',
    threadId: opts.threadId,
    messageId: opts.messageId,
    draftId,
    payload: {
      confidence: run.emission.confidence,
      reasoning: run.emission.reasoning,
      toolCalls: run.toolCalls,
    },
    outcome: 'ok',
  });

  logger.info({ messageId: opts.messageId, draftId, confidence: run.emission.confidence }, 'drafted');
  return draftId;
}

export function startDraftWorker() {
  return makeWorker<{
    messageId: string;
    threadId: string;
    requiresExtraConfirmation?: boolean;
  }>('draft', async (job) => {
    await generateDraft(job.data);
  });
}
