# Agent Chat — Backend

Backend for the Agent Chat clone (Magica / Galaxy work trial). Frontend lives in a separate repo.

In short: the frontend sends a message, this backend saves it, starts a durable background run on **Trigger.dev**, and returns straight away. The agent then works in the background — talks to **OpenRouter Free**, loads **skills** when needed, calls **tools** (Crop Image, GPT Image 2, Merge Videos through the Magica API), asks the user for approval when required, and streams progress live. Everything is saved in **Postgres**, so a page reload or a dropped connection doesn't lose anything.

> **Status:** work in progress. Done so far: project setup, env validation, logging, error format, CORS, first database schema with tests. The schema grows feature by feature, one migration per step — see the plan in [`docs/DATA-MODEL.md`](docs/DATA-MODEL.md). Full checklist in [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md).

---

## Tech stack

| Area | What we use |
|---|---|
| Framework | Next.js 16 App Router — **route handlers only**, no UI |
| Language | TypeScript (strict) |
| Database | PostgreSQL on Neon + Prisma 7 (Neon adapter) |
| Auth | Clerk |
| LLM | OpenRouter Free (`openrouter/free` only, no paid fallback) |
| Background jobs + realtime | Trigger.dev v4 |
| Uploads | Transloadit Community + S3 |
| Validation | Zod |
| Tests | Vitest |
| Package manager | pnpm |

---

## Setup

You need Node 22+ and pnpm.

**1. Install**
```bash
pnpm install
```

**2. Env**
```bash
cp .env.example .env
```
Fill every value. The app checks them at startup and tells you exactly which one is missing.

| Key | Where to get it |
|---|---|
| `DATABASE_URL` | Neon → Connect → **pooled** connection string |
| `DIRECT_URL` | Neon → Connect → turn pooling **off** (used only for migrations) |
| `CLERK_SECRET_KEY` | Clerk dashboard → API keys |
| `TRIGGER_SECRET_KEY` | Trigger.dev → project → API keys (dev) |
| `OPENROUTER_API_KEY` | openrouter.ai → Keys |
| `OPENROUTER_MODEL` | must be `openrouter/free` |
| `MAGICA_BASE_URL` / `MAGICA_API_KEY` | supplied for the trial |
| `TRANSLOADIT_KEY` / `TRANSLOADIT_SECRET` | Transloadit → Credentials |
| `CLIENT_ORIGIN` | frontend URL, e.g. `http://localhost:3000` |
| `STARTING_CREDITS` | credits a new user gets, e.g. `100` |
| `MAX_AGENT_TURNS` | safety limit for the agent loop, e.g. `8` |

Also put your Trigger.dev **project ref** (`proj_...`) in `trigger.config.ts`.

**3. Database**
```bash
pnpm db:deploy      # apply migrations
pnpm db:generate    # generate Prisma client
```

**4. Run**
```bash
pnpm dev            # API on http://localhost:4000
pnpm trigger:dev    # Trigger.dev worker (second terminal)
```
Check it's alive: `curl http://localhost:4000/api/v1/health` → `{"ok":true}`

**5. Checks**
```bash
pnpm typecheck
pnpm lint
pnpm test
```
⚠️ Tests in `tests/db/` write to the database in `DATABASE_URL`. Use a separate Neon branch for testing, not your main one.

---

## Project structure

```
src/
  app/api/v1/     HTTP routes — thin: auth → validate → call module → respond
  contracts/      Zod schemas for every shape (shared with the frontend)
  lib/            db, env, errors, logger
  modules/        business logic, one folder per feature (chats, runs, credits…)
  agent/          agent loop, OpenRouter + Magica clients, tools, skills
  trigger/        Trigger.dev tasks
  proxy.ts        CORS
agent-skills/     skills: agent-skills/<name>/SKILL.md
prisma/           schema + migrations (each migration has NOTES.md with rollback SQL)
tests/db/         tests that need a real database
docs/             architecture and design docs
```

We keep it simple on purpose: no empty placeholder files, no barrel `index.ts` files, a file becomes a folder only when it really grows, and unit tests sit next to the code they test.

---

## Architecture overview

![High-level design](docs/hld.png)

Three ideas drive everything:
1. **The API is quick.** It validates, saves, starts the run, and returns `runId` + a realtime token. It never waits for the AI.
2. **Trigger.dev does the long work.** One durable task per agent turn. Waiting (approvals, Magica polling) doesn't burn compute.
3. **Postgres is the source of truth.** Realtime is only for live UI. After a reload, the frontend reads state from the API and reconnects.

**What happens when a user sends a message:**

![Send message flow](docs/lld.png)

**Data model** (target design — tables are added step by step, `prisma/schema.prisma` shows what exists today):

![Data model](docs/data-model.png)

More detail:
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — big picture, request flow, scaling

---

## Design decisions and trade-offs

Only decisions that are already in the code. This table grows as features are built — the full plan with reasons is in [`docs/DECISIONS.md`](docs/DECISIONS.md).

| Decision | Why | Trade-off |
|---|---|---|
| Backend is a separate Next.js app with only route handlers | Trial needs two repos + REST via Next.js route handlers (confirmed on Slack) | Two deploys, CORS between them |
| One active run per chat enforced by a **partial unique index** in Postgres | The DB guarantees it even with two tabs or two servers. App-level checks can race. | Raw SQL in the migration that Prisma doesn't know about — a test protects it |
| Foreign keys with `ON DELETE RESTRICT`, soft delete planned via `deletedAt` | Nothing gets deleted by accident; history like runs is never lost | Delete logic (coming with chat management) must filter `deletedAt: null` |
