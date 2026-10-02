import { describe, expect, it } from 'vitest'
import { expandQueryLocally } from '../../src/main/services/query-expander'
import { Bm25Index } from '../../src/main/services/semantic-index'

describe('expandQueryLocally', () => {
  it('strips conversational stopwords from vague user prompts', () => {
    const expanded = expandQueryLocally('in this app please make the button work')
    // Stopwords like 'in', 'this', 'app', 'please', 'make', 'the' must not clutter primary terms
    expect(expanded.primaryTerms).not.toContain('in')
    expect(expanded.primaryTerms).not.toContain('this')
    expect(expanded.primaryTerms).not.toContain('app')
    expect(expanded.primaryTerms).not.toContain('please')
    expect(expanded.primaryTerms).not.toContain('make')
    expect(expanded.primaryTerms).not.toContain('the')

    // Domain keywords must remain in primary terms
    expect(expanded.primaryTerms).toContain('button')
    expect(expanded.primaryTerms).toContain('work')
  })

  it('splits compound names (camelCase, snake_case, kebab-case)', () => {
    const expanded = expandQueryLocally('fix WebChatWindow and user_status_indicator')
    expect(expanded.primaryTerms).toContain('webchatwindow')
    expect(expanded.primaryTerms).toContain('web')
    expect(expanded.primaryTerms).toContain('chat')
    expect(expanded.primaryTerms).toContain('window')
    expect(expanded.primaryTerms).toContain('user')
    expect(expanded.primaryTerms).toContain('status')
    expect(expanded.primaryTerms).toContain('indicator')
  })

  it('stems words and expands synonyms into expandedTerms and allTerms', () => {
    const expanded = expandQueryLocally('buttons clicking and notifications showing')
    expect(expanded.allTerms).toContain('button')
    expect(expanded.allTerms).toContain('click')
    expect(expanded.allTerms).toContain('notification')
  })

  it('expands domain developer synonyms for vague and symptom queries', () => {
    const expanded = expandQueryLocally('fix indicator and make login faster')
    // Synonyms for indicator
    expect(expanded.allTerms).toContain('status')
    expect(expanded.allTerms).toContain('badge')
    expect(expanded.allTerms).toContain('state')

    // Synonyms for faster / slow
    expect(expanded.allTerms).toContain('speed')
    expect(expanded.allTerms).toContain('perf')
    expect(expanded.allTerms).toContain('latency')

    // Synonyms for login / auth
    expect(expanded.allTerms).toContain('auth')
    expect(expanded.allTerms).toContain('session')
  })

  it('safely handles JavaScript prototype property names without error', () => {
    // Words like constructor, toString, valueOf, hasOwnProperty must not cause "sub is not iterable"
    expect(() => {
      expandQueryLocally('constructor toString valueOf hasOwnProperty prototype')
    }).not.toThrow()

    const expanded = expandQueryLocally('constructor toString valueOf hasOwnProperty prototype')
    expect(expanded.allTerms).toBeDefined()
    expect(expanded.allTerms.length).toBeGreaterThan(0)
  })
})

describe('Bm25Index multi-channel ranking', () => {
  it('gives path and symbol matches higher weight than body text', () => {
    const docs = [
      {
        path: 'src/renderer/components/StatusIndicator.tsx',
        pathTokens: ['src', 'renderer', 'components', 'status', 'indicator', 'tsx'],
        symbolTokens: ['StatusIndicator', 'status', 'indicator', 'render'],
        bodyPreview: 'export function StatusIndicator() { return <div>live</div> }',
      },
      {
        path: 'src/main/services/logger.ts',
        pathTokens: ['src', 'main', 'services', 'logger', 'ts'],
        symbolTokens: ['log', 'info'],
        bodyPreview: 'This file logs the status of operations to console.',
      },
    ]

    const index = new Bm25Index(docs)
    const hits = index.search('status indicator', 5)

    expect(hits.length).toBeGreaterThan(0)
    // StatusIndicator.tsx has status & indicator in both path and symbols, so it must rank #1
    expect(hits[0]?.path).toBe('src/renderer/components/StatusIndicator.tsx')
    expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? 0)
  })

  it('matches stemmed query terms against indexed documents', () => {
    const docs = [
      {
        path: 'src/renderer/buttons.tsx',
        pathTokens: ['src', 'renderer', 'buttons', 'tsx'],
        bodyPreview: 'export const PrimaryButton = () => <button>click</button>',
      },
    ]
    const index = new Bm25Index(docs)
    // Query uses singular 'button', document has 'buttons' in path
    const hits = index.search('button', 5)
    expect(hits.length).toBe(1)
    expect(hits[0]?.path).toBe('src/renderer/buttons.tsx')
  })
})
