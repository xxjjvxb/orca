import type {
  LinearMcpIssueListRequest,
  LinearMcpIssueListResult
} from '../../shared/linear-agent-access'
import { acquire, clearToken, getClients, isAuthError, release } from './client'
import { classifyLinearError, linearMessage } from './issue-context-errors'
import { ISSUE_FIELDS, mapIssue, type RawIssue } from './issue-context-raw'

const LIST_ISSUES_DEFAULT_LIMIT = 50
const LIST_ISSUES_MAX_LIMIT = 250

type RawListIssuesResponse = {
  issues?: {
    nodes?: RawIssue[]
    pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }
  } | null
}

const LIST_ISSUES_QUERY = `
  query OrcaLinearListIssues(
    $first: Int!
    $after: String
    $filter: IssueFilter
    $orderBy: PaginationOrderBy
    $includeArchived: Boolean
  ) {
    issues(
      first: $first
      after: $after
      filter: $filter
      orderBy: $orderBy
      includeArchived: $includeArchived
    ) {
      nodes { ${ISSUE_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }
`

export async function listMcpIssues(
  request: LinearMcpIssueListRequest
): Promise<LinearMcpIssueListResult> {
  if (request.cursor && request.workspaceId === 'all') {
    throw new Error('Cursor pagination requires a concrete Linear workspace.')
  }
  const limit = clampLimit(request.limit)
  const orderBy = request.orderBy ?? 'updatedAt'
  const entries = getClients(request.workspaceId)
  const issues: LinearMcpIssueListResult['issues'] = []
  const workspaceErrors: LinearMcpIssueListResult['meta']['workspaceErrors'] = []
  let hasMore = false
  let nextCursor: string | undefined

  for (const entry of entries) {
    await acquire()
    try {
      const raw = await entry.client.client.rawRequest<
        RawListIssuesResponse,
        Record<string, unknown>
      >(LIST_ISSUES_QUERY, {
        first: limit,
        after: request.cursor,
        filter: buildIssueFilter(request),
        orderBy,
        includeArchived: request.includeArchived ?? false
      })
      const connection = raw.data?.issues
      issues.push(
        ...(connection?.nodes ?? []).map((issue) => ({
          ...mapIssue(issue),
          workspace: { id: entry.workspace.id, name: entry.workspace.organizationName }
        }))
      )
      hasMore ||= connection?.pageInfo?.hasNextPage === true
      if (entries.length === 1) {
        nextCursor = connection?.pageInfo?.endCursor ?? undefined
      }
    } catch (error) {
      if (isAuthError(error)) {
        clearToken(entry.workspace.id)
      }
      if (request.workspaceId !== 'all') {
        throw error
      }
      workspaceErrors.push({
        workspace: { id: entry.workspace.id, name: entry.workspace.organizationName },
        code: classifyLinearError(error),
        message: linearMessage(error)
      })
    } finally {
      release()
    }
  }

  issues.sort((left, right) => compareIssues(left, right, orderBy))
  if (issues.length > limit) {
    hasMore = true
    issues.length = limit
  }
  return {
    issues,
    meta: {
      limit,
      returned: issues.length,
      hasMore,
      ...(hasMore && nextCursor ? { nextCursor } : {}),
      orderBy,
      workspaceId: request.workspaceId,
      partial: workspaceErrors.length > 0,
      workspaceErrors
    }
  }
}

function buildIssueFilter(request: LinearMcpIssueListRequest): Record<string, unknown> {
  const filter: Record<string, unknown> = {}
  if (request.team) {
    filter.team = namedFilter(request.team, true)
  }
  if (request.cycle) {
    filter.cycle = nullableNamedFilter(request.cycle)
  }
  if (request.label) {
    filter.labels = { some: namedFilter(request.label) }
  }
  if (request.query) {
    filter.searchableContent = { contains: request.query }
  }
  if (request.state) {
    filter.state = namedFilter(request.state)
  }
  if (request.project) {
    filter.project = nullableNamedFilter(request.project)
  }
  if (request.release) {
    filter.releases = { some: namedFilter(request.release, false, true) }
  }
  if (request.assignee) {
    filter.assignee = nullableUserFilter(request.assignee)
  }
  if (request.delegate) {
    filter.delegate = nullableUserFilter(request.delegate)
  }
  if (request.parentId) {
    filter.parent = nullableIdFilter(request.parentId)
  }
  if (request.priority !== undefined) {
    filter.priority = { eq: request.priority }
  }
  if (request.createdAt) {
    filter.createdAt = { gte: request.createdAt }
  }
  if (request.updatedAt) {
    filter.updatedAt = { gte: request.updatedAt }
  }
  return filter
}

function namedFilter(value: string, includeKey = false, includeVersion = false): object {
  return {
    or: [
      { id: { eq: value } },
      { name: { eqIgnoreCase: value } },
      ...(includeKey ? [{ key: { eqIgnoreCase: value } }] : []),
      ...(includeVersion ? [{ version: { eqIgnoreCase: value } }] : [])
    ]
  }
}

function nullableNamedFilter(value: string): object {
  return value === 'null' ? { null: true } : namedFilter(value)
}

function nullableIdFilter(value: string): object {
  return value === 'null' ? { null: true } : { id: { eq: value } }
}

function nullableUserFilter(value: string): object {
  if (value === 'null') {
    return { null: true }
  }
  if (value.toLocaleLowerCase() === 'me') {
    return { isMe: { eq: true } }
  }
  return {
    or: [
      { id: { eq: value } },
      { displayName: { eqIgnoreCase: value } },
      { name: { eqIgnoreCase: value } },
      { email: { eqIgnoreCase: value } }
    ]
  }
}

function clampLimit(limit: number | undefined): number {
  return Math.min(
    Math.max(1, Math.floor(limit ?? LIST_ISSUES_DEFAULT_LIMIT)),
    LIST_ISSUES_MAX_LIMIT
  )
}

function compareIssues(
  left: LinearMcpIssueListResult['issues'][number],
  right: LinearMcpIssueListResult['issues'][number],
  orderBy: 'createdAt' | 'updatedAt'
): number {
  return (right[orderBy] ?? '').localeCompare(left[orderBy] ?? '')
}
