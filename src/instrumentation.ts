// Node-only code lives in startup-check.ts so the Edge build never sees process.exit.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { checkConnections } = await import("./startup-check");
  await checkConnections();
}
