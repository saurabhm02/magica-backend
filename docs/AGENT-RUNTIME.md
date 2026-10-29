# Agent Runtime — loop, tools, skills, waitpoints, credits

This is the heart of the backend. Read this before touching `src/agent/` or `src/trigger/`.

---

## 1. Agent turn task (`trigger/agent-turn.ts`)

![Send message flow](lld.png)

One Trigger.dev task = one agent turn (one user message → one final assistant reply).

```
input: { runId }

1. load AgentRun. If status is already terminal → exit (idempotent re-delivery).
2. mark run `running`, set metadata.status = "thinking"
3. load chat history (bounded, newest N messages) + already-loaded RunSkills
4. build prompt:
     - system prompt
     - skill catalog (only name + description)
     - tool list from registry (name, description, JSON schema from Zod)
5. for turn in 1..MAX_AGENT_TURNS:
     stream = llm.stream(messages, tools)
     - pipe text deltas → realtime text stream
     - collect thinking/reasoning blocks
     - collect tool calls
     if no tool calls → final answer, break
     validate each tool call input (Zod). Bad input → send error back to model as tool result (counts as a turn)
     approvals: if any call needs approval → waitpoint (see section 4)
     run tools (section 3) → append tool results to messages
6. save assistant Message (ordered content blocks), usage, actual routed model
7. settle credits (refund unused reserve)
8. mark run `succeeded` / `failed` / `cancelled`, final metadata
```

Max turns hit → stop safely, save what we have, status `failed` with code `MAX_TURNS`.

Cancel → frontend calls `POST /runs/:id/cancel` → we cancel the Trigger run + mark `cancelled` + settle credits. Partial text is kept and shown.

### Partial output is precious
We save streamed text progressively (every few seconds / on each tool boundary) into the assistant message with status `streaming`. If the task crashes, the user still sees what was written. Doc says: *preserve streamed text, tool results, generated assets, and the failed assistant turn.*

---

## 2. LLM provider (`agent/llm.ts`)

