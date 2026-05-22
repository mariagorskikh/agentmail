/**
 * @agentmail/sdk — tiny client for the AgentMail agent-native mailbox.
 *
 * No dependencies. Uses node:crypto for HMAC and the global fetch.
 * The consumer is expected to compile this themselves (no build step here).
 */

import { createHash, createHmac } from 'node:crypto';

// ---------- Public types ----------

export interface AgentMailOptions {
  /** Base URL of the mailbox, e.g. 'http://localhost:3000' or 'https://maria.agentmail.io'. No trailing slash required. */
  baseUrl: string;
  /** Your public agent_id slug (e.g. 'acme-scheduler'). Sent in X-AgentMail-Key. */
  agentId: string;
  /** The HMAC secret issued at registration ('am_live_...'). Never log it. */
  secret: string;
  /** Injectable fetch (for tests). Defaults to global fetch. */
  fetch?: typeof fetch;
}

export interface SendMessageInput {
  /** Short subject/topic of the message. 1..120 chars. */
  topic: string;
  /** Body content. 1..16000 chars. Treated as data, not instructions, by the drafter. */
  body: string;
  /** Optional list of message_id_hdr values this message references. */
  refs?: string[];
  /** Priority hint. 'high' is for time-sensitive asks only. */
  priority?: 'low' | 'normal' | 'high';
  /** Free-form metadata stored alongside the message. */
  metadata?: Record<string, unknown>;
}

export interface SendMessageResult {
  /** Stable header-style message id (RFC5322-ish) you use to poll status. */
  message_id_hdr: string;
  status: 'accepted';
  /** Server's hint at how long the human-in-the-loop pipeline will take. */
  expected_eta_seconds: number;
}

export interface MessageStatus {
  message_id_hdr: string;
  /** Lifecycle state. 'sent' means a reply was dispatched to you. */
  status: 'received' | 'drafted' | 'approved' | 'sent' | 'rejected';
  /** Thread to poll for the actual reply text once status='sent'. */
  reply_thread_id: string | null;
}

export interface ThreadMessage {
  from: string;
  body: string;
  ts: string;
  direction: 'inbound' | 'outbound';
}

// ---------- Internal helpers ----------

function trimSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

function deriveHmacKey(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

function signPayload(secret: string, timestamp: string, bodyJson: string): string {
  const key = deriveHmacKey(secret);
  return createHmac('sha256', key).update(`${timestamp}.${bodyJson}`).digest('hex');
}

async function readErrorText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return `<no body> (${res.status} ${res.statusText})`;
  }
}

// ---------- Client ----------

export class AgentMail {
  private readonly baseUrl: string;
  private readonly agentId: string;
  private readonly secret: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: AgentMailOptions) {
    if (!opts.baseUrl) throw new Error('AgentMail: baseUrl is required');
    if (!opts.agentId) throw new Error('AgentMail: agentId is required');
    if (!opts.secret) throw new Error('AgentMail: secret is required');
    this.baseUrl = trimSlash(opts.baseUrl);
    this.agentId = opts.agentId;
    this.secret = opts.secret;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    if (typeof this.fetchImpl !== 'function') {
      throw new Error(
        'AgentMail: no fetch available. Pass `fetch` in options or run on Node >=18.',
      );
    }
  }

  /**
   * Fetch the public mailbox card. Unauthenticated.
   *
   * Useful for discovering owner name, accepted formats, rate limits, and
   * the undo window before sending. Cache the result locally.
   */
  static async card(baseUrl: string, fetcher?: typeof fetch): Promise<unknown> {
    const f = fetcher ?? globalThis.fetch;
    if (typeof f !== 'function') {
      throw new Error('AgentMail.card: no fetch available');
    }
    const url = `${trimSlash(baseUrl)}/.well-known/agentmail.json`;
    const res = await f(url, { method: 'GET' });
    if (!res.ok) {
      throw new Error(`AgentMail.card: ${res.status} ${await readErrorText(res)}`);
    }
    return (await res.json()) as unknown;
  }

  /**
   * Send a structured message to the mailbox owner.
   *
   * IMPORTANT: This does NOT reach the human instantly. Most messages
   * land in Lane 4 (queued for human-approved reply). Plan for >1 minute
   * end-to-end latency including the 60s undo window. Poll {@link status}
   * if you need to wait for a reply.
   */
  async send(input: SendMessageInput): Promise<SendMessageResult> {
    return this.signedJson<SendMessageResult>('POST', '/api/v1/agent/messages', input);
  }

  /**
   * Look up the current status of a message you sent.
   * Status moves through: received -> drafted -> approved -> sent (or rejected).
   */
  async status(messageIdHdr: string): Promise<MessageStatus> {
    const path = `/api/v1/agent/messages/${encodeURIComponent(messageIdHdr)}`;
    return this.signedJson<MessageStatus>('GET', path);
  }

  /**
   * Fetch messages in a thread you're a participant in.
   * Use `sinceIso` (ISO-8601 timestamp) to page only newer messages.
   */
  async threadMessages(threadId: string, sinceIso?: string): Promise<ThreadMessage[]> {
    const qs = sinceIso ? `?since=${encodeURIComponent(sinceIso)}` : '';
    const path = `/api/v1/agent/threads/${encodeURIComponent(threadId)}${qs}`;
    return this.signedJson<ThreadMessage[]>('GET', path);
  }

  // ---------- Internal: signed request ----------

  private async signedJson<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<T> {
    // For GET we still sign — payload is just an empty body. The server's
    // verifyHmac contract is `${timestamp}.${rawBody}`, so for GET the raw
    // body is the empty string.
    const bodyJson = body === undefined ? '' : JSON.stringify(body);
    const timestamp = Date.now().toString();
    const signature = signPayload(this.secret, timestamp, bodyJson);

    const headers: Record<string, string> = {
      'X-AgentMail-Key': this.agentId,
      'X-AgentMail-Timestamp': timestamp,
      'X-AgentMail-Signature': signature,
    };
    if (method === 'POST') {
      headers['Content-Type'] = 'application/json';
    }

    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: method === 'POST' ? bodyJson : undefined,
    });

    if (!res.ok) {
      throw new Error(
        `AgentMail ${method} ${path} failed: ${res.status} ${await readErrorText(res)}`,
      );
    }

    // Some endpoints (e.g. 204 No Content) may have no body; guard against it.
    const text = await res.text();
    if (!text) return undefined as unknown as T;
    return JSON.parse(text) as T;
  }
}
