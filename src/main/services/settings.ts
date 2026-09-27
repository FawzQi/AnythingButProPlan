import { app, safeStorage } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  AiProviderId,
  AiSettings,
  AiSettingsSaveRequest,
  AppMode,
  SuggestMethod,
  WebChatTargetId,
} from '@shared/types'

/**
 * Persist AI provider preferences and API keys. The keys live in
 * `userData/ai-settings.json`, encrypted with Electron's `safeStorage`
 * (OS keychain on macOS / Windows, kwallet / gnome-keyring on Linux). The
 * renderer never sees a decrypted key — every API call goes through the
 * main process — so a compromised renderer cannot exfiltrate credentials.
 */

interface StoredShape {
  provider: AiProviderId | null
  /** Base64-encoded, safeStorage-encrypted ciphertext per provider. */
  encryptedKeys: Partial<Record<AiProviderId, string>>
  modelByProvider: Partial<Record<AiProviderId, string>>
  /**
   * Which file-suggestion pipeline the UI should run. Defaults to
   * `gitnexus-only`, the local-recall method that needs no provider call.
   */
  suggestMethod: SuggestMethod
  /** Which chat site the "Send to web chat" button drives. */
  webChatTarget: WebChatTargetId
  /** Coding mode or research mode. Defaults to `coding`. */
  mode: AppMode
}

const EMPTY: StoredShape = {
  provider: null,
  encryptedKeys: {},
  modelByProvider: {},
  suggestMethod: 'gitnexus-only',
  webChatTarget: 'deepseek',
  mode: 'coding',
}

function asAppMode(value: unknown): AppMode {
  return value === 'research' ? 'research' : 'coding'
}

const WEB_CHAT_IDS: readonly WebChatTargetId[] = [
  'deepseek',
  'chatgpt',
  'claude',
  'gemini',
  'kimi',
  'qwen',
]

function asWebChatTarget(value: unknown): WebChatTargetId {
  return typeof value === 'string' &&
    (WEB_CHAT_IDS as readonly string[]).includes(value)
    ? (value as WebChatTargetId)
    : 'deepseek'
}

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'ai-settings.json')
}

async function readStored(): Promise<StoredShape> {
  try {
    const raw = await fs.readFile(settingsPath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<StoredShape>
    return {
      provider: parsed.provider ?? null,
      encryptedKeys: parsed.encryptedKeys ?? {},
      modelByProvider: parsed.modelByProvider ?? {},
      // An older settings file may carry a method that no longer exists —
      // `current` and `gitnexus` were retired when the app moved to the
      // local-first pipeline. Both migrate to `gitnexus-only`, the closest
      // surviving behaviour: local recall, no provider call, deterministic
      // result. Anything unrecognised falls back to the same default so a
      // hand-edited settings file cannot put the app into an unrecognised
      // state.
      suggestMethod:
        parsed.suggestMethod === 'gitnexus-jev' ||
        parsed.suggestMethod === 'gitnexus-llm'
          ? parsed.suggestMethod
          : 'gitnexus-only',
      webChatTarget: asWebChatTarget(parsed.webChatTarget),
      // Research mode arrived after the first settings files were written,
      // so an existing file has no `mode` at all. Narrowing here rather than
      // trusting the field means a missing or hand-edited value lands on
      // coding mode — the half of the app that carries the filesystem
      // actions — instead of an unrecognised state.
      mode: asAppMode(parsed.mode),
    }
  } catch {
    return { ...EMPTY }
  }
}

async function writeStored(shape: StoredShape): Promise<void> {
  const file = settingsPath()
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(shape, null, 2), 'utf8')
}

function encryptKey(plain: string): string {
  if (plain === '') return ''
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(plain).toString('base64')
  }
  // Linux without a keyring falls through here. Storing base64 plaintext is
  // worse than encryption but better than refusing the feature entirely; the
  // user opted into a local key file by using a free-tier API.
  return Buffer.from(plain, 'utf8').toString('base64')
}

function decryptKey(cipher: string): string | null {
  if (cipher === '') return null
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(cipher, 'base64'))
    }
    return Buffer.from(cipher, 'base64').toString('utf8')
  } catch {
    return null
  }
}

export async function getSettings(): Promise<AiSettings> {
  const stored = await readStored()
  const hasApiKey: Partial<Record<AiProviderId, boolean>> = {}
  for (const [id, cipher] of Object.entries(stored.encryptedKeys)) {
    hasApiKey[id as AiProviderId] = Boolean(cipher)
  }
  return {
    provider: stored.provider,
    modelByProvider: stored.modelByProvider,
    hasApiKey,
    suggestMethod: stored.suggestMethod,
    webChatTarget: stored.webChatTarget,
    mode: stored.mode,
  }
}

export async function saveSettings(
  request: AiSettingsSaveRequest,
): Promise<AiSettings> {
  const stored = await readStored()
  if (request.provider !== undefined) {
    stored.provider = request.provider
  }
  if (request.suggestMethod !== undefined) {
    stored.suggestMethod = request.suggestMethod
  }
  if (request.webChatTarget !== undefined) {
    stored.webChatTarget = request.webChatTarget
  }
  if (request.mode !== undefined) {
    stored.mode = request.mode
  }
  if (request.model) {
    stored.modelByProvider = {
      ...stored.modelByProvider,
      [request.model.provider]: request.model.model,
    }
  }
  if (request.apiKey) {
    const { provider, key } = request.apiKey
    if (key === '') {
      const next = { ...stored.encryptedKeys }
      delete next[provider]
      stored.encryptedKeys = next
    } else {
      stored.encryptedKeys = {
        ...stored.encryptedKeys,
        [provider]: encryptKey(key),
      }
    }
  }
  await writeStored(stored)
  return getSettings()
}

/**
 * Decrypt the stored key for a provider. Only called from the main process
 * immediately before an outbound request — the plaintext never crosses the
 * contextBridge.
 */
export async function getApiKey(provider: AiProviderId): Promise<string | null> {
  const stored = await readStored()
  const cipher = stored.encryptedKeys[provider]
  if (!cipher) return null
  return decryptKey(cipher)
}

/**
 * Resolve the effective model for a provider: the user's explicit choice if
 * one is stored, otherwise the provider's first (default) model.
 */
export async function resolveModel(
  provider: AiProviderId,
  fallback: string,
): Promise<string> {
  const stored = await readStored()
  return stored.modelByProvider[provider] ?? fallback
}