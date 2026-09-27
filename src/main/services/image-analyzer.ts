import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { AiProviderId } from '@shared/types'
import { getApiKey, resolveModel } from './settings'
import { getProvider } from './ai-providers'
import { visionProviderOption } from '@shared/vision-providers'
import { asObjectList, extractJsonObject } from './json-salvage'
import { convertedRoot } from './document-scanner'
import { writeFileEnsuringDir } from './fs-service'

/**
 * Figure analysis for `text-images` conversions.
 *
 * Every image the extractor wrote is sent to a vision model once, and the
 * description is cached in the document's `meta.json`. The cache is the
 * point: analysis costs money and the same figure does not need describing
 * twice, so a re-conversion of the same document reuses the recorded
 * descriptions instead of re-billing. That is also what the `imageAnalyzed`
 * flag on the state record guards — "cannot be analyzed twice" is enforced by
 * the record, not by a disabled button in the UI.
 *
 * The provider is per-conversion and recorded in `meta.json`, so a document
 * re-run later keeps using whatever model produced the descriptions already
 * stored. Switching models mid-corpus would give the index a mix of
 * description styles with no way to tell which was which.
 */

/**
 * Images per call. Twenty is the practical ceiling for the OpenAI-compatible
 * vendors before the request body gets large enough to hit proxy and vendor
 * size limits; Google accepts fewer, which `visionBatchSize` handles.
 */
const IMAGES_PER_CALL = 20
const IMAGES_PER_CALL_GOOGLE = 16

/** Vision models are slow on dense figures; anything past this has hung. */
const CALL_TIMEOUT_MS = 120_000

const VISION_INSTRUCTIONS = [
  'You describe figures taken from technical documents so that a reader who',
  'cannot see them can still follow the surrounding text.',
  '',
  'For each image, write 2-4 sentences: what kind of figure it is (chart,',
  'diagram, table, photograph, equation), what it shows, and any numbers,',
  'axis labels, or legends that carry meaning. Do not speculate about',
  'content that is not visible. Do not repeat the caption if one is present',
  'in the image.',
  '',
  'Reply with ONLY a JSON object keyed by image filename:',
  '{"images":[{"file":"figure-1.png","description":"..."}]}',
].join('\n')

export interface ImageAnalysisResult {
  /** Filename → description, for the images in this document. */
  notes: Map<string, string>
  /** True when the cached descriptions were reused instead of re-billed. */
  fromCache: boolean
}

interface MetaCache {
  provider?: string
  model?: string
  analyzedAt?: number
  images?: Record<string, string>
}

function metaPath(projectRoot: string, slug: string): string {
  return path.join(convertedRoot(projectRoot), slug, 'meta.json')
}

