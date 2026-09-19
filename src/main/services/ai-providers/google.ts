import type { AiProvider, CompleteInput } from "./types";
import { describeFetchError, httpFetch } from "./http";

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

/**
 * Google AI Studio uses a different shape from the OpenAI-compatible
 * vendors: `systemInstruction` rather than a system message, `contents`
 * rather than `messages`, and the API key travels in the query string.
 * Everything else — text in, text out — is the same.
 *
 * Model names on this endpoint rotate on Google's own schedule, and a name
 * that worked a month ago can start returning 404 `model ... is not found
 * for API version v1beta` for new users. When that happens, replace the
 * entries below with names from the live catalogue:
 *
 *   curl "https://generativelanguage.googleapis.com/v1beta/models?key=YOUR_KEY" \
 *     | jq -r '.models[] | select(.supportedGenerationMethods | index("generateContent")) | .name'
 *
 * The names below are the current stable entries; the older `gemini-1.5-*`
 * family has been retired from this endpoint.
 *
 * Requests go through `httpFetch` (Chromium's network stack) rather than
 * the global `fetch`, which is what makes proxy and dual-stack network
 * setups work. See `http.ts` for the reasoning.
 */
export const googleProvider: AiProvider = {
  id: "google",
  label: "Google AI Studio",
  keyUrl: "https://aistudio.google.com/apikey",
  // Seed list only. Google rotates the model catalogue on its own schedule —
  // `gemini-1.5-*`, then `gemini-2.0-*`, then `gemini-2.5-*` have all been
  // retired from `generateContent` at various points, and the error message
  // Google returns sometimes recommends a name (`gemini-3.6-flash`) that its
  // own documentation does not list. `listModels` below is the source of
  // truth; this array only matters for the window before that completes.
  models: ["gemini-3.5-flash", "gemini-3.1-flash-lite"],
  async listModels(apiKey: string): Promise<string[]> {
    // `?key=` rather than a bearer header — Google's Generative Language
    // API still uses the query-string form for API keys on `v1beta`.
    const url = `${BASE}?key=${encodeURIComponent(apiKey)}`;
    let response: Response;
    try {
      response = await httpFetch(url);
    } catch (error) {
      throw new Error(describeFetchError("Google AI Studio", error));
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `Google AI Studio model list returned ${response.status}: ${
          detail.slice(0, 200) || response.statusText
        }`,
      );
    }
    const json = (await response.json()) as {
      models?: Array<{
        name?: string;
        supportedGenerationMethods?: string[];
      }>;
    };
    return (
      (json.models ?? [])
        // Only models that can actually answer a text prompt. This filters
        // out embedding, AQA, and other special-purpose entries without
        // needing a denylist of names.
        .filter((m) =>
          m.supportedGenerationMethods?.includes("generateContent"),
        )
        // The list endpoint returns `models/gemini-...`; the request body
        // wants the bare ID, so strip the prefix.
        .map((m) => (m.name ?? "").replace(/^models\//, ""))
        .filter((name) => name !== "")
        .sort()
    );
  },
  async complete(input: CompleteInput): Promise<string> {
    const url = `${BASE}/${encodeURIComponent(input.model)}:generateContent?key=${encodeURIComponent(input.apiKey)}`;
    const body = {
      systemInstruction: { parts: [{ text: input.system }] },
      contents: [{ role: "user", parts: [{ text: input.user }] }],
      generationConfig: {
        maxOutputTokens: input.maxTokens ?? 2048,
        temperature: input.temperature ?? 0.1,
      },
    };
    let response: Response;
    try {
      response = await httpFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new Error(describeFetchError("Google AI Studio", error));
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `Google AI Studio returned ${response.status}: ${
          detail.slice(0, 300) || response.statusText
        }`,
      );
    }
    const json = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof text !== "string") {
      throw new Error(
        "Google AI Studio returned an unexpected response shape.",
      );
    }
    return text;
  },
};
