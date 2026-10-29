# AGENTS.md — Backend (server)

Hi agent 👋 Please read this fully before touching any code. This file tells you how this repo works and what rules we follow. If something here is not clear, stop and ask, don't guess.

## What is this repo?

This is the **backend** for our Agent Chat clone (Galaxy Agent Chat, Magica work trial).

Basically the flow is like this:

1. Frontend (separate repo `client`) sends a message to our REST API.
2. We save it in Postgres, reserve some credits, and start a **durable background run** on Trigger.dev.
3. The API returns quickly (it does NOT wait for the AI).
4. Inside Trigger.dev, the agent loop talks to **OpenRouter Free**, loads **skills** when needed, and calls **tools** (Crop Image, GPT Image 2, Merge Videos via Magica).
5. Live progress goes to the browser through **Trigger.dev Realtime**. Final state is always saved in **Postgres**.

**Golden rule: Postgres is the source of truth. Realtime is only for showing live updates.** If realtime and DB disagree, DB wins.

Full picture is in `docs/ARCHITECTURE.md`. Agent runtime details are in `docs/AGENT-RUNTIME.md`.

## Tech stack (fixed by the trial, don't change)

| Thing | What we use |
|---|---|
| Package manager | **pnpm** (not npm, not bun, not yarn) |
| Framework | Next.js App Router, **only Route Handlers** (no UI pages here) |
| Language | TypeScript **strict** |
| DB | PostgreSQL (Neon) + **Prisma** (migrations committed) |
| Auth | Clerk (verify the Bearer token from frontend) |
| LLM | OpenRouter Free, model **`openrouter/free` only**, no paid fallback ever |
| Background jobs | Trigger.dev (tasks, child tasks, waitpoints, realtime) |
| Uploads | Transloadit Community (free) + S3-compatible storage |
| Validation | Zod, at every boundary |
| Tests | Vitest (+ MSW for HTTP mocks) |
| Docs (bonus) | Mintlify |

Don't add new big libraries without asking. If you feel one is needed, explain why in your reply first.

## Commands

```bash
pnpm install
pnpm dev                 # next dev (API on :4000)
pnpm trigger:dev         # trigger.dev dev worker
pnpm db:migrate          # prisma migrate dev
pnpm db:generate         # prisma generate
pnpm test                # vitest
pnpm typecheck           # tsc --noEmit
pnpm lint
```

Before you say "done", run `pnpm typecheck && pnpm test` and tell me the result honestly. If something fails, say it fails. Don't hide it.

## Folder structure

```
src/
  app/api/v1/...        # route handlers — THIN. auth → parse → call module → return
  contracts/            # Zod schemas = single source of truth (shared with client)
  lib/                  # small shared pieces: db, env, errors, logger (auth later)
  modules/              # business logic, one folder per feature
    chats/
      chats.ts          # functions for this feature
      chats.test.ts     # unit tests live next to the code
  agent/
    loop.ts             # provider-neutral agent loop
    llm.ts              # streamChat() for any OpenAI-compatible API
    magica.ts           # Magica API client
    tools/              # registry.ts + one file per tool
    skills/             # registry.ts + loader.ts
  trigger/              # Trigger.dev tasks (agent-turn.ts, magica-run.ts)
  proxy.ts              # CORS (Next 16 name for middleware)
agent-skills/<name>/SKILL.md   # skills live here (path fixed by the trial doc)
prisma/                 # schema.prisma + migrations (each with NOTES.md)
tests/db/               # tests that need the real database
```

Structure rules:
- **No empty files or placeholder folders.** Create a file in the step that actually fills it.
- Start with **one file**. Turn it into a folder only when it really grows (e.g. `magica.ts` → `magica/` if it passes ~300 lines).
- Unit tests next to the code (`x.ts` + `x.test.ts`). Tests that need Postgres go in `tests/db/`.
- No `index.ts` barrel files. Import from the real file.

## Rules we follow (please don't break these)

### Contracts
- Every request body, response, tool input/output, realtime metadata and saved message content has a **Zod schema in `src/contracts/`**.
- `src/contracts/` must import **only `zod`**. No Prisma, no server code. Because frontend copies this folder.
- Infer TS types from Zod (`z.infer`). Don't write the same type twice by hand.

### Route handlers
- Keep them thin: auth → parse with Zod → call a module function → return.
- Every route checks **ownership**. If the chat is not this user's, return **404 not found** (not 403), so we don't leak that it exists.
- Errors always come back in one shape: `{ error: { code, message, retryable, traceId } }`. Use helpers from `src/lib/errors.ts`.

