import { db, now } from './db'

// Labels on watched sites (Production, Non-prod, a client's name…). Monitoring
// shows one table per label, in the labels' order, and a "No label" table
// last. A site can have several labels and then shows in each of their tables.

export const LABEL_COLORS = ['green', 'amber', 'blue', 'purple', 'red', 'grey'] as const
export type LabelColor = (typeof LABEL_COLORS)[number]
export const MAX_LABEL_LENGTH = 30
export const MAX_LABELS_PER_SITE = 8
export const MAX_LABELS = 40

export type MonitorLabel = { id: number; name: string; color: LabelColor; position: number; sites: number }

type Row = { id: number; name: string; color: string; position: number; sites: number }
const toColor = (c: string): LabelColor => (LABEL_COLORS as readonly string[]).includes(c) ? c as LabelColor : 'grey'

/** Trimmed, single spaces, at most 30 characters; '' when nothing is left. */
export function cleanLabelName(input: string): string {
  return input.replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL_LENGTH).trim()
}

export function listLabels(): MonitorLabel[] {
  const rows = db().prepare(`SELECT l.id, l.name, l.color, l.position, (SELECT COUNT(*) FROM watched_site_labels s WHERE s.label_id = l.id) AS sites
    FROM monitor_labels l ORDER BY l.position, l.name COLLATE NOCASE`).all() as Row[]
  return rows.map((r) => ({ ...r, color: toColor(r.color) }))
}

/** Label ids per site id, in the labels' order. */
export function labelsBySite(): Map<number, number[]> {
  const rows = db().prepare(`SELECT s.site_id, s.label_id FROM watched_site_labels s JOIN monitor_labels l ON l.id = s.label_id
    ORDER BY l.position, l.name COLLATE NOCASE`).all() as { site_id: number; label_id: number }[]
  const out = new Map<number, number[]>()
  for (const r of rows) out.set(r.site_id, [...(out.get(r.site_id) ?? []), r.label_id])
  return out
}

function findLabel(name: string): MonitorLabel | undefined {
  return listLabels().find((l) => l.name.toLowerCase() === name.toLowerCase())
}

/** Makes a label (or returns the one with that name). New labels go last and take the next colour. */
export function ensureLabel(name: string): MonitorLabel | { error: string } {
  const clean = cleanLabelName(name)
  if (!clean) return { error: 'A label needs a name.' }
  const have = findLabel(clean)
  if (have) return have
  const all = listLabels()
  if (all.length >= MAX_LABELS) return { error: `There can be at most ${MAX_LABELS} labels. Delete one under Labels first.` }
  const color = LABEL_COLORS[all.length % (LABEL_COLORS.length - 1)]
  const position = all.reduce((n, l) => Math.max(n, l.position), -1) + 1
  db().prepare('INSERT INTO monitor_labels (name, color, position, created_at) VALUES (?, ?, ?, ?)').run(clean, color, position, now())
  return findLabel(clean)!
}

/** Replaces a site's labels with these names, making any new ones. */
export function setSiteLabels(siteId: number, names: string[]): { error?: string; added: string[] } {
  const wanted: string[] = []
  for (const n of names.map(cleanLabelName).filter(Boolean)) if (!wanted.some((w) => w.toLowerCase() === n.toLowerCase())) wanted.push(n)
  if (wanted.length > MAX_LABELS_PER_SITE) return { error: `A site can have at most ${MAX_LABELS_PER_SITE} labels.`, added: [] }
  const before = new Set(listLabels().map((l) => l.name.toLowerCase()))
  const ids: number[] = []
  for (const name of wanted) {
    const label = ensureLabel(name)
    if ('error' in label) return { error: label.error, added: [] }
    ids.push(label.id)
  }
  const conn = db()
  conn.transaction(() => {
    conn.prepare('DELETE FROM watched_site_labels WHERE site_id = ?').run(siteId)
    const add = conn.prepare('INSERT OR IGNORE INTO watched_site_labels (site_id, label_id) VALUES (?, ?)')
    for (const id of ids) add.run(siteId, id)
  })()
  return { added: wanted.filter((n) => !before.has(n.toLowerCase())) }
}

export type LabelEdit = { id: number; name: string; color: string; remove: boolean }

