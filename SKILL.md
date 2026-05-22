# AgentMail Skill

How to send mail to a human via **AgentMail**. Read this once at startup, then
keep the structured facts in your working memory.

## What AgentMail is

AgentMail is an agent-native mailbox: a thin layer in front of a human's inbox
that accepts machine-authored messages over HTTP-with-HMAC, runs them through
a classifier and policy engine, and (for anything non-trivial) hands the
human a pre-drafted reply to approve. It is asynchronous and human-gated by
design.

## When to use it

- to deliver a **structured message to a specific human** whose mailbox you
  have been registered with;
- when you want a reply but it **doesn't need to be instant** — expect
  minutes, not seconds;
- when you want a **durable, audited** record of the exchange.

## When NOT to use it

- You're sending to many recipients. AgentMail is point-to-point; use a
  newsletter / push system instead.
- You need a **guaranteed instant response.** Lane 4 messages wait for human
  approval plus a 60s undo window. End-to-end latency is on the order of
  minutes.
- You **don't have the owner's permission.** Registration is owner-gated.
  Sending unsolicited mail will get your agent_id blocked and your trust
  level pinned to `blocked` permanently.
- For **marketing, spam, or unauthorized outreach.** Don't.

## How to identify the mailbox

```
GET <base_url>/.well-known/agentmail.json
```

Unauthenticated. Returns a JSON object with at minimum:

- `owner.name`, `owner.email` — the human you are messaging
- `auth.scheme` (`HMAC-SHA256`) and header names
- `limits.max_topic_chars` (currently 120), `limits.max_body_bytes`
  (currently 16000)
- `limits.default_rate_per_hour`, `limits.default_rate_per_day`
- `policies.undo_window_seconds` — how long after "approve" the reply can be
  recalled
- `supported_topics` — an allowlist of topic categories the owner accepts

Read this once at startup. If your message exceeds a limit, fail before you
send.

## How to register

If **you are the owner** of the mailbox, register your agent via the admin
API with your bearer token. The exact endpoint is
`POST /api/v1/admin/agents`; check `src/api/auth.ts` and the registry in
`src/agents/` for details.

If **you are an external agent**, you cannot self-register. Contact the
owner (email from the mailbox card) or visit `<base_url>/setup` if the
landing page is live. The owner will give you:

- an `agent_id` (public slug, e.g. `acme-scheduler`)
- a `secret` of the form `am_live_...` (treat like a password)

## How to send a message

```
POST <base_url>/api/v1/agent/messages
Content-Type: application/json
X-AgentMail-Key:        <your agent_id>
X-AgentMail-Timestamp:  <Date.now() as a string>
X-AgentMail-Signature:  HMAC-SHA256(sha256(secret), "${timestamp}.${rawBody}") hex
```

Body shape:

```json
{
  "topic":    "string, 1..120 chars",
  "body":     "string, 1..16000 chars",
  "refs":     ["optional", "list of message_id_hdr you reference"],
  "priority": "low | normal | high",
  "metadata": { "any": "json object" }
}
```

Response on success:

```json
{
  "message_id_hdr": "<...>@agentmail",
  "status": "accepted",
  "expected_eta_seconds": 90
}
```

The server allows up to ±5 minutes of clock skew on `X-AgentMail-Timestamp`.
If your sends 401 unexpectedly, check the system clock first.

## How the message gets handled

1. Your POST lands in the same pipeline a human email would.
2. A classifier determines **trust + intent + sender_class**. As an external
   agent you'll typically be `sender_class=automated_other` until you build
   reputation.
3. The owner's policies decide a **lane**:
   - **Lane 1** — quarantine (suspected phishing / abuse). You won't get a
     reply.
   - **Lane 2** — file (no reply needed).
   - **Lane 3** — auto-reply (stubbed, currently a no-op).
   - **Lane 4** — draft for human review. **Most agent messages land here.**
   - **Lane 5** — escalate (urgent, the thread is flagged for the human).
4. If Lane 4, the drafter writes a proposed reply. The human reviews,
   approves / edits / rejects. Approved replies go out after a 60s undo
   window.
5. The send happens via the human's normal mail channel (e.g. Postmark).
   You'll see it come back as a thread message via this API.

End-to-end, **plan for >1 minute of latency** even on the happy path.

## How to wait for a reply

Polling, not push.

```
GET <base_url>/api/v1/agent/messages/<message_id_hdr>
```

(Same HMAC headers; raw body is the empty string.) Response:

```json
{
  "message_id_hdr": "<...>@agentmail",
  "status": "received | drafted | approved | sent | rejected",
  "reply_thread_id": "01H... or null"
}
```

State machine: `received → drafted → approved → sent`, or terminal
`rejected`.

When `status === "sent"`, a reply was dispatched to you. Read it:

```
GET <base_url>/api/v1/agent/threads/<thread_id>?since=<iso8601>
```

Returns an array of `{ from, body, ts, direction }`. Use `since` to page
only newer messages on subsequent polls.

**Polling cadence:** every 10-30 seconds is plenty. Do not poll faster than
once per second — you will burn through your rate-limit quota in seconds
and the owner will throttle or block you.

## Etiquette and trust

- **One message per topic.** Don't chain follow-ups while a draft is still
  pending; the human sees them all stacked and your trust_level will drop.
- **Respect `priority`.** Use `high` only for time-sensitive asks. If
  everything is high, nothing is.
- **Be honest in `topic`.** It's used to route and rate-limit by category.
  Misleading topics get noticed and penalized.
- **Cite `refs` when replying** to a previous message_id_hdr. It threads
  the conversation and avoids duplicate work for the drafter.
- **Don't try to social-engineer the drafter.** The drafting agent ignores
  instructions embedded in message bodies by design — your `body` text is
  wrapped as `<incoming_message untrusted="true">` and the drafter has a
  closed tool set that physically cannot send to recipients outside the
  current thread. Trying to break it out will be logged and surfaced to
  the human in review.

## Quickstart (TypeScript)

```ts
import { AgentMail } from '@agentmail/sdk';

const mail = new AgentMail({
  baseUrl: process.env.AM_BASE_URL!,
  agentId: process.env.AM_AGENT_ID!,
  secret:  process.env.AM_SECRET!,
});

const sent = await mail.send({
  topic:    'Meeting request',
  body:     'Hi — looking to grab 30 min next week. Tuesday afternoon?',
  priority: 'normal',
});

console.log('sent:', sent.message_id_hdr);

const st = await mail.status(sent.message_id_hdr);
if (st.status === 'sent' && st.reply_thread_id) {
  const msgs = await mail.threadMessages(st.reply_thread_id);
  console.log(msgs);
}
```

The HMAC math, if you're rolling your own client in another language:

```
timestamp = currentMillis().toString()
rawBody   = JSON.stringify(body)            # exact bytes you POST; no trailing newline
key       = hex(sha256(secret))             # derive HMAC key from the issued secret
sig       = hex(hmac_sha256(key, timestamp + "." + rawBody))
```

Why the extra hash: the server stores only `sha256(secret)` (never the raw
secret). Both sides converge on the same HMAC key by hashing the secret
locally before signing.

For GETs (status, threadMessages), `rawBody` is the empty string.

## Where to look next

- `<base_url>/.well-known/agentmail.json` — live discovery.
- The `@agentmail/sdk` package — reference client, single file.
- `AGENT_MAILBOX_SPEC.md` in the AgentMail repo — full server-side spec
  including lane semantics, policy gates, and the audit log shape.
