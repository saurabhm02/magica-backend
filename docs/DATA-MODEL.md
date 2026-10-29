# Data Model (Postgres + Prisma)

All app data lives in **Postgres only** (doc says no Mongo, no second DB). This file explains every table and why we need it. 

![Data model](data-model.png)

The diagram shows the full target design. A few names changed during review (`kind` → `type`, run status `done` → `succeeded`) — the tables below and `prisma/schema.prisma` are the source of truth.

> This file is the **target design**. We don't create everything on day 1 — the schema grows with the features, one migration per step (plan below). `prisma/schema.prisma` is always the current truth.

## Migration plan

| Step | Migration | Adds |
|---|---|---|
| S1 ✅ | `create_chats_messages_runs` | `User`, `Chat`, `Message`, `AgentRun` (core fields), one-active-run partial index |
| S5 | `add_tool_invocations` | `ToolInvocation` + `ToolStatus` enum |
| S6 | `add_run_skills` | `RunSkill` |
| S7 | `add_credits` | `User.creditBalance` + `>= 0` check, `CreditLedger` + `LedgerType`, `AgentRun.reservedCredits/chargedCredits`, `ToolInvocation.credits` |
| S8 | `add_waitpoints` | `Waitpoint` + `WaitpointType/WaitpointStatus`, `AgentRun.planMode` |
| S9 | `add_run_heartbeat` | `AgentRun.heartbeatAt` + `@@index([status, heartbeatAt])` |
| S10 | `add_attachments` | `Attachment` + `AttachmentType/AttachmentStatus` |
| S11 | `add_search` | `pg_trgm`, trigram index on `Chat.title`, `Message.searchText` + trigram index |

Rules for every new migration:
- new columns are nullable or have a default (old code keeps working during deploy)
- each migration folder gets a `NOTES.md` (what, forward, rollback SQL, compatibility)
- open the generated SQL and make sure Prisma isn't dropping our raw SQL indexes

## Quick view

```
User ──< Chat ──< Message ──< Attachment
  │        │          ▲
  │        └──< AgentRun >── (userMessage / assistantMessage, both point back to Message)
  │                 ├──< ToolInvocation
  │                 ├──< RunSkill
  │                 └──< Waitpoint
  └──< CreditLedger (also points to AgentRun / ToolInvocation)
```

`──<` means one-to-many.

## Tables in simple words

| Table | What it is | Why we need it (doc requirement) |
|---|---|---|
| `User` | logged-in person + credit balance | owner of everything, credit balance |
| `Chat` | one conversation | chat management, pagination, search, pin, delete |
| `Message` | one message, content as ordered blocks | persistence, content blocks in JSONB |
| `Attachment` | one uploaded file | Transloadit: assembly id, status, metadata, urls, owner |
| `AgentRun` | one AI turn | durable run, one active run per chat, recovery |
| `ToolInvocation` | one tool call | tool cards after reload, charge once, Magica runId |
| `RunSkill` | which skill (and version) a run loaded | skill durability (`contentHash`) |
| `Waitpoint` | one approval question | resume exactly once, survives reload |
| `CreditLedger` | every credit change, never edited | append-only ledger |

## Prisma schema

