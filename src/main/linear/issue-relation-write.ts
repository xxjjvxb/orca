import type {
  LinearIssueRelationship,
  LinearIssueRelationWriteResult
} from '../../shared/linear-issue-relation-write'
import { acquire, clearToken, getClients, isAuthError, release } from './client'
import { readConnectionPages } from './issue-context-pagination'
import {
  INVERSE_RELATIONS_QUERY,
  RELATIONS_QUERY,
  type RawRelationNode,
  type RawRelationsResponse
} from './issue-context-raw'

const RELATION_WRITE_READ_CAP = 250

type RelationMutationResponse = {
  issueRelationCreate?: {
    success?: boolean
    issueRelation?: RawRelationNode | null
  } | null
  issueRelationDelete?: { success?: boolean } | null
}

const CREATE_RELATION_MUTATION = `
  mutation OrcaLinearCreateIssueRelation($input: IssueRelationCreateInput!) {
    issueRelationCreate(input: $input) {
      success
      issueRelation {
        id
        type
        issue { id identifier title url }
        relatedIssue { id identifier title url }
      }
    }
  }
`

const DELETE_RELATION_MUTATION = `
  mutation OrcaLinearDeleteIssueRelation($id: String!) {
    issueRelationDelete(id: $id) { success }
  }
`

export async function writeIssueRelation(params: {
  issue: LinearIssueRelationWriteResult['issue']
  relatedIssue: LinearIssueRelationWriteResult['relatedIssue']
  relationship: LinearIssueRelationship
  operation: 'add' | 'remove'
  workspaceId: string
}): Promise<LinearIssueRelationWriteResult> {
  const entry = getClients(params.workspaceId)[0]
  if (!entry) {
    throw new Error('Not connected to Linear')
  }
  await acquire()
  try {
    const relations = await readRelations(entry, params.issue.id)
    const existing = relations.find(
      (relation) =>
        relation.relationship === params.relationship &&
        relation.relatedIssue?.id === params.relatedIssue.id
    )
    if (params.operation === 'add' && existing) {
      return result(params, existing, true)
    }
    if (params.operation === 'remove' && !existing) {
      return result(params, absentRelation(params), true)
    }
    if (params.operation === 'remove' && existing) {
      const raw = await entry.client.client.rawRequest<
        RelationMutationResponse,
        Record<string, unknown>
      >(DELETE_RELATION_MUTATION, { id: existing.id })
      if (raw.data?.issueRelationDelete?.success !== true) {
        throw new Error('Linear relation removal failed')
      }
      return result(params, existing, false)
    }
    const input = relationCreateInput(params)
    const raw = await entry.client.client.rawRequest<
      RelationMutationResponse,
      Record<string, unknown>
    >(CREATE_RELATION_MUTATION, { input })
    const created = raw.data?.issueRelationCreate
    if (created?.success !== true || !created.issueRelation) {
      throw new Error('Linear relation creation failed')
    }
    return result(params, normalizeRelation(created.issueRelation, params.issue.id), false)
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.workspace.id)
    }
    throw error
  } finally {
    release()
  }
}

async function readRelations(
  entry: ReturnType<typeof getClients>[number],
  issueId: string
): Promise<LinearIssueRelationWriteResult['relation'][]> {
  const outbound = await readConnectionPages(RELATION_WRITE_READ_CAP, async (page) => {
    const raw = await entry.client.client.rawRequest<RawRelationsResponse, Record<string, unknown>>(
      RELATIONS_QUERY,
      { id: issueId, ...page }
    )
    return raw.data?.issue?.relations ?? null
  })
  const inverse = await readConnectionPages(RELATION_WRITE_READ_CAP, async (page) => {
    const raw = await entry.client.client.rawRequest<RawRelationsResponse, Record<string, unknown>>(
      INVERSE_RELATIONS_QUERY,
      { id: issueId, ...page }
    )
    return raw.data?.issue?.inverseRelations ?? null
  })
  return [
    ...outbound.nodes.map((node) => normalizeRelation(node, issueId, 'outbound')),
    ...inverse.nodes.map((node) => normalizeRelation(node, issueId, 'inbound'))
  ]
}

function normalizeRelation(
  node: RawRelationNode,
  issueId: string,
  knownDirection?: 'outbound' | 'inbound'
): LinearIssueRelationWriteResult['relation'] {
  const outbound = knownDirection
    ? knownDirection === 'outbound'
    : node.issue?.id === issueId || node.relatedIssue?.id !== issueId
  const neighbor = outbound ? node.relatedIssue : node.issue
  const type = node.type ?? null
  return {
    id: node.id,
    type,
    direction: outbound ? 'outbound' : 'inbound',
    relationship:
      type === 'blocks'
        ? outbound
          ? 'blocks'
          : 'blockedBy'
        : type === 'duplicate'
          ? outbound
            ? 'duplicateOf'
            : 'duplicatedBy'
          : type === 'similar'
            ? 'similar'
            : 'relatedTo',
    relatedIssue: neighbor
      ? {
          id: neighbor.id,
          identifier: neighbor.identifier,
          title: neighbor.title,
          url: neighbor.url
        }
      : null
  }
}

function relationCreateInput(params: {
  issue: { id: string }
  relatedIssue: { id: string }
  relationship: LinearIssueRelationship
}): { issueId: string; relatedIssueId: string; type: string } {
  if (params.relationship === 'blockedBy') {
    return {
      issueId: params.relatedIssue.id,
      relatedIssueId: params.issue.id,
      type: 'blocks'
    }
  }
  return {
    issueId: params.issue.id,
    relatedIssueId: params.relatedIssue.id,
    type:
      params.relationship === 'relatedTo'
        ? 'related'
        : params.relationship === 'duplicateOf'
          ? 'duplicate'
          : 'blocks'
  }
}

function absentRelation(params: {
  relatedIssue: LinearIssueRelationWriteResult['relatedIssue']
  relationship: LinearIssueRelationship
}): LinearIssueRelationWriteResult['relation'] {
  return {
    id: '',
    type: linearRelationType(params.relationship),
    direction: params.relationship === 'blockedBy' ? 'inbound' : 'outbound',
    relationship: params.relationship,
    relatedIssue: params.relatedIssue
  }
}

function linearRelationType(relationship: LinearIssueRelationship): string {
  if (relationship === 'relatedTo') {
    return 'related'
  }
  if (relationship === 'duplicateOf') {
    return 'duplicate'
  }
  return 'blocks'
}

function result(
  params: {
    issue: LinearIssueRelationWriteResult['issue']
    relatedIssue: LinearIssueRelationWriteResult['relatedIssue']
    operation: 'add' | 'remove'
    workspaceId: string
  },
  relation: LinearIssueRelationWriteResult['relation'],
  alreadySet: boolean
): LinearIssueRelationWriteResult {
  return {
    issue: params.issue,
    relatedIssue: params.relatedIssue,
    relation,
    operation: params.operation,
    meta: { workspaceId: params.workspaceId, alreadySet }
  }
}
