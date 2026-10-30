import { createHmac, randomUUID } from "node:crypto";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { POST as libraryAttachmentRoute } from "@/app/api/v1/attachments/from-library/route";
import { POST as completeUploadRoute } from "@/app/api/v1/uploads/complete/route";
import { POST as uploadParamsRoute } from "@/app/api/v1/uploads/params/route";
import type { CompleteUploadResponse } from "@/contracts/attachment";
import type { ErrorResponse } from "@/contracts/errors";
import * as authModule from "@/lib/auth";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";
import {
  attachToMessage,
  completeUpload,
  createLibraryAttachment,
  createUploadParams,
  formatAuthExpires,
  mapTransloaditError,
  sanitizeFilename,
} from "@/modules/attachments/attachments";
import { createChat } from "@/modules/chats/chats";
import { listMessages, sendMessage } from "@/modules/messages/messages";
import { buildPrompt } from "@/trigger/agent-turn";

const mswServer = setupServer();

let userId: string;
let otherUserId: string;

function make32HexId(): string {
  return randomUUID().replace(/-/g, "").toLowerCase();
}

beforeAll(async () => {
  mswServer.listen();

  const userA = await db.user.create({
    data: { clerkUserId: `test_att_user_a_${randomUUID()}`, creditBalance: 10_000_000n },
  });
  const userB = await db.user.create({
    data: { clerkUserId: `test_att_user_b_${randomUUID()}`, creditBalance: 10_000_000n },
  });
  userId = userA.id;
  otherUserId = userB.id;

  vi.spyOn(authModule, "requireUser").mockImplementation(async (req: NextRequest) => {
    const authHeader = req.headers.get("Authorization");
    if (authHeader?.includes("other_user")) {
      return { id: otherUserId, clerkUserId: "other_clerk", creditBalance: 10_000_000n, createdAt: new Date() };
    }
    return { id: userId, clerkUserId: "user_clerk", creditBalance: 10_000_000n, createdAt: new Date() };
  });
});

afterEach(() => {
  mswServer.resetHandlers();
});

afterAll(async () => {
  mswServer.close();
  await db.attachment.deleteMany({ where: { userId: { in: [userId, otherUserId] } } });
  await db.creditLedger.deleteMany({ where: { userId: { in: [userId, otherUserId] } } });
  await db.toolInvocation.deleteMany({ where: { userId: { in: [userId, otherUserId] } } });
  await db.agentRun.deleteMany({ where: { userId: { in: [userId, otherUserId] } } });
  await db.message.deleteMany({ where: { chat: { userId: { in: [userId, otherUserId] } } } });
  await db.chat.deleteMany({ where: { userId: { in: [userId, otherUserId] } } });
  await db.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
  await db.$disconnect();
});

