import { toast } from 'sonner'
import { useAppStore } from '@/store'
import {
  createWebRuntimeSessionTerminal,
  isWebTerminalSurfaceTabId
} from '@/runtime/web-runtime-session'
import type { Tab, TuiAgent } from '../../../shared/types'
import type { AgentLaunchSpawnRequest } from '../../../shared/agent-launch-spawn-request'
import { translate } from '@/i18n/i18n'

function removeStaleLocalAgentTabsForWebHostLaunch(worktreeId: string): void {
  const state = useAppStore.getState()
  for (const tab of state.tabsByWorktree[worktreeId] ?? []) {
    if (tab.launchAgent && !isWebTerminalSurfaceTabId(tab.id)) {
      // Why: pruning a stale local agent tab is a system close — keep it out of
      // the Cmd+Shift+T reopen stack.
      state.closeTab(tab.id, { reason: 'cleanup' })
    }
  }
}

/**
 * Launch an agent terminal on the web runtime host instead of a local tab.
 *
 * Why: paired web tabs are host-owned, so this path never creates a local tab
 * (callers return tabId: null). Local-only agent tabs cannot be closed because
 * close routes through session.tabs.close on the host, so prune them before
 * the host snapshot.
 */
export function launchAgentInWebHostTab(args: {
  agent: TuiAgent
  worktreeId: string
  environmentId: string | null
  groupId?: string
  hasPrompt: boolean
  agentLaunch: AgentLaunchSpawnRequest
  viewMode?: Tab['viewMode']
  onPromptDelivered?: () => void
}): void {
  const {
    agent,
    worktreeId,
    environmentId,
    groupId,
    hasPrompt,
    agentLaunch,
    viewMode,
    onPromptDelivered
  } = args
  removeStaleLocalAgentTabsForWebHostLaunch(worktreeId)
  // Why: the host resolves the launch from `agentLaunch` (identity + prompt
  // policy only); the client never sends an assembled command/config/token.
  void createWebRuntimeSessionTerminal({
    worktreeId,
    environmentId,
    targetGroupId: groupId,
    activate: true,
    ...(viewMode ? { viewMode } : {}),
    agentLaunch
  }).then((created) => {
    // Why: created means the host accepted the launch, not that a local tab
    // exists; keep pruning stale local rows until the snapshot mirrors.
    removeStaleLocalAgentTabsForWebHostLaunch(worktreeId)
    if (!created) {
      toast.error(
        translate(
          'auto.lib.launch.agent.in.new.tab.11cce5cc77',
          'Could not launch {{value0}} in a new terminal.',
          { value0: agent }
        )
      )
      return
    }
    useAppStore.getState().setActiveTabType('terminal')
    if (hasPrompt) {
      onPromptDelivered?.()
    }
  })
}
