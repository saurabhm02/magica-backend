import { NextResponse } from "next/server";
import { ListModelsResponse } from "@/contracts/api";
import { VISION_MODELS } from "@/lib/constants";
import { env } from "@/lib/env";
import { route } from "@/lib/http";

export const GET = route(async () => {
  const models = [
    {
      id: env.LLM_MODEL,
      label: "OpenRouter Free",
      default: true,
    },
  ];

  return NextResponse.json(
    ListModelsResponse.parse({
      models,
      visionModels: VISION_MODELS,
    }),
  );
});
