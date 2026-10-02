import type { AiProviderId } from '@shared/types'
import { getProvider } from './ai-providers'

/**
 * Common English filler words that frequently occur in user prompts
 * (e.g. "in this app make the live indicator actually checking...")
 * but carry near-zero discriminative value for code retrieval.
 */
const STOPWORDS = new Set([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and',
  'any', 'are', 'aren\'t', 'as', 'at', 'be', 'because', 'been', 'before', 'being',
  'below', 'between', 'both', 'but', 'by', 'can', 'can\'t', 'cannot', 'could',
  'couldn\'t', 'did', 'didn\'t', 'do', 'does', 'doesn\'t', 'doing', 'don\'t',
  'down', 'during', 'each', 'few', 'for', 'from', 'further', 'had', 'hadn\'t',
  'has', 'hasn\'t', 'have', 'haven\'t', 'having', 'he', 'her', 'here', 'hers',
  'herself', 'him', 'himself', 'his', 'how', 'i', 'if', 'in', 'into', 'is',
  'isn\'t', 'it', 'its', 'itself', 'let', 'me', 'more', 'most', 'my', 'myself',
  'no', 'nor', 'not', 'of', 'off', 'on', 'once', 'only', 'or', 'other', 'ought',
  'our', 'ours', 'ourselves', 'out', 'over', 'own', 'same', 'she', 'should',
  'shouldn\'t', 'so', 'some', 'such', 'than', 'that', 'the', 'their', 'theirs',
  'them', 'themselves', 'then', 'there', 'these', 'they', 'this', 'those',
  'through', 'to', 'too', 'under', 'until', 'up', 'very', 'was', 'wasn\'t',
  'we', 'were', 'weren\'t', 'what', 'when', 'where', 'which', 'while', 'who',
  'whom', 'why', 'with', 'won\'t', 'would', 'wouldn\'t', 'you', 'your', 'yours',
  'yourself', 'yourselves',
  // Conversational filler words
  'app', 'please', 'make', 'want', 'need', 'trying', 'sure', 'actually', 'properly',
])

/**
 * Curated developer vocabulary mapping: bridges natural language symptom words
 * to technical implementation identifiers frequently used in codebases.
 */
const DOMAIN_SYNONYMS: Record<string, string[]> = Object.assign(Object.create(null), {
  // Authentication & Session
  login: ['auth', 'signin', 'session', 'token', 'credential'],
  logout: ['signout', 'session', 'auth'],
  auth: ['login', 'signin', 'session', 'token', 'permission'],
  session: ['token', 'auth', 'cookie', 'state'],

  // Live status & Indicators
  indicator: ['status', 'badge', 'state', 'dot', 'signal', 'pulse', 'spinner', 'working', 'idle', 'paused'],
  status: ['indicator', 'state', 'working', 'idle', 'paused', 'badge'],
  working: ['busy', 'generating', 'thinking', 'loading', 'active', 'progress'],
  paused: ['pause', 'continue', 'resume', 'interrupted'],
  idle: ['ready', 'inactive', 'standby'],
  spinner: ['loading', 'indicator', 'progress', 'spin'],

  // UI & Components
  button: ['btn', 'click', 'press', 'action', 'submit', 'trigger'],
  modal: ['dialog', 'popup', 'overlay', 'window'],
  dialog: ['modal', 'popup', 'alert', 'confirm'],
  page: ['view', 'screen', 'component', 'dashboard', 'panel'],
  dashboard: ['panel', 'view', 'prompt', 'board', 'home'],
  tree: ['hierarchy', 'node', 'filetree', 'folder'],
  tab: ['tabs', 'switcher', 'navigation', 'panel'],
  dark: ['theme', 'darkmode', 'light', 'color', 'mode'],
  theme: ['dark', 'light', 'mode', 'tailwind', 'color', 'style'],
  color: ['theme', 'style', 'css', 'class', 'bg'],

  // Performance & Latency
  slow: ['perf', 'performance', 'latency', 'speed', 'cache', 'debounce', 'throttle', 'optimize'],
  fast: ['speed', 'perf', 'performance', 'latency', 'cache', 'optimize'],
  faster: ['speed', 'perf', 'performance', 'latency', 'cache', 'optimize'],
  sluggish: ['slow', 'perf', 'performance', 'latency', 'lag', 'speed', 'cache', 'optimize'],
  lag: ['latency', 'slow', 'delay', 'perf', 'performance'],
  speed: ['perf', 'performance', 'fast', 'latency', 'cache'],
  perf: ['performance', 'speed', 'latency', 'cache', 'benchmark'],

  // AI & Chat
  ai: ['llm', 'model', 'provider', 'prompt', 'completion', 'chat', 'webchat'],
  llm: ['ai', 'model', 'provider', 'chat', 'deepseek', 'groq', 'openai'],
  chat: ['webchat', 'conversation', 'prompt', 'message', 'reply', 'response'],
  webchat: ['chat', 'window', 'deepseek', 'chatgpt', 'browser', 'target'],
  prompt: ['instruction', 'template', 'builder', 'query', 'input'],

  // System & Files
  file: ['path', 'fs', 'document', 'entry', 'tree'],
  folder: ['dir', 'directory', 'path', 'folder'],
  git: ['vcs', 'commit', 'diff', 'branch', 'log', 'history'],
  diff: ['patch', 'change', 'viewer', 'compare', 'hunk'],
  test: ['spec', 'unit', 'e2e', 'vitest', 'playwright', 'assert'],
  error: ['fail', 'failure', 'exception', 'catch', 'reject', 'warn'],
  bug: ['issue', 'fix', 'error', 'defect', 'problem'],
  upload: ['import', 'scanner', 'attach', 'file', 'converter'],
})

