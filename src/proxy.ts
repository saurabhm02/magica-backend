import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { CORS_ALLOWED_HEADERS, CORS_ALLOWED_METHODS } from "@/lib/constants";
import { env } from "@/lib/env";

function corsHeaders(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": CORS_ALLOWED_METHODS,
    "Access-Control-Allow-Headers": CORS_ALLOWED_HEADERS,
  };
}

export default function proxy(request: NextRequest) {
  const origin = request.headers.get("origin");
  const allowed = origin === env.CLIENT_ORIGIN;

  if (request.method === "OPTIONS") {
    return new NextResponse(null, { status: allowed ? 204 : 403, headers: allowed ? corsHeaders(origin) : {} });
  }

  const response = NextResponse.next();
  if (allowed) {
    for (const [key, value] of Object.entries(corsHeaders(origin))) {
      response.headers.set(key, value);
    }
  }
  return response;
}

export const config = {
  matcher: "/api/:path*",
};
