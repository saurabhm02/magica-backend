import { MergeVideosInput, MergeVideosOutput } from "@/contracts/tools";
import type { MagicaTool } from "@/lib/types";

export function buildMergeVideosParams(input: MergeVideosInput): Record<string, unknown> {
  return {
    video_urls: input.video_urls,
    transition: input.transition ?? "none",
  };
}

export function estimateMergeVideosCredits(input?: Partial<MergeVideosInput>): number {
  const count = input?.video_urls?.length ?? 2;
  const extra = Math.max(0, count - 1);
  return 40_000 + extra * 10_000;
}

export const mergeVideosTool: MagicaTool<MergeVideosInput, MergeVideosOutput> = {
  name: "merge_videos",
  description: "Combine 2 to 100 ordered videos into a single video with optional transition (none, fade, dissolve).",
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
