# @agentmail/sdk

Tiny TypeScript client for [AgentMail](../README.md) — an agent-native mailbox
that sits in front of a human and turns "agent → human" messages into
human-approved replies.

No dependencies. Uses `node:crypto` for HMAC and the global `fetch`. The
consumer is expected to compile this themselves; there is no build step in
this package.

## 30-second quickstart

```ts
import { AgentMail } from '@agentmail/sdk';

const mail = new AgentMail({
  baseUrl: 'https://maria.agentmail.io',   // or http://localhost:3000 in dev
  agentId: 'acme-scheduler',               // your public slug
  secret:  process.env.AGENTMAIL_SECRET!,  // 'am_live_...'
});

// 1. Send a message. This does NOT reach the human instantly.
const { message_id_hdr, expected_eta_seconds } = await mail.send({
  topic:    'Meeting request for next week',
  body:     'Hi Maria — Alex from Acme would like 30 minutes...',
  priority: 'normal',
});

// 2. Poll until the human approves and the reply ships.
let status = await mail.status(message_id_hdr);
while (status.status !== 'sent' && status.status !== 'rejected') {
  await new Promise(r => setTimeout(r, 10_000));
  status = await mail.status(message_id_hdr);
}

// 3. If we got a reply, read the thread.
if (status.status === 'sent' && status.reply_thread_id) {
  const messages = await mail.threadMessages(status.reply_thread_id);
  for (const m of messages) {
    console.log(`[${m.direction}] ${m.from}: ${m.body}`);
  }
}
```

Run the included example:

```bash
AM_BASE_URL=http://localhost:3000 \
AM_AGENT_ID=acme-scheduler \
AM_SECRET=am_live_xxxxxxxxxxxxxxxx \
npx tsx sdk/example.ts
```

## How to get a key

You need an `agentId` (public slug) and a `secret` (`am_live_...`). Both are
issued by the mailbox owner at registration.

- If **you are the owner**, register an agent through the admin endpoint
  with your bearer token. See the project README's "Receiving real mail"
  section or `POST /api/v1/admin/agents`.
- If **you are an outside agent**, ask the owner to register you. The
  landing page at `https://<baseUrl>/setup` will host self-serve
  registration once available. Until then, contact the owner email listed
  in the mailbox card (see below).

Treat the secret like a password. It is the only thing the server uses to
authenticate you. If it leaks, rotate it via the admin API.

## The "human in the loop" gotcha

Your messages **do not reach the human instantly.** Here's the lifecycle:

1. You `send()`. The server returns `message_id_hdr` and an
   `expected_eta_seconds` hint.
2. The mailbox classifies your message and routes it. Most agent messages
   land in **Lane 4 — Draft for human review.**
3. A drafter writes a proposed reply.
4. The human reviews the draft. They can approve, edit, or reject.
5. Approved drafts go out after a **60-second undo window**.

End-to-end latency is on the order of **minutes**, not seconds. Plan for it.

If your code needs the response synchronously, you have two options:

- Poll `status(message_id_hdr)` until it transitions to `sent` (a reply was
  shipped to you) or `rejected` (the human declined).
- When status is `sent`, read the reply text from
  `threadMessages(status.reply_thread_id)`.

Backoff your polling — once every 10-30 seconds is plenty. Do not poll
faster than once per second; your rate limits will burn out.

## The public mailbox card

Every AgentMail instance publishes a discovery card at:

```
GET https://<baseUrl>/.well-known/agentmail.json
```

It's unauthenticated and tells you:

- the **owner's name and email** (for out-of-band coordination),
- the **HMAC scheme and header names** (so you can verify you're talking to
  a current version of AgentMail),
- the **size limits** (`max_topic_chars`, `max_body_bytes`),
- the default **rate limits** per hour and per day,
- the **undo window** in seconds — i.e. how long after "approve" the
  message can still be recalled,
- the list of **supported topics** the owner explicitly accepts.

Cache the card locally; it doesn't change often. Read it once at startup so
you can fail fast if the mailbox is misconfigured or your message is too big.

```ts
const card = await AgentMail.card('https://maria.agentmail.io');
console.log(card);
```

## API surface

```ts
new AgentMail({ baseUrl, agentId, secret, fetch? });

AgentMail.card(baseUrl, fetch?)                       // GET /.well-known/agentmail.json
mail.send({ topic, body, refs?, priority?, metadata? })
mail.status(messageIdHdr)
mail.threadMessages(threadId, sinceIso?)
```

All authenticated requests carry:

| Header                   | Value                                                            |
|--------------------------|------------------------------------------------------------------|
| `X-AgentMail-Key`        | your `agentId`                                                   |
| `X-AgentMail-Timestamp`  | current `Date.now()` as a string                                 |
| `X-AgentMail-Signature`  | `HMAC-SHA256(sha256(secret), "${timestamp}.${JSON.stringify(body)}")` hex |
| `Content-Type`           | `application/json` (POST only)                                   |

Server allows ±5 minutes of clock skew; if your sends mysteriously 401,
check the system clock.

## Error handling

All client methods throw `Error` with the server's response text on any
non-2xx. There is intentionally no retry logic — wire your own. A `429` is
worth backing off on; a `4xx` other than that is almost certainly a bug in
your call and retrying won't help.

## See also

- [`SKILL.md`](../SKILL.md) — the copy-pasteable "how to talk to this
  mailbox" doc you can drop into another agent's prompt or Claude session.
- [`AGENT_MAILBOX_SPEC.md`](../AGENT_MAILBOX_SPEC.md) — the full spec
  governing the server side.
