# CLAUDE.md

You are building an agent-native mailbox. The full specification is in **`AGENT_MAILBOX_SPEC.md`** — read it before writing any code.

## How to work on this repo

1. **Read `AGENT_MAILBOX_SPEC.md` end-to-end before starting.** It is the source of truth.
2. **Work through Section 14 (Build Order) in order.** Do not skip ahead. Each task has acceptance criteria.
3. **Confirm acceptance criteria before moving to the next task.** Run the test, run the dev server, hit the endpoint. Do not declare a task complete because the code "looks right."
4. **Ambiguity policy**: if the spec is ambiguous, pick the simpler option, leave a `TODO(human)` comment, and continue. Do not stop and wait.
5. **Out-of-scope creep**: if you find yourself adding things not in the spec, stop. Add them to `FUTURE_WORK.md` instead.

## Conventions

- TypeScript everywhere, strict mode on.
- One folder per pipeline stage (`src/edge`, `src/ingest`, `src/classify`, …).
- No ORM. Raw SQL with the `postgres` library (porsager).
- All IDs are ULIDs.
- All times are `timestamptz`, UTC.
- All money is integer cents.
- Errors are thrown, not returned. Workers catch at the top level and log.
- Tests are Vitest. Coverage is behavior-based, not line-based — see spec Section 15.

## What "done" means tonight

Per spec Section 1 "In scope for tonight":

- Real Postmark inbound webhook → message persisted, threaded, classified, routed.
- Lanes 1, 2, 4 fully working. Lane 3 stubbed. Lane 5 marks the thread.
- Drafts created for Lane 4, surfaced in a web UI for approve/edit/reject.
- Approved drafts go out via Postmark with a 60s undo window.
- Policy engine gates every action with capability-bound tools.
- Audit log records every action.
- `docker compose up && npm install && npm run migrate && npm run demo` produces a working populated inbox on a fresh clone.

## What is explicitly NOT done tonight

See spec Section 16. In particular: no multi-user, no calendar, no standing-instructions UI, no real-time push, no mobile, no OAuth.

## If you get stuck

Leave a `TODO(human)` comment with the specific question and continue. The user will resolve it in the morning. Do not stop the build because of one blocker.
