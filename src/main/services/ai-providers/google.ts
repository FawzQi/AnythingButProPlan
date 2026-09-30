import type { AiProvider, CompleteInput, EmbedInput, VisionInput } from "./types";
import { describeFetchError, httpFetch } from "./http";

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

/**
 * The embedding model the research index is built with.
 *
 * Pinned rather than configurable. A different model produces vectors in a
 * different space, so switching invalidates every stored embedding and the
 * whole corpus has to be re-embedded — a cost the user pays for no gain they
 * can see.
 *
 * `text-embedding-004` was the pinned name for a while, but Google has
 * retired it from `v1beta`: `embedContent` and `batchEmbedContents` now answer
 * 404 (`models/text-embedding-004 is not found for API version v1beta`).
 * `gemini-embedding-001` is the current embedding model that supports both
 * methods. Its native width is 3072; the request below pins
 * `outputDimensionality: 768` so the on-disk vector width is unchanged from
 * what `text-embedding-004` produced. There is no retrieval-quality gain from
 * the wider vector at the 20–200-document scale this app targets, and the
 * extra width triples the index size. Note that swapping the model still
 * changes the vector *space* — every stored embedding must be rebuilt once,
 * after which the index is stable again.
 *
 * See CLAUDE.md, "Embeddings".
 */
export const EMBEDDING_MODEL = "gemini-embedding-001";
export const EMBEDDING_DIMENSIONS = 768;

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
  /**
   * Vision uses `inlineData` parts — the same `parts` array as text, with
   * `mimeType` and base64 `data` instead of `text`. Google accepts up to 16
   * images per request on this endpoint, which is why the figure analyzer
   * batches at 20 for the OpenAI-compatible vendors but clamps to 16 when
   * this provider is selected.
   */
  async completeVision(input: VisionInput): Promise<string> {
    const url = `${BASE}/${encodeURIComponent(input.model)}:generateContent?key=${encodeURIComponent(input.apiKey)}`;
    const body = {
      contents: [
        {
          role: "user",
          parts: [
            { text: input.prompt },
            ...input.images.map((image) => ({
              inlineData: { mimeType: image.mimeType, data: image.base64 },
            })),
          ],
        },
      ],
      generationConfig: {
        maxOutputTokens: input.maxTokens ?? 1024,
        temperature: 0.1,
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
      throw new Error(describeFetchError("Google AI Studio", error), {
        cause: error,
      });
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
    if (typeof text !== "string" || text === "") {
      throw new Error("Google AI Studio returned no image description.");
    }
    return text;
  },
  /**
   * `batchEmbedContents` takes up to 100 requests per call, which is exactly
   * why the index builder batches at 100. The response's `embeddings` array
   * is aligned with `requests`, and the caller relies on that alignment to
   * pair each vector with its chunk.
   *
   * `outputDimensionality` is required on `gemini-embedding-001` if the
   * caller wants anything other than the native 3072. The research index
   * pins 768 so the stored width matches what `text-embedding-004` produced;
   * a caller that does not pass it will get back 3072-wide vectors and the
   * load-time byte-length check in `VectorStore.load` will reject the old
   * index rather than silently pairing chunks with truncated vectors.
   */
  async embed(input: EmbedInput): Promise<number[][]> {
    if (input.texts.length === 0) return [];
    const url = `${BASE}/${encodeURIComponent(input.model)}:batchEmbedContents?key=${encodeURIComponent(input.apiKey)}`;
    const body = {
      requests: input.texts.map((text) => ({
        // Each sub-request carries the full `models/...` name, unlike the
        // `generateContent` call where the model is in the URL path.
        model: `models/${input.model}`,
        content: { parts: [{ text }] },
        // Pin the width so the stored index stays 768-wide regardless of
        // what the model's native output is.
        outputDimensionality: EMBEDDING_DIMENSIONS,
      })),
    };
    let response: Response;
    try {
      response = await httpFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new Error(describeFetchError("Google AI Studio", error), {
        cause: error,
      });
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `Google AI Studio embedding returned ${response.status}: ${
          detail.slice(0, 300) || response.statusText
        }`,
      );
    }
    const json = (await response.json()) as {
      embeddings?: Array<{ values?: number[] }>;
    };
    const vectors = (json.embeddings ?? []).map((entry) => entry.values ?? []);
    if (vectors.length !== input.texts.length) {
      // A short array would silently misalign every vector after the gap
      // with the wrong chunk — worse than failing, because the index would
      // look complete and retrieve the wrong passages.
      throw new Error(
        `Google AI Studio returned ${vectors.length} embeddings for ${input.texts.length} texts.`,
      );
    }
    return vectors;
  },
};