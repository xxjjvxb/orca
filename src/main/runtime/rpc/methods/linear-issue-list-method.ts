import { z } from 'zod'
import { defineMethod } from '../core'
import { OptionalFiniteNumber, OptionalString } from '../schemas'
import { LinearIssueAttributeFilterSchema } from './linear-issue-attribute-filter-schema'

const LegacyListIssues = z
  .object({
    filter: z.enum(['assigned', 'created', 'all', 'completed']).optional(),
    limit: OptionalFiniteNumber,
    workspaceId: OptionalString,
    attributeFilter: LinearIssueAttributeFilterSchema.optional()
  })
  .strict()
  .optional()

const McpListIssues = z
  .object({
    team: OptionalString,
    cycle: OptionalString,
    label: OptionalString,
    limit: z.number().int().min(1).max(250).optional(),
    query: OptionalString,
    state: OptionalString,
    cursor: OptionalString,
    orderBy: z.enum(['createdAt', 'updatedAt']).optional(),
    project: OptionalString,
    release: OptionalString,
    assignee: OptionalString,
    delegate: OptionalString,
    parentId: OptionalString,
    priority: z.number().int().min(0).max(4).optional(),
    createdAt: OptionalString,
    updatedAt: OptionalString,
    includeArchived: z.boolean(),
    workspaceId: z.union([z.string(), z.literal('all')]).optional()
  })
  .strict()

const ListIssues = z.union([McpListIssues, LegacyListIssues])

export const LINEAR_ISSUE_LIST_METHOD = defineMethod({
  name: 'linear.listIssues',
  params: ListIssues,
  handler: async (params, { runtime }) => {
    if (params && 'includeArchived' in params) {
      return runtime.linearMcpIssueList(params)
    }
    return runtime.linearListIssues(params?.filter, params?.limit, params?.workspaceId, {
      attributeFilter: params?.attributeFilter
    })
  }
})