async function readMeta(
  projectRoot: string,
  slug: string,
): Promise<MetaCache> {
  try {
    const raw = await fs.readFile(metaPath(projectRoot, slug), 'utf8')
    const parsed = JSON.parse(raw) as MetaCache
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function mimeTypeFor(fileName: string): string {
  switch (path.extname(fileName).toLowerCase()) {
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.gif':
      return 'image/gif'
    case '.webp':
      return 'image/webp'
    default:
      // Extractors emit PNG by default; anything unrecognised is sent as PNG
      // rather than dropped, and a vendor that rejects it says so.
      return 'image/png'
  }
}

interface RawImageEntry {
  file?: unknown
  description?: unknown
}

function parseDescriptions(raw: string, batch: string[]): Map<string, string> {
  const parsed = extractJsonObject(raw)
  const notes = new Map<string, string>()
  if (parsed === null) return notes

  const known = new Set(batch)
  for (const entry of asObjectList(parsed, 'images', 'results')) {
    if (entry === null || typeof entry !== 'object') continue
    const record = entry as RawImageEntry
    const file = typeof record.file === 'string' ? path.basename(record.file) : null
    const description =
      typeof record.description === 'string' ? record.description.trim() : ''
    if (file === null || description === '' || !known.has(file)) continue
    notes.set(file, description)
  }
  return notes
}

export interface AnalyzeImagesRequest {
  projectRoot: string
  slug: string
  /** Absolute path of the document's `images/` directory. */
  imagesDir: string
  providerId: AiProviderId
}

/**
 * Describe every figure in one document, reusing the cache when it was
 * produced by the same provider and model.
 */
export async function analyzeImages(
  request: AnalyzeImagesRequest,
): Promise<ImageAnalysisResult> {
  const { projectRoot, slug, imagesDir, providerId } = request

  const provider = getProvider(providerId)
  const vision = visionProviderOption(providerId)
  const cache = await readMeta(projectRoot, slug)

  const files = (await fs.readdir(imagesDir))
    .filter((name) => !name.startsWith('.'))
    .sort()
  if (files.length === 0) return { notes: new Map(), fromCache: true }

  const cached = cache.images ?? {}
  const reusable =
    cache.provider === providerId &&
    cache.model === vision.model &&
    files.every((name) => typeof cached[name] === 'string')
  if (reusable) {
    return { notes: new Map(files.map((name) => [name, cached[name] ?? ''])), fromCache: true }
  }

  if (provider.completeVision === undefined) {
    throw new Error(
      `${vision.label} cannot read images on this endpoint. Pick another vision provider.`,
    )
  }
  const apiKey = await getApiKey(providerId)
  if (apiKey === null || apiKey === '') {
    throw new Error(
      `No API key saved for ${vision.label}. Add one in Settings, or convert in text-only mode.`,
    )
  }
  // The user's model choice wins when they have made one; otherwise the
  // catalogue default for this provider, which is the model the picker shows.
  const chosenModel = await resolveModel(providerId, vision.model)

  const batchSize =
    providerId === 'google' ? IMAGES_PER_CALL_GOOGLE : IMAGES_PER_CALL
  const notes = new Map<string, string>()

  for (let offset = 0; offset < files.length; offset += batchSize) {
    const batch = files.slice(offset, offset + batchSize)
    const images = await Promise.all(
      batch.map(async (name) => ({
        mimeType: mimeTypeFor(name),
        base64: (await fs.readFile(path.join(imagesDir, name))).toString('base64'),
      })),
    )

    // The instructions travel with the batch rather than in a separate
    // system field: the vision call sites (Google's `inlineData`, the
    // OpenAI-compatible `image_url` parts) do not all accept a system
    // instruction, and one prompt shape works on both.
    const prompt = [
      VISION_INSTRUCTIONS,
      '',
      `Describe the ${batch.length} image(s) below.`,
      `Filenames, in the order the images are attached: ${batch.join(', ')}`,
    ].join('\n')

    const response = await withTimeout(
      provider.completeVision({
        apiKey,
        model: chosenModel,
        prompt,
        images,
        maxTokens: 512 * batch.length,
      }),
      CALL_TIMEOUT_MS,
      `${vision.label} did not answer within ${CALL_TIMEOUT_MS / 1000}s.`,
    )

    const parsed = parseDescriptions(response, batch)
    for (const [name, description] of parsed) notes.set(name, description)

    // A batch the model answered without usable JSON would otherwise vanish:
    // the figure stays in the markdown, undescribed, and nothing says why.
    if (parsed.size === 0) {
      throw new Error(
        `${vision.label} returned no usable descriptions for ${batch.length} image(s). ` +
          `The response began: ${response.trim().slice(0, 120)}`,
      )
    }
  }

  const missing = files.filter((name) => !notes.has(name))
  if (missing.length > 0) {
    throw new Error(
      `${vision.label} skipped ${missing.length} image(s): ${missing.slice(0, 3).join(', ')}`,
    )
  }

  await writeFileEnsuringDir(
    metaPath(projectRoot, slug),
    `${JSON.stringify(
      {
        provider: providerId,
        model: chosenModel,
        analyzedAt: Date.now(),
        images: Object.fromEntries(notes),
      },
      null,
      2,
    )}\n`,
  )

  return { notes, fromCache: false }
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}
