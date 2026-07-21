import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareDaemonLoginSessionHistoryDir } from './daemon-login-session-history'

const tempDirs: string[] = []

function createUserDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-login-history-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('daemon login-session history', () => {
  it('keeps the existing unscoped path for headless and non-macOS runtimes', () => {
    const userDataPath = createUserDataDir()
    expect(prepareDaemonLoginSessionHistoryDir(userDataPath)).toBe(
      join(userDataPath, 'terminal-history')
    )
  })

  it('preserves recovery data for the same login scope', () => {
    const userDataPath = createUserDataDir()
    const scope = 'macos-gui:501:1001:31622fb2-6a38-4323-9678-f0533e61d900'
    const historyDir = prepareDaemonLoginSessionHistoryDir(userDataPath, scope)
    const sentinel = join(historyDir, 'same-session-checkpoint')
    writeFileSync(sentinel, 'keep')

    expect(prepareDaemonLoginSessionHistoryDir(userDataPath, scope)).toBe(historyDir)
    expect(readFileSync(sentinel, 'utf8')).toBe('keep')
  })

  it('clears recovery data before reusing the slot for a later login scope', () => {
    const userDataPath = createUserDataDir()
    const historyDir = prepareDaemonLoginSessionHistoryDir(
      userDataPath,
      'macos-gui:501:1001:31622fb2-6a38-4323-9678-f0533e61d900'
    )
    const sentinel = join(historyDir, 'prior-session-checkpoint')
    writeFileSync(sentinel, 'discard')

    expect(
      prepareDaemonLoginSessionHistoryDir(
        userDataPath,
        'macos-gui:501:2002:31622fb2-6a38-4323-9678-f0533e61d900'
      )
    ).toBe(historyDir)
    expect(existsSync(sentinel)).toBe(false)
    expect(
      readFileSync(join(userDataPath, 'terminal-history', 'daemon-login-session.scope'), 'utf8')
    ).toBe('macos-gui:501:2002:31622fb2-6a38-4323-9678-f0533e61d900')
  })

  it('clears recovery data when a reboot reuses the same audit session id', () => {
    const userDataPath = createUserDataDir()
    const beforeReboot = 'macos-gui:501:1001:31622fb2-6a38-4323-9678-f0533e61d900'
    const afterReboot = 'macos-gui:501:1001:a7af08e0-f85c-4aa1-8b57-b087d254dc85'
    const historyDir = prepareDaemonLoginSessionHistoryDir(userDataPath, beforeReboot)
    const sentinel = join(historyDir, 'prior-boot-checkpoint')
    writeFileSync(sentinel, 'discard')

    prepareDaemonLoginSessionHistoryDir(userDataPath, afterReboot)

    expect(existsSync(sentinel)).toBe(false)
  })
})
