import { startDemoTarget, type FixtureVariant } from "@autopw/execution-fixture";

const variant = (process.env.AUTOPW_DEMO_VARIANT === "fail" || process.env.AUTOPW_DEMO_VARIANT === "incomplete" ? process.env.AUTOPW_DEMO_VARIANT : "pass") as FixtureVariant;
const target = await startDemoTarget(variant);
console.log(JSON.stringify({ baseUrl: target.baseUrl, variant }));
process.on("SIGINT", () => { void target.close().then(() => process.exit(0)); });
process.on("SIGTERM", () => { void target.close().then(() => process.exit(0)); });
