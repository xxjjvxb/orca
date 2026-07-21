import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const LOGIN_SESSION_HISTORY_DIR = 'daemon-login-session'
const LOGIN_SESSION_SCOPE_FILE = 'daemon-login-session.scope'

export function prepareDaemonLoginSessionHistoryDir(
  userDataPath: string,
  runtimeScope?: string
): string {
  const baseDir = join(userDataPath, 'terminal-history')
  if (!runtimeScope) {
    mkdirSync(baseDir, { recursive: true })
    return baseDir
  }

  const historyDir = join(baseDir, LOGIN_SESSION_HISTORY_DIR)
  const scopePath = join(baseDir, LOGIN_SESSION_SCOPE_FILE)
  let savedScope: string | null = null
  try {
    savedScope = readFileSync(scopePath, 'utf8')
  } catch {
    // First scoped launch or an interrupted prior cleanup.
  }

  if (savedScope !== runtimeScope && existsSync(historyDir)) {
    // Why: recovery bytes from an invalid login session must never be restored into the new scope.
    rmSync(historyDir, { recursive: true, force: true })
  }
  mkdirSync(historyDir, { recursive: true })
  if (savedScope !== runtimeScope) {
    writeFileSync(scopePath, runtimeScope, { mode: 0o600 })
  }
  return historyDir
}