```prisma
enum MessageRole     { user assistant system tool }
enum MessageStatus   { pending streaming complete failed cancelled }
enum RunStatus       { queued running waiting succeeded failed cancelled }
enum ToolStatus      { pending running succeeded failed cancelled }
enum WaitpointType   { credit plan options media }
enum WaitpointStatus { pending approved declined expired }
enum AttachmentStatus { uploading processing ready failed }
enum AttachmentType   { image video audio }
enum LedgerType       { grant reserve charge refund }

model User {
  id            String         @id @default(cuid())
  clerkUserId   String         @unique
  creditBalance Int            @default(0)
  createdAt     DateTime       @default(now())
  chats         Chat[]
  runs          AgentRun[]
  ledger        CreditLedger[]
  attachments   Attachment[]
}

model Chat {
  id        String     @id @default(cuid())
  userId    String
  user      User       @relation(fields: [userId], references: [id])
  title     String     @default("New chat")
  pinned    Boolean    @default(false)
  deletedAt DateTime?
  createdAt DateTime   @default(now())
  updatedAt DateTime   @updatedAt
  messages  Message[]
  runs      AgentRun[]

  @@index([userId, pinned(sort: Desc), updatedAt(sort: Desc), id(sort: Desc)])
}

model Message {
  id                    String        @id @default(cuid())
  chatId                String
  chat                  Chat          @relation(fields: [chatId], references: [id])
  role                  MessageRole
  status                MessageStatus
  content               Json          // ContentBlock[] — validated by Zod before every write
  clientRequestId       String?       // idempotent send
  createdAt             DateTime      @default(now())
  updatedAt             DateTime      @updatedAt
  attachments           Attachment[]
  runsAsUserMessage     AgentRun[]    @relation("RunUserMessage")
  runAsAssistantMessage AgentRun?     @relation("RunAssistantMessage")

  @@unique([chatId, clientRequestId])
  @@index([chatId, createdAt(sort: Desc), id(sort: Desc)])
}

model Attachment {
  id                String           @id @default(cuid())
  userId            String
  user              User             @relation(fields: [userId], references: [id])
  messageId         String?          // null until message is sent
  message           Message?         @relation(fields: [messageId], references: [id])
  position          Int              @default(0) // keep attachment order
  assemblyId        String?
  transloaditFileId String?
  status            AttachmentStatus
  type              AttachmentType
  mime              String
  sizeBytes         Int
  originalName      String           // sanitized
  url               String?
  urlExpiresAt      DateTime?
  createdAt         DateTime         @default(now())

  @@unique([assemblyId, transloaditFileId])
  @@index([assemblyId])
  @@index([userId, createdAt])
  @@index([messageId, position])
}

model AgentRun {
  id                 String           @id @default(cuid())
  chatId             String
  chat               Chat             @relation(fields: [chatId], references: [id])
  userId             String
  user               User             @relation(fields: [userId], references: [id], onDelete: Restrict)
  userMessageId      String
  userMessage        Message          @relation("RunUserMessage", fields: [userMessageId], references: [id], onDelete: Restrict)
  assistantMessageId String?          @unique
  assistantMessage   Message?         @relation("RunAssistantMessage", fields: [assistantMessageId], references: [id], onDelete: Restrict)
  status             RunStatus        @default(queued)
  idempotencyKey     String           @unique
  triggerRunId       String?          @unique
  reservedCredits    Int              @default(0)
  chargedCredits     Int              @default(0)
  routedModel        String?
  usage              Json?            // tokens etc. (0 credits)
  error              Json?            // safe error { code, message, retryable }
  planMode           Boolean          @default(false)
  heartbeatAt        DateTime?
  startedAt          DateTime?
  finishedAt         DateTime?
  createdAt          DateTime         @default(now())
  updatedAt          DateTime         @updatedAt
  tools              ToolInvocation[]
  skills             RunSkill[]
  waitpoints         Waitpoint[]
  ledger             CreditLedger[]

  @@index([chatId, createdAt])
  @@index([userMessageId])
  @@index([status, heartbeatAt])
}

model ToolInvocation {
  id             String         @id @default(cuid())
  runId          String
  run            AgentRun       @relation(fields: [runId], references: [id])
  toolCallId     String         // id from the LLM
  order          Int            // keep result order deterministic
  toolName       String
  status         ToolStatus     @default(pending)
  input          Json           // sanitized
  output         Json?
  magicaRunId    String?
  credits        Int            @default(0)
  durationMs     Int?
  error          Json?
  idempotencyKey String         @unique
  createdAt      DateTime       @default(now())
  updatedAt      DateTime       @updatedAt
  ledger         CreditLedger[]

  @@unique([runId, toolCallId])
  @@index([runId, order])
}

model RunSkill {
  id          String   @id @default(cuid())
  runId       String
  run         AgentRun @relation(fields: [runId], references: [id])
  skillName   String
  contentHash String
  loadedAt    DateTime @default(now())

  @@unique([runId, skillName]) // dedupe
}

model Waitpoint {
  id             String          @id @default(cuid())
  runId          String
  run            AgentRun        @relation(fields: [runId], references: [id])
  type           WaitpointType
  status         WaitpointStatus @default(pending)
  tokenId        String          @unique
  idempotencyKey String?         @unique // set when the user responds
  payload        Json            // question shown to user
  response       Json?
  expiresAt      DateTime
  resolvedAt     DateTime?
  createdAt      DateTime        @default(now())

  @@index([runId, status])
}

model CreditLedger {
  id               String          @id @default(cuid())
  userId           String
  user             User            @relation(fields: [userId], references: [id])
  runId            String?
  run              AgentRun?       @relation(fields: [runId], references: [id], onDelete: Restrict)
  toolInvocationId String?
  toolInvocation   ToolInvocation? @relation(fields: [toolInvocationId], references: [id], onDelete: Restrict)
  type             LedgerType
  delta            Int             // + adds, - removes
  balanceAfter     Int
  reason           String
  idempotencyKey   String          @unique
  createdAt        DateTime        @default(now())

  @@index([userId, createdAt(sort: Desc), id(sort: Desc)])
}
```

