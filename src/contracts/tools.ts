import { z } from "zod";
import { SafeError } from "./errors";

export const CropImageInput = z.object({
  image_url: z.string().url().meta({ title: "Input Image" }).describe("Public URL of the image to crop"),
  x_percent: z.number().min(0).max(100).meta({ title: "X Position (%)", default: 0 }).optional().describe("Horizontal start position (0-100%)"),
  y_percent: z.number().min(0).max(100).meta({ title: "Y Position (%)", default: 0 }).optional().describe("Vertical start position (0-100%)"),
  width_percent: z.number().min(0).max(100).meta({ title: "Width (%)", default: 100 }).optional().describe("Crop width (0-100%)"),
  height_percent: z.number().min(0).max(100).meta({ title: "Height (%)", default: 100 }).optional().describe("Crop height (0-100%)"),
  x_px: z.number().int().nonnegative().optional().describe("Exact horizontal start position in pixels"),
  y_px: z.number().int().nonnegative().optional().describe("Exact vertical start position in pixels"),
  width_px: z.number().int().positive().optional().describe("Exact crop width in pixels"),
  height_px: z.number().int().positive().optional().describe("Exact crop height in pixels"),
  crop: z
    .object({
      x: z.number().int().nonnegative().describe("Horizontal start position in pixels"),
      y: z.number().int().nonnegative().describe("Vertical start position in pixels"),
      width: z.number().int().positive().describe("Crop width in pixels"),
      height: z.number().int().positive().describe("Crop height in pixels"),
    })
    .optional()
    .describe("Pixel bounding box rectangle (x, y, width, height)"),
});
export type CropImageInput = z.infer<typeof CropImageInput>;

export const CropImageOutput = z.object({
  image_url: z.string().url().describe("URL of the cropped image"),
});
export type CropImageOutput = z.infer<typeof CropImageOutput>;

export const GPT_IMAGE_2_SIZES = [
  "Auto",
  "1024x1024",
  "1536x1024",
  "1024x1536",
  "2048x2048",
  "2048x1152",
  "3840x2160",
  "2160x3840",
] as const;
export type GptImage2Size = (typeof GPT_IMAGE_2_SIZES)[number];

export const GptImage2Input = z.object({
  prompt: z.string().min(1).max(4000).meta({ title: "Prompt" }).describe("Text prompt describing the image to generate or edit"),
  mode: z.enum(["text", "edit"]).optional().describe("Generation mode: text for new images, edit when modifying existing images"),
  uploadedImages: z.array(z.string().url()).max(10).optional().describe("Source image URLs to edit (max 10)"),
  size: z.enum(GPT_IMAGE_2_SIZES).meta({ title: "Size" }).optional().default("1024x1024").describe("Output image size preset (default: 1024x1024)"),
  quality: z.enum(["High", "Medium", "Low"]).meta({ title: "Quality" }).optional().default("Medium").describe("Rendering quality level (default: Medium, use High only when requested)"),
  background: z.enum(["Auto", "Opaque"]).meta({ title: "Background" }).optional().describe("Background mode"),
  n: z.number().int().min(1).max(4).meta({ title: "Number of Images" }).optional().default(1).describe("Number of images to generate (default: 1)"),
  output_format: z.enum(["PNG", "JPEG", "WebP"]).meta({ title: "Output Format" }).optional().describe("Output file format"),
});
export type GptImage2Input = z.infer<typeof GptImage2Input>;

export const GptImage2Output = z
  .object({
    images: z.array(z.string().url()).optional(),
    result: z.array(z.string().url()).optional(),
  })
  .transform((val) => ({
    images: val.images ?? val.result ?? [],
  }))
  .refine((val) => val.images.length > 0, {
    message: "Output must contain at least one image URL",
  });
export type GptImage2Output = z.infer<typeof GptImage2Output>;

export const MergeVideosInput = z.object({
  video_urls: z.array(z.string().url()).min(2).max(100).meta({ title: "Videos" }).describe("2 to 100 ordered video URLs to concatenate"),
  transition: z.enum(["none", "fade", "dissolve"]).meta({ title: "Transition" }).optional().default("none").describe("Transition effect between videos"),
});
export type MergeVideosInput = z.infer<typeof MergeVideosInput>;

export const MergeVideosOutput = z.object({
  video_url: z.string().url().describe("URL of the concatenated video"),
});
export type MergeVideosOutput = z.infer<typeof MergeVideosOutput>;

