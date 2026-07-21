import { toast } from 'sonner'
import { useAppStore } from '@/store'
import {
  createWebRuntimeSessionTerminal,
  isWebTerminalSurfaceTabId
} from '@/runtime/web-runtime-session'
import type { Tab, TuiAgent } from '../../../shared/types'
import type {
  AgentLaunchPreferences,
  AgentPromptDelivery
} from '../../../shared/agent-session-host-authority'
import type { SleepingAgentLaunchConfig } from '../../../shared/agent-session-resume'
import type { StartupCommandDelivery } from '../../../shared/codex-startup-delivery'
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
  prompt?: string
  promptDelivery?: AgentPromptDelivery
  agentArgs?: string | null
  launchPreferences?: AgentLaunchPreferences
  command: string
  env?: Record<string, string>
  launchConfig: SleepingAgentLaunchConfig
  startupCommandDelivery?: StartupCommandDelivery
  viewMode?: Tab['viewMode']
  onPromptDelivered?: () => void
}): void {
  const {
    agent,
    worktreeId,
    environmentId,
    groupId,
    hasPrompt,
    prompt,
    promptDelivery,
    agentArgs,
    launchPreferences,
    command,
    env,
    launchConfig,
    startupCommandDelivery,
    viewMode,
    onPromptDelivered
  } = args
  removeStaleLocalAgentTabsForWebHostLaunch(worktreeId)
  void createWebRuntimeSessionTerminal({
    worktreeId,
    environmentId,
    targetGroupId: groupId,
    activate: true,
    ...(viewMode ? { viewMode } : {}),
    agentSessionKind: 'fresh',
    ...(hasPrompt
      ? {
          launchAgent: agent,
          command,
          ...(env ? { env } : {}),
          launchConfig,
          ...(startupCommandDelivery ? { startupCommandDelivery } : {})
        }
      : { agent }),
    ...(hasPrompt && prompt ? { prompt } : {}),
    ...(promptDelivery ? { promptDelivery } : {}),
    ...(agentArgs !== undefined ? { agentArgs } : {}),
    ...(launchPreferences ? { launchPreferences } : {})
  }).then((outcome) => {
    // Why: created means the host accepted the launch, not that a local tab
    // exists; keep pruning stale local rows until the snapshot mirrors.
    removeStaleLocalAgentTabsForWebHostLaunch(worktreeId)
    if (outcome.status === 'failed') {
      toast.error(
        outcome.message ||
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
