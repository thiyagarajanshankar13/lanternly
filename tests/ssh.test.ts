import crypto from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Server, utils } from 'ssh2'
import { sshRunner, type ServerRow } from '@/lib/engine'

// A throwaway SSH server standing in for a clubs VM: it answers like
// clubctl-ssh would, echoing the command and what arrived on stdin.
const hostKeys = utils.generateKeyPairSync('ed25519')
const clientKeys = utils.generateKeyPairSync('ed25519')
const hostPublic = utils.parseKey(hostKeys.public)
if (hostPublic instanceof Error) throw hostPublic
const hostKeyLine = `ssh-ed25519 ${hostPublic.getPublicSSH().toString('base64')}`

let server: Server
let port = 0

beforeAll(async () => {
  process.env.DEPLOYER_SSH_KEY = clientKeys.private
  server = new Server({ hostKeys: [hostKeys.private] }, (client) => {
    client.on('authentication', (ctx) => (ctx.method === 'publickey' && ctx.username === 'deployer' ? ctx.accept() : ctx.reject()))
    client.on('ready', () => {
      client.on('session', (accept) => {
        accept().on('exec', (acceptExec, _reject, info) => {
          const stream = acceptExec()
          let stdin = ''
          stream.on('data', (d: Buffer) => { stdin += d.toString() })
          stream.on('end', () => {
            stream.write(`cmd=${info.command}\n`)
            stream.stderr.write(`stdin=${stdin}`)
            stream.exit(info.command.startsWith('fail') ? 3 : 0)
            stream.end()
          })
        })
      })
    })
    client.on('error', () => {})
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => { port = (server.address() as { port: number }).port; resolve() }))
})
afterAll(() => server.close())

const row = (hostKey: string): ServerRow => ({ id: 1, name: 'test', host: '127.0.0.1', port, username: 'deployer', host_key: hostKey, public_ip: '', max_clubs: 5, accepts_new: 1 })

describe('ssh runner', () => {
  it('sends the command and stdin, and returns output and exit code', async () => {
    const chunks: string[] = []
    const res = await sshRunner(row(hostKeyLine), ['create', 'riverside', 'img:1', 'a.avro.site'], 'TZ=Australia/Sydney\n', (c) => chunks.push(c))
    expect(res.code).toBe(0)
    expect(res.output).toContain('cmd=create riverside img:1 a.avro.site')
    expect(res.output).toContain('stdin=TZ=Australia/Sydney')
    expect(chunks.join('')).toBe(res.output)
    expect((await sshRunner(row(hostKeyLine), ['fail'])).code).toBe(3)
  })
  it('refuses a server whose host key is different or missing', async () => {
    const other = utils.parseKey(utils.generateKeyPairSync('ed25519').public)
    if (other instanceof Error) throw other
    await expect(sshRunner(row(`ssh-ed25519 ${other.getPublicSSH().toString('base64')}`), ['status'])).rejects.toThrow(/Can't reach/)
    await expect(sshRunner(row(''), ['status'])).rejects.toThrow(/no host key/)
  })
  it('never sends words with shell characters', async () => {
    await expect(sshRunner(row(hostKeyLine), ['logs', 'x; rm -rf /'])).rejects.toThrow(/unsafe/)
    await expect(sshRunner(row(hostKeyLine), ['logs', `$(${crypto.randomUUID()})`])).rejects.toThrow(/unsafe/)
  })
})