export const GetModelInfoInput = z.object({}).describe("No input parameters required");
export type GetModelInfoInput = z.infer<typeof GetModelInfoInput>;

export const GetModelInfoOutput = z.object({
  configuredModel: z.string(),
  routedModel: z.string().optional(),
});
export type GetModelInfoOutput = z.infer<typeof GetModelInfoOutput>;

export const LoadSkillInput = z.object({
  name: z.string().min(1).describe("The name of the skill to load (e.g. product-photo, social-crop, video-montage)"),
});
export type LoadSkillInput = z.infer<typeof LoadSkillInput>;

export const LoadSkillOutput = z.object({
  name: z.string(),
  content: z.string(),
  contentHash: z.string(),
});
export type LoadSkillOutput = z.infer<typeof LoadSkillOutput>;

export const ReadSkillAssetInput = z.object({
  skill: z.string().min(1).describe("The name of the skill the asset belongs to (e.g. social-crop)"),
  path: z.string().min(1).describe("The relative filename of the asset within the skill directory (e.g. dimensions.json)"),
});
export type ReadSkillAssetInput = z.infer<typeof ReadSkillAssetInput>;

export const ReadSkillAssetOutput = z.object({
  skill: z.string(),
  path: z.string(),
  content: z.string(),
  contentHash: z.string(),
});
export type ReadSkillAssetOutput = z.infer<typeof ReadSkillAssetOutput>;

export const QuestionOption = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  recommended: z.boolean().optional(),
});
export type QuestionOption = z.infer<typeof QuestionOption>;

export const Question = z.object({
  id: z.string(),
  question: z.string(),
  type: z.enum(["choice", "text"]),
  options: z.array(QuestionOption).optional(),
  placeholder: z.string().optional(),
  allowOther: z.boolean().optional(),
});
export type Question = z.infer<typeof Question>;

export const RequestUserOptionsInput = z.object({
  message: z.string().describe("Contextual message explaining why options are being requested"),
  questions: z.array(Question).min(1).max(4).describe("1 to 4 questions for the user"),
});
export type RequestUserOptionsInput = z.infer<typeof RequestUserOptionsInput>;

export const AnswerItem = z.object({
  questionId: z.string(),
  question: z.string().optional(),
  answer: z.string(),
});
export type AnswerItem = z.infer<typeof AnswerItem>;

export const RequestUserOptionsOutput = z.object({
  answers: z.array(AnswerItem),
});
export type RequestUserOptionsOutput = z.infer<typeof RequestUserOptionsOutput>;

export const PlanStepInput = z.object({
  title: z.string().describe("Short title of the step"),
  description: z.string().describe("Description of what this step will do"),
  tool: z.string().describe("Name of the tool to execute"),
  input: z.record(z.string(), z.unknown()).describe("Input arguments for the tool"),
  estimatedCredits: z.number().optional().describe("Estimated credits filled by server"),
});
export type PlanStepInput = z.infer<typeof PlanStepInput>;

export const SubmitPlanInput = z.object({
  title: z.string().describe("Title of the plan"),
  overview: z.string().describe("Overview or rationale of the plan"),
  steps: z.array(PlanStepInput).min(1).describe("List of planned steps"),
  totalEstimatedCredits: z.number().optional().describe("Total estimated credits filled by server"),
});
export type SubmitPlanInput = z.infer<typeof SubmitPlanInput>;

export const SubmitPlanOutput = z.object({
  action: z.enum(["run_all", "step_by_step", "request_changes"]),
  feedback: z.string().optional(),
  status: z.string().optional(),
  steps: z.array(z.unknown()).optional(),
});
export type SubmitPlanOutput = z.infer<typeof SubmitPlanOutput>;

export const MagicaRunSuccess = z.object({
  ok: z.literal(true),
  output: z.record(z.string(), z.unknown()),
  creditUsed: z.number().optional(),
});
export type MagicaRunSuccess = z.infer<typeof MagicaRunSuccess>;

export const MagicaRunFailure = z.object({
  ok: z.literal(false),
  error: SafeError,
});
export type MagicaRunFailure = z.infer<typeof MagicaRunFailure>;

export const MagicaRunResult = z.discriminatedUnion("ok", [MagicaRunSuccess, MagicaRunFailure]);
export type MagicaRunResult = z.infer<typeof MagicaRunResult>;
