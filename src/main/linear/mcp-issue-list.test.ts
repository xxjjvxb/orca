import { beforeEach, describe, expect, it, vi } from 'vitest'

const rawRequest = vi.fn()

vi.mock('./client', () => ({
  acquire: vi.fn(),
  release: vi.fn(),
  clearToken: vi.fn(),
  isAuthError: () => false,
  getClients: () => [
    {
      workspace: { id: 'workspace-1', organizationName: 'Acme' },
      client: { client: { rawRequest } }
    }
  ]
}))

describe('MCP-compatible Linear issue listing', () => {
  beforeEach(() => vi.clearAllMocks())

  it('passes rich filters, ordering, archive scope, and cursor to Linear', async () => {
    rawRequest.mockResolvedValue({
      data: {
        issues: {
          nodes: [
            {
              id: 'issue-1',
              identifier: 'ENG-1',
              title: 'Fix auth',
              url: 'https://linear.app/acme/issue/ENG-1',
              labels: { nodes: [] },
              createdAt: '2026-07-01T00:00:00.000Z',
              updatedAt: '2026-07-20T00:00:00.000Z'
            }
          ],
          pageInfo: { hasNextPage: true, endCursor: 'next-page' }
        }
      }
    })
    const { listMcpIssues } = await import('./mcp-issue-list')

    const result = await listMcpIssues({
      team: 'ENG',
      label: 'Bug',
      state: 'In Progress',
      assignee: 'me',
      project: 'Launch',
      priority: 2,
      query: 'auth',
      updatedAt: '-P7D',
      cursor: 'current-page',
      orderBy: 'createdAt',
      includeArchived: true,
      limit: 100,
      workspaceId: 'workspace-1'
    })

    expect(rawRequest).toHaveBeenCalledWith(
      expect.stringContaining('query OrcaLinearListIssues'),
      expect.objectContaining({
        first: 100,
        after: 'current-page',
        orderBy: 'createdAt',
        includeArchived: true,
        filter: expect.objectContaining({
          searchableContent: { contains: 'auth' },
          priority: { eq: 2 },
          updatedAt: { gte: '-P7D' },
          assignee: { isMe: { eq: true } }
        })
      })
    )
    expect(result.meta).toMatchObject({
      limit: 100,
      returned: 1,
      hasMore: true,
      nextCursor: 'next-page',
      orderBy: 'createdAt'
    })
    expect(result.issues[0]).toMatchObject({
      identifier: 'ENG-1',
      workspace: { id: 'workspace-1', name: 'Acme' }
    })
  })

  it('uses null filters and clamps direct callers to the MCP maximum', async () => {
    rawRequest.mockResolvedValue({
      data: { issues: { nodes: [], pageInfo: { hasNextPage: false } } }
    })
    const { listMcpIssues } = await import('./mcp-issue-list')

    await listMcpIssues({ assignee: 'null', parentId: 'null', limit: 999 })

    expect(rawRequest.mock.calls[0]?.[1]).toMatchObject({
      first: 250,
      filter: { assignee: { null: true }, parent: { null: true } }
    })
  })
})
