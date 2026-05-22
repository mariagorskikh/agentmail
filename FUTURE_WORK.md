# Future work

Items in spec §16 (explicitly out of scope tonight) and other improvements
that came up during the build. Listed in roughly priority order.

## Out of scope by design (spec §16)

- **Multi-user / multi-tenancy**, auth, sessions. Today: single user, static
  Bearer token.
- **Standing-instructions chat UI** for editing policies. Today: edit
  `config/policies.yaml` and restart the server.
- **OOO autoreply UI** — the Lane 3 hook exists in `route.worker.ts` but
  the auto-action worker is a no-op stub.
- **Calendar integration** (`.ics` parsing, RSVP) — not started.
- **Real-time push** (WebSockets / SSE) — UI polls every 10s.
- **Mobile / native clients**.
- **OAuth into Gmail / Outlook** — we are the mailbox.
- **Importing historical mail**.
- **Self-hosted SMTP** — Postmark only.
- **DKIM/SPF/DMARC configuration UI** — assume Postmark handles it.
- **End-to-end encryption**.

## Deviations from the spec to reconcile

- **Frontend stack**: spec asks for Next.js + shadcn/ui + Tailwind. We ship
  a minimal vanilla-JS SPA served by Fastify (`web/index.html` + `web/app.js`
  + `web/styles.css`). It meets all functional acceptance criteria of spec
  §12 (tabs, thread view, approve/edit/reject, undo countdown, audit
  page) but lacks the component library and design polish. Migrate to
  Next.js when there's time.
- **Migration runner**: spec specifies `node-pg-migrate`. We ship a 60-line
  custom runner (`scripts/migrate.ts`) because raw SQL migrations don't fit
  cleanly into the TS migration mode of node-pg-migrate. The runner records
  applied migrations in `_migrations` and runs each file once in a
  transaction. Switch back if there's a desire to use down-migrations.
- **Prompt caching**: not enabled — the vendored Anthropic SDK version
  doesn't accept `cache_control` on `TextBlockParam`. Re-enable when SDK is
  upgraded. Will reduce per-message classifier latency and cost.

## Improvements that came up during the build

- **Search across messages** (Postgres full-text on `messages.text_body`).
- **Per-contact trust adjustment** from the UI (today: insert/update rows
  in `contacts.trust_level` manually).
- **`requires_extra_confirmation` UX**: today we show a red banner on the
  draft card. The spec hints at a stronger flow (a second confirmation
  step). Wire that up.
- **Dead-letter queue**: ingestion failures retry up to 5 times then throw.
  Persist permanent failures in a `dead_letters` table for replay.
- **Auto-archive after send**: outbound messages currently leave the thread
  in `open` state. Add a heuristic.
- **Reclassify on demand from the UI** (the API exists at
  `POST /api/threads/:id/reclassify`; the UI doesn't surface it).
- **HTML body rendering**: today we display `text_body` only. The sanitized
  `html_body` is in the row but not rendered.
- **Attachment download UX**: API endpoint exists at
  `GET /api/messages/:id/attachments/:attId` but the UI doesn't list
  attachments per message.
- **Tests for the API routes**: today we exercise them via the demo
  script. Add Fastify integration tests with `inject()`.
- **CI** — no GitHub Actions config.
- **Production deployment** — no Dockerfile for the app processes
  (`docker-compose.yml` only covers Postgres + Redis); container build for
  `src/server.ts` and `src/worker.ts` is needed.
