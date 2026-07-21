type WebAgentSessionHandoff = {
  environmentId: string
  worktreeId: string
  provisionalTabId: string
  hostTabId: string
}

const hostTabIdByProvisionalTab = new Map<string, string>()

function handoffKey(args: Omit<WebAgentSessionHandoff, 'hostTabId'>): string {
  return `${args.environmentId}\0${args.worktreeId}\0${args.provisionalTabId}`
}

export function recordWebAgentSessionHandoff(args: WebAgentSessionHandoff): void {
  if (
    !args.environmentId.trim() ||
    !args.worktreeId.trim() ||
    !args.provisionalTabId.trim() ||
    !args.hostTabId.trim()
  ) {
    return
  }
  hostTabIdByProvisionalTab.set(handoffKey(args), args.hostTabId)
}

export function resolveWebAgentSessionHandoff(
  args: Omit<WebAgentSessionHandoff, 'hostTabId'>
): string | null {
  return hostTabIdByProvisionalTab.get(handoffKey(args)) ?? null
}

export function clearWebAgentSessionHandoff(args: Omit<WebAgentSessionHandoff, 'hostTabId'>): void {
  hostTabIdByProvisionalTab.delete(handoffKey(args))
}

export function clearWebAgentSessionHandoffsForWorktree(
  environmentId: string,
  worktreeId: string
): void {
  const prefix = `${environmentId}\0${worktreeId}\0`
  for (const key of hostTabIdByProvisionalTab.keys()) {
    if (key.startsWith(prefix)) {
      hostTabIdByProvisionalTab.delete(key)
    }
  }
}

export function clearWebAgentSessionHandoffsForEnvironment(environmentId: string): void {
  const prefix = `${environmentId}\0`
  for (const key of hostTabIdByProvisionalTab.keys()) {
    if (key.startsWith(prefix)) {
      hostTabIdByProvisionalTab.delete(key)
    }
  }
}

export function resetWebAgentSessionHandoffsForTests(): void {
  hostTabIdByProvisionalTab.clear()
}
