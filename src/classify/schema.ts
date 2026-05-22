import { z } from 'zod';

export const ClassificationSchema = z.object({
  trust: z.enum(['high', 'medium', 'low', 'hostile']),
  sender_class: z.enum([
    'transactional',
    'marketing',
    'cold_outreach',
    'human',
    'phishing',
    'automated_other',
  ]),
  intent: z.enum([
    'fyi',
    'response_needed',
    'action_needed',
    'decision_needed',
    'scheduling',
    'verification',
    'social',
    'unclear',
  ]),
  urgency: z.number().int().min(0).max(5),
  recommended_lane: z.number().int().min(1).max(5),
  entities: z
    .object({
      people: z.array(z.string()).default([]),
      dates: z.array(z.string()).default([]),
      money_cents: z.array(z.number()).default([]),
      links: z.array(z.string()).default([]),
    })
    .default({ people: [], dates: [], money_cents: [], links: [] }),
  reasoning: z.string().max(1000),
});

export type Classification = z.infer<typeof ClassificationSchema>;

export const PROMPT_VERSION = 'v1';
