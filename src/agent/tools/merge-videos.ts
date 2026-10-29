import { estimateNodeCredits } from "@/agent/magica";
import { MergeVideosInput, MergeVideosOutput } from "@/contracts/tools";
import { CREDIT_COSTS } from "@/lib/constants";
import type { MagicaTool } from "@/lib/types";

export function buildMergeVideosParams(input: MergeVideosInput): Record<string, unknown> {
  return {
    video_urls: input.video_urls,
    transition: input.transition ?? "none",
  };
}

export const MERGE_VIDEOS_PRICING_LINES = [
  "Base: 40,000 microcredits (0.04M) per billable minute",
  "Additional videos: 10,000 microcredits (0.01M) per video",
];

export async function estimateMergeVideosCredits(input?: Partial<MergeVideosInput>): Promise<number> {
  const count = input?.video_urls?.length ?? 2;
  const extra = Math.max(0, count - 1);
  const fallback = CREDIT_COSTS.merge_videos + extra * CREDIT_COSTS.merge_videos_additional;

  return estimateNodeCredits({
    nodeType: "merge_videos",
    data: { video_urls: input?.video_urls ?? [] },
    fallback,
  });
}

export const mergeVideosTool: MagicaTool<MergeVideosInput, MergeVideosOutput> = {
  name: "merge_videos",
  displayName: "Merge Videos",
  description: "Combine 2 to 100 ordered videos into a single video with optional transition (none, fade, dissolve).",
  category: "video",
  pricingLines: MERGE_VIDEOS_PRICING_LINES,
  inputSchema: MergeVideosInput,
  renderKey: "video-result",
  estimateCredits: (input) => estimateMergeVideosCredits(input),
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