/**
 * Lightweight English stemmer / suffix normalizer.
 * Reduces common inflected endings so "checking" matches "check",
 * "buttons" matches "button", and "crashed" matches "crash".
 */
export function stemToken(word: string): string {
  let s = word.toLowerCase()
  if (s.length <= 3) return s

  if (s.endsWith('sses')) return s.slice(0, -2)
  if (s.endsWith('ies')) return s.slice(0, -3) + 'y'
  if (s.endsWith('ss')) return s
  if (s.endsWith('s') && !s.endsWith('us') && !s.endsWith('is')) return s.slice(0, -1)

  if (s.endsWith('eed') && s.length > 4) return s.slice(0, -1)
  if (s.endsWith('ed') && s.length > 4) {
    s = s.slice(0, -2)
    if (s.endsWith('at') || s.endsWith('bl') || s.endsWith('iz')) return s + 'e'
    return s
  }

  if (s.endsWith('ing') && s.length > 5) {
    const base = s.slice(0, -3)
    if (base.endsWith('at') || base.endsWith('bl') || base.endsWith('iz')) return base + 'e'
    // e.g. "running" -> "run"
    if (base.length >= 3 && base[base.length - 1] === base[base.length - 2]) {
      return base.slice(0, -1)
    }
    return base
  }

  if (s.endsWith('er') && s.length > 4) {
    const base = s.slice(0, -2)
    if (base.length >= 3 && base[base.length - 1] === base[base.length - 2]) {
      return base.slice(0, -1)
    }
    return base
  }

  return s
}

// Handle common fused compound words (e.g. webchat -> web, chat)
const FUSED_COMPOUNDS: Record<string, string[]> = Object.assign(Object.create(null), {
  webchat: ['web', 'chat'],
  codebase: ['code', 'base'],
  filesystem: ['file', 'system'],
  darkmode: ['dark', 'mode'],
  lightmode: ['light', 'mode'],
  datatype: ['data', 'type'],
  filepath: ['file', 'path'],
  filename: ['file', 'name'],
})

/**
 * Splits camelCase, PascalCase, snake_case, kebab-case, and compound words.
 */
