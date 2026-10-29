import { MergeVideosInput, MergeVideosOutput } from "@/contracts/tools";
import { CREDIT_COSTS } from "@/lib/constants";
import type { MagicaTool } from "@/lib/types";

export function buildMergeVideosParams(input: MergeVideosInput): Record<string, unknown> {
  return {
    video_urls: input.video_urls,
    transition: input.transition ?? "none",
  };
}

export const mergeVideosTool: MagicaTool<MergeVideosInput, MergeVideosOutput> = {
  name: "merge_videos",
  description: "Combine 2 to 100 ordered videos into a single video with optional transition (none, fade, dissolve).",
  inputSchema: MergeVideosInput,
  renderKey: "video-result",
  estimateCredits: () => CREDIT_COSTS.merge_videos,
  assets: (output) => [{ type: "video", url: output.video_url }],
  describe: (input) => {
    const count = Array.isArray(input.video_urls) ? input.video_urls.length : 2;
    return {
      label: "Merging your videos...",
      doneLabel: "merged videos",
      detail: `${count} videos`,
      model: "Merge Videos",
      fields: [
        { label: "Model", value: "merge_videos" },
        { label: "Videos", value: String(count) },
        { label: "Transition", value: input.transition ?? "none" },
      ],
    };
  },
  magica: {
    nodeType: "merge_videos",
    buildInput: buildMergeVideosParams,
    outputSchema: MergeVideosOutput,
  },
};
