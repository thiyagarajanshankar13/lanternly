'use client'

import { useState } from 'react'
import type { Role } from '@/lib/access'

type Site = { id: number; name: string; displayName: string; kind: string }
type ProjectChoice = { id: number; displayName: string; services: number }

const ROLE_CHOICES: { value: Role; label: string; help: string }[] = [
  { value: 'viewer', label: 'Viewer', help: 'Watches the sites below: status, monitoring, deploy output and logs. Changes nothing.' },
  { value: 'operator', label: 'Operator', help: 'Runs the sites below: deploy, restart, pause, settings, domains, back up. In the projects below they can also add apps and databases. Can’t remove or restore.' },
  { value: 'owner', label: 'Owner', help: 'Everything: every site, servers, settings, costs, releases and people.' },
]

/** Role cards plus the site list: "All sites" or a searchable checklist, and whole projects. Posts role, allSites, sites[], projects[]. */
export function AccessPicker({ sites, projects = [], role: initialRole = 'viewer', allSites: initialAll = false, siteIds = [], projectIds = [], idPrefix = 'p', lockOwner }: {
  sites: Site[]
  projects?: ProjectChoice[]
  projectIds?: number[]
  role?: Role
  allSites?: boolean
  siteIds?: number[]
  idPrefix?: string
  /** Editing yourself: you can't step down from owner. */
  lockOwner?: boolean
}) {
  const [role, setRole] = useState<Role>(initialRole)
  const [all, setAll] = useState(initialAll)
  const [picked, setPicked] = useState(new Set(siteIds))
  const [pickedProjects, setPickedProjects] = useState(new Set(projectIds))
  const [q, setQ] = useState('')
  const shown = sites.filter((s) => !q || `${s.displayName} ${s.name}`.toLowerCase().includes(q.toLowerCase()))
  const toggle = (id: number) => setPicked((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })
  return (
    <>
      <div className="field"><label>Role</label>
        <div className="role-pick">
          {ROLE_CHOICES.map((r) => (
            <label key={r.value}>
              <input type="radio" name="role" value={r.value} checked={role === r.value} onChange={() => setRole(r.value)} disabled={lockOwner && r.value !== 'owner'} />
              <span><strong>{r.label}</strong><span className="muted small">{r.help}</span></span>
            </label>
          ))}
        </div>
        {lockOwner && <div className="help">You can&apos;t take away your own owner role. Another owner can.</div>}
      </div>
      {role !== 'owner' && !all && projects.length > 0 && (
        <div className="field">
          <label>Whole projects</label>
          <div className="site-pick">
            {projects.map((p) => (
              <label key={p.id} htmlFor={`${idPrefix}-proj-${p.id}`}>
                <input id={`${idPrefix}-proj-${p.id}`} type="checkbox" name="projects" value={p.id} checked={pickedProjects.has(p.id)}
                  onChange={() => setPickedProjects((prev) => { const n = new Set(prev); if (n.has(p.id)) n.delete(p.id); else n.add(p.id); return n })} />
                {p.displayName}<span className="muted">{p.services} service{p.services === 1 ? '' : 's'}</span>
              </label>
            ))}
          </div>
          <div className="help">Every service in a ticked project, including ones added later.{role === 'operator' ? ' Operators can add apps and databases to them.' : ''}</div>
        </div>
      )}
      {role !== 'owner' && (
        <div className="field">
          <label>Sites</label>
          <label className="small" style={{ fontWeight: 400, marginBottom: 8 }}>
            <input type="checkbox" name="allSites" checked={all} onChange={(e) => setAll(e.target.checked)} /> All sites and projects, including ones added later
          </label>
          {!all && (
            <>
              {sites.length > 6 && <input type="search" placeholder="Find a site" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a site" style={{ marginBottom: 8 }} />}
              <div className="site-pick">
                {sites.length === 0 && <p className="muted small" style={{ margin: '4px 0' }}>No sites yet.</p>}
                {shown.map((s) => (
                  <label key={s.id} htmlFor={`${idPrefix}-site-${s.id}`}>
                    <input id={`${idPrefix}-site-${s.id}`} type="checkbox" checked={picked.has(s.id)} onChange={() => toggle(s.id)} />
                    {s.displayName}<span className="muted">{s.kind === 'app' ? 'app' : s.kind === 'postgres' ? 'database' : s.name}</span>
                  </label>
                ))}
              </div>
              {/* Ticked sites hidden by the search box still count. */}
              {[...picked].map((id) => <input key={id} type="hidden" name="sites" value={id} />)}
              <div className="help">{picked.size} site{picked.size === 1 ? '' : 's'} picked.</div>
            </>
          )}
        </div>
      )}
    </>
  )
}
