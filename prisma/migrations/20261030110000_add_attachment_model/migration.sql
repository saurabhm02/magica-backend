-- CreateEnum
CREATE TYPE "AttachmentSource" AS ENUM ('upload', 'library');

-- CreateEnum
CREATE TYPE "AttachmentKind" AS ENUM ('image', 'video', 'audio');

-- CreateEnum
CREATE TYPE "AttachmentStatus" AS ENUM ('ready', 'failed');

-- CreateTable
CREATE TABLE "Attachment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "messageId" TEXT,
    "position" INTEGER,
    "source" "AttachmentSource" NOT NULL,
    "kind" "AttachmentKind" NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "assemblyId" TEXT,
    "status" "AttachmentStatus" NOT NULL DEFAULT 'ready',
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Attachment_assemblyId_url_key" ON "Attachment"("assemblyId", "url");

-- CreateIndex
CREATE INDEX "Attachment_userId_createdAt_id_idx" ON "Attachment"("userId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "Attachment_messageId_position_idx" ON "Attachment"("messageId", "position");

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
