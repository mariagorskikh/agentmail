import type { Lane } from '../shared/types.js';
import { getPolicies, type Policy } from './rules.js';

export interface RouteContext {
  classification: {
    trust: string;
    sender_class: string;
    intent: string;
    urgency: number;
    recommended_lane: number;
    entities?: {
      money_cents?: number[];
    };
  };
  message: {
    text_body: string | null;
    from_trust_level: string;
    subject: string;
  };
  user_status?: string; // 'ooo' etc; not implemented yet
}

export interface RouteDecision {
  lane: Lane;
  reason: string;
  matchedPolicy: string | null;
  requiresExtraConfirmation: boolean;
}

function bodyMatchesAny(body: string | null, keywords: string[]): boolean {
  if (!body) return false;
  const lower = body.toLowerCase();
  return keywords.some((kw) => lower.includes(kw.toLowerCase()));
}

function policyMatches(policy: Policy, ctx: RouteContext): boolean {
  const w = policy.when;
  if (w.from_trust_level && ctx.message.from_trust_level !== w.from_trust_level) return false;
  if (w.sender_class && ctx.classification.sender_class !== w.sender_class) return false;
  if (w.trust && ctx.classification.trust !== w.trust) return false;
  if (w.intent && ctx.classification.intent !== w.intent) return false;
  if (w.user_status && ctx.user_status !== w.user_status) return false;
  if (w.body_contains_any && !bodyMatchesAny(ctx.message.text_body, w.body_contains_any))
    return false;
  if (w.money_amount_gte_cents !== undefined) {
    const amounts = ctx.classification.entities?.money_cents ?? [];
    if (!amounts.some((c) => c >= w.money_amount_gte_cents!)) return false;
  }
  return true;
}

export function checkRoute(ctx: RouteContext): RouteDecision {
  const cfg = getPolicies();
  let lane: Lane = (ctx.classification.recommended_lane as Lane) ?? 4;
  let reason = 'classifier recommendation';
  let matchedPolicy: string | null = null;
  let requiresExtraConfirmation = false;

  for (const p of cfg.policies) {
    if (policyMatches(p, ctx)) {
      if (p.then.force_lane) {
        lane = p.then.force_lane as Lane;
        reason = p.then.reason ?? `forced by policy ${p.name}`;
        matchedPolicy = p.name;
        break;
      }
    }
  }

  // Global guards: only upgrade toward lane 5
  for (const guard of cfg.limits.required_human_review_if) {
    let hit = false;
    if (guard.body_contains_any && bodyMatchesAny(ctx.message.text_body, guard.body_contains_any)) {
      hit = true;
    }
    if (guard.money_amount_gte_cents !== undefined) {
      const amounts = ctx.classification.entities?.money_cents ?? [];
      if (amounts.some((c) => c >= guard.money_amount_gte_cents!)) hit = true;
    }
    if (hit) {
      requiresExtraConfirmation = true;
      if (lane < 5) {
        lane = 5;
        reason = 'global guard required_human_review_if';
        matchedPolicy = matchedPolicy ?? 'limits.required_human_review_if';
      }
    }
  }

  return { lane, reason, matchedPolicy, requiresExtraConfirmation };
}

export interface DraftCheckContext {
  to_emails: string[];
  cc_emails: string[];
  body_text: string;
  thread_participants: string[];
  owner_email: string;
}

export interface CheckResult {
  ok: boolean;
  reason?: string;
}

const HEX_BLOB = /[A-Fa-f0-9]{200,}/;
const BASE64_BLOB = /[A-Za-z0-9+/=]{200,}/;

export function checkDraft(ctx: DraftCheckContext): CheckResult {
  const cfg = getPolicies();
  const allowedSet = new Set(
    [...ctx.thread_participants, ctx.owner_email].map((e) => e.toLowerCase()),
  );
  for (const r of [...ctx.to_emails, ...ctx.cc_emails]) {
    if (!allowedSet.has(r.toLowerCase())) {
      return { ok: false, reason: `recipient ${r} not in thread participants` };
    }
  }
  if (ctx.body_text.length > 8000) {
    return { ok: false, reason: 'body exceeds 8000 chars' };
  }
  // Forbidden recipients pattern match (e.g. "*@example.com")
  for (const pattern of cfg.limits.forbidden_recipients) {
    const re = patternToRegex(pattern);
    for (const r of [...ctx.to_emails, ...ctx.cc_emails]) {
      if (re.test(r)) {
        return { ok: false, reason: `recipient ${r} matches forbidden pattern ${pattern}` };
      }
    }
    // also scan body text for forbidden addresses
    if (re.test(ctx.body_text)) {
      return { ok: false, reason: `body contains forbidden address pattern ${pattern}` };
    }
  }
  // Exfil heuristic
  if (HEX_BLOB.test(ctx.body_text) || BASE64_BLOB.test(ctx.body_text)) {
    return { ok: false, reason: 'body contains long opaque blob (potential exfil)' };
  }
  return { ok: true };
}

function patternToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(escaped, 'i');
}

export interface SendCheckContext {
  draftId: string;
  to_emails: string[];
  cc_emails: string[];
  bodyHash: string;
  expectedBodyHash: string;
  perHourCount: number;
  perDayCount: number;
  perHourLimit: number;
  perDayLimit: number;
}

export function checkSend(ctx: SendCheckContext): CheckResult {
  const cfg = getPolicies();
  if (ctx.bodyHash !== ctx.expectedBodyHash) {
    return { ok: false, reason: 'draft body changed since approval' };
  }
  if (ctx.perHourCount >= ctx.perHourLimit) {
    return { ok: false, reason: `per-hour outbound limit reached (${ctx.perHourLimit})` };
  }
  if (ctx.perDayCount >= ctx.perDayLimit) {
    return { ok: false, reason: `per-day outbound limit reached (${ctx.perDayLimit})` };
  }
  if (ctx.to_emails.length + ctx.cc_emails.length > cfg.limits.max_recipients_per_send) {
    return {
      ok: false,
      reason: `recipient count exceeds ${cfg.limits.max_recipients_per_send}`,
    };
  }
  for (const pattern of cfg.limits.forbidden_recipients) {
    const re = patternToRegex(pattern);
    for (const r of [...ctx.to_emails, ...ctx.cc_emails]) {
      if (re.test(r)) return { ok: false, reason: `recipient ${r} matches forbidden pattern` };
    }
  }
  return { ok: true };
}
