const MACOS_GUI_SCOPE_PATTERN =
  /^macos-gui:(\d+):(\d+):([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i
// Why: macOS exposes the no-audit-session sentinel (-1) as an unsigned 32-bit value.
const MACOS_NO_AUDIT_SESSION_ID = 0xffff_ffff
const MACOS_BOOT_SESSION_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

export type MacosGuiSessionScope = `macos-gui:${number}:${number}:${string}`
export type MacosProcessSessionIdentity = { uid: number; auditSessionId: number }

type ResolveMacosGuiSessionScopeOptions = {
  isGuiRuntime: boolean
  platform?: NodeJS.Platform
  pid?: number
  uid?: number
  readProcessDomain?: (pid: number) => Promise<string>
  readBootSessionId?: () => Promise<string>
}

function isValidAuditSessionId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value !== MACOS_NO_AUDIT_SESSION_ID
}

export function parseMacosProcessSessionIdentity(
  output: string
): MacosProcessSessionIdentity | null {
  const context = /security context\s*=\s*\{([^}]*)\}/s.exec(output)?.[1]
  if (!context) {
    return null
  }
  const uid = Number(/\buid\s*=\s*(\d+)/.exec(context)?.[1])
  const auditSessionId = Number(/\basid\s*=\s*(\d+)/.exec(context)?.[1])
  if (!Number.isSafeInteger(uid) || uid < 0 || !isValidAuditSessionId(auditSessionId)) {
    return null
  }
  return { uid, auditSessionId }
}

export function parseMacosGuiSessionScope(scope: string | undefined):
  | (MacosProcessSessionIdentity & {
      bootSessionId: string
    })
  | null {
  const match = scope ? MACOS_GUI_SCOPE_PATTERN.exec(scope) : null
  if (!match) {
    return null
  }
  const uid = Number(match[1])
  const auditSessionId = Number(match[2])
  return Number.isSafeInteger(uid) && isValidAuditSessionId(auditSessionId)
    ? { uid, auditSessionId, bootSessionId: match[3].toLowerCase() }
    : null
}

async function readLaunchctlProcessDomain(pid: number): Promise<string> {
  const { execFile } = await import('node:child_process')
  return new Promise((resolve, reject) => {
    execFile(
      '/bin/launchctl',
      ['print', `pid/${pid}`],
      { encoding: 'utf8', timeout: 1_000, maxBuffer: 64 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(error)
        } else {
          resolve(stdout)
        }
      }
    )
  })
}

async function readMacosBootSessionId(): Promise<string> {
  // Why: audit session IDs can repeat after reboot; the boot UUID keeps cold recovery fenced too.
  const { execFile } = await import('node:child_process')
  return new Promise((resolve, reject) => {
    execFile(
      '/usr/sbin/sysctl',
      ['-n', 'kern.bootsessionuuid'],
      { encoding: 'utf8', timeout: 1_000, maxBuffer: 1024 },
      (error, stdout) => {
        if (error) {
          reject(error)
        } else {
          resolve(stdout.trim())
        }
      }
    )
  })
}

export async function readMacosProcessSessionIdentity(
  pid: number,
  readProcessDomain: (pid: number) => Promise<string> = readLaunchctlProcessDomain
): Promise<MacosProcessSessionIdentity | null> {
  if (process.platform !== 'darwin') {
    return null
  }
  try {
    return parseMacosProcessSessionIdentity(await readProcessDomain(pid))
  } catch {
    return null
  }
}

export async function resolveMacosGuiSessionScope({
  isGuiRuntime,
  platform = process.platform,
  pid = process.pid,
  uid = process.getuid?.(),
  readProcessDomain = readLaunchctlProcessDomain,
  readBootSessionId = readMacosBootSessionId
}: ResolveMacosGuiSessionScopeOptions): Promise<MacosGuiSessionScope | undefined> {
  if (platform !== 'darwin' || !isGuiRuntime) {
    return undefined
  }
  if (!Number.isSafeInteger(uid) || (uid as number) < 0) {
    throw new Error('Cannot determine the macOS GUI login-session owner')
  }
  const [identity, rawBootSessionId] = await Promise.all([
    readProcessDomain(pid).then(parseMacosProcessSessionIdentity),
    readBootSessionId()
  ])
  const bootSessionId = rawBootSessionId.trim().toLowerCase()
  if (!identity || identity.uid !== uid || !MACOS_BOOT_SESSION_PATTERN.test(bootSessionId)) {
    throw new Error('Cannot determine the macOS GUI login-session owner')
  }
  return `macos-gui:${identity.uid}:${identity.auditSessionId}:${bootSessionId}`
}
