# AgentMail

An agent-native mailbox — incoming email is ingested via Postmark, classified
by Claude, routed into one of five autonomy lanes, and (for Lane 4) drafted
into a reply that a human reviews before it goes out. Built per
[`AGENT_MAILBOX_SPEC.md`](./AGENT_MAILBOX_SPEC.md).

## What works

- Postmark inbound webhook → message persisted, threaded, classified, routed.
- Lanes 1, 2, 4 fully wired. Lane 3 is a no-op stub. Lane 5 marks the thread.
- Drafting agent uses capability-bound tools — it cannot reply to anyone
  outside the current thread, regardless of what the incoming message says.
- Drafts surfaced in a web UI with **Approve / Edit & Approve / Reject**.
  Approved drafts go out via Postmark with a 60s undo window.
- Policy engine gates routing, drafting, and sending. Every action is recorded
  in an append-only `audit_log` table.
- Heuristic classifier fallback works offline (no `ANTHROPIC_API_KEY` needed
  to demo). With the key set, Claude classifies and drafts.
- All security-sensitive paths covered by behavior-based tests (48 passing).

## Quickstart

```bash
# 1. Provision Postgres + Redis (locally or via docker compose)
docker compose up -d        # or use local services

# 2. Configure
cp .env.example .env        # then edit (set OWNER_EMAIL, ANTHROPIC_API_KEY, etc.)

# 3. Install + migrate + boot
npm install
npx tsx scripts/migrate.ts
npx tsx src/server.ts &
npx tsx src/worker.ts &

# 4. Inject fixtures end-to-end
npx tsx scripts/demo.ts

# 5. Open the UI
open http://localhost:3000/
# Enter your API_TOKEN (from .env) when prompted.
```

## What's in the box

| Path | Purpose |
|---|---|
| `src/edge/` | Postmark inbound webhook, Zod-validated payload, queue dispatch |
| `src/ingest/` | Parse RFC 5322 → DB rows, threading, dedupe, HTML sanitization |
| `src/classify/` | Claude-based classifier with heuristic fallback |
| `src/route/` | Policy-driven router: 1=quarantine, 2=file, 3=auto, 4=draft, 5=escalate |
| `src/draft/` | Drafting agent with capability-bound tools |
| `src/policy/` | Policy engine: `checkRoute`, `checkDraft`, `checkSend` + rate limiting |
| `src/outbound/` | Delayed send via BullMQ, Postmark client, undo support |
| `src/api/` | Fastify routes for threads, drafts, messages, audit |
| `web/` | Single-page UI served by Fastify (vanilla JS, no build step) |
| `config/policies.yaml` | Static policy rules (VIP, phishing, marketing, etc.) |
| `migrations/` | Forward-only SQL migrations |
| `test/` | Vitest suite: threading, policy, classify, tools, ingest, e2e |

## Common operations

```bash
# Run tests
npx vitest run

# Type-check
npx tsc --noEmit

# Reset DB (dev only)
PGPASSWORD=app psql -h localhost -U app -d agentmail \
  -c "TRUNCATE audit_log, drafts, classifications, attachments, messages, threads RESTART IDENTITY CASCADE;"

# Tail logs
tail -f /tmp/server.log /tmp/worker.log

# Inspect Redis queues
redis-cli LRANGE bull:ingest:wait 0 -1
```

## Receiving real mail

1. Get a Postmark account, create an Inbound Stream, and set the webhook URL
   to `https://<your-host>/webhooks/postmark/inbound`.
2. Configure HTTP Basic auth in Postmark to match `POSTMARK_WEBHOOK_TOKEN` (`user:pass`).
3. To test locally, use `cloudflared tunnel --url http://localhost:3000` and
   point Postmark at the tunnel URL.

## Security stance

- Email bodies are treated as **data, never instructions**. They are wrapped
  in `<incoming_message untrusted="true">…</incoming_message>` for the LLM.
- The drafting agent gets a **closed set of tools**, all scoped to the
  current thread. It physically cannot send to a non-participant; the
  `draft_reply` tool rejects out-of-scope recipients before the draft is even
  persisted.
- Every draft passes through `checkDraft()` (forbidden-recipient patterns,
  exfil heuristics, length limit) before insertion.
- Every send passes through `checkSend()` (rate limits, body-hash
  consistency) before going out.
- An append-only `audit_log` records every classify, route, draft, send,
  approve, reject, undo, and block — `actor`, `outcome`, `payload`.

## Tests

48 passing across 6 files:

- `test/threading.test.ts` — all four threading algorithm branches + edge cases
- `test/policy.test.ts` — every yaml policy + draft/send guards
- `test/classify.test.ts` — schema + heuristic fallback
- `test/tools.test.ts` — recipient binding, thread-scope enforcement
- `test/ingest.test.ts` — dedupe, contact upsert, persistence
- `test/e2e.test.ts` — full pipeline per fixture (including prompt-injection
  fixture — verifies the agent cannot exfil to a non-participant address)

Run `npx vitest run`.

## Deviations from the spec

- **Frontend**: spec asks for Next.js. We ship a minimal vanilla-JS SPA
  served by Fastify (`web/index.html` + `web/app.js`). All acceptance
  criteria of spec §12 are met (tabs, thread view, approve/edit/reject,
  undo countdown, audit log page). See `FUTURE_WORK.md`.
- **Migration runner**: we use a custom 60-line runner (`scripts/migrate.ts`)
  instead of `node-pg-migrate`, because that library has a TS migration
  loader that conflicts with raw SQL files.
- **Prompt caching** on the Anthropic system prompts: not enabled in this
  cut because the SDK version vendored here doesn't expose `cache_control`
  in `TextBlockParam`. Functional cost optimization, deferred.

See [`FUTURE_WORK.md`](./FUTURE_WORK.md) for what's deliberately out of scope.
