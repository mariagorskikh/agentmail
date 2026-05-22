import sanitizeHtml from 'sanitize-html';
import type { PostmarkInbound } from '../edge/postmark.schema.js';

export interface ParsedMessage {
  messageIdHdr: string;
  inReplyTo: string | null;
  references: string[];
  fromEmail: string;
  fromName: string | null;
  toEmails: string[];
  ccEmails: string[];
  bccEmails: string[];
  subject: string;
  textBody: string | null;
  htmlBody: string | null;
  rawHeaders: Record<string, string>;
  authResults: { spf: string; dkim: string; dmarc: string; raw: string };
  receivedAt: Date;
}

function headerMap(headers: { Name: string; Value: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers) out[h.Name.toLowerCase()] = h.Value;
  return out;
}

function pickFirst(s: string): string {
  return s.split(',')[0]?.trim() ?? '';
}

function extractAngle(s: string): string | null {
  // RFC 5322 message-id: <abc@example.com>
  const m = s.match(/<([^>]+)>/);
  if (m) return m[1] ?? null;
  return s.trim() || null;
}

function extractReferences(s: string): string[] {
  if (!s) return [];
  const matches = s.match(/<[^>]+>/g);
  if (!matches) return [];
  return matches.map((m) => m.slice(1, -1));
}

function parseAuthResults(raw: string): { spf: string; dkim: string; dmarc: string; raw: string } {
  const lower = raw.toLowerCase();
  const get = (label: string) => {
    const re = new RegExp(`${label}\\s*=\\s*([a-z]+)`);
    const m = lower.match(re);
    return m?.[1] ?? 'unknown';
  };
  return {
    spf: get('spf'),
    dkim: get('dkim'),
    dmarc: get('dmarc'),
    raw,
  };
}

function uniqLower(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of arr) {
    const l = a.trim().toLowerCase();
    if (!l) continue;
    if (!seen.has(l)) {
      seen.add(l);
      out.push(l);
    }
  }
  return out;
}

const HTML_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'p',
    'br',
    'div',
    'span',
    'strong',
    'em',
    'b',
    'i',
    'u',
    'a',
    'ul',
    'ol',
    'li',
    'blockquote',
    'pre',
    'code',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'table',
    'thead',
    'tbody',
    'tr',
    'td',
    'th',
    'hr',
    'img',
  ],
  allowedAttributes: {
    a: ['href', 'name', 'target', 'rel', 'data-original-href'],
    img: ['src', 'alt', 'title', 'width', 'height'],
    '*': ['style', 'class'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  transformTags: {
    a: (tagName, attribs) => ({
      tagName: 'a',
      attribs: {
        ...attribs,
        rel: 'noopener noreferrer',
        'data-original-href': attribs.href ?? '',
      },
    }),
  },
  allowedSchemesByTag: {},
  disallowedTagsMode: 'discard',
};

export function sanitize(html: string): string {
  if (!html) return '';
  return sanitizeHtml(html, HTML_OPTIONS);
}

export function parseInbound(payload: PostmarkInbound): ParsedMessage {
  const hmap = headerMap(payload.Headers);
  const realMessageId = extractAngle(hmap['message-id'] ?? payload.MessageID) ?? payload.MessageID;
  const inReplyTo = hmap['in-reply-to'] ? extractAngle(hmap['in-reply-to']) : null;
  const references = extractReferences(hmap['references'] ?? '');
  const authResultsRaw = hmap['authentication-results'] ?? '';
  const authResults = parseAuthResults(authResultsRaw);

  const toEmails = uniqLower(
    payload.ToFull && payload.ToFull.length > 0
      ? payload.ToFull.map((a) => a.Email)
      : payload.To.split(',').map((s) => s.trim()),
  );
  const ccEmails = uniqLower(
    payload.CcFull && payload.CcFull.length > 0
      ? payload.CcFull.map((a) => a.Email)
      : payload.Cc.split(',').map((s) => s.trim()),
  );
  const bccEmails = uniqLower(
    payload.BccFull && payload.BccFull.length > 0
      ? payload.BccFull.map((a) => a.Email)
      : payload.Bcc.split(',').map((s) => s.trim()),
  );

  let receivedAt = new Date();
  if (payload.Date) {
    const d = new Date(payload.Date);
    if (!Number.isNaN(d.getTime())) receivedAt = d;
  }

  return {
    messageIdHdr: realMessageId,
    inReplyTo,
    references,
    fromEmail: payload.FromFull?.Email ?? pickFirst(payload.From),
    fromName: payload.FromName || payload.FromFull?.Name || null,
    toEmails,
    ccEmails,
    bccEmails,
    subject: payload.Subject ?? '',
    textBody: payload.TextBody || null,
    htmlBody: payload.HtmlBody ? sanitize(payload.HtmlBody) : null,
    rawHeaders: hmap,
    authResults,
    receivedAt,
  };
}
