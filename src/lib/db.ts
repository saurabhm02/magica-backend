import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import { neonConfig } from "@neondatabase/serverless";
import { PrismaNeon } from "@prisma/adapter-neon";
import { PrismaClient } from "@prisma/client";
import ws from "ws";
import { DB_CONNECT_ATTEMPT_TIMEOUT_MS } from "@/lib/constants";
import { env } from "@/lib/env";


setDefaultAutoSelectFamilyAttemptTimeout(DB_CONNECT_ATTEMPT_TIMEOUT_MS);
neonConfig.webSocketConstructor = ws;

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

const adapter = new PrismaNeon({ connectionString: env.DATABASE_URL });

export const db = globalForPrisma.prisma ?? new PrismaClient({ adapter });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db;
}
