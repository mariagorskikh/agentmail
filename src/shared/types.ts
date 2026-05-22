export type Direction = 'inbound' | 'outbound';
export type TrustLevel = 'blocked' | 'unknown' | 'known' | 'vip' | 'self';
export type ThreadStatus =
  | 'open'
  | 'awaiting_reply'
  | 'snoozed'
  | 'resolved'
  | 'archived'
  | 'quarantined';
export type Lane = 1 | 2 | 3 | 4 | 5;
export type Trust = 'high' | 'medium' | 'low' | 'hostile';
export type SenderClass =
  | 'transactional'
  | 'marketing'
  | 'cold_outreach'
  | 'human'
  | 'phishing'
  | 'automated_other';
export type Intent =
  | 'fyi'
  | 'response_needed'
  | 'action_needed'
  | 'decision_needed'
  | 'scheduling'
  | 'verification'
  | 'social'
  | 'unclear';
export type DraftStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'sent'
  | 'superseded'
  | 'expired';
export type AuditOutcome = 'ok' | 'blocked' | 'error';
export type Actor = 'agent' | 'user' | 'system';

export interface ThreadRow {
  id: string;
  subject_norm: string;
  participants: string[];
  status: ThreadStatus;
  current_lane: Lane | null;
  snoozed_until: Date | null;
  message_count: number;
  last_message_at: Date;
  created_at: Date;
  updated_at: Date;
}

export interface MessageRow {
  id: string;
  thread_id: string;
  direction: Direction;
  message_id_hdr: string;
  in_reply_to: string | null;
  references_hdr: string[];
  from_email: string;
  from_name: string | null;
  to_emails: string[];
  cc_emails: string[];
  bcc_emails: string[];
  subject: string;
  text_body: string | null;
  html_body: string | null;
  raw_headers: Record<string, string>;
  auth_results: Record<string, unknown>;
  received_at: Date;
  created_at: Date;
}

export interface ClassificationRow {
  id: string;
  message_id: string;
  trust: Trust;
  sender_class: SenderClass;
  intent: Intent;
  urgency: number;
  recommended_lane: Lane;
  entities: { people: string[]; dates: string[]; money_cents: number[]; links: string[] };
  reasoning: string;
  model: string;
  prompt_version: string;
  created_at: Date;
}

export interface DraftRow {
  id: string;
  thread_id: string;
  in_reply_to_id: string;
  to_emails: string[];
  cc_emails: string[];
  subject: string;
  body_text: string;
  status: DraftStatus;
  agent_reasoning: string;
  agent_confidence: number;
  tool_calls: unknown[];
  created_at: Date;
  decided_at: Date | null;
  decided_by: string | null;
  send_at: Date | null;
  edited_body: string | null;
}
