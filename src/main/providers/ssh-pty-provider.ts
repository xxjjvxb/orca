import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import type { IPtyProvider, PtyProcessInfo, PtySpawnOptions, PtySpawnResult } from './types'
import { toAppSshPtyId, toRelaySshPtyId } from './ssh-pty-id'
import type {
  RemoteCliBridgeEnv,
  SshPtyDataCallback,
  SshPtyExitCallback,
  SshPtyReplayCallback
} from './ssh-pty-provider-contract'
import {
  proveSshAgentSessionClaimCapability,
  validateClaimedSshSpawn
} from './ssh-agent-session-claim-validation'
import {
  assertSshAgentSessionCreateResult,
  requestSshAgentSessionCreate,
  sshSupportsAgentSessionCreateOperations
} from './ssh-agent-session-create-operation'
import { isPtyIncarnationId } from '../../shared/pty-incarnation'
import { mapSshPtyProcessList } from './ssh-agent-session-process-list'
import {
  parseSshPtyAttachResult,
  reattachSshPtySessionWithExitFence,
  type SshPtyAttachResult
} from './ssh-pty-session-reattach'
import { waitForSshCapabilityProbe } from './ssh-capability-probe-waiter'
import { buildSshPtySpawnRequest } from './ssh-pty-spawn-request'
import { SshPtySpawnExitRaceTracker } from './ssh-pty-spawn-exit-race'

/** Remote PTY provider that proxies IPtyProvider operations through the relay. */
export class SshPtyProvider implements IPtyProvider {
  private mux: SshChannelMultiplexer
  private connectionId: string
  private dataListeners = new Set<SshPtyDataCallback>()
  private replayListeners = new Set<SshPtyReplayCallback>()
  private exitListeners = new Set<SshPtyExitCallback>()
  // Why: stale notification callbacks must not outlive a disconnected provider.
  private unsubscribeNotifications: (() => void) | null = null
  private agentSessionClaimCapability: Promise<void> | null = null
  private agentSessionClaimCapabilitySupported = false
  private agentSessionCreateOperationCapability: Promise<boolean> | null = null
  private spawnExitRaces = new SshPtySpawnExitRaceTracker()

  constructor(
    connectionId: string,
    mux: SshChannelMultiplexer,
    private readonly remoteCliBridgeEnv?: RemoteCliBridgeEnv
  ) {
    this.connectionId = connectionId
    this.mux = mux

    this.unsubscribeNotifications = mux.onNotification((method, params) => {
      switch (method) {
        case 'pty.data':
          for (const cb of this.dataListeners) {
            cb({ id: this.toAppPtyId(params.id as string), data: params.data as string })
          }
          break

        case 'pty.replay':
          for (const cb of this.replayListeners) {
            cb({ id: this.toAppPtyId(params.id as string), data: params.data as string })
          }
          break

        case 'pty.exit':
          this.spawnExitRaces.recordExit(params.id as string, params.incarnationId)
          for (const cb of this.exitListeners) {
            cb({
              id: this.toAppPtyId(params.id as string),
              code: params.code as number,
              ...(isPtyIncarnationId(params.incarnationId)
                ? { incarnationId: params.incarnationId }
                : {})
            })
          }
          break
      }
    })
  }

  dispose(): void {
    if (this.unsubscribeNotifications) {
      this.unsubscribeNotifications()
      this.unsubscribeNotifications = null
    }
    this.dataListeners.clear()
    this.replayListeners.clear()
    this.exitListeners.clear()
  }

  getConnectionId = (): string => this.connectionId

  private toRelayPtyId(id: string): string {
    return toRelaySshPtyId(this.connectionId, id)
  }

  private toAppPtyId(id: string): string {
    return toAppSshPtyId(this.connectionId, id)
  }