One function: `streamChat(messages, signal)`, an async generator yielding `text-delta`, `usage`, `done` (with the actual routed model, for Model Discovery), or a single `error` event. It talks to any OpenAI-compatible endpoint through the official `openai` package — nothing in the file mentions OpenRouter by name, so swapping providers later is a `baseURL`/`apiKey` change, not a rewrite.
- Retries (429, 5xx, network) are the SDK's `maxRetries` option, which only retries before the stream starts — exactly our rule, so there's no retry loop to write.
- HTTP errors map to our own codes: `429 → LLM_RATE_LIMITED`, `5xx/network → LLM_UNAVAILABLE` (both retryable), other `4xx → LLM_UNAVAILABLE` (not retryable, a bad key won't fix itself). No paid fallback. Tool-calling (`LLM_MALFORMED_TOOL_CALL`, `tool-call`/`reasoning-delta` events) lands when tools do (S5+).

---

## 3. Tool registry (`agent/tools/`)

```ts
defineTool({
  name: "crop_image",
  description: "Crop an image ...",
  inputSchema: CropImageInput,     // from contracts
  outputSchema: CropImageOutput,   // from contracts
  renderKey: "image-result",       // frontend picks renderer by this
  needsApproval: (input, ctx) => ctx.estimate > ctx.approvalThreshold,
  estimateCredits: (input) => CREDIT_COSTS.crop_image,
  execute: async (input, ctx) => { ... return output },
})
```

- `registry.ts` collects all tools into a `Map<name, Tool>`. Loop, prompt builder, credit estimator and API all read from this one map.
- **Adding a tool = add one file + add it to the registry list.** No `if (name === ...)` anywhere else.
- Tools get a `ctx` (runId, userId, signal, logger, magica client). They **return output only**. Orchestrator saves `ToolInvocation`, charges credits, emits realtime.

### Tools we ship

| Tool | What | Notes |
|---|---|---|
| `crop_image` | Magica `crop_image` | `image_url` + one of: percent coords, pixel coords, or `crop.{x,y,width,height}`. Validate full rectangle. Output `image_url`. |
| `gpt_image_2` | Magica `gpt_image_2` | mode `text` (`gpt-image-2-text`) for new, `edit` (`gpt-image-2-edit`) when user gives an image. **Input fields come from Magica model schema**, fetched + cached, not hardcoded. |
| `merge_videos` | Magica `merge_videos` | 2–100 ordered `video_urls`, transition `none \| fade \| dissolve`. Keep order. Output `video_url`. |
| `get_model_info` | model discovery | returns configured route `openrouter/free` + last routed model. |
| `load_skill` | skills | returns SKILL.md body |
| `read_skill_asset` | skills | returns one allowed asset file |

### Parallel tool calls
- If the model asks for 3 tools at once, run independent ones in parallel (`batch.triggerAndWait` for Magica child tasks).
- Results are put back **in the original tool-call order** (`ToolInvocation.order`). Charges are per invocation with idempotency key `charge:<toolInvocationId>`, so parallel = no double charge.

### Magica child task (`trigger/magica-run.ts`)

```
input: { toolInvocationId, nodeType, params }
1. if ToolInvocation already has magicaRunId → skip POST, go to polling (resume safe)
2. POST {MAGICA_BASE_URL}/v1/nodes/{nodeType}/run   (Bearer key, server only)
3. save magicaRunId immediately
4. poll GET /v1/nodes/runs/{runId} with backoff (2s, 4s, 8s ... max 15s) using wait.for → no compute burn
5. overall timeout (e.g. 10 min) → failed with MAGICA_TIMEOUT
6. success → validate output with Zod → return
```

Error mapping: `401 → MAGICA_UNAUTHORIZED (no retry)`, `429 → MAGICA_RATE_LIMITED (retry with backoff)`, network/5xx before POST succeeded → retry, failed run → `MAGICA_RUN_FAILED (no retry, it may have charged)`.

Never put the Magica key or raw Magica response headers into logs, prompts or DB.

---

## 4. Waitpoints (approvals)

We start with **credit approval** and **plan approval** (confirmed by Bobby). Options/media later, same mechanism.

```
1. create Waitpoint row (type, payload, expiresAt, status=pending)
2. token = wait.createToken({ timeout })   → save tokenId on the row
3. metadata.waitpoint = { id, type, payload }   → frontend shows overlay
4. run status = waiting, then wait.forToken(token)   (task sleeps, no compute)
5. user clicks → POST /waitpoints/:id/respond { decision, idempotencyKey }
     UPDATE ... WHERE id = ? AND status = 'pending'  → only first click wins
     wait.completeToken(tokenId, { decision })
6. task resumes → approved: continue / declined: stop safely
7. timeout → status expired, clear overlay, assistant message says how to continue
```

- **Credit approval**: before a tool whose estimate is above threshold, or total turn estimate above threshold.
- **Plan approval**: when user turned on *plan mode* in composer, the agent first proposes a plan (list of steps), we pause, user approves/edits, then it executes.

---

## 5. Skills (`agent/skills/`)

Folder: `agent-skills/<skill-name>/SKILL.md` (+ optional `.md` guides and small assets).

```md
---
name: image-cropping
description: How to pick crop rectangles for common aspect ratios (1:1, 16:9, 9:16)...
---
# body ...
```

**Registry (startup):**
- scan only `agent-skills/`
- parse YAML frontmatter with Zod (`name` kebab-case, `description` 10–300 chars)
- reject: missing frontmatter, name != folder name, duplicates, file > 64 KB, total skill dir > 512 KB
- keep: `{ name, description, dir, files[] }`

**Loader tools:**
- `load_skill({ name })` → unknown → typed error. Returns body + `contentHash` (sha256).
- `read_skill_asset({ name, path })` → normalize path, must stay inside the skill dir, allowed ext only (`.md .txt .json .csv`), size limit.

**Durability:**
- On load → upsert `RunSkill(runId, skillName, contentHash)` (unique on runId+skillName = dedupe).
- On retry/resume → restore loaded skills from `RunSkill`. If the file's hash changed since, use the stored version? We store the hash; if mismatch we log a warning and fail that load with `SKILL_CHANGED` (safer than silently using different guidance). Decision D7.

**3 skills we ship:**
1. `image-cropping` — aspect ratios, safe areas, how to choose crop params.
2. `image-prompting` — writing good GPT Image 2 prompts, text vs edit mode.
3. `video-merging` — ordering clips, when to use fade vs dissolve vs none.

Skills only guide. Side effects still happen via normal tools with the same auth + credit rules.

---

## 6. Credits

| Step | What happens | Ledger row |
|---|---|---|
| First login | grant `STARTING_CREDITS` | `grant +N` |
| Send | reserve minimum admission amount | `reserve -R` |
| Tool done | charge actual tool cost, once | `charge -C` (key `charge:<toolInvocationId>`) |
| Run ends | refund unused reserve | `refund +X` |
| OpenRouter | record tokens/model, **0 credits** | stored on run usage, not ledger |

- Balance update + ledger insert are always in **the same transaction**.
- Not enough balance at send → `402 INSUFFICIENT_CREDITS`, nothing is started.
- Runs out mid-turn → stop before next billable tool, charge completed work, keep partial results, status `failed` code `CREDITS_EXHAUSTED`.
- Costs per tool live in config (`CREDIT_COSTS`), Bobby said we can set them ourselves.
- Per-tool cost on `ToolInvocation.credits`, turn total on `AgentRun.chargedCredits`.

---

## 7. Run metadata contract (realtime)

```ts
RunMetadata = {
  status: "queued" | "thinking" | "working" | "waiting" | "stopping" | "complete" | "failed" | "cancelled",
  currentStep?: string,
  thinkingStartedAt?: string,
  tools: { id, name, status, startedAt, finishedAt?, renderKey, outputPreview? }[],
  assets: { type: "image" | "video" | "audio", url, toolInvocationId }[],
  waitpoint?: { id, type, payload, expiresAt },
  error?: { code, message, retryable },
}
```

Keep it **small** (bounded updates). Text is NOT in metadata, text goes in the text stream.
