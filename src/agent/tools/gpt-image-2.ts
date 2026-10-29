import { GptImage2Input, GptImage2Output } from "@/contracts/tools";
import { CREDIT_COSTS } from "@/lib/constants";
import { AppError } from "@/lib/errors";
import type { MagicaTool } from "@/lib/types";

export function getGptImage2SubModelId(input?: Partial<GptImage2Input>): {
  isEdit: boolean;
  subModelId: "gpt-image-2-edit" | "gpt-image-2-text";
} {
  const isEdit = input?.mode === "edit" || Boolean(input?.uploadedImages && input.uploadedImages.length > 0);
  return {
    isEdit,
    subModelId: isEdit ? "gpt-image-2-edit" : "gpt-image-2-text",
  };
}

export function buildGptImage2Payload(input: GptImage2Input): {
  subModelId: string;
  params: Record<string, unknown>;
} {
  const { isEdit, subModelId } = getGptImage2SubModelId(input);

  const params: Record<string, unknown> = {
    prompt: input.prompt,
    size: input.size ?? "1024x1024",
    quality: input.quality ?? "Medium",
    background: input.background ?? "Auto",
    n: input.n ?? 1,
    output_format: input.output_format ?? "PNG",
  };

  if (isEdit) {
    if (!input.uploadedImages || input.uploadedImages.length === 0) {
      throw new AppError("TOOL_INPUT_INVALID", "Invalid input for gpt_image_2: uploadedImages", false);
    }
    params.uploadedImages = input.uploadedImages;
  }

  return { subModelId, params };
}

export const gptImage2Tool: MagicaTool<GptImage2Input, GptImage2Output> = {
  name: "gpt_image_2",
  description:
    "Generate a new image from a text prompt or edit an existing image using OpenAI's GPT Image 2 model. Default quality is Medium (use High only when user asks for high/best quality), default size is 1024x1024, default n is 1. To edit, provide uploadedImages.",
  inputSchema: GptImage2Input,
  renderKey: "image-result",
  estimateCredits: () => CREDIT_COSTS.gpt_image_2,
  assets: (output) => output.images.map((url) => ({ type: "image", url })),
  describe: (input) => {
    const prompt = input?.prompt || "";
    const shortPrompt = prompt.length > 25 ? prompt.slice(0, 25) + "..." : prompt;
    const { subModelId } = getGptImage2SubModelId(input);
    return {
      label: prompt ? `Generating your ${shortPrompt} image...` : "Generating image...",
      doneLabel: "generated an image",
      detail: prompt,
      model: "GPT Image 2",
      fields: [
        { label: "Model", value: subModelId },
        { label: "Prompt", value: prompt },
        { label: "Outputs", value: String(input?.n ?? 1) },
        { label: "Size", value: String(input?.size ?? "1024x1024") },
        { label: "Quality", value: String(input?.quality ?? "Medium") },
        { label: "Background", value: String(input?.background ?? "Auto") },
        { label: "Output Format", value: String(input?.output_format ?? "PNG") },
      ],
    };
  },
  magica: {
    nodeType: "gpt_image_2",
    subModelId: (input) => getGptImage2SubModelId(input).subModelId,
    buildInput: (input) => buildGptImage2Payload(input).params,
    outputSchema: GptImage2Output,
  },
};