describe("File Uploads & Attachments", () => {
  describe("1. Signature & Upload Params", () => {
    it("signature matches HMAC-SHA384 of params, expires matches YYYY/MM/DD HH:mm:ss+00:00 format, secret never leaves server", () => {
      const files = [{ name: "photo.png", size: 1024 * 100, type: "image/png" }];
      const result = createUploadParams(userId, files);

      expect(typeof result.params).toBe("string");
      expect(typeof result.signature).toBe("string");
      expect(result.signature.startsWith("sha384:")).toBe(true);

      // Verify HMAC calculation matches
      const expectedDigest = createHmac("sha384", env.TRANSLOADIT_SECRET)
        .update(result.params)
        .digest("hex");
      expect(result.signature).toBe(`sha384:${expectedDigest}`);

      // Verify params contents
      const parsed = JSON.parse(result.params);
      expect(parsed.auth.key).toBe(env.TRANSLOADIT_KEY);
      expect(parsed.fields.userId).toBe(userId);
      expect(parsed.steps[":original"]).toEqual({ robot: "/upload/handle" });

      // Verify expiration format: YYYY/MM/DD HH:mm:ss+00:00
      expect(parsed.auth.expires).toMatch(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\+00:00$/);

      // Secret never leaves server
      expect(result.params).not.toContain(env.TRANSLOADIT_SECRET);
    });

    it("formatAuthExpires produces valid UTC format", () => {
      const date = new Date(Date.UTC(2026, 9, 30, 12, 5, 9));
      expect(formatAuthExpires(date)).toBe("2026/10/30 12:05:09+00:00");
    });

    it("includes S3 store step with credential name and acl bucket-default, and no S3 keys", () => {
      const origCreds = env.TRANSLOADIT_S3_CREDENTIALS;
      try {
        // Without credential: no store step
        delete env.TRANSLOADIT_S3_CREDENTIALS;
        const noStore = createUploadParams(userId, [{ name: "photo.png", size: 500, type: "image/png" }]);
        const parsedNoStore = JSON.parse(noStore.params);
        expect(parsedNoStore.steps.store).toBeUndefined();

        // With credential: store step has acl bucket-default and credential name
        env.TRANSLOADIT_S3_CREDENTIALS = "magica20";
        const result = createUploadParams(userId, [{ name: "photo.png", size: 500, type: "image/png" }]);
        const parsed = JSON.parse(result.params);
        expect(parsed.steps.store).toEqual({
          robot: "/s3/store",
          use: ":original",
          credentials: "magica20",
          acl: "bucket-default",
          path: "uploads/${fields.userId}/${unique_prefix}/${file.url_name}",
        });
        // Never leaks raw S3 credentials or keys in params sent to browser
        expect(parsed.steps.store.key).toBeUndefined();
        expect(parsed.steps.store.secret).toBeUndefined();
        expect(parsed.steps.store.bucket).toBeUndefined();
      } finally {
        if (origCreds !== undefined) {
          env.TRANSLOADIT_S3_CREDENTIALS = origCreds;
        } else {
          delete env.TRANSLOADIT_S3_CREDENTIALS;
        }
      }
    });
  });

  describe("2. Limits Reject Before Saving", () => {
    it("rejects files larger than 500 MB with UPLOAD_TOO_LARGE", async () => {
      const over500MB = 500 * 1024 * 1024 + 1;
      expect(() =>
        createUploadParams(userId, [{ name: "huge.mp4", size: over500MB, type: "video/mp4" }]),
      ).toThrowError(expect.objectContaining({ code: "UPLOAD_TOO_LARGE" }));

      const req = new NextRequest("http://localhost:4000/api/v1/uploads/params", {
        method: "POST",
        body: JSON.stringify({ files: [{ name: "huge.mp4", size: over500MB, type: "video/mp4" }] }),
      });
      const res = await uploadParamsRoute(req, { params: Promise.resolve({}) });
      expect(res.status).toBe(400);
      const json = (await res.json()) as ErrorResponse;
      expect(json.error.code).toBe("UPLOAD_TOO_LARGE");
    });

    it("rejects disallowed MIME types and SVG with UPLOAD_TYPE_NOT_ALLOWED", async () => {
      // SVG removed from allowed list
      expect(() =>
        createUploadParams(userId, [{ name: "vector.svg", size: 100, type: "image/svg+xml" }]),
      ).toThrowError(expect.objectContaining({ code: "UPLOAD_TYPE_NOT_ALLOWED" }));

      // Shell script disallowed
      const req = new NextRequest("http://localhost:4000/api/v1/uploads/params", {
        method: "POST",
        body: JSON.stringify({ files: [{ name: "malware.exe", size: 1000, type: "application/x-msdownload" }] }),
      });
      const res = await uploadParamsRoute(req, { params: Promise.resolve({}) });
      expect(res.status).toBe(400);
      const json = (await res.json()) as ErrorResponse;
      expect(json.error.code).toBe("UPLOAD_TYPE_NOT_ALLOWED");
    });

    it("rejects more than 10 files or empty files list", () => {
      const elevenFiles = Array.from({ length: 11 }, (_, i) => ({
        name: `img_${i}.png`,
        size: 100,
        type: "image/png",
      }));
      expect(() => createUploadParams(userId, elevenFiles)).toThrowError(
        expect.objectContaining({ code: "VALIDATION_FAILED" }),
      );
      expect(() => createUploadParams(userId, [])).toThrowError(
        expect.objectContaining({ code: "VALIDATION_FAILED" }),
      );
    });
  });

  describe("3. Complete is Idempotent & DTO Cleanliness", () => {
    it("returns { attachments: Attachment[] }, excludes userId and assemblyId, and is idempotent", async () => {
      const assemblyId = make32HexId();
      const mockAssembly = {
        ok: "ASSEMBLY_COMPLETED",
        assembly_id: assemblyId,
        fields: { userId },
        uploads: [
          {
            id: "upl_1",
            name: "test-image.png",
            size: 2048,
            mime: "image/png",
            ssl_url: `https://tmp.transloadit.com/${assemblyId}/test-image.png`,
          },
        ],
      };

      mswServer.use(
        http.get(`https://api2.transloadit.com/assemblies/${assemblyId}`, () => {
          return HttpResponse.json(mockAssembly);
        }),
      );

      const firstCall = await completeUpload(userId, assemblyId);
      expect(firstCall.attachments).toHaveLength(1);
      const att = firstCall.attachments[0]!;
      expect(att.name).toBe("test-image.png");
      expect(att.status).toBe("ready");
      expect(att.source).toBe("upload");
      expect(att.kind).toBe("image");
      expect(att.expiresAt).not.toBeNull();
      // Browser does not need userId or assemblyId
      expect((att as Record<string, unknown>).userId).toBeUndefined();
      expect((att as Record<string, unknown>).assemblyId).toBeUndefined();

      const countAfterFirst = await db.attachment.count({ where: { assemblyId } });
      expect(countAfterFirst).toBe(1);

      // Second call: must be idempotent and return the same row
      const secondCall = await completeUpload(userId, assemblyId);
      expect(secondCall.attachments).toHaveLength(1);
      expect(secondCall.attachments[0]!.id).toBe(att.id);

      const countAfterSecond = await db.attachment.count({ where: { assemblyId } });
      expect(countAfterSecond).toBe(1);

      // Route returns { attachments } shape
      const req = new NextRequest("http://localhost:4000/api/v1/uploads/complete", {
        method: "POST",
        body: JSON.stringify({ assemblyId }),
      });
      const res = await completeUploadRoute(req, { params: Promise.resolve({}) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as CompleteUploadResponse;
      expect(Array.isArray(body.attachments)).toBe(true);
      expect(body.attachments[0]!.id).toBe(att.id);
    });

    it("saves one attachment per file with S3 URL and no expiry when store step ran", async () => {
      const assemblyId = make32HexId();
      const mockAssembly = {
        ok: "ASSEMBLY_COMPLETED",
        assembly_id: assemblyId,
        fields: { userId },
        uploads: [
          {
            id: "upl_s3_1",
            name: "artwork.png",
            size: 4096,
            mime: "image/png",
            ssl_url: `https://tmp.transloadit.com/${assemblyId}/artwork.png`,
          },
        ],
        results: {
          store: [
            {
              id: "res_s3_1",
              original_id: "upl_s3_1",
              name: "artwork.png",
              size: 4096,
              mime: "image/png",
              ssl_url: "https://magica20.s3.ap-south-1.amazonaws.com/uploads/user1/prefix/artwork.png",
            },
          ],
        },
      };

      mswServer.use(
        http.get(`https://api2.transloadit.com/assemblies/${assemblyId}`, () => {
          return HttpResponse.json(mockAssembly);
        }),
      );

      const res = await completeUpload(userId, assemblyId);
      expect(res.attachments).toHaveLength(1);
      const att = res.attachments[0]!;
      expect(att.url).toBe("https://magica20.s3.ap-south-1.amazonaws.com/uploads/user1/prefix/artwork.png");
      expect(att.name).toBe("artwork.png");
      expect(att.expiresAt).toBeNull();

      // Only one row in DB (never saves both temporary and stored copy)
      const rows = await db.attachment.findMany({ where: { assemblyId } });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.url).toBe("https://magica20.s3.ap-south-1.amazonaws.com/uploads/user1/prefix/artwork.png");
      expect(rows[0]!.expiresAt).toBeNull();
    });

    it("rejects invalid assemblyId format (not 32 hex chars)", async () => {
      await expect(completeUpload(userId, "invalid-asm-id")).rejects.toThrowError(
        expect.objectContaining({ code: "VALIDATION_FAILED" }),
      );

      const req = new NextRequest("http://localhost:4000/api/v1/uploads/complete", {
        method: "POST",
        body: JSON.stringify({ assemblyId: "NOT_HEX_32" }),
      });
      const res = await completeUploadRoute(req, { params: Promise.resolve({}) });
      expect(res.status).toBe(400);
    });
  });

  describe("4. Don't Trust Browser: Real Mime, Size, Count Checked in completeUpload", () => {
    it("rejects completeUpload if real Transloadit file mime is disallowed", async () => {
      const assemblyId = make32HexId();
      mswServer.use(
        http.get(`https://api2.transloadit.com/assemblies/${assemblyId}`, () => {
          return HttpResponse.json({
            ok: "ASSEMBLY_COMPLETED",
            assembly_id: assemblyId,
            fields: { userId },
            uploads: [
              {
                id: "u1",
                name: "script.sh",
                size: 200,
                mime: "text/x-shellscript",
                ssl_url: "https://tmp.example.com/script.sh",
              },
            ],
          });
        }),
      );

      await expect(completeUpload(userId, assemblyId)).rejects.toThrowError(
        expect.objectContaining({ code: "UPLOAD_TYPE_NOT_ALLOWED" }),
      );
    });

    it("rejects completeUpload if real Transloadit file size exceeds MAX_UPLOAD_BYTES", async () => {
      const assemblyId = make32HexId();
      mswServer.use(
        http.get(`https://api2.transloadit.com/assemblies/${assemblyId}`, () => {
          return HttpResponse.json({
            ok: "ASSEMBLY_COMPLETED",
            assembly_id: assemblyId,
            fields: { userId },
            uploads: [
              {
                id: "u1",
                name: "huge.mp4",
                size: 500 * 1024 * 1024 + 5000,
                mime: "video/mp4",
                ssl_url: "https://tmp.example.com/huge.mp4",
              },
            ],
          });
        }),
      );

      await expect(completeUpload(userId, assemblyId)).rejects.toThrowError(
        expect.objectContaining({ code: "UPLOAD_TOO_LARGE" }),
      );
    });
  });

  describe("5. Another User's Assembly is Rejected", () => {
    it("rejects assembly if fields.userId does not match the authenticated user", async () => {
      const assemblyId = make32HexId();
      mswServer.use(
        http.get(`https://api2.transloadit.com/assemblies/${assemblyId}`, () => {
          return HttpResponse.json({
            ok: "ASSEMBLY_COMPLETED",
            assembly_id: assemblyId,
            fields: { userId: otherUserId },
            uploads: [{ name: "other.png", size: 100, mime: "image/png", ssl_url: "https://tmp.example.com/other.png" }],
          });
        }),
      );

      await expect(completeUpload(userId, assemblyId)).rejects.toThrowError(
        expect.objectContaining({ code: "UNAUTHORIZED" }),
      );

      const req = new NextRequest("http://localhost:4000/api/v1/uploads/complete", {
        method: "POST",
        body: JSON.stringify({ assemblyId }),
      });
      const res = await completeUploadRoute(req, { params: Promise.resolve({}) });
      expect(res.status).toBe(401);
      const json = (await res.json()) as ErrorResponse;
      expect(json.error.code).toBe("UNAUTHORIZED");
    });
  });

  describe("6. Send Links Attachments in Order & Agent Prompt", () => {
    it("links attachments in specified order and formats them in buildPrompt", async () => {
      const chat = await createChat(userId);

      const attA = await db.attachment.create({
        data: {
          userId,
          name: "cat.png",
          sizeBytes: 1000n,
          mimeType: "image/png",
          kind: "image",
          source: "upload",
          status: "ready",
          url: "https://example.com/cat.png",
        },
      });

      const attB = await db.attachment.create({
        data: {
          userId,
          name: "video.mp4",
          sizeBytes: 5000n,
          mimeType: "video/mp4",
          kind: "video",
          source: "upload",
          status: "ready",
          url: "https://example.com/video.mp4",
        },
      });

      // Send in reverse order: attB first (index 0), attA second (index 1)
      const clientRequestId = randomUUID();
      const sent = await sendMessage(userId, chat.id, {
        content: "Edit these files",
        clientRequestId,
        planMode: false,
        attachmentIds: [attB.id, attA.id],
      });

      expect(sent.message.attachments).toHaveLength(2);
      expect(sent.message.attachments[0]!.id).toBe(attB.id);
      expect(sent.message.attachments[0]!.position).toBe(0);
      expect(sent.message.attachments[1]!.id).toBe(attA.id);
      expect(sent.message.attachments[1]!.position).toBe(1);

      // Verify listMessages includes attachments in position order
      const listed = await listMessages(userId, chat.id, { limit: 10 });
      const msg = listed.items.find((m) => m.id === sent.message.id);
      expect(msg?.attachments).toHaveLength(2);
      expect(msg?.attachments[0]!.id).toBe(attB.id);
      expect(msg?.attachments[1]!.id).toBe(attA.id);

      // Verify buildPrompt formats the Attached line with exact order (the image can't be downloaded
      // here, so the message stays plain text with just the links)
      mswServer.use(http.get("https://example.com/cat.png", () => new HttpResponse(null, { status: 404 })));
      const prompt = await buildPrompt(chat.id, sent.message.id);
      const userMessageInPrompt = prompt.find((p) => p.role === "user");
      expect(userMessageInPrompt?.content).toContain(
        "Edit these files\nAttached: 1. video video.mp4 https://example.com/video.mp4, 2. image cat.png https://example.com/cat.png",
      );
    });
  });

  describe("Images reach the model", () => {
    it("sends the answered message's images inline, keeps the links, and leaves older messages as text", async () => {
      const chat = await createChat(userId);
      const makeImage = (url: string) =>
        db.attachment.create({
          data: { userId, name: "mug.png", sizeBytes: 3n, mimeType: "image/png", kind: "image", source: "upload", status: "ready", url },
        });
      mswServer.use(http.get("https://example.com/mug.png", () => new HttpResponse(new Uint8Array([1, 2, 3]))));

      const older = await makeImage("https://example.com/old.png");
      const first = await sendMessage(userId, chat.id, { content: "first", clientRequestId: randomUUID(), planMode: false, attachmentIds: [older.id] });
      await db.agentRun.update({ where: { id: first.run.id }, data: { status: "succeeded" } });

      const image = await makeImage("https://example.com/mug.png");
      const sent = await sendMessage(userId, chat.id, { content: "describe this", clientRequestId: randomUUID(), planMode: false, attachmentIds: [image.id] });

      const prompt = await buildPrompt(chat.id, sent.message.id);
      const users = prompt.filter((m) => m.role === "user");
      expect(users[0]!.content).toBe("first\nAttached: 1. image mug.png https://example.com/old.png");
      expect(users[1]!.content).toEqual([
        { type: "text", text: "describe this\nAttached: 1. image mug.png https://example.com/mug.png" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${Buffer.from([1, 2, 3]).toString("base64")}` } },
      ]);
    });
  });

  describe("7. Atomic Claim Concurrency & Rejection of Expired/Used/Cross-User Files", () => {
    it("rejects expired attachment", async () => {
      const chat = await createChat(userId);
      const expiredAtt = await db.attachment.create({
        data: {
          userId,
          name: "expired.png",
          sizeBytes: 100n,
          mimeType: "image/png",
          kind: "image",
          source: "upload",
          status: "ready",
          url: "https://example.com/expired.png",
          expiresAt: new Date(Date.now() - 60_000),
        },
      });

      await expect(
        sendMessage(userId, chat.id, {
          content: "Use expired",
          clientRequestId: randomUUID(),
          planMode: false,
          attachmentIds: [expiredAtt.id],
        }),
      ).rejects.toThrow(AppError);
    });

    it("uses NOT_FOUND path for another user's file so existence is not revealed", async () => {
      const chat = await createChat(userId);
      const msg = await db.message.create({
        data: { chatId: chat.id, role: "user", status: "complete", content: [] },
      });

      const otherAtt = await db.attachment.create({
        data: {
          userId: otherUserId,
          name: "secret.png",
          sizeBytes: 100n,
          mimeType: "image/png",
          kind: "image",
          source: "upload",
          status: "ready",
          url: "https://example.com/secret.png",
        },
      });

      await db.$transaction(async (tx) => {
        await expect(
          attachToMessage(tx, userId, msg.id, [otherAtt.id]),
        ).rejects.toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
      });
    });

    it("atomic claim prevents two concurrent sends from claiming the same attachment", async () => {
      const chat = await createChat(userId);
      const msg1 = await db.message.create({
        data: { chatId: chat.id, role: "user", status: "complete", content: [] },
      });
      const msg2 = await db.message.create({
        data: { chatId: chat.id, role: "user", status: "complete", content: [] },
      });

      const att = await db.attachment.create({
        data: {
          userId,
          name: "claim-test.png",
          sizeBytes: 100n,
          mimeType: "image/png",
          kind: "image",
          source: "upload",
          status: "ready",
          url: "https://example.com/claim-test.png",
        },
      });

      // First claim succeeds
      await db.$transaction(async (tx) => {
        await attachToMessage(tx, userId, msg1.id, [att.id]);
      });

      // Second claim on the same attachment fails with VALIDATION_FAILED
      await db.$transaction(async (tx) => {
        await expect(
          attachToMessage(tx, userId, msg2.id, [att.id]),
        ).rejects.toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
      });
    });
  });

  describe("8. Failed Assembly & Quota Errors Map to Safe Messages", () => {
    it("maps quota errors (NO_CREDITS / RATE_LIMIT_REACHED) to safe error codes", () => {
      expect(mapTransloaditError("NO_CREDITS").code).toBe("UPLOAD_QUOTA_EXCEEDED");
      expect(mapTransloaditError("COMMUNITY_SLOTS_DEPLETED").code).toBe("UPLOAD_QUOTA_EXCEEDED");
      expect(mapTransloaditError("RATE_LIMIT_REACHED").code).toBe("RATE_LIMITED");
    });

    it("maps file errors (MAX_FILE_SIZE_EXCEEDED) to UPLOAD_TOO_LARGE", () => {
      expect(mapTransloaditError("MAX_FILE_SIZE_EXCEEDED").code).toBe("UPLOAD_TOO_LARGE");
    });

    it("maps assembly execution failure to safe message", () => {
      const err = mapTransloaditError("ASSEMBLY_EXECUTION_FAILED", "Custom error details");
      expect(err.code).toBe("INTERNAL");
      expect(err.message).toBe("Custom error details");
    });

    it("completeUpload maps quota error from assembly endpoint", async () => {
      const assemblyId = make32HexId();
      mswServer.use(
        http.get(`https://api2.transloadit.com/assemblies/${assemblyId}`, () => {
          return HttpResponse.json({
            ok: "ASSEMBLY_ERRORED",
            error: "COMMUNITY_SLOTS_DEPLETED",
            message: "No credits available",
          });
        }),
      );

      await expect(completeUpload(userId, assemblyId)).rejects.toThrowError(
        expect.objectContaining({ code: "UPLOAD_QUOTA_EXCEEDED" }),
      );
    });
  });

  describe("9. Library Attachments", () => {
    it("creates library attachment by toolInvocationId and url from tool's assets()", async () => {
      const generatedUrl = `https://example.com/gen_${randomUUID()}.png`;

      const invocation = await db.toolInvocation.create({
        data: {
          userId,
          toolCallId: `call_${randomUUID()}`,
          order: 0,
          toolName: "gpt_image_2",
          status: "succeeded",
          input: { prompt: "test prompt" },
          output: { images: [generatedUrl] },
          idempotencyKey: `inv_${randomUUID()}`,
        },
      });

      const att = await createLibraryAttachment(userId, invocation.id, generatedUrl);
      expect(att.source).toBe("library");
      expect(att.kind).toBe("image");
      expect(att.mimeType).toBe("image/png");
      expect(att.url).toBe(generatedUrl);
      expect(att.status).toBe("ready");
      expect(att.expiresAt).toBeNull();

      // Route returns 201
      const req = new NextRequest("http://localhost:4000/api/v1/attachments/from-library", {
        method: "POST",
        body: JSON.stringify({ toolInvocationId: invocation.id, url: generatedUrl }),
      });
      const res = await libraryAttachmentRoute(req, { params: Promise.resolve({}) });
      expect(res.status).toBe(201);
    });

    it("rejects if URL is not in toolInvocation's assets", async () => {
      const invocation = await db.toolInvocation.create({
        data: {
          userId,
          toolCallId: `call_${randomUUID()}`,
          order: 0,
          toolName: "gpt_image_2",
          status: "succeeded",
          input: { prompt: "test prompt" },
          output: { images: ["https://example.com/real.png"] },
          idempotencyKey: `inv_${randomUUID()}`,
        },
      });

      await expect(
        createLibraryAttachment(userId, invocation.id, "https://example.com/unrelated.png"),
      ).rejects.toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
    });

    it("rejects if toolInvocation belongs to another user", async () => {
      const otherInvocation = await db.toolInvocation.create({
        data: {
          userId: otherUserId,
          toolCallId: `call_${randomUUID()}`,
          order: 0,
          toolName: "gpt_image_2",
          status: "succeeded",
          input: { prompt: "other" },
          output: { images: ["https://example.com/other.png"] },
          idempotencyKey: `inv_${randomUUID()}`,
        },
      });

      await expect(
        createLibraryAttachment(userId, otherInvocation.id, "https://example.com/other.png"),
      ).rejects.toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
    });

    it("creates library attachment by attachmentId for an upload", async () => {
      const originalUpload = await db.attachment.create({
        data: {
          userId,
          name: "uploaded_photo.png",
          sizeBytes: 5120n,
          mimeType: "image/png",
          kind: "image",
          source: "upload",
          status: "ready",
          url: "https://example.com/uploaded_photo.png",
        },
      });

      const copy = await createLibraryAttachment(userId, { attachmentId: originalUpload.id });
      expect(copy.source).toBe("library");
      expect(copy.id).not.toBe(originalUpload.id);
      expect(copy.name).toBe("uploaded_photo.png");
      expect(copy.url).toBe(originalUpload.url);
      expect(copy.mimeType).toBe("image/png");
      expect(copy.kind).toBe("image");
      expect(copy.sizeBytes).toBe(5120);
      expect(copy.status).toBe("ready");

      // Route supports { attachmentId }
      const req = new NextRequest("http://localhost:4000/api/v1/attachments/from-library", {
        method: "POST",
        body: JSON.stringify({ attachmentId: originalUpload.id }),
      });
      const res = await libraryAttachmentRoute(req, { params: Promise.resolve({}) });
      expect(res.status).toBe(201);
    });

    it("rejects attachmentId reuse if attachment belongs to another user", async () => {
      const otherUpload = await db.attachment.create({
        data: {
          userId: otherUserId,
          name: "secret_other.png",
          sizeBytes: 100n,
          mimeType: "image/png",
          kind: "image",
          source: "upload",
          status: "ready",
          url: "https://example.com/secret_other.png",
        },
      });

      await expect(
        createLibraryAttachment(userId, { attachmentId: otherUpload.id }),
      ).rejects.toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
    });

    it("rejects attachmentId reuse if attachment has expired", async () => {
      const expiredUpload = await db.attachment.create({
        data: {
          userId,
          name: "expired_upload.png",
          sizeBytes: 100n,
          mimeType: "image/png",
          kind: "image",
          source: "upload",
          status: "ready",
          url: "https://example.com/expired_upload.png",
          expiresAt: new Date(Date.now() - 10_000),
        },
      });

      await expect(
        createLibraryAttachment(userId, { attachmentId: expiredUpload.id }),
      ).rejects.toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
    });
  });

  describe("Sanitization Helper", () => {
    it("sanitizes filenames", () => {
      expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
      expect(sanitizeFilename("C:\\Users\\test\\my_photo.jpg")).toBe("my_photo.jpg");
      expect(sanitizeFilename("hello\x00world.png")).toBe("helloworld.png");
      expect(sanitizeFilename("   ")).toBe("file");
    });
  });
});
