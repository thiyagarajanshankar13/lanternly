import path from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { MIGRATIONS, resetDbForTests } from '@/lib/db'
import { CONSOLE_PAGES } from '@/lib/access'
import { getSettings } from '@/lib/settings'
import { PLUGINS, enabledPlugins, hiddenByPlugin, pagesWithPlugins, pluginForPage, pluginOn, servicesLabel, setPluginOn } from '@/plugins'
import { freshEnv } from './setup'

// Phase 2 of the generic deployer: Avrosphere sites and AWS are plugins.

const PLUGINS_MIGRATION = MIGRATIONS.findIndex((m) => m.includes("SELECT 'plugins', 'avrosphere aws'"))

describe('plugins', () => {
  it('a fresh install starts with none: no Costs or AI assistant pages, and the list is called Services', () => {
    freshEnv()
    expect(enabledPlugins().size).toBe(0)
    expect(servicesLabel()).toBe('Services')
    const pages = pagesWithPlugins(CONSOLE_PAGES)
    expect(pages).not.toContain('/admin/costs')
    expect(pages).toContain('/admin/servers')
    expect(hiddenByPlugin({ kind: 'avrosphere' })).toBe(true)
    // A kind no installed plugin adds stays hidden too.
    expect(hiddenByPlugin({ kind: 'nobody-adds-this' })).toBe(true)
    expect(hiddenByPlugin({ kind: 'app' })).toBe(false)
    expect(hiddenByPlugin({ kind: 'postgres' })).toBe(false)
  })

  it('turns plugins on and off one at a time', () => {
    freshEnv()
    setPluginOn('aws', true)
    expect(pluginOn('aws')).toBe(true)
    expect(getSettings().plugins).toBe('aws')
    expect(pagesWithPlugins(CONSOLE_PAGES)).toContain('/admin/costs')
    expect(servicesLabel()).toBe('Services')
    setPluginOn('aws', false)
    expect(getSettings().plugins).toBe('')
    expect(pagesWithPlugins(CONSOLE_PAGES)).not.toContain('/admin/costs')
  })

  it('every page a plugin owns is a real side-menu page, owned by one plugin', () => {
    const owned = PLUGINS.flatMap((p) => p.pages)
    expect(new Set(owned).size).toBe(owned.length)
    // Each has a side-menu entry and isn't a core page.
    for (const p of PLUGINS) expect(p.menu?.map((m) => m.href).sort()).toEqual([...p.pages].sort())
    for (const href of owned) expect(CONSOLE_PAGES).not.toContain(href)
    expect(pluginForPage('/admin/costs')?.id).toBe('aws')
    expect(pluginForPage('/admin/settings')).toBeUndefined()
  })
})

describe('an install from before plugins', () => {
  function upgradeFrom(seed: (old: Database.Database) => void) {
    const dir = freshEnv()
    resetDbForTests()
    const old = new Database(path.join(dir, 'deployer.sqlite'))
    for (let i = 0; i < PLUGINS_MIGRATION; i++) old.exec(MIGRATIONS[i])
    old.pragma(`user_version = ${PLUGINS_MIGRATION}`)
    seed(old)
    old.close()
    return getSettings().plugins
  }

  it('keeps both plugins on when people use it', () => {
    expect(PLUGINS_MIGRATION).toBeGreaterThan(0)
    expect(upgradeFrom((old) => old.prepare("INSERT INTO admins (email, password_hash, created_at) VALUES ('o@example.com', 'x', '2026-01-01')").run())).toBe('avrosphere aws')
    expect(enabledPlugins()).toEqual(new Set(PLUGINS.map((p) => p.id).filter((id) => id === 'avrosphere' || id === 'aws')))
  })

  it('never overwrites a choice already saved', () => {
    expect(upgradeFrom((old) => {
      old.prepare("INSERT INTO admins (email, password_hash, created_at) VALUES ('o@example.com', 'x', '2026-01-01')").run()
      old.prepare("INSERT INTO settings (key, value) VALUES ('plugins', 'aws')").run()
    })).toBe('aws')
  })

  it('starts with none when nobody has used it yet', () => {
    expect(upgradeFrom(() => {})).toBe('')
  })
})
