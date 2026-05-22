import { describe, it, expect, beforeAll } from 'vitest';
import { checkRoute, checkDraft, checkSend } from '../src/policy/engine.js';
import { loadPoliciesFromDisk } from '../src/policy/rules.js';

beforeAll(() => {
  loadPoliciesFromDisk();
});

describe('checkRoute', () => {
  it('escalates VIP senders to lane 5', () => {
    const d = checkRoute({
      classification: {
        trust: 'high',
        sender_class: 'human',
        intent: 'response_needed',
        urgency: 1,
        recommended_lane: 4,
        entities: {},
      },
      message: { text_body: 'hi', from_trust_level: 'vip', subject: 'hi' },
    });
    expect(d.lane).toBe(5);
    expect(d.matchedPolicy).toBe('vip-always-escalate');
  });

  it('quarantines hostile senders (lane 1)', () => {
    const d = checkRoute({
      classification: {
        trust: 'hostile',
        sender_class: 'phishing',
        intent: 'verification',
        urgency: 1,
        recommended_lane: 1,
        entities: {},
      },
      message: { text_body: 'verify', from_trust_level: 'unknown', subject: 'urgent' },
    });
    expect(d.lane).toBe(1);
  });

  it('files marketing into lane 2', () => {
    const d = checkRoute({
      classification: {
        trust: 'medium',
        sender_class: 'marketing',
        intent: 'fyi',
        urgency: 0,
        recommended_lane: 2,
        entities: {},
      },
      message: { text_body: 'newsletter', from_trust_level: 'unknown', subject: 'news' },
    });
    expect(d.lane).toBe(2);
  });

  it('files cold outreach into lane 2', () => {
    const d = checkRoute({
      classification: {
        trust: 'medium',
        sender_class: 'cold_outreach',
        intent: 'fyi',
        urgency: 0,
        recommended_lane: 4,
        entities: {},
      },
      message: { text_body: 'pitch', from_trust_level: 'unknown', subject: 'hi' },
    });
    expect(d.lane).toBe(2);
  });

  it('escalates on financial keyword', () => {
    const d = checkRoute({
      classification: {
        trust: 'high',
        sender_class: 'human',
        intent: 'response_needed',
        urgency: 3,
        recommended_lane: 4,
        entities: {},
      },
      message: {
        text_body: 'Please process the wire transfer for the invoice',
        from_trust_level: 'known',
        subject: 'wire',
      },
    });
    expect(d.lane).toBe(5);
  });

  it('escalates on money_amount_gte_cents global guard', () => {
    const d = checkRoute({
      classification: {
        trust: 'high',
        sender_class: 'human',
        intent: 'response_needed',
        urgency: 3,
        recommended_lane: 4,
        entities: { money_cents: [50000] },
      },
      message: { text_body: 'payment', from_trust_level: 'known', subject: 'invoice' },
    });
    expect(d.lane).toBe(5);
    expect(d.requiresExtraConfirmation).toBe(true);
  });

  it('uses recommended_lane when no policy applies', () => {
    const d = checkRoute({
      classification: {
        trust: 'medium',
        sender_class: 'human',
        intent: 'response_needed',
        urgency: 1,
        recommended_lane: 4,
        entities: {},
      },
      message: { text_body: 'hi', from_trust_level: 'known', subject: 'hi' },
    });
    expect(d.lane).toBe(4);
  });
});

describe('checkDraft', () => {
  const ctx = (over: Partial<Parameters<typeof checkDraft>[0]> = {}) => ({
    to_emails: ['friend@x.com'],
    cc_emails: [],
    body_text: 'short body',
    thread_participants: ['friend@x.com'],
    owner_email: 'me@x.com',
    ...over,
  });

  it('passes when recipients in scope', () => {
    expect(checkDraft(ctx()).ok).toBe(true);
  });

  it('blocks out-of-scope recipient', () => {
    const r = checkDraft(ctx({ to_emails: ['attacker@evil.com'] }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/attacker@evil.com/);
  });

  it('blocks long base64-looking blob (exfil heuristic)', () => {
    const blob = 'A'.repeat(300);
    const r = checkDraft(ctx({ body_text: `hi ${blob}` }));
    expect(r.ok).toBe(false);
  });

  it('blocks body > 8000 chars', () => {
    const r = checkDraft(ctx({ body_text: 'x'.repeat(9000) }));
    expect(r.ok).toBe(false);
  });

  it('blocks forbidden recipient pattern', () => {
    const r = checkDraft(
      ctx({
        to_emails: ['someone@example.com'],
        thread_participants: ['someone@example.com'],
      }),
    );
    expect(r.ok).toBe(false);
  });
});

describe('checkSend', () => {
  const base = {
    draftId: 'd1',
    to_emails: ['friend@x.com'],
    cc_emails: [],
    bodyHash: 'abc',
    expectedBodyHash: 'abc',
    perHourCount: 0,
    perDayCount: 0,
    perHourLimit: 30,
    perDayLimit: 200,
  };
  it('passes baseline', () => {
    expect(checkSend(base).ok).toBe(true);
  });
  it('blocks when body changed', () => {
    const r = checkSend({ ...base, bodyHash: 'def' });
    expect(r.ok).toBe(false);
  });
  it('blocks at hourly limit', () => {
    const r = checkSend({ ...base, perHourCount: 30 });
    expect(r.ok).toBe(false);
  });
  it('blocks at daily limit', () => {
    const r = checkSend({ ...base, perDayCount: 200 });
    expect(r.ok).toBe(false);
  });
  it('blocks excessive recipients', () => {
    const r = checkSend({
      ...base,
      to_emails: ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com', 'e@x.com', 'f@x.com'],
    });
    expect(r.ok).toBe(false);
  });
});
