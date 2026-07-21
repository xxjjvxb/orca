import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DaemonClient, type DaemonClientOptions } from './client'
import { DaemonServer, type DaemonServerOptions } from './daemon-server'
import { getDaemonSocketPath } from './daemon-spawner'
import type { SubprocessHandle } from './session'

type SessionScopedClientOptions = DaemonClientOptions & {
  runtimeScope: string
}

type SessionScopedServerOptions = DaemonServerOptions & {
  runtimeScope: string
}

function createLiveSubprocess(): SubprocessHandle {
  let onExit: ((code: number) => void) | null = null
  return {
    pid: 7936,
    getForegroundProcess: () => null,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => queueMicrotask(() => onExit?.(0))),
    forceKill: vi.fn(() => queueMicrotask(() => onExit?.(137))),
    signal: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn((callback) => {
      onExit = callback
    }),
    dispose: vi.fn()
  }
}

describe('macOS GUI login-session daemon lifecycle', () => {
  let runtimeDir: string
  let socketPath: string
  let tokenPath: string
  let server: DaemonServer | null
  const clients: DaemonClient[] = []

  beforeEach(() => {
    runtimeDir = mkdtempSync(join(tmpdir(), 'orca-macos-login-session-'))
    socketPath = getDaemonSocketPath(runtimeDir)
    tokenPath = join(runtimeDir, 'daemon.token')
    server = null
  })

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      client.disconnect()
    }
    await server?.shutdown().catch(() => {})
    rmSync(runtimeDir, { recursive: true, force: true })
  })

  function createClient(runtimeScope: string): DaemonClient {
    const options: SessionScopedClientOptions = { socketPath, tokenPath, runtimeScope }
    const client = new DaemonClient(options)
    clients.push(client)
    return client
  }

  async function startScopedServer(
    runtimeScope = 'macos-gui:501:1001:31622fb2-6a38-4323-9678-f0533e61d900'
  ): Promise<void> {
    const daemonOptions: SessionScopedServerOptions = {
      socketPath,
      tokenPath,
      runtimeScope,
      spawnSubprocess: () => createLiveSubprocess()
    }
    server = new DaemonServer(daemonOptions)
    await server.start()
  }

  async function createTerminal(client: DaemonClient): Promise<{ isNew: boolean; pid: number }> {
    await client.ensureConnected()
    return client.request('createOrAttach', {
      sessionId: 'restored-terminal',
      cols: 80,
      rows: 24
    })
  }

  it('rejects a later login before it can warm-attach a surviving PTY', async () => {
    await startScopedServer()

    const originalLogin = createClient('macos-gui:501:1001:31622fb2-6a38-4323-9678-f0533e61d900')
    await expect(createTerminal(originalLogin)).resolves.toMatchObject({ isNew: true })

    // Model logout's observed failure mode: the GUI client exits but its detached daemon survives.
    originalLogin.disconnect()

    const laterLogin = createClient('macos-gui:501:2002:31622fb2-6a38-4323-9678-f0533e61d900')
    await expect(createTerminal(laterLogin)).rejects.toThrow('Runtime scope mismatch')
  })

  it.each(['WindowServer crash/restart', 'app crash/relaunch', 'normal app quit/reopen'])(
    'preserves the PTY across %s inside the same login session',
    async () => {
      await startScopedServer()
      const originalClient = createClient('macos-gui:501:1001:31622fb2-6a38-4323-9678-f0533e61d900')
      await expect(createTerminal(originalClient)).resolves.toMatchObject({ isNew: true })
      originalClient.disconnect()

      const replacementClient = createClient(
        'macos-gui:501:1001:31622fb2-6a38-4323-9678-f0533e61d900'
      )
      await expect(createTerminal(replacementClient)).resolves.toMatchObject({
        isNew: false,
        pid: 7936
      })
    }
  )

  it('models reboot as daemon loss rather than warm PTY inheritance', async () => {
    await startScopedServer()
    const beforeReboot = createClient('macos-gui:501:1001:31622fb2-6a38-4323-9678-f0533e61d900')
    await expect(createTerminal(beforeReboot)).resolves.toMatchObject({ isNew: true })
    beforeReboot.disconnect()
    await server?.shutdown()

    const rebootedScope = 'macos-gui:501:1001:a7af08e0-f85c-4aa1-8b57-b087d254dc85'
    await startScopedServer(rebootedScope)
    const afterReboot = createClient(rebootedScope)
    await expect(createTerminal(afterReboot)).resolves.toMatchObject({ isNew: true })
  })

  it('keeps a switched-away login usable after rejecting another login scope', async () => {
    await startScopedServer()
    const originalLogin = createClient('macos-gui:501:1001:31622fb2-6a38-4323-9678-f0533e61d900')
    await expect(createTerminal(originalLogin)).resolves.toMatchObject({ isNew: true })
    originalLogin.disconnect()

    const otherLogin = createClient('macos-gui:502:3003:31622fb2-6a38-4323-9678-f0533e61d900')
    await expect(createTerminal(otherLogin)).rejects.toThrow('Runtime scope mismatch')

    const switchedBack = createClient('macos-gui:501:1001:31622fb2-6a38-4323-9678-f0533e61d900')
    await expect(createTerminal(switchedBack)).resolves.toMatchObject({
      isNew: false,
      pid: 7936
    })
  })

  it('keeps fast-switched user accounts isolated on independent daemon endpoints', async () => {
    const firstUserDir = mkdtempSync(join(tmpdir(), 'orca-macos-fast-switch-user-a-'))
    const secondUserDir = mkdtempSync(join(tmpdir(), 'orca-macos-fast-switch-user-b-'))
    const firstServer = new DaemonServer({
      socketPath: getDaemonSocketPath(firstUserDir),
      tokenPath: join(firstUserDir, 'daemon.token'),
      runtimeScope: 'macos-gui:501:1001:31622fb2-6a38-4323-9678-f0533e61d900',
      spawnSubprocess: () => createLiveSubprocess()
    })
    const secondServer = new DaemonServer({
      socketPath: getDaemonSocketPath(secondUserDir),
      tokenPath: join(secondUserDir, 'daemon.token'),
      runtimeScope: 'macos-gui:502:2002:31622fb2-6a38-4323-9678-f0533e61d900',
      spawnSubprocess: () => createLiveSubprocess()
    })
    const firstUser = new DaemonClient({
      socketPath: getDaemonSocketPath(firstUserDir),
      tokenPath: join(firstUserDir, 'daemon.token'),
      runtimeScope: 'macos-gui:501:1001:31622fb2-6a38-4323-9678-f0533e61d900'
    })
    const secondUser = new DaemonClient({
      socketPath: getDaemonSocketPath(secondUserDir),
      tokenPath: join(secondUserDir, 'daemon.token'),
      runtimeScope: 'macos-gui:502:2002:31622fb2-6a38-4323-9678-f0533e61d900'
    })

    try {
      await Promise.all([firstServer.start(), secondServer.start()])
      await expect(createTerminal(firstUser)).resolves.toMatchObject({ isNew: true })
      await expect(createTerminal(secondUser)).resolves.toMatchObject({ isNew: true })
      firstUser.disconnect()
      await expect(createTerminal(secondUser)).resolves.toMatchObject({ isNew: false })
      await expect(createTerminal(firstUser)).resolves.toMatchObject({ isNew: false })
    } finally {
      firstUser.disconnect()
      secondUser.disconnect()
      await Promise.all([firstServer.shutdown(), secondServer.shutdown()])
      rmSync(firstUserDir, { recursive: true, force: true })
      rmSync(secondUserDir, { recursive: true, force: true })
    }
  })

  it('lets concurrent clients in one login session share one PTY', async () => {
    await startScopedServer()
    const first = createClient('macos-gui:501:1001:31622fb2-6a38-4323-9678-f0533e61d900')
    const second = createClient('macos-gui:501:1001:31622fb2-6a38-4323-9678-f0533e61d900')

    const results = await Promise.all([createTerminal(first), createTerminal(second)])
    expect(results.filter((result) => result.isNew)).toHaveLength(1)
    expect(results.every((result) => result.pid === 7936)).toBe(true)
  })
})
