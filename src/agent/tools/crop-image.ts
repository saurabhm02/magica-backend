import { CropImageInput, CropImageOutput } from "@/contracts/tools";
import { CREDIT_COSTS } from "@/lib/constants";
import type { MagicaTool } from "@/lib/types";

export function buildCropImageParams(input: CropImageInput): Record<string, unknown> {
  const params: Record<string, unknown> = {
    image_url: input.image_url,
  };

  if (input.crop) {
    params.x_px = input.crop.x;
    params.y_px = input.crop.y;
    params.width_px = input.crop.width;
    params.height_px = input.crop.height;
  } else {
    if (input.x_percent !== undefined) params.x_percent = input.x_percent;
    if (input.y_percent !== undefined) params.y_percent = input.y_percent;
    if (input.width_percent !== undefined) params.width_percent = input.width_percent;
    if (input.height_percent !== undefined) params.height_percent = input.height_percent;
    if (input.x_px !== undefined) params.x_px = input.x_px;
    if (input.y_px !== undefined) params.y_px = input.y_px;
    if (input.width_px !== undefined) params.width_px = input.width_px;
    if (input.height_px !== undefined) params.height_px = input.height_px;
  }

  return params;
}

export const cropImageTool: MagicaTool<CropImageInput, CropImageOutput> = {
  name: "crop_image",
  displayName: "Crop Image",
  description:
    "Crop an image using percentage coordinates (x_percent, y_percent, width_percent, height_percent), exact pixel dimensions (width_px, height_px, optional x_px, y_px), or pixel bounding box (crop.{x,y,width,height}).",
  category: "image",
  inputSchema: CropImageInput,
  renderKey: "image-result",
  estimateCredits: () => CREDIT_COSTS.crop_image,
  assets: (output) => [{ type: "image", url: output.image_url }],
  describe: (input) => {
    let detail = "square crop";
    if (input.crop) {
      detail = `${input.crop.width}x${input.crop.height} crop`;
    } else if (input.width_px && input.height_px) {
      detail = `${input.width_px}x${input.height_px} crop`;
    } else if (input.width_percent && input.height_percent) {
      detail = `${input.width_percent}%x${input.height_percent}% crop`;
    }
    return {
      label: "Cropping your image...",
      doneLabel: "cropped an image",
      detail,
      model: "Crop Image",
      fields: [
        { label: "Model", value: "crop_image" },
        { label: "Image URL", value: input.image_url ?? "" },
        { label: "Crop Area", value: detail },
      ],
    };
  },
  magica: {
    nodeType: "crop_image",
    buildInput: buildCropImageParams,
    outputSchema: CropImageOutput,
  },
};
