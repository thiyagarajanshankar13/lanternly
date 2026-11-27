import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/lib/db'
import { addWatched, removeWatched } from '@/lib/monitor'
import {
  cleanLabelName, ensureLabel, filterSites, groupSites, labelsBySite, listLabels, MAX_LABELS_PER_SITE, parseShow, saveLabels, setSiteLabels,
} from '@/lib/monitorLabels'
import { freshEnv } from './setup'

freshEnv()

beforeEach(() => { db().exec('DELETE FROM watched_sites; DELETE FROM monitor_labels') })

const names = (siteId: number) => (labelsBySite().get(siteId) ?? []).map((id) => listLabels().find((l) => l.id === id)!.name)

describe('monitoring labels', () => {
  it('cleans names', () => {
    expect(cleanLabelName('  Non   prod ')).toBe('Non prod')
    expect(cleanLabelName('x'.repeat(40))).toHaveLength(30)
    expect(cleanLabelName('   ')).toBe('')
  })

  it('sets a site\'s labels, making new ones and reusing existing ones whatever the case', () => {
    const a = addWatched('A', 'https://a.example.com')
    const b = addWatched('B', 'https://b.example.com')
    expect(setSiteLabels(a.id, ['Production', 'Clients']).added).toEqual(['Production', 'Clients'])
    expect(setSiteLabels(b.id, ['production', ' Production ', '']).added).toEqual([])
    expect(names(a.id)).toEqual(['Production', 'Clients'])
    expect(names(b.id)).toEqual(['Production'])
    expect(listLabels().map((l) => [l.name, l.sites])).toEqual([['Production', 2], ['Clients', 1]])
    // New labels take different colours.
    expect(new Set(listLabels().map((l) => l.color)).size).toBe(2)
    setSiteLabels(a.id, [])
    expect(names(a.id)).toEqual([])
    expect(setSiteLabels(a.id, Array.from({ length: MAX_LABELS_PER_SITE + 1 }, (_, i) => `L${i}`)).error).toMatch(/at most/)
  })

  it('removing a site removes its links but keeps the label', () => {
    const a = addWatched('A', 'https://a.example.com')
    setSiteLabels(a.id, ['Production'])
    removeWatched(a.id)
    expect(listLabels().map((l) => [l.name, l.sites])).toEqual([['Production', 0]])
  })

  it('saves renames, colours, order, deletes and a new label', () => {
    const a = addWatched('A', 'https://a.example.com')
    setSiteLabels(a.id, ['Prod', 'Dev'])
    const [prod, dev] = listLabels()
    // Swapping two names works (no unique-index clash).
    expect(saveLabels([{ id: prod.id, name: 'Dev', color: 'red', remove: false }, { id: dev.id, name: 'Prod', color: 'nope', remove: false }], [dev.id, prod.id]).error).toBeUndefined()
    expect(listLabels().map((l) => [l.id, l.name, l.color])).toEqual([[dev.id, 'Prod', 'grey'], [prod.id, 'Dev', 'red']])
    expect(saveLabels([{ id: prod.id, name: 'same', color: 'red', remove: false }, { id: dev.id, name: 'Same', color: 'red', remove: false }], []).error).toMatch(/Two labels/)
    expect(saveLabels([{ id: prod.id, name: '', color: 'red', remove: false }], []).error).toMatch(/name/)
    expect(saveLabels([], [], 'prod').error).toMatch(/already/)
    const r = saveLabels([{ id: prod.id, name: 'Dev', color: 'red', remove: true }], [], 'Clients')
    expect(r.removed).toEqual(['Dev'])
    expect(listLabels().map((l) => l.name)).toEqual(['Prod', 'Clients'])
    expect(names(a.id)).toEqual(['Prod'])
  })

  it('groups sites by label, in label order, with No label last and filters', () => {
    const sites = ['A', 'B', 'C', 'D'].map((n) => addWatched(n, `https://${n.toLowerCase()}.example.com`))
    setSiteLabels(sites[0].id, ['Prod'])
    setSiteLabels(sites[1].id, ['Prod', 'Clients'])
    setSiteLabels(sites[2].id, ['Non-prod'])
    const labels = listLabels()
    const by = labelsBySite()
    const out = (show?: Set<string>) => groupSites(sites, labels, by, show).map((g) => [g.label?.name ?? 'none', g.sites.map((s) => s.name).join('')])
    expect(out()).toEqual([['Prod', 'AB'], ['Clients', 'B'], ['Non-prod', 'C'], ['none', 'D']])
    const clients = labels.find((l) => l.name === 'Clients')!
    expect(out(parseShow(`${clients.id},none,junk`))).toEqual([['Clients', 'B'], ['none', 'D']])
    expect(filterSites(sites, by, parseShow(`${clients.id}`)).map((s) => s.name)).toEqual(['B'])
    expect(filterSites(sites, by, parseShow('none')).map((s) => s.name)).toEqual(['D'])
    // A label with no sites makes no table.
    ensureLabel('Empty')
    expect(groupSites(sites, listLabels(), by).map((g) => g.label?.name ?? 'none')).not.toContain('Empty')
  })
})
