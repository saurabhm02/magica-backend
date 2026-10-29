# REST API (v1)

All routes are under `/api/v1`. All need `Authorization: Bearer <clerk session token>` (except webhooks, which use signatures).

Every request and response body has a Zod schema in `src/contracts/api/`. Frontend uses the same schemas.

## Error shape (same everywhere)

```json
{ "error": { "code": "RUN_ALREADY_ACTIVE", "message": "A reply is already in progress in this chat.", "retryable": false, "traceId": "..." } }
```

`message` is always user-safe. No stack traces, no provider raw errors, no secrets.

## Routes

### Me / credits
| Method | Path | What |
|---|---|---|
| GET | `/me` | user + `creditBalance` (creates user on first call) |
| GET | `/credits/ledger?cursor&limit` | ledger history, newest first |
| GET | `/models` | configured model route (`openrouter/free`) + status |

### Chats
| Method | Path | What |
|---|---|---|
| GET | `/chats?cursor&limit&q` | list (pinned first, then recent). `q` = search title + message text |
| POST | `/chats` | create empty chat |
| PATCH | `/chats/:chatId` | rename / pin / unpin |
| DELETE | `/chats/:chatId` | soft delete (cancels active run first) |
| GET | `/chats/:chatId/messages?cursor&limit` | newest first, `cursor` for older |
| GET | `/chats/:chatId/active-run` | active run if any → used on reload to reconnect |

### Send + runs
| Method | Path | What |
|---|---|---|
| POST | `/chats/:chatId/messages` | **send turn** → `{ chatId, messageId, runId, realtime: { accessToken } }` |
| GET | `/runs/:runId` | run status + tools + waitpoint (REST fallback when realtime fails) |
| POST | `/runs/:runId/cancel` | stop the run (idempotent) |
| POST | `/runs/:runId/retry` | retry a failed/cancelled turn (creates a new run on the same user message) |
| POST | `/runs/:runId/realtime-token` | fresh realtime token (when old one expires) |

Send body:
```json
{ "content": "make a 16:9 cover and crop it square", "attachmentIds": ["att_1"], "clientRequestId": "uuid-from-client", "planMode": false }
```

### Waitpoints
| Method | Path | What |
|---|---|---|
| POST | `/waitpoints/:waitpointId/respond` | `{ decision: "approve" \| "decline", edits?, idempotencyKey }`. First answer wins, duplicates return the same result |

### Uploads
| Method | Path | What |
|---|---|---|
| POST | `/uploads/sign` | returns signed Transloadit assembly params (secret stays here) + creates `Attachment` rows (`uploading`) |
| POST | `/webhooks/transloadit` | assembly finished → verify signature → update attachment (idempotent: duplicate completion is ignored) |
| GET | `/attachments/:id` | status + url (refresh expired temp urls) |

## Status codes we use

| Code | When |
|---|---|
| 400 | Zod validation failed (with field errors) |
| 401 | no / bad token |
| 402 | `INSUFFICIENT_CREDITS` |
| 404 | not found **or not yours** (we don't say which) |
| 409 | `RUN_ALREADY_ACTIVE`, waitpoint already resolved |
| 413 | message / file too big |
| 429 | our rate limit |
| 5xx | our bug — safe message + traceId |

## Bonus (only after core is done)
- Versioned public API with API keys: `POST /v1/messages`, `POST /v1/chat/completions`-style, `POST /v1/tools/:name/run`, `GET /v1/runs/:id`.
- Signed outbound webhooks: `agent.started`, `agent.completed`, `agent.failed`, `tool.completed` (HMAC header, retries).
- Mintlify docs with a Webhooks section.
