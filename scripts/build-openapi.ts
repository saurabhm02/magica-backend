import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  ActiveRunResponse,
  CancelRunResponse,
  CreateChatRequest,
  CreateToolRunRequest,
  CreateToolRunResponse,
  CreditBalanceResponse,
  DeleteChatResponse,
  ListAssetsResponse,
  ListChatsResponse,
  ListLedgerResponse,
  ListMessagesResponse,
  ListToolRunsResponse,
  ListToolsResponse,
  MeResponse,
  RespondWaitpointInput,
  RespondWaitpointResponse,
  SendMessageRequest,
  SendMessageResponse,
  ToolDetailResponse,
  ToolRunResponse,
  UpdateChatRequest,
} from "@/contracts/api";
import { Chat } from "@/contracts/chat";
import { ErrorResponse } from "@/contracts/errors";

function toSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  const clean = { ...json };
  delete clean.$schema;
  return clean;
}

const errorSchema = toSchema(ErrorResponse);

function jsonBody(schema: z.ZodType, description?: string) {
  return {
    description,
    required: true,
    content: {
      "application/json": {
        schema: toSchema(schema),
      },
    },
  };
}

function jsonResponse(status: number, description: string, schema?: z.ZodType | Record<string, unknown>) {
  return {
    [status]: {
      description,
      content: {
        "application/json": {
          schema: schema && "parse" in schema ? toSchema(schema as z.ZodType) : schema ?? {},
        },
      },
    },
  };
}

const commonErrorResponses = {
  ...jsonResponse(401, "Unauthorized (missing or invalid Bearer token)", errorSchema),
  ...jsonResponse(500, "Internal server error", errorSchema),
};

const validationErrorResponse = {
  ...jsonResponse(422, "Validation failed for request input", errorSchema),
};

const notFoundResponse = {
  ...jsonResponse(404, "Resource not found", errorSchema),
};

const conflictResponse = {
  ...jsonResponse(409, "Run already active for this chat", errorSchema),
};

