# Migration: add_tool_invocations

## What
Adds `ToolInvocation` table and `ToolStatus` enum to record tool calls per agent run, preserve run output/duration, and support idempotent dispatch and retries.

## Forward
`pnpm prisma migrate deploy`

## Rollback
```sql
DROP TABLE IF EXISTS "ToolInvocation";
DROP TYPE IF EXISTS "ToolStatus";
```

## Compatibility
Fully backward-compatible. Adds a new table and enum with no breaking changes to existing tables or columns. Old queries on `AgentRun` continue to function without changes.
