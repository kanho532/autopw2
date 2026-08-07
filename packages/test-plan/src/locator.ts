import type { LocatorRef } from "./model.js";

export const AUTOMATIC_LOCATOR_KINDS = ["role", "label", "test_id", "text", "id"] as const;

export function cssLocator(value: string): LocatorRef {
  return { by: "css", value, authority: "trusted_manual" };
}

export function locatorKey(locator: LocatorRef): string {
  return Object.entries(locator).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => key + "=" + String(value)).join("|");
}