export function generateOpenApiSpec(): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "Magica Agent Chat API",
      version: "1.0.0",
      description:
        "Public REST API for Magica Agent Chat: conversational AI runs, multi-turn tool execution, live streaming tokens, credit hold/settlement ledger, and human approval waitpoints.",
    },
    servers: [
      {
        url: "https://magica-server.vercel.app/api/v1",
        description: "Production",
      },
      {
        url: "http://localhost:4000/api/v1",
        description: "Local development server",
      },
    ],
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description: "Clerk session token passed as `Authorization: Bearer <token>` header.",
        },
      },
      schemas: {
        ErrorResponse: errorSchema,
      },
    },
    paths: {
      "/health": {
        get: {
          tags: ["System"],
          summary: "Health check",
          description: "Returns service status. Does not require authentication.",
          security: [],
          responses: {
            ...jsonResponse(200, "Service is healthy", {
              type: "object",
              properties: { ok: { type: "boolean", const: true } },
              required: ["ok"],
            }),
          },
        },
      },
      "/me": {
        get: {
          tags: ["User"],
          summary: "Get current user",
          description: "Returns the authenticated user's ID and account creation timestamp.",
          responses: {
            ...jsonResponse(200, "Current authenticated user", MeResponse),
            ...commonErrorResponses,
          },
        },
      },
      "/me/credits": {
        get: {
          tags: ["Credits"],
          summary: "Get credit balance",
          description: "Returns the authenticated user's current balance in microcredits (1,000,000 microcredits = 1 credit).",
          responses: {
            ...jsonResponse(200, "Current credit balance", CreditBalanceResponse),
            ...commonErrorResponses,
          },
        },
      },
      "/me/credits/ledger": {
        get: {
          tags: ["Credits"],
          summary: "List credit ledger entries",
          description: "Returns paginated ledger entries (grants, reserves, settlements, refunds) showing exact credit audit history.",
          parameters: [
            {
              name: "cursor",
              in: "query",
              required: false,
              description: "Opaque pagination cursor from a previous page",
              schema: { type: "string" },
            },
            {
              name: "limit",
              in: "query",
              required: false,
              description: "Number of records to return (default 20, max 50)",
              schema: { type: "integer", minimum: 1, maximum: 50, default: 20 },
            },
          ],
          responses: {
            ...jsonResponse(200, "Paginated credit ledger entries", ListLedgerResponse),
            ...commonErrorResponses,
          },
        },
      },
      "/chats": {
        get: {
          tags: ["Chats"],
          summary: "List chats",
          description: "Returns paginated chats owned by the user, sorted with pinned chats first, then newest first. Supports search filtering with `q`.",
          parameters: [
            {
              name: "cursor",
              in: "query",
              required: false,
              description: "Opaque pagination cursor from a previous page",
              schema: { type: "string" },
            },
            {
              name: "limit",
              in: "query",
              required: false,
              description: "Number of chats to return (default 20, max 50)",
              schema: { type: "integer", minimum: 1, maximum: 50, default: 20 },
            },
            {
              name: "q",
              in: "query",
              required: false,
              description: "Search keyword matching chat messages",
              schema: { type: "string" },
            },
          ],
          responses: {
            ...jsonResponse(200, "Paginated list of chats", ListChatsResponse),
            ...commonErrorResponses,
          },
        },
        post: {
          tags: ["Chats"],
          summary: "Create a chat",
          description: "Creates a new empty chat conversation.",
          requestBody: jsonBody(CreateChatRequest, "Optional chat title"),
          responses: {
            ...jsonResponse(200, "Newly created chat", Chat),
            ...commonErrorResponses,
            ...validationErrorResponse,
          },
        },
      },
      "/chats/{chatId}": {
        patch: {
          tags: ["Chats"],
          summary: "Update a chat",
          description: "Renames a chat title or pins/unpins it.",
          parameters: [
            {
              name: "chatId",
              in: "path",
              required: true,
              description: "Unique chat ID",
              schema: { type: "string" },
            },
          ],
          requestBody: jsonBody(UpdateChatRequest, "Fields to update (title and/or pinned)"),
          responses: {
            ...jsonResponse(200, "Updated chat", Chat),
            ...commonErrorResponses,
            ...notFoundResponse,
            ...validationErrorResponse,
          },
        },
        delete: {
          tags: ["Chats"],
          summary: "Delete a chat",
          description: "Deletes a chat and all associated messages, runs, and tool invocations.",
          parameters: [
            {
              name: "chatId",
              in: "path",
              required: true,
              description: "Unique chat ID",
              schema: { type: "string" },
            },
          ],
          responses: {
            ...jsonResponse(200, "Chat deleted successfully", DeleteChatResponse),
            ...commonErrorResponses,
            ...notFoundResponse,
          },
        },
      },
      "/chats/{chatId}/messages": {
        get: {
          tags: ["Messages"],
          summary: "List chat messages",
          description: "Returns paginated messages for a chat in reverse chronological order (newest first).",
          parameters: [
            {
              name: "chatId",
              in: "path",
              required: true,
              description: "Unique chat ID",
              schema: { type: "string" },
            },
            {
              name: "cursor",
              in: "query",
              required: false,
              description: "Opaque pagination cursor from a previous page",
              schema: { type: "string" },
            },
            {
              name: "limit",
              in: "query",
              required: false,
              description: "Number of messages to return (default 20, max 50)",
              schema: { type: "integer", minimum: 1, maximum: 50, default: 20 },
            },
          ],
          responses: {
            ...jsonResponse(200, "Paginated list of messages", ListMessagesResponse),
            ...commonErrorResponses,
            ...notFoundResponse,
          },
        },
        post: {
          tags: ["Messages"],
          summary: "Send a message",
          description:
            "Appends a user message to the chat and triggers an asynchronous agent run. Returns the run ID and a read-only Trigger.dev realtime token to stream text and tool steps live.",
          parameters: [
            {
              name: "chatId",
              in: "path",
              required: true,
              description: "Unique chat ID",
              schema: { type: "string" },
            },
          ],
          requestBody: jsonBody(SendMessageRequest, "Message content, clientRequestId for idempotency, and optional planMode"),
          responses: {
            ...jsonResponse(200, "Message sent and agent run dispatched", SendMessageResponse),
            ...commonErrorResponses,
            ...notFoundResponse,
            ...conflictResponse,
            ...validationErrorResponse,
          },
        },
      },
      "/chats/{chatId}/active-run": {
        get: {
          tags: ["Runs"],
          summary: "Get active agent run",
          description:
            "Returns the current in-flight agent run for a chat (status 'queued', 'running', or 'waiting'). Includes a fresh realtime token and any pending waitpoint. Returns null if no run is active.",
          parameters: [
            {
              name: "chatId",
              in: "path",
              required: true,
              description: "Unique chat ID",
              schema: { type: "string" },
            },
          ],
          responses: {
            ...jsonResponse(200, "Active run info or null", ActiveRunResponse),
            ...commonErrorResponses,
            ...notFoundResponse,
          },
        },
      },
      "/chats/{chatId}/runs/{runId}/cancel": {
        post: {
          tags: ["Runs"],
          summary: "Cancel an agent run",
          description: "Cancels an in-progress or queued agent run, refunds any unspent credit holds, and marks the run status as cancelled.",
          parameters: [
            {
              name: "chatId",
              in: "path",
              required: true,
              description: "Unique chat ID",
              schema: { type: "string" },
            },
            {
              name: "runId",
              in: "path",
              required: true,
              description: "Unique run ID to cancel",
              schema: { type: "string" },
            },
          ],
          responses: {
            ...jsonResponse(200, "Run cancelled successfully", CancelRunResponse),
            ...commonErrorResponses,
            ...notFoundResponse,
          },
        },
      },
      "/chats/{chatId}/waitpoints/{id}/respond": {
        post: {
          tags: ["Waitpoints"],
          summary: "Respond to a waitpoint",
          description:
            "Submits answers or actions to a suspended run waitpoint (e.g. human options questionnaire or plan mode approval). Resumes the agent run immediately.",
          parameters: [
            {
              name: "chatId",
              in: "path",
              required: true,
              description: "Unique chat ID",
              schema: { type: "string" },
            },
            {
              name: "id",
              in: "path",
              required: true,
              description: "Unique waitpoint ID",
              schema: { type: "string" },
            },
          ],
          requestBody: jsonBody(
            RespondWaitpointInput,
            "Response answers, skip flag, or plan action (run_all, step_by_step, request_changes)",
          ),
          responses: {
            ...jsonResponse(200, "Waitpoint response recorded and token completed", RespondWaitpointResponse),
            ...commonErrorResponses,
            ...notFoundResponse,
            ...validationErrorResponse,
          },
        },
      },
      "/tools": {
        get: {
          tags: ["Tools"],
          summary: "List available tools",
          description: "Returns visible tools from the registry with categories, descriptions, and estimated microcredits.",
          responses: {
            ...jsonResponse(200, "List of available tools", ListToolsResponse),
            ...commonErrorResponses,
          },
        },
      },
      "/tools/{name}": {
        get: {
          tags: ["Tools"],
          summary: "Get tool details",
          description: "Returns full metadata for a single tool: display name, JSON schema of inputs for building forms, pricing lines, and default credit estimates.",
          parameters: [
            {
              name: "name",
              in: "path",
              required: true,
              description: "Tool name (e.g. gpt_image_2, crop_image, merge_videos)",
              schema: { type: "string" },
            },
          ],
          responses: {
            ...jsonResponse(200, "Tool specification and pricing details", ToolDetailResponse),
            ...commonErrorResponses,
            ...notFoundResponse,
          },
        },
      },
      "/tools/{name}/runs": {
        get: {
          tags: ["Tools"],
          summary: "List tool run history",
          description: "Returns paginated direct execution history for a specific tool.",
          parameters: [
            {
              name: "name",
              in: "path",
              required: true,
              description: "Tool name",
              schema: { type: "string" },
            },
            {
              name: "cursor",
              in: "query",
              required: false,
              description: "Opaque pagination cursor",
              schema: { type: "string" },
            },
            {
              name: "limit",
              in: "query",
              required: false,
              description: "Number of runs to return (default 20, max 50)",
              schema: { type: "integer", minimum: 1, maximum: 50, default: 20 },
            },
            {
              name: "source",
              in: "query",
              required: false,
              description: "Filter runs by origin (ui or api)",
              schema: { type: "string", enum: ["ui", "api"] },
            },
          ],
          responses: {
            ...jsonResponse(200, "Paginated tool runs history", ListToolRunsResponse),
            ...commonErrorResponses,
            ...notFoundResponse,
          },
        },
        post: {
          tags: ["Tools"],
          summary: "Execute a tool directly",
          description:
            "Executes a single tool directly without LLM orchestration. Validates input schema, reserves credits, dispatches execution, and returns a realtime token for live updates.",
          parameters: [
            {
              name: "name",
              in: "path",
              required: true,
              description: "Tool name (e.g. gpt_image_2, crop_image, merge_videos)",
              schema: { type: "string" },
            },
          ],
          requestBody: jsonBody(CreateToolRunRequest, "Validated tool input object matching the tool's inputSchema"),
          responses: {
            ...jsonResponse(200, "Tool run created and dispatched", CreateToolRunResponse),
            ...commonErrorResponses,
            ...notFoundResponse,
            ...validationErrorResponse,
          },
        },
      },
      "/tool-runs/{id}": {
        get: {
          tags: ["Tools"],
          summary: "Get tool run details",
          description: "Returns status, output, credit usage, generated assets, and a fresh realtime token for a direct tool execution.",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              description: "Unique tool invocation / run ID",
              schema: { type: "string" },
            },
          ],
          responses: {
            ...jsonResponse(200, "Tool run details and status", ToolRunResponse),
            ...commonErrorResponses,
            ...notFoundResponse,
          },
        },
      },
      "/assets": {
        get: {
          tags: ["Assets"],
          summary: "List generated assets",
          description: "Returns paginated image and video assets produced by tool invocations across all chats for the user.",
          parameters: [
            {
              name: "cursor",
              in: "query",
              required: false,
              description: "Opaque pagination cursor",
              schema: { type: "string" },
            },
            {
              name: "limit",
              in: "query",
              required: false,
              description: "Number of assets to return (default 20, max 50)",
              schema: { type: "integer", minimum: 1, maximum: 50, default: 20 },
            },
            {
              name: "type",
              in: "query",
              required: false,
              description: "Optional filter by asset type: 'image' or 'video'",
              schema: { type: "string", enum: ["image", "video"] },
            },
          ],
          responses: {
            ...jsonResponse(200, "Paginated list of generated media assets", ListAssetsResponse),
            ...commonErrorResponses,
          },
        },
      },
    },
  };
}

function main() {
  const spec = generateOpenApiSpec();
  const outDir = path.resolve(process.cwd(), "api-docs");
  mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "openapi.json");
  writeFileSync(outPath, JSON.stringify(spec, null, 2));

  const pathCount = Object.keys(spec.paths as Record<string, unknown>).length;
  let operationCount = 0;
  for (const item of Object.values(spec.paths as Record<string, Record<string, unknown>>)) {
    operationCount += Object.keys(item).length;
  }

  console.log(`Generated OpenAPI spec at ${outPath}`);
  console.log(`Paths: ${pathCount}, Operations: ${operationCount}`);
}

main();
