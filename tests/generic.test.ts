import path from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { MIGRATIONS, resetDbForTests } from '@/lib/db'
import { displayLocale, getSettings, saveSettings } from '@/lib/settings'
import { clubNameError } from '@/lib/validate'
import { fmtTime } from '@/components/ui'
import { freshEnv } from './setup'

// Phase 1 of the generic deployer: nothing about Avrotech is assumed by a new
// install, and an existing install keeps exactly what it had.

const BRANDING_MIGRATION = MIGRATIONS.findIndex((m) => m.includes("'brandTagline', 'Avrosphere by Avrotech'"))

describe('a fresh install', () => {
  it('starts with generic settings', () => {
    freshEnv()
    const s = getSettings()
    expect(s).toMatchObject({
      brandName: 'Deployer', brandTagline: '', brandLogoUrl: '', locale: 'en-US', extraReservedNames: '',
      baseDomain: '', defaultTimezone: 'UTC', githubOwner: '', githubBuildRepo: '',
      backupRegion: 'us-east-1', costRegion: 'us-east-1', provisionRegion: 'us-east-1', provisionZone: 'us-east-1a',
    })
    expect(clubNameError('avrosphere')).toBeNull()
    expect(clubNameError('admin')).not.toBeNull()
  })

  it('reserves the names added in Settings', () => {
    freshEnv()
    saveSettings({ extraReservedNames: 'acme acme-cloud' })
    expect(clubNameError('acme')).toMatch(/kept for the platform/)
    expect(clubNameError('acme-cloud')).toMatch(/kept for the platform/)
    expect(clubNameError('acme-shop')).toBeNull()
  })

  it('writes dates in the chosen locale and time zone', () => {
    freshEnv()
    const at = '2026-11-27T03:05:00Z'
    expect(fmtTime(at)).toBe('Nov 27, 3:05 AM')
    saveSettings({ locale: 'en-AU', defaultTimezone: 'Australia/Melbourne' })
    expect(fmtTime(at)).toBe('27 Nov, 2:05 pm')
    saveSettings({ locale: 'not a locale' })
    expect(displayLocale()).toBe('en-US')
  })
})

describe('an install from before the change', () => {
  function upgradeFrom(withAdmin: boolean, preset: Record<string, string> = {}) {
    const dir = freshEnv()
    resetDbForTests()
    const file = path.join(dir, 'deployer.sqlite')
    const old = new Database(file)
    for (let i = 0; i < BRANDING_MIGRATION; i++) old.exec(MIGRATIONS[i])
    old.pragma(`user_version = ${BRANDING_MIGRATION}`)
    if (withAdmin) old.prepare("INSERT INTO admins (email, password_hash, created_at) VALUES ('o@example.com', 'x', '2026-01-01')").run()
    for (const [k, v] of Object.entries(preset)) old.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(k, v)
    old.close()
    return getSettings()
  }

  it('keeps the Avrotech values it ran with', () => {
    expect(BRANDING_MIGRATION).toBeGreaterThan(0)
    expect(upgradeFrom(true)).toMatchObject({
      brandName: 'Deployer', brandTagline: 'Avrosphere by Avrotech', brandLogoUrl: '/brand/avrotech-logo.png', locale: 'en-AU',
      extraReservedNames: 'avro avrotech avrosphere', baseDomain: 'avro.site', defaultTimezone: 'Australia/Sydney',
      githubOwner: 'avrotech-com-au', githubBuildRepo: 'avrotech-com-au/avrosphere-self-service',
      backupRegion: 'ap-southeast-2', costRegion: 'ap-southeast-2', provisionRegion: 'ap-southeast-2', provisionZone: 'ap-southeast-2a',
    })
    expect(clubNameError('avrosphere')).toMatch(/kept for the platform/)
  })

  it("never overwrites a setting that was already saved", () => {
    expect(upgradeFrom(true, { baseDomain: 'clubs.example.com', backupRegion: 'eu-west-1' })).toMatchObject({ baseDomain: 'clubs.example.com', backupRegion: 'eu-west-1', defaultTimezone: 'Australia/Sydney' })
  })

  it('treats a database with no one in it as a fresh install', () => {
    expect(upgradeFrom(false)).toMatchObject({ baseDomain: '', brandTagline: '', locale: 'en-US' })
  })
})
