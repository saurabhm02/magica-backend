import { defineConfig } from "@trigger.dev/sdk";
import { additionalFiles } from "@trigger.dev/build/extensions/core";

export default defineConfig({
  project: "proj_qvsbemkhzhryzljhzrea",
  runtime: "node",
  logLevel: "log",
  maxDuration: 3600,
  processKeepAlive: true,
  retries: {
    enabledInDev: true,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 10000,
      factor: 2,
      randomize: true,
    },
  },
  dirs: ["./src/trigger"],
  build: {
    extensions: [additionalFiles({ files: ["agent-skills/**"] })],
  },
});