export function splitCompound(text: string): string[] {
  const pieces: string[] = []

  // Preserve unsplit words lowercase for exact compound/symbol matches
  for (const raw of text.split(/[^a-zA-Z0-9]+/)) {
    const lower = raw.toLowerCase()
    if (lower.length >= 2 && lower.length <= 40 && !pieces.includes(lower)) {
      pieces.push(lower)
    }
  }

  // Split on transition from lowercase/digit to uppercase
  const separated = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()

  for (const part of separated.split(/[^a-z0-9]+/)) {
    if (part.length >= 2 && part.length <= 40 && !pieces.includes(part)) {
      pieces.push(part)
    }
  }

  for (const part of [...pieces]) {
    const sub = FUSED_COMPOUNDS[part]
    if (Array.isArray(sub)) {
      for (const s of sub) {
        if (!pieces.includes(s)) pieces.push(s)
      }
    }
  }

  return pieces
}

export interface ExpandedQuery {
  /** High-signal terms derived directly from user prompt (cleaned & filtered). */
  primaryTerms: string[]
  /** Morphological stems and synonym expansions. */
  expandedTerms: string[]
  /** All unique tokens combined for hybrid matching. */
  allTerms: string[]
  /** Tokens spent if AI expansion was executed. */
  stage1Tokens?: number
}

/**
 * Rule-based expansion: fast, local, offline, deterministic.
 */
export function expandQueryLocally(instruction: string): ExpandedQuery {
  const rawPieces = splitCompound(instruction)
  const primarySet = new Set<string>()
  const expandedSet = new Set<string>()

  for (const piece of rawPieces) {
    if (STOPWORDS.has(piece)) continue
    primarySet.add(piece)

    // Suffix reduction
    const stem = stemToken(piece)
    if (stem !== piece && stem.length >= 2) {
      expandedSet.add(stem)
    }

    // Domain synonym lookup
    const synonyms = DOMAIN_SYNONYMS[piece] ?? DOMAIN_SYNONYMS[stem]
    if (Array.isArray(synonyms)) {
      for (const syn of synonyms) {
        expandedSet.add(syn)
      }
    }
  }

  // If all words were stopwords, retain the raw pieces to avoid empty query
  if (primarySet.size === 0) {
    for (const piece of rawPieces) {
      primarySet.add(piece)
    }
  }

  const primaryTerms = [...primarySet]
  const expandedTerms = [...expandedSet].filter((t) => !primarySet.has(t))
  const allTerms = [...primaryTerms, ...expandedTerms]

  return { primaryTerms, expandedTerms, allTerms }
}

/**
 * AI-assisted Stage-1 Query Expansion (HyDE / Keyword Generator).
 * Calls the configured model with a lightweight prompt to generate
 * specific code identifiers and file keywords from a vague user instruction.
 */
export async function expandQueryWithAi(
  instruction: string,
  providerId: AiProviderId,
  model: string,
  apiKey: string,
): Promise<ExpandedQuery> {
  const local = expandQueryLocally(instruction)
  if (!apiKey || instruction.trim().length === 0) {
    return local
  }

  try {
    const provider = getProvider(providerId)
    const prompt =
      'You are a code search assistant. Given the following user instruction, ' +
      'list 8 to 12 concise code identifiers, function names, component names, ' +
      'and technical file concepts a developer would search for in the codebase to solve this.\n\n' +
      `User Instruction: "${instruction}"\n\n` +
      'Output ONLY a comma-separated list of keywords/identifiers, with no commentary or prose.'

    const responseText = await provider.complete({
      apiKey,
      model,
      system: 'You are a code search assistant that outputs comma-separated identifiers.',
      user: prompt,
      maxTokens: 120,
      temperature: 0.1,
    })

    const combinedSet = new Set(local.allTerms)
    const aiKeywords: string[] = []

    const cleanTokens = responseText
      .replace(/[^\w\s,-]/g, '')
      .split(/[,\n]+/)
      .map((k: string) => k.trim().toLowerCase())
      .filter((k: string) => k.length >= 2 && k.length <= 40)

    for (const kw of cleanTokens) {
      for (const part of splitCompound(kw)) {
        if (!STOPWORDS.has(part) && !combinedSet.has(part)) {
          combinedSet.add(part)
          aiKeywords.push(part)
        }
      }
    }

    return {
      primaryTerms: local.primaryTerms,
      expandedTerms: [...local.expandedTerms, ...aiKeywords],
      allTerms: [...combinedSet],
    }
  } catch {
    // If AI expansion fails, return local expansion without failing the query
    return local
  }
}
