# Backend Architecture

This doc explains how the backend is built and why. Keep it updated when something big changes.

## 1. The big picture

![High-level design](hld.png)

In simple words:

- **API is quick.** It validates, saves, starts the run and returns `chatId, messageId, runId` + a realtime token. It never waits for the AI.
- **Trigger.dev does the heavy work.** One durable task per agent turn. It can run for minutes, pause for approval, and continue.
- **Postgres is the boss.** Realtime is just transport for live UI. On reload, frontend reads state from DB and reconnects.

## 2. Request flow: user sends a message

![Send message flow](lld.png)

1. `POST /api/v1/chats/:chatId/messages` with `{ content, attachmentIds, clientRequestId, planMode }`.
2. Check: Clerk auth → chat belongs to user → message length → attachments belong to user and are ready → model is `openrouter/free`.
3. Rate limit check (per user).
4. **One DB transaction:**
   - insert user `Message`
   - insert `AgentRun` (status `queued`, `idempotencyKey = clientRequestId`)
   - reserve minimum credits → `CreditLedger` row (`reserve`) + update `User.creditBalance`
   - the partial unique index blocks a 2nd active run in same chat → we return `409 RUN_ALREADY_ACTIVE`
5. Trigger `agent-turn` task with `idempotencyKey = runId`. Save `triggerRunId`.
6. Create a **public realtime token** scoped to only this run.
7. Return `{ chatId, messageId, runId, realtime: { accessToken } }`.

If the same `clientRequestId` comes again (double click / retry), we return the **same** run, we don't create a new one.

## 3. Inside the run (agent-turn task)

Details in `docs/AGENT-RUNTIME.md`. Short version:

```
load run + chat history (bounded) + RunSkill state
build prompt: system + skill names/descriptions + tool list
loop (max N turns):
   call OpenRouter (stream text → realtime text stream)
   if model asks for tools:
       validate input with Zod (registry)
       if tool needs approval → create waitpoint → pause (no compute while waiting)
       run tools (independent ones in parallel, Magica ones as child tasks)
       save ToolInvocation rows + charge credits exactly once
       feed results back to model
   else: final answer → break
save final assistant message, usage, settle credits (refund unused), mark run done
```

## 4. Modules and responsibility

| Folder | Owns |
|---|---|
| `app/api/v1/*` | HTTP only. Thin. |
| `contracts/` | All Zod schemas. Shared with frontend. Imports only `zod`. |
| `modules/chats` | create, list (cursor), search, pin, soft delete |
| `modules/messages` | send turn, list messages (cursor, newest first) |
| `modules/runs` | dispatch, cancel, status, stale run cleanup |
| `modules/credits` | balance, reserve, charge, refund, ledger (append-only) |
| `modules/uploads` | Transloadit signature, webhook, attachment rows |
| `modules/waitpoints` | create, respond (idempotent), expire |
| `agent/loop.ts` | provider-neutral loop |
| `agent/openrouter.ts` | `LlmProvider` interface + OpenRouter adapter |
| `agent/tools` | registry + tools |
| `agent/skills` | skill registry + safe loader |
| `agent/magica.ts` | Magica HTTP client (base URL from env) |
| `trigger/` | Trigger.dev task definitions only — they call into `agent/` and `modules/` |

Dependency direction: `app → modules → lib/db`, `trigger → agent → modules`. Contracts can be imported by anyone. Nothing imports from `app/`.

## 5. Sharing types with the frontend

Doc says: *backend owns contracts, frontend consumes shared types, never redefine.*

Our way: all Zod lives in `server/src/contracts/`. Frontend runs `pnpm sync:contracts`, which copies this folder into `client/src/contracts/` with a "generated, don't edit" header. That copy is committed in the client repo, so Vercel build works without any private package setup.

Why not npm package? For a 3-day trial, publishing a private package + auth on Vercel is extra work and can break deploy. Copy-sync gives the same result: one source, zero hand-written duplicates. (See `docs/DECISIONS.md` D2.)

## 6. Realtime

- **Text** goes through a Trigger.dev realtime **text stream** (token by token).
- **Status/progress** goes through **run metadata** (`status`, `currentStep`, `activeTools`, `thinkingStartedAt`, `waitpoint`, `assets`). Metadata shape is a Zod contract too.
- Frontend uses both, and when the run finishes it refetches messages from REST so the final message comes from DB (no duplicates).
- Token expired / connection dropped → frontend calls `POST /runs/:id/realtime-token` and reconnects; if still failing, polls `GET /runs/:id`.

## 7. Auth

- Frontend gets a Clerk session token and sends `Authorization: Bearer <token>`.
- Backend verifies with Clerk server SDK, then maps `clerkUserId → User` (create on first request, with starting credits from config).
- CORS: only the client origin from env is allowed.

## 8. Scale thinking (doc asks: 100 tools/skills, 1,000 concurrent turns)

- API is stateless and fast → scales horizontally on Vercel.
- Long work is in Trigger.dev, not in API requests. Waiting (approvals, Magica polling) uses `wait.*`, so idle runs don't use compute.
- Tool + skill registries are maps, loaded once. Prompt gets only names/descriptions, so 100 skills don't blow up the prompt.
- All lists are cursor paginated with composite indexes. Message history for the prompt is bounded (last N messages + summary later if needed).
- One active run per chat is enforced by the DB, so no race conditions even with many servers.
- Credits use row-level updates inside transactions + idempotency keys, so parallel tool calls can't double charge.

## 9. Environments / config

All config in `src/lib/env.ts` validated by Zod at startup. Missing env → app fails fast with a clear message. See `.env.example`.

Important ones: `DATABASE_URL`, `CLERK_SECRET_KEY`, `TRIGGER_SECRET_KEY`, `OPENROUTER_API_KEY`, `OPENROUTER_MODEL=openrouter/free`, `MAGICA_BASE_URL`, `MAGICA_API_KEY`, `TRANSLOADIT_KEY`, `TRANSLOADIT_SECRET`, `CLIENT_ORIGIN`, `STARTING_CREDITS`, `MAX_AGENT_TURNS`.
