# Backend Requirements Checklist

Everything the task doc asks from the backend, as a checklist. Tick it only when it really works end to end (not just "code written").

Day tags follow the POA: **D1** = day 1, **D2** = day 2 (mid review), **D3** = day 3. **B** = bonus.

## Setup (D1)
- [ ] pnpm, Next.js App Router (route handlers only), TS strict
- [ ] Zod env validation (`src/lib/env.ts`), `.env.example`
- [ ] Prisma + Neon, first migration committed (with raw SQL indexes + NOTES.md)
- [ ] Clerk token verification + user auto-create with starting credits
- [ ] CORS for client origin only
- [ ] Structured logger with traceId
- [ ] Trigger.dev project + `trigger.config.ts`

## Thin slice (D1)
- [ ] `POST /chats/:id/messages`: auth, ownership, size, Zod
- [ ] transaction: user message + AgentRun + reserve
- [ ] trigger `agent-turn` with idempotency key, return `chatId, messageId, runId, realtime token`
- [ ] agent-turn calls OpenRouter Free (`openrouter/free`) with streaming → realtime text stream
- [ ] final assistant message saved as content blocks
- [ ] routed model recorded

## Contracts (D1–D2)
- [ ] Zod for every request/response, message content blocks, tool I/O, run metadata, errors
- [ ] `src/contracts` imports only `zod`

## Tools (D2)
- [ ] registry with full contract (name, description, Zod in/out, estimateCredits, execute, renderKey)
- [ ] `crop_image` real Magica (percent / pixel / crop rect)
- [ ] `gpt_image_2` real Magica (text + edit; fields from Magica model schema)
- [ ] `merge_videos` real Magica (2–100 urls, none/fade/dissolve, order kept)
- [ ] `get_model_info` (configured route + routed model, reject paid models)
- [ ] Magica child task: POST → save runId → poll with backoff + timeout
- [ ] parallel tool calls with deterministic order + no double charge
- [ ] agent picks tools from intent, can chain (generate → crop)
- [ ] tool rows persist sanitized input, runId, status, duration, credits, urls, safe errors

## Skills (D2)
- [ ] registry: scan, frontmatter Zod, size limits, duplicates rejected
- [ ] only names + descriptions in base prompt
- [ ] `load_skill`, `read_skill_asset` with path normalization + traversal block
- [ ] RunSkill persisted with content hash, dedupe, restore on resume
- [ ] 3 skills shipped
- [ ] tests: selective loading, bad frontmatter, duplicate, unknown, traversal, dedupe, durable resume

## Runs + recovery (D2)
- [ ] one active run per chat (DB index) + 409
- [ ] cancel (idempotent), retry
- [ ] `GET /chats/:id/active-run`, `GET /runs/:id` for reload + REST fallback
- [ ] realtime token refresh route
- [ ] stale run detection (heartbeat)
- [ ] partial output saved progressively

## Credits (D2)
- [ ] balance, grant, reserve, charge once, refund, ledger in same transaction
- [ ] insufficient credits blocks send (402)
- [ ] mid-turn exhaustion stops safely
- [ ] per-tool cost + turn total

## Waitpoints (D2)
- [ ] credit approval
- [ ] plan approval (plan mode)
- [ ] respond endpoint idempotent, resume exactly once
- [ ] expiry clears overlay + clear message

## Uploads (D3)
- [ ] `/uploads/sign` with signed assembly params (secret server-side)
- [ ] Transloadit webhook: verify signature, idempotent completion
- [ ] persist assembly id, status, sanitized metadata, urls, owner, order
- [ ] limits: MIME/type/count, 0.5 GB per file, quota errors, expired temp urls

## Chat management (D3)
- [ ] cursor pagination for chats + messages (newest first, older cursor)
- [ ] search title + message content
- [ ] pin without breaking cursor
- [ ] soft delete with ownership checks on every mutation

## Quality (D3)
- [ ] Vitest: registry, skills, credits, idempotency, one-active-run
- [ ] Magica failure fixtures: 401, 429, timeout, failed run, duplicate dispatch
- [ ] acceptance: one real conversation per Magica tool + one chained
- [ ] README: setup, architecture, decisions/trade-offs, what next
- [ ] deployed on Vercel + Trigger.dev deployed

## Bonus (B)
- [ ] versioned public REST API with API keys
- [ ] signed outbound webhooks (agent.started/completed/failed, tool.completed)
- [ ] Mintlify docs incl. Webhooks section
- [ ] MCP server (optional)