### Database
- Use **transactions** when creating multiple related rows (message + run + credit reserve) and for credit settlement.
- Use **unique idempotency keys** for: dispatch, tool completion, approvals, credit charges.
- **Never** do unbounded queries. Lists use **cursor pagination** with `take` + `(createdAt, id)` cursor.
- JSONB only for validated content blocks and tool payloads. Normal fields (status, role, ids, timestamps) stay as real columns.
- Partial unique index (one active run per chat) is raw SQL inside the migration, because Prisma schema can't express it. Don't remove it.
- **Schema grows per feature.** Each step adds its own migration (names in the plan in `docs/DATA-MODEL.md`) with a `NOTES.md`. Don't add tables or columns for a later step. After generating a migration, read the SQL and make sure it doesn't drop our raw SQL indexes.

### Agent + tools
- Every tool is **one file** with: `name, description, inputSchema, outputSchema, estimateCredits(), execute(), renderKey`. Register it in the registry. Adding a tool must NOT need changes in the loop or other places.
- Tools **never write chat state directly**. They return output; the orchestrator saves it and charges credits.
- Magica calls run as **Trigger.dev child tasks** with polling (use `wait.for` between polls so we don't burn compute).
- Model is always `openrouter/free`. Reject anything else at the boundary.

### Skills
- Only from `agent-skills/<name>/SKILL.md`. Validate frontmatter, size, duplicates at startup.
- Base prompt gets **only names + descriptions**. Body/assets only via `load_skill` / `read_skill_asset` tools.
- Normalize paths, block `../`, block unsupported file types and big files.
- Save `(runId, skillName, contentHash)` in `RunSkill`.

### Secrets (very important)
- Magica key, OpenRouter key, Transloadit secret, Clerk secret, Trigger secret: **server-side env only**.
- Never put them in: responses, logs, prompts, DB rows, error messages, test snapshots.
- Never commit `.env`. Only `.env.example` with empty values.
- Don't sign up / pay for anything. If something needs paid credits, stop and ask.

### Logs
- Use `src/lib/logger.ts` (structured JSON). Always include `chatId, runId, messageId, traceId` and `waitpointTokenId` when relevant.
- Never log full prompts with user files or any secret.

### Code style — write like a senior dev, not like an AI
Code should be simple enough that I can explain any file in a review without reading it twice. Doc also scores "least lines of code for the same functionality".

**Do:**
- Small functions, clear names (`reserveCredits`, not `handleCreditOperation`).
- Straight-line code. Early returns instead of nested `if`s.
- **Constants go in `src/lib/constants.ts`, plain types in `src/lib/types.ts`.** No magic numbers or strings inside functions. Two exceptions: limits the frontend also needs stay in `src/contracts/` (the client copies that folder), and types made from a Zod schema stay next to that schema (`z.infer`).
- URLs and keys always come from env (`src/lib/env.ts`), never hard-coded.
- One way of doing a thing across the repo. Copy the existing pattern before inventing a new one.
- Use what the library already gives (Zod, Prisma, Trigger.dev) before writing helpers.
- Comment only the **why** (a business rule, a gotcha). One line is usually enough.

**Don't (this is the "AI slop" list):**
- ❌ comments that repeat the code (`// increment counter`, `// return the result`)
- ❌ `try/catch` around everything "just in case". Catch only where you can actually handle it or map it to our error code.
- ❌ wrappers around wrappers, `BaseService`, `AbstractFactory`, `Manager`/`Helper`/`Handler` classes with one method
- ❌ interfaces / generics / config options for a second use case that doesn't exist yet
- ❌ re-validating data that Zod already validated at the boundary
- ❌ a `utils.ts` dumping ground. Put helpers next to where they are used.
- ❌ `console.log`, emojis in code, commented-out code, TODOs without a reason
- ❌ big "defensive" null checks on things the types already guarantee
- ❌ adding a library for something that is 5 lines of code
- ❌ `any`, `as unknown as X`, `!` non-null assertions to silence errors

If you write a shortcut on purpose (e.g. simple in-memory cache), mark it with a one-line comment saying the limit and the upgrade path.

**Simple ≠ skipping requirements.** Idempotency, transactions, ownership checks, retries and the error cases in `docs/ERROR-HANDLING.md` are required — keep them, just write them simply.

## Git
Don't commit, push, or create branches. Just make the changes in the working tree and tell me what you changed. I will review and commit myself.

## When you finish a task, reply with
1. What you changed (files)
2. How to test it
3. Result of `pnpm typecheck && pnpm test`
4. Anything you are not sure about or skipped

If the task built a decision from `docs/DECISIONS.md` into real code, add one row for it to the "Design decisions and trade-offs" table in `README.md`. That table lists only what is already built.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
