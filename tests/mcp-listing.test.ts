import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { describe, expect, it } from 'vitest'
import { collectServerResourceEntries } from '../extensions/mcp/listing.ts'

type Resources = Array<{ uri: string; name: string }>
const clientOf = (resources: () => Promise<{ resources: Resources }>, templates: () => Promise<{ resourceTemplates: Array<{ uriTemplate: string; name: string }> }>): Client => ({ listResources: resources, listResourceTemplates: templates }) as unknown as Client

const emptyTemplates = async () => ({ resourceTemplates: [] })

describe('collectServerResourceEntries', () => {
  it('records a listing failure inline so one server cannot empty the whole listing', async () => {
    const entries: Array<Record<string, unknown>> = []
    await collectServerResourceEntries(
      entries,
      'bad',
      clientOf(async () => {
        throw new Error('boom')
      }, emptyTemplates),
      1000,
    )
    await collectServerResourceEntries(
      entries,
      'good',
      clientOf(async () => ({ resources: [{ uri: 'x://a', name: 'A' }] }), emptyTemplates),
      1000,
    )
    expect(entries).toEqual([
      { server: 'bad', error: 'boom' },
      { server: 'good', uri: 'x://a', name: 'A' },
    ])
  })

  it('keeps the entries collected before a mid-pagination failure', async () => {
    const entries: Array<Record<string, unknown>> = []
    let page = 0
    await collectServerResourceEntries(
      entries,
      'flaky',
      clientOf(async () => {
        page += 1
        if (page === 1) return { resources: [{ uri: 'x://first', name: 'First' }], nextCursor: 'more' } as { resources: Resources }
        throw new Error('page 2 died')
      }, emptyTemplates),
      1000,
    )
    expect(entries).toEqual([
      { server: 'flaky', uri: 'x://first', name: 'First' },
      { server: 'flaky', error: 'page 2 died' },
    ])
  })

  it('stays silent when only the optional template listing fails', async () => {
    const entries: Array<Record<string, unknown>> = []
    await collectServerResourceEntries(
      entries,
      's',
      clientOf(
        async () => ({ resources: [] }),
        async () => {
          throw new Error('method not found')
        },
      ),
      1000,
    )
    expect(entries).toEqual([])
  })
})