  async spawn(opts: PtySpawnOptions): Promise<PtySpawnResult> {
    if (opts.agentSessionEnsure && opts.sessionId) {
      throw new Error('agent_session_claim_unavailable')
    }
    if (opts.agentSessionEnsure) {
      const supportsClaims = await this.supportsAgentSessionClaims({ signal: opts.signal })
      if (opts.signal?.aborted) {
        throw new Error('client_disconnected')
      }
      if (!supportsClaims) {
        throw new Error('agent_session_claim_unavailable')
      }
    }
    if (opts.sessionId) {
      return await reattachSshPtySessionWithExitFence({
        mux: this.mux,
        connectionId: this.connectionId,
        sessionId: opts.sessionId,
        options: opts,
        exitRaceTracker: this.spawnExitRaces
      })
    }

    const supportsCreateOperation = opts.agentSessionCreateOperationId
      ? await this.supportsAgentSessionCreateOperations({ signal: opts.signal })
      : false
    if (opts.signal?.aborted) {
      throw new Error('client_disconnected')
    }
    if (opts.agentSessionCreateOperationId && !supportsCreateOperation) {
      // Why: host routing owns legacy selection; a changed relay must not downgrade after dispatch.
      throw new Error('execution_owner_unavailable')
    }
    const operation = this.spawnExitRaces.begin()
    try {
      const result = await requestSshAgentSessionCreate({
        mux: this.mux,
        operationId: opts.agentSessionCreateOperationId,
        signal: opts.signal,
        params: buildSshPtySpawnRequest({
          options: opts,
          remoteCliBridgeEnv: this.remoteCliBridgeEnv,
          supportsCreateOperation
        })
      })
      if (opts.agentSessionCreateOperationId) {
        assertSshAgentSessionCreateResult(result)
      }
      const spawnResult = result as PtySpawnResult
      if (this.spawnExitRaces.didMatchingExitArrive(operation, spawnResult)) {
        // Why: relay notification can share the response batch; no controller registration may follow.
        throw Object.assign(new Error('agent_session_exited_during_start'), {
          agentSessionOperationOutcome: 'unknown' as const
        })
      }
      const claimed = spawnResult.agentSessionEnsure
      if (opts.agentSessionEnsure) {
        const validation = validateClaimedSshSpawn(spawnResult, opts.agentSessionEnsure)
        if (!validation.valid) {
          if (validation.cleanup === 'created' && typeof spawnResult.id === 'string') {
            try {
              // Why: immediate relay shutdown resolves only after physical exit;
              // a best-effort graceful request cannot prove the duplicate is gone.
              await this.mux.request('pty.shutdown', { id: spawnResult.id, immediate: true })
            } catch {
              throw new Error('execution_owner_unavailable')
            }
          }
          throw new Error(validation.error)
        }
      }
      return {
        ...spawnResult,
        id: this.toAppPtyId(spawnResult.id),
        ...(claimed
          ? {
              agentSessionEnsure: {
                ...claimed,
                owner: {
                  ...claimed.owner,
                  ptyId: this.toAppPtyId(claimed.owner.ptyId)
                }
              }
            }
          : {}),
        ...(opts.sessionId ? { sessionExpired: true } : {})
      }
    } finally {
      this.spawnExitRaces.finish(operation)
    }
  }

  async supportsAgentSessionClaims(options: { signal?: AbortSignal } = {}): Promise<boolean> {
    const probe = this.agentSessionClaimCapability ?? proveSshAgentSessionClaimCapability(this.mux)
    this.agentSessionClaimCapability = probe
    try {
      await waitForSshCapabilityProbe(probe, options.signal)
      this.agentSessionClaimCapabilitySupported = true
      return true
    } catch {
      if (!options.signal?.aborted && this.agentSessionClaimCapability === probe) {
        // Why: negative physical probes must follow a relay upgraded on this connection.
        this.agentSessionClaimCapability = null
        this.agentSessionClaimCapabilitySupported = false
      }
      return false
    }
  }

  providesAgentSessionOwnerListings(_ptyId: string): boolean {
    return this.agentSessionClaimCapabilitySupported
  }

  async supportsAgentSessionCreateOperations(
    options: { signal?: AbortSignal } = {}
  ): Promise<boolean> {
    const probe =
      this.agentSessionCreateOperationCapability ??
      sshSupportsAgentSessionCreateOperations(this.mux)
    this.agentSessionCreateOperationCapability = probe
    let supported: boolean
    try {
      supported = await waitForSshCapabilityProbe(probe, options.signal)
    } catch {
      // Why: one canceled waiter must not cancel or evict the shared physical probe used by peers.
      return false
    }
    if (!supported && this.agentSessionCreateOperationCapability === probe) {
      // Why: negative capability results must follow a relay upgraded on the same connection.
      this.agentSessionCreateOperationCapability = null
    }
    return supported
  }

