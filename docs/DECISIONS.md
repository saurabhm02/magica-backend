# Decisions Log

Short notes on why we chose what we chose. Useful for the daily reviews and the README "design decisions and trade-offs" section. Add a new entry whenever we take a real decision.

Format: **Decision** — why — what we gave up.

---

**D1. Backend = Next.js route handlers only, separate repo from frontend.**
Doc requires two repos and REST via Next.js Route Handlers. API stays thin and stateless, heavy work goes to Trigger.dev.
Trade-off: two deploys, need CORS + token passing between domains.
✅ Confirmed by Bobby on Slack (backend = separate Next.js app, route handlers only).

**D2. Contracts live in `server/src/contracts`, frontend copies them with `pnpm sync:contracts`.**
Backend owns all shapes, frontend never redefines them. Copy-sync avoids private npm package + auth setup on Vercel, which can break deploys in a 3-day trial.
Trade-off: need to remember to sync; frontend CI checks that the copy matches.

**D3. One active run per chat = partial unique index in Postgres.**
DB guarantees it even with two servers and two tabs at the same time. App-level checks have race conditions.
Trade-off: raw SQL in migration, must protect it from Prisma dropping it (test covers it).

**D4. One transaction for user message + AgentRun + credit reserve.**
Either all three exist or none. No orphan runs, no reserve without run.

**D5. Idempotency keys everywhere it matters.**
Send (`clientRequestId`), Trigger dispatch (`runId`), tool charge (`charge:<toolInvocationId>`), approvals (first `pending → resolved` update wins). Double clicks, retries and re-deliveries become safe.

**D6. Magica calls as typed child tasks with polling via `wait.for`.**
Long Magica jobs don't block the agent task and don't burn compute while waiting. `magicaRunId` is saved right after POST, so a resumed task continues polling instead of paying again.

**D7. Skill version is pinned per run by content hash; mismatch on resume = fail that load (`SKILL_CHANGED`).**
Doc says retries/resumes must use the same guidance. Silently loading changed content would break that promise.
Trade-off: if someone edits a skill during a paused run, that run's skill load fails clearly instead of continuing.

**D8. Credits: reserve → charge per tool → refund, in an append-only ledger.**
Like a bank statement: every number explainable. OpenRouter usage recorded at 0 credits as doc says. Costs from config (confirmed with Bobby).

**D9. Retry OpenRouter only before the first token is streamed.**
After text started, retry would show duplicate/different text. So we fail clearly with partial text kept and a Retry button.

**D10. Text in realtime stream, status in run metadata.**
Doc asks to stream text separately from metadata. Metadata stays small; text can be long.

**D11. Soft delete with `deletedAt`.**
Runs + ledger reference chats; ledger is append-only history. One nullable timestamp says if + when.

**D12. Approvals: credit + plan first** (confirmed by Bobby). Same waitpoint mechanism, so options/media are just new `kind` values + a renderer.

**D13. Neon for Postgres** (confirmed by Bobby). Free tier, serverless, pooled connection string for Vercel.

**D14. Search with `pg_trgm` (trigram) indexes, not a search engine.**
Good enough for titles + message text at our scale, no extra service.
