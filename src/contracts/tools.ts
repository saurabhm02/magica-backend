import { z } from "zod";
import { SafeError } from "./errors";

export const CropImageInput = z.object({
  image_url: z.string().url().describe("Public URL of the image to crop"),
  x_percent: z.number().min(0).max(100).optional().describe("Horizontal start position (0-100%)"),
  y_percent: z.number().min(0).max(100).optional().describe("Vertical start position (0-100%)"),
  width_percent: z.number().min(0).max(100).optional().describe("Crop width (0-100%)"),
  height_percent: z.number().min(0).max(100).optional().describe("Crop height (0-100%)"),
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
  prompt: z.string().min(1).max(4000).describe("Text prompt describing the image to generate or edit"),
  mode: z.enum(["text", "edit"]).optional().describe("Generation mode: text for new images, edit when modifying existing images"),
  uploadedImages: z.array(z.string().url()).max(10).optional().describe("Source image URLs to edit (max 10)"),
  size: z.enum(GPT_IMAGE_2_SIZES).optional().default("1024x1024").describe("Output image size preset (default: 1024x1024)"),
  quality: z.enum(["High", "Medium", "Low"]).optional().default("Medium").describe("Rendering quality level (default: Medium, use High only when requested)"),
  background: z.enum(["Auto", "Opaque"]).optional().describe("Background mode"),
  n: z.number().int().min(1).max(4).optional().default(1).describe("Number of images to generate (default: 1)"),
  output_format: z.enum(["PNG", "JPEG", "WebP"]).optional().describe("Output file format"),
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
  video_urls: z.array(z.string().url()).min(2).max(100).describe("2 to 100 ordered video URLs to concatenate"),
  transition: z.enum(["none", "fade", "dissolve"]).optional().default("none").describe("Transition effect between videos"),
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