  async attach(id: string): Promise<void> {
    await this.mux.request('pty.attach', { id: this.toRelayPtyId(id) })
  }

  async attachForReconnect(
    id: string,
    expected?: { paneKey?: string; tabId?: string }
  ): Promise<SshPtyAttachResult> {
    // Why: reconnect owns replay delivery so stale/duplicate attach results can
    // be filtered before they reach the renderer. The expected identity lets the
    // relay reject a cross-generation id collision instead of reattaching this
    // lease to a different pane's freshly spawned PTY.
    return parseSshPtyAttachResult(
      await this.mux.request('pty.attach', {
        id: this.toRelayPtyId(id),
        suppressReplayNotification: true,
        ...(expected?.paneKey ? { expectedPaneKey: expected.paneKey } : {}),
        ...(expected?.tabId ? { expectedTabId: expected.tabId } : {})
      })
    )
  }

  write(id: string, data: string): void {
    this.mux.notify('pty.data', { id: this.toRelayPtyId(id), data })
  }

  resize(id: string, cols: number, rows: number): void {
    this.mux.notify('pty.resize', { id: this.toRelayPtyId(id), cols, rows })
  }

  async shutdown(id: string, opts: { immediate?: boolean; keepHistory?: boolean }): Promise<void> {
    await this.mux.request('pty.shutdown', {
      id: this.toRelayPtyId(id),
      immediate: opts.immediate ?? false,
      keepHistory: opts.keepHistory ?? false
    })
  }

  async sendSignal(id: string, signal: string): Promise<void> {
    await this.mux.request('pty.sendSignal', { id: this.toRelayPtyId(id), signal })
  }

  async getCwd(id: string): Promise<string> {
    const result = await this.mux.request('pty.getCwd', { id: this.toRelayPtyId(id) })
    return result as string
  }

  async getInitialCwd(id: string): Promise<string> {
    const result = await this.mux.request('pty.getInitialCwd', { id: this.toRelayPtyId(id) })
    return result as string
  }

  async clearBuffer(id: string): Promise<void> {
    await this.mux.request('pty.clearBuffer', { id: this.toRelayPtyId(id) })
  }

  acknowledgeDataEvent(id: string, charCount: number): void {
    this.mux.notify('pty.ackData', { id: this.toRelayPtyId(id), charCount })
  }

  async hasChildProcesses(id: string): Promise<boolean> {
    const result = await this.mux.request('pty.hasChildProcesses', { id: this.toRelayPtyId(id) })
    return result as boolean
  }

  async getForegroundProcess(id: string): Promise<string | null> {
    const result = await this.mux.request('pty.getForegroundProcess', { id: this.toRelayPtyId(id) })
    return result as string | null
  }

  async serialize(ids: string[]): Promise<string> {
    const result = await this.mux.request('pty.serialize', {
      ids: ids.map((id) => this.toRelayPtyId(id))
    })
    return result as string
  }

  async revive(state: string): Promise<void> {
    await this.mux.request('pty.revive', { state })
  }

  async listProcesses(): Promise<PtyProcessInfo[]> {
    const result = await this.mux.request('pty.listProcesses')
    return mapSshPtyProcessList(result as PtyProcessInfo[], (id) => this.toAppPtyId(id))
  }

  async getDefaultShell(): Promise<string> {
    const result = await this.mux.request('pty.getDefaultShell')
    return result as string
  }

  async getProfiles(): Promise<{ name: string; path: string }[]> {
    const result = await this.mux.request('pty.getProfiles')
    return result as { name: string; path: string }[]
  }

  onData(callback: SshPtyDataCallback): () => void {
    this.dataListeners.add(callback)
    return () => this.dataListeners.delete(callback)
  }

  onReplay(callback: SshPtyReplayCallback): () => void {
    this.replayListeners.add(callback)
    return () => this.replayListeners.delete(callback)
  }

  onExit(callback: SshPtyExitCallback): () => void {
    this.exitListeners.add(callback)
    return () => this.exitListeners.delete(callback)
  }
}
