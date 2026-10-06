import { DEFAULT_VISION_PROVIDER, VISION_PROVIDERS } from "@shared/vision-providers";
import type { AiProviderId, DocumentEntry } from "@shared/types";

export function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "") {
    throw new Error(`Invalid ${label}: expected a non-empty string.`);
  }
  return value;
}

export function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`Invalid ${label}: expected a string.`);
  }
  return value;
}

export function requireVisionProvider(
  value: unknown,
): DocumentEntry["visionProvider"] {
  const ids = VISION_PROVIDERS.map((option) => option.id);
  return ids.includes(value as AiProviderId)
    ? (value as AiProviderId)
    : DEFAULT_VISION_PROVIDER;
}
