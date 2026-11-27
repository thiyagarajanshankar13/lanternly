import { describe, expect, it } from 'vitest'
import { MAX_LIVE, followLogs, liveCount } from '@/lib/liveLogs'
import type { ServerRow } from '@/lib/engine'
import { freshEnv } from './setup'

freshEnv()
const server = { id: 1, name: 'S1', host: '10.0.0.1', port: 22, username: 'deployer', host_key: '', public_ip: '', max_clubs: 5, accepts_new: 1 } as unknown as ServerRow

describe('live logs (practice engine)', () => {
  it('hands on whole lines and stops cleanly', async () => {
    const got: string[] = []
    const f = await followLogs(server, 'alpha', 200, (l) => got.push(l))
    expect(got[0]).toContain('alpha')
    expect(liveCount()).toBe(1)
    f.stop()
    await f.done
    expect(liveCount()).toBe(0)
  })
  it('refuses bad names and too many streams', async () => {
    await expect(followLogs(server, 'Bad Name', 10, () => {})).rejects.toThrow()
    const open = []
    for (let i = 0; i < MAX_LIVE; i++) open.push(await followLogs(server, 'alpha', 10, () => {}))
    await expect(followLogs(server, 'alpha', 10, () => {})).rejects.toThrow(/Too many/)
    for (const f of open) f.stop()
    expect(liveCount()).toBe(0)
  })
})
