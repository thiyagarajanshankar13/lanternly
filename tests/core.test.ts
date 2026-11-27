import { describe, expect, it } from 'vitest'
import { decrypt, encrypt, hashPassword, randomPassword, verifyPassword } from '@/lib/crypto'
import { clubDomains, envToText } from '@/lib/clubEnv'
import { base32Decode, base32Encode, totpAt, verifyTotp } from '@/lib/totp'
import { cleanDomain, clubNameError, extraEnvError, isDomain, isImage } from '@/lib/validate'
import { freshEnv } from './setup'

freshEnv()

describe('crypto', () => {
  it('round-trips and rejects tampering', () => {
    const boxed = encrypt('square-token')
    expect(boxed).not.toContain('square-token')
    expect(decrypt(boxed)).toBe('square-token')
    const parts = boxed.split(':')
    parts[3] = Buffer.from('other').toString('base64')
    expect(() => decrypt(parts.join(':'))).toThrow()
  })
  it('hashes passwords with a salt', () => {
    const a = hashPassword('correct horse'), b = hashPassword('correct horse')
    expect(a).not.toBe(b)
    expect(verifyPassword('correct horse', a)).toBe(true)
    expect(verifyPassword('wrong', a)).toBe(false)
    expect(randomPassword()).toMatch(/^[A-Za-z2-9]{16}$/)
  })
})

describe('two-step codes', () => {
  it('matches the RFC 6238 test vector', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'))
    expect(base32Decode(secret).toString()).toBe('12345678901234567890')
    expect(totpAt(secret, 59_000)).toBe('287082')
    expect(totpAt(secret, 1111111109_000)).toBe('081804')
  })
  it('allows one step of clock drift, no more', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'))
    const t = 1_700_000_000_000
    expect(verifyTotp(secret, totpAt(secret, t), t)).toBe(true)
    expect(verifyTotp(secret, totpAt(secret, t - 30_000), t)).toBe(true)
    expect(verifyTotp(secret, totpAt(secret, t - 90_000), t)).toBe(false)
    expect(verifyTotp(secret, 'abcdef', t)).toBe(false)
  })
})

describe('addresses', () => {
  it('uses the subdomain, then the first custom domain as the main address', () => {
    const club = { name: 'riverside', customDomains: [] as string[] }
    expect(clubDomains(club, 'example.com')).toEqual(['riverside.example.com'])
    expect(clubDomains({ ...club, customDomains: ['www.rtt.com.au'] }, 'example.com')).toEqual(['www.rtt.com.au', 'riverside.example.com'])
    expect(clubDomains({ ...club, appPublic: false }, 'example.com')).toEqual([])
  })
  it('writes settings one KEY=value per line', () => {
    expect(envToText({ A: '1', B: 'x y' })).toBe('A=1\nB=x y\n')
  })
})

describe('validation', () => {
  it('club names', () => {
    expect(clubNameError('riverside')).toBeNull()
    expect(clubNameError('river-side2')).toBeNull()
    for (const bad of ['a', 'Riverside', '1club', 'club_', 'club-', 'a--b', 'admin', 'www', 'x'.repeat(40)]) expect(clubNameError(bad)).not.toBeNull()
  })
  it('domains, images and extra settings', () => {
    expect(cleanDomain(' https://WWW.Example.com/path ')).toBe('www.example.com')
    expect(isDomain('www.example.com')).toBe(true)
    expect(isDomain('example')).toBe(false)
    expect(isDomain('exa mple.com')).toBe(false)
    expect(isImage('ghcr.io/avrotech-com-au/avrosphere-shared:abc1234')).toBe(true)
    expect(isImage('img; rm -rf /')).toBe(false)
    expect(extraEnvError('A=1\n# c\nB=two words')).toBeNull()
    expect(extraEnvError('lower=1')).not.toBeNull()
    expect(extraEnvError('CLUBCTL_MEMORY_MB=1')).not.toBeNull()
  })
})