/**
 * Saves the Labels popup: renames, colours, deletes and the new order (ids,
 * first table first), plus an optional new label. Deleting a label only takes
 * it off its sites.
 */
export function saveLabels(edits: LabelEdit[], order: number[], newName = ''): { error?: string; removed: string[] } {
  const all = listLabels()
  const byId = new Map(all.map((l) => [l.id, l]))
  const kept = edits.filter((e) => byId.has(e.id) && !e.remove)
  const names = new Map<string, number>()
  for (const e of kept) {
    const name = cleanLabelName(e.name)
    if (!name) return { error: `Give "${byId.get(e.id)!.name}" a name, or tick Delete.`, removed: [] }
    const key = name.toLowerCase()
    if (names.has(key)) return { error: `Two labels are called "${name}". Use different names.`, removed: [] }
    names.set(key, e.id)
  }
  // Labels not in the form keep their name for the clash check.
  for (const l of all) if (!edits.some((e) => e.id === l.id)) names.set(l.name.toLowerCase(), l.id)
  const added = cleanLabelName(newName)
  if (added && names.has(added.toLowerCase())) return { error: `There is already a label called "${added}".`, removed: [] }
  if (added && names.size >= MAX_LABELS) return { error: `There can be at most ${MAX_LABELS} labels.`, removed: [] }

  const removed = edits.filter((e) => e.remove && byId.has(e.id)).map((e) => byId.get(e.id)!.name)
  const conn = db()
  conn.transaction(() => {
    for (const e of edits) if (e.remove && byId.has(e.id)) conn.prepare('DELETE FROM monitor_labels WHERE id = ?').run(e.id)
    // Renames go through a temporary name so swapping two names doesn't hit the unique index.
    for (const e of kept) conn.prepare('UPDATE monitor_labels SET name = ? WHERE id = ?').run(`__renaming_${e.id}`, e.id)
    for (const e of kept) conn.prepare('UPDATE monitor_labels SET name = ?, color = ? WHERE id = ?').run(cleanLabelName(e.name), toColor(e.color), e.id)
    const left = all.filter((l) => !removed.includes(l.name)).map((l) => l.id)
    const sorted = [...order.filter((id) => left.includes(id)), ...left.filter((id) => !order.includes(id))]
    sorted.forEach((id, i) => conn.prepare('UPDATE monitor_labels SET position = ? WHERE id = ?').run(i, id))
  })()
  if (added) {
    const made = ensureLabel(added)
    if ('error' in made) return { error: made.error, removed }
  }
  return { removed }
}

export type SiteGroup<T> = { label: MonitorLabel | null; sites: T[] }

/**
 * One group per label that has sites (labels' order), then "No label" (label
 * null). A site with several labels is in each of their groups. `show` limits
 * the groups to these label ids ('none' = No label); empty or missing = all.
 */
export function groupSites<T extends { id: number }>(sites: T[], labels: MonitorLabel[], bySite: Map<number, number[]>, show?: Set<string>): SiteGroup<T>[] {
  const wanted = (key: string) => !show || show.size === 0 || show.has(key)
  const groups: SiteGroup<T>[] = []
  for (const label of labels) {
    if (!wanted(String(label.id))) continue
    const list = sites.filter((s) => bySite.get(s.id)?.includes(label.id))
    if (list.length) groups.push({ label, sites: list })
  }
  const known = new Set(labels.map((l) => l.id))
  const none = sites.filter((s) => !(bySite.get(s.id) ?? []).some((id) => known.has(id)))
  if (none.length && wanted('none')) groups.push({ label: null, sites: none })
  return groups
}

/** For the "One list" view with chips picked: sites that have any shown label (or none, when No label is shown). */
export function filterSites<T extends { id: number }>(sites: T[], bySite: Map<number, number[]>, show?: Set<string>): T[] {
  if (!show || show.size === 0) return sites
  return sites.filter((s) => {
    const ids = bySite.get(s.id) ?? []
    return ids.length ? ids.some((id) => show.has(String(id))) : show.has('none')
  })
}

/** The ?show= value: label ids and 'none', comma separated. */
export function parseShow(value: string | undefined): Set<string> {
  return new Set((value ?? '').split(',').map((v) => v.trim()).filter((v) => v === 'none' || /^\d+$/.test(v)))
}
