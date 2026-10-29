# Error Handling

Doc rule: **every failed turn must be explainable from the UI alone** — status, safe error message, tool outcomes, partial output, and retry path.

For each case: retry? (only when safe) → what we save → what user sees.

| Case | Retry? | What we save | What user sees |
|---|---|---|---|
| OpenRouter 429 / unavailable | Yes, backoff max 3, **only if nothing streamed yet**. No paid fallback. | run `failed` `LLM_UNAVAILABLE`, partial text if any | "Free models are busy right now. Try again in a bit." + Retry |
| OpenRouter empty stream | Same as above | same | same |
| Malformed tool call | Send error back to model once as tool result; if again → stop | tool row `failed`, run continues or fails | tool card shows "Couldn't run this step" |
| Max turns reached | No | run `failed` `MAX_TURNS`, all partial output | "Stopped after too many steps." + Retry |
| Magica 401 | No | tool `failed` `MAGICA_UNAUTHORIZED` | "Image service not available." |
| Magica 429 / network before run created | Yes, backoff | attempts count | spinner continues |
| Magica timeout | No (it may still charge) | tool `failed` `MAGICA_TIMEOUT`, keep `magicaRunId` | tool card failed + Retry |
| Magica run failed | No | tool `failed` + safe reason | tool card failed |
| Cancel mid-run | — | run `cancelled`, partial text, completed tools, credits settled | "Stopped" label, Retry button |
| Reload / switch chat | — | nothing new | `GET /chats/:id/active-run` → reconnect, run continues |
| Realtime drop | Bounded reconnect + token refresh, then REST polling | — | small "Reconnecting…" then normal |
| Duplicate send | — | same `clientRequestId` → same run returned | only one reply |
| Second send while running | — | DB index blocks it → 409 | composer shows Stop instead of Send |
| Stale run (worker died) | — | heartbeat older than X → mark `failed` `STALE_RUN`, release index | failed turn + Retry |
| Not enough credits at send | — | nothing started | "Not enough credits" with balance |
| Credits run out mid-turn | — | stop before next billable tool, charge done work, keep partial | "Ran out of credits" |
| Message / file too big, bad type | — | **rejected before saving** | specific message e.g. "File is over 0.5 GB" |
| Transloadit quota / failed assembly | Retry from UI | attachment `failed` | file chip red + Retry / Remove |
| Duplicate Transloadit webhook | — | ignored (already `ready`) | nothing |
| Temp upload url expired | — | refresh via `GET /attachments/:id` | preview just works |
| Waitpoint not answered | — | `expired`, run stops safely | overlay closes, "Approval timed out. Send again to continue." |
| Other user's chat | — | — | 404, nothing leaked |

## Error codes

Keep the list in `src/contracts/errors.ts` as a Zod enum, so frontend can switch on them:

`UNAUTHORIZED, NOT_FOUND, VALIDATION_FAILED, RATE_LIMITED, RUN_ALREADY_ACTIVE, INSUFFICIENT_CREDITS, CREDITS_EXHAUSTED, LLM_RATE_LIMITED, LLM_UNAVAILABLE, LLM_EMPTY_STREAM, LLM_MALFORMED_TOOL_CALL, MAX_TURNS, MAGICA_UNAUTHORIZED, MAGICA_RATE_LIMITED, MAGICA_TIMEOUT, MAGICA_RUN_FAILED, TOOL_INPUT_INVALID, SKILL_NOT_FOUND, SKILL_INVALID_PATH, SKILL_CHANGED, WAITPOINT_EXPIRED, WAITPOINT_ALREADY_RESOLVED, UPLOAD_TOO_LARGE, UPLOAD_TYPE_NOT_ALLOWED, UPLOAD_QUOTA_EXCEEDED, STALE_RUN, CANCELLED, INTERNAL`

## Logging

Structured JSON logs. Fields: `level, msg, traceId, chatId, runId, messageId, toolInvocationId, waitpointTokenId, processId, code, durationMs`.

- `traceId` is created at the API request and passed into the Trigger task payload, so one turn can be followed end to end.
- Never log: API keys, Authorization headers, full prompts, file contents, raw provider error bodies.
