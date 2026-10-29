import { NextResponse } from "next/server";
import { z } from "zod";
import { getTool } from "@/agent/tools/registry";
import { ToolDetailResponse } from "@/contracts/api";
import { requireUser } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { route } from "@/lib/http";

export const GET = route<{ params: Promise<{ name: string }> }>(async (req, { params }) => {
  await requireUser(req);
  const { name } = await params;
  const tool = getTool(name);

  if (!tool || tool.hidden) {
    throw new AppError("NOT_FOUND", "Tool not found", false);
  }

  const defaultEstimate = await tool.estimateCredits({});
  const inputs = z.toJSONSchema(tool.inputSchema) as Record<string, unknown>;

  return NextResponse.json(
    ToolDetailResponse.parse({
      name: tool.name,
      displayName: tool.displayName,
      description: tool.description,
      category: tool.category,
      inputs,
      pricingLines: tool.pricingLines ?? [],
      defaultEstimate,
    }),
  );
});
