// Heuristic fallback classifier — used when ANTHROPIC_API_KEY is missing
// or as a deterministic guess for tests. Conservative.
import type { MessageRow } from '../shared/types.js';
import type { Classification } from './schema.js';

const MARKETING_DOMAINS = [
  'mailchimp',
  'sendgrid',
  'constantcontact',
  'newsletter',
  'updates',
  'marketing',
];
const PHISHING_PHRASES = [
  'verify your account',
  'confirm your password',
  'click here to confirm',
  'unauthorized login attempt',
  'urgent action required',
  'we have detected unusual activity',
  'wire transfer',
];
const TRANSACTIONAL_PATTERNS = [
  'receipt',
  'order #',
  'your order',
  'shipping confirmation',
  'invoice',
  'payment received',
];
const COLD_OUTREACH_PATTERNS = [
  'i came across your',
  'i noticed you',
  'quick question',
  'a quick intro',
  'we help companies like',
  'book a demo',
  'sales pitch',
];

function lower(...parts: (string | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ').toLowerCase();
}

export function heuristicClassify(msg: {
  from_email: string;
  from_name: string | null;
  subject: string;
  text_body: string | null;
  auth_results: { dmarc?: string; spf?: string; dkim?: string };
}): Classification {
  const text = lower(msg.subject, msg.text_body);
  const fromLower = msg.from_email.toLowerCase();
  const dmarc = (msg.auth_results.dmarc ?? '').toLowerCase();

  const isPhish = PHISHING_PHRASES.some((p) => text.includes(p));
  const isMarketing =
    MARKETING_DOMAINS.some((d) => fromLower.includes(d)) ||
    /unsubscribe/i.test(msg.text_body ?? '') ||
    text.includes('newsletter');
  const isTransactional = TRANSACTIONAL_PATTERNS.some((p) => text.includes(p));
  const isCold = COLD_OUTREACH_PATTERNS.some((p) => text.includes(p));

  let trust: Classification['trust'] = 'medium';
  if (dmarc === 'fail') trust = 'hostile';
  else if (isPhish) trust = 'hostile';
  else if (dmarc === 'pass') trust = 'medium';

  let senderClass: Classification['sender_class'] = 'human';
  if (isPhish) senderClass = 'phishing';
  else if (isTransactional) senderClass = 'transactional';
  else if (isMarketing) senderClass = 'marketing';
  else if (isCold) senderClass = 'cold_outreach';

  let intent: Classification['intent'] = 'fyi';
  if (senderClass === 'human') {
    if (/\?/.test(msg.text_body ?? '')) intent = 'response_needed';
    else if (/schedule|meeting|calendar/i.test(text)) intent = 'scheduling';
    else intent = 'response_needed';
  } else if (senderClass === 'transactional') intent = 'fyi';
  else if (senderClass === 'marketing') intent = 'fyi';
  else if (senderClass === 'phishing') intent = 'verification';
  else if (senderClass === 'cold_outreach') intent = 'fyi';

  let lane: Classification['recommended_lane'] = 4;
  if (senderClass === 'phishing') lane = 1;
  else if (senderClass === 'marketing') lane = 2;
  else if (senderClass === 'cold_outreach') lane = 2;
  else if (senderClass === 'transactional') lane = 2;
  else if (senderClass === 'human') lane = 4;

  return {
    trust,
    sender_class: senderClass,
    intent,
    urgency: senderClass === 'human' ? 2 : 1,
    recommended_lane: lane,
    entities: { people: [], dates: [], money_cents: [], links: [] },
    reasoning: `Heuristic classification: ${senderClass} based on header/body patterns.`,
  };
}

export function heuristicClassifyFromRow(row: MessageRow): Classification {
  return heuristicClassify({
    from_email: row.from_email,
    from_name: row.from_name,
    subject: row.subject,
    text_body: row.text_body,
    auth_results: row.auth_results as { dmarc?: string; spf?: string; dkim?: string },
  });
}
