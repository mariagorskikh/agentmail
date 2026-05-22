import { describe, it, expect } from 'vitest';
import { ClassificationSchema } from '../src/classify/schema.js';
import { heuristicClassify } from '../src/classify/heuristic.js';

describe('ClassificationSchema', () => {
  it('accepts a valid payload', () => {
    const p = ClassificationSchema.parse({
      trust: 'medium',
      sender_class: 'human',
      intent: 'response_needed',
      urgency: 2,
      recommended_lane: 4,
      entities: { people: [], dates: [], money_cents: [], links: [] },
      reasoning: 'looks human',
    });
    expect(p.recommended_lane).toBe(4);
  });

  it('rejects out-of-range lane', () => {
    const r = ClassificationSchema.safeParse({
      trust: 'medium',
      sender_class: 'human',
      intent: 'response_needed',
      urgency: 2,
      recommended_lane: 7,
      entities: { people: [], dates: [], money_cents: [], links: [] },
      reasoning: 'x',
    });
    expect(r.success).toBe(false);
  });

  it('rejects invalid enum', () => {
    const r = ClassificationSchema.safeParse({
      trust: 'super_high',
      sender_class: 'human',
      intent: 'response_needed',
      urgency: 2,
      recommended_lane: 4,
      entities: { people: [], dates: [], money_cents: [], links: [] },
      reasoning: 'x',
    });
    expect(r.success).toBe(false);
  });
});

describe('heuristicClassify', () => {
  it('flags phishing on hostile DMARC + scary phrasing', () => {
    const c = heuristicClassify({
      from_email: 'security@paypaI-secure.example',
      from_name: 'Security',
      subject: 'urgent: verify your account',
      text_body: 'unauthorized login attempt — click here to confirm your password',
      auth_results: { dmarc: 'fail' },
    });
    expect(c.trust).toBe('hostile');
    expect(c.sender_class).toBe('phishing');
    expect(c.recommended_lane).toBe(1);
  });

  it('files marketing newsletter to lane 2', () => {
    const c = heuristicClassify({
      from_email: 'newsletter@updates.example.com',
      from_name: 'Newsletter',
      subject: 'Weekly newsletter',
      text_body: 'tips and content. click to unsubscribe.',
      auth_results: { dmarc: 'pass' },
    });
    expect(c.sender_class).toBe('marketing');
    expect(c.recommended_lane).toBe(2);
  });

  it('routes a human reply to lane 4', () => {
    const c = heuristicClassify({
      from_email: 'sarah@biz.example',
      from_name: 'Sarah',
      subject: 'Re: project',
      text_body: 'Thanks! Can you confirm the start date?',
      auth_results: { dmarc: 'pass' },
    });
    expect(c.sender_class).toBe('human');
    expect(c.recommended_lane).toBe(4);
  });
});
