import { describe, expect, it, vi } from 'vitest'
import {
  parseMacosGuiSessionScope,
  parseMacosProcessSessionIdentity,
  resolveMacosGuiSessionScope
} from './macos-gui-session-scope'

const BOOT_SESSION_ID = '31622fb2-6a38-4323-9678-f0533e61d900'
const PROCESS_DOMAIN = `pid/123 = {
  type = pid
  security context = {
    uid = 501
    asid = 100101
  }
}`

describe('macOS GUI session scope', () => {
  it('parses the audit session and boot identity', () => {
    expect(parseMacosProcessSessionIdentity(PROCESS_DOMAIN)).toEqual({
      uid: 501,
      auditSessionId: 100101
    })
    expect(parseMacosGuiSessionScope(`macos-gui:501:100101:${BOOT_SESSION_ID}`)).toEqual({
      uid: 501,
      auditSessionId: 100101,
      bootSessionId: BOOT_SESSION_ID
    })
  })

  it('rejects missing, default, zero, and malformed security contexts', () => {
    expect(parseMacosProcessSessionIdentity('security context = { uid = 501 asid = 0 }')).toBeNull()
    expect(
      parseMacosProcessSessionIdentity('security context = { uid = 501 asid = 4294967295 }')
    ).toBeNull()
    expect(parseMacosProcessSessionIdentity('type = pid')).toBeNull()
    expect(parseMacosGuiSessionScope(`macos-gui:501:not-a-number:${BOOT_SESSION_ID}`)).toBeNull()
    expect(parseMacosGuiSessionScope(`macos-gui:501:4294967295:${BOOT_SESSION_ID}`)).toBeNull()
    expect(parseMacosGuiSessionScope('macos-gui:501:100101:not-a-boot-uuid')).toBeNull()
  })

  it('resolves a desktop runtime from its audit and boot sessions', async () => {
    const readProcessDomain = vi.fn(async () => PROCESS_DOMAIN)
    const readBootSessionId = vi.fn(async () => BOOT_SESSION_ID.toUpperCase())
    await expect(
      resolveMacosGuiSessionScope({
        isGuiRuntime: true,
        platform: 'darwin',
        pid: 123,
        uid: 501,
        readProcessDomain,
        readBootSessionId
      })
    ).resolves.toBe(`macos-gui:501:100101:${BOOT_SESSION_ID}`)
    expect(readProcessDomain).toHaveBeenCalledWith(123)
    expect(readBootSessionId).toHaveBeenCalledOnce()
  })

  it('fails closed when a desktop runtime cannot prove its user and sessions', async () => {
    await expect(
      resolveMacosGuiSessionScope({
        isGuiRuntime: true,
        platform: 'darwin',
        uid: 502,
        readProcessDomain: async () => PROCESS_DOMAIN,
        readBootSessionId: async () => BOOT_SESSION_ID
      })
    ).rejects.toThrow('Cannot determine')
  })

  it.each([
    { platform: 'linux' as const, isGuiRuntime: true },
    { platform: 'darwin' as const, isGuiRuntime: false }
  ])('does not scope $platform headless=$isGuiRuntime', async ({ platform, isGuiRuntime }) => {
    const readProcessDomain = vi.fn(async () => PROCESS_DOMAIN)
    const readBootSessionId = vi.fn(async () => BOOT_SESSION_ID)
    await expect(
      resolveMacosGuiSessionScope({
        platform,
        isGuiRuntime,
        readProcessDomain,
        readBootSessionId
      })
    ).resolves.toBeUndefined()
    expect(readProcessDomain).not.toHaveBeenCalled()
    expect(readBootSessionId).not.toHaveBeenCalled()
  })

  it.runIf(process.platform === 'darwin')(
    'reads the current macOS process audit and boot sessions without touching login state',
    async () => {
      const scope = await resolveMacosGuiSessionScope({ isGuiRuntime: true })
      expect(parseMacosGuiSessionScope(scope)).toMatchObject({ uid: process.getuid?.() })
    }
  )
})