## Raw SQL in migration (Prisma can't express these)

```sql
-- one active run per chat
CREATE UNIQUE INDEX "AgentRun_one_active_per_chat"
  ON "AgentRun" ("chatId")
  WHERE status IN ('queued', 'running', 'waiting');

-- search chat titles + message text (simple and fast enough)
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX "Chat_title_trgm" ON "Chat" USING gin (title gin_trgm_ops);

-- credits can never go negative, no matter what app code does
ALTER TABLE "User" ADD CONSTRAINT "User_creditBalance_non_negative" CHECK ("creditBalance" >= 0);
```

Message content search: we keep a plain `searchText` column later if needed (text extracted from blocks), with a trigram index. Not JSONB search.

Steps: `pnpm prisma migrate dev --create-only --name init` → paste SQL at the end → `pnpm prisma migrate dev`.

⚠️ **Watch out:** Prisma doesn't know about these raw objects, so in a *later* migration it may try to `DROP INDEX`/`DROP CONSTRAINT` them. Every time you create a new migration, open the generated SQL and remove any drop of `AgentRun_one_active_per_chat`, `Chat_title_trgm`, or `User_creditBalance_non_negative`. We also have tests that exercise each of these at the DB level, so if one of them ever disappears, the test catches it.

## Small decisions (so you can explain in review)

- **`deletedAt` (soft delete), not `isDeleted`**: runs and the credit ledger point to the chat, and the ledger is history we never lose. One nullable timestamp tells *if* and *when*. Two fields could disagree. All chat queries add `deletedAt: null`.
- **Pinned + cursor**: list order is `(pinned desc, updatedAt desc, id desc)` and the cursor includes all three, so pinning doesn't break pagination. The index carries the same three directions so Postgres can walk it without a sort.
- **`clientRequestId` unique per chat**: double click on send returns the same message/run.
- **`balanceAfter` in ledger**: makes debugging easy, you can see the balance at each step.
- **ints for credits**: no floating point money bugs.
- **`User.creditBalance >= 0` as a DB check, not just app logic**: credit bugs are exactly the kind of thing we want to be impossible, not just "tested". The constraint catches any code path (including ones we haven't written yet) that would push a balance negative.
- **`AgentRun.userMessageId` is not unique**: a failed run can be retried against the same user message, producing a second `AgentRun` row for it. The thing we actually can't have twice is *two active runs in the same chat*, which `AgentRun_one_active_per_chat` enforces directly — not the message relation.
- **`AgentRun.assistantMessageId` stays unique**: unlike the user message, exactly one assistant message is ever produced per successful run.
- **`type` not `kind`**: `Waitpoint.type`/`WaitpointType` and `Attachment.type`/`AttachmentType` — one name for "what kind of thing is this" across the schema. `Attachment.type` is now a real enum instead of a free string, so bad values can't be inserted.
- **`Attachment.assemblyId` not unique alone**: paired with `transloaditFileId` in `@@unique([assemblyId, transloaditFileId])`. One Transloadit assembly can produce multiple output files (e.g. a video plus a thumbnail), each becoming its own `Attachment` row with the same `assemblyId`.
- **Real foreign keys everywhere, `onDelete: Restrict`**: every id-shaped field now points at its table with an actual FK, and the ones that didn't already default to it set `onDelete: Restrict` explicitly (Prisma's default for an *optional* relation is `SetNull`, which would silently erase history — e.g. a `CreditLedger` row losing its `runId`). We never hard delete, so restrict is always correct.

## Migration notes (doc asks forward/rollback notes)

Each migration folder gets a short `NOTES.md`:
- what it changes
- forward: `prisma migrate deploy`
- rollback: the manual SQL to undo (Prisma has no auto down-migrations)
- compatibility: is old code still OK with the new schema? (add columns nullable first, backfill, then make required)
