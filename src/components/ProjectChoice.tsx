'use client'

import { useState } from 'react'
import { DatabasePicker } from './DatabasePicker'

type P = { id: number; displayName: string; server: string; databases: { id: number; name: string; displayName: string; kind?: string; buckets?: string[] }[] }

/**
 * For a new app: which project it joins (or a new one named after it), the
 * project's databases to connect, and "create a new database for it".
 * Posts projectId ('' = new project), db[], prefix-<id>, newDb.
 */
export function ProjectChoice({ projects, initial, fixed, allowNew, noNewDb }: { projects: P[]; initial?: number; fixed?: boolean; allowNew: boolean; noNewDb?: boolean }) {
  const [id, setId] = useState<number | 0>(initial ?? 0)
  const [newDb, setNewDb] = useState(false)
  const project = projects.find((p) => p.id === id)
  return (
    <>
      {fixed && project ? (
        <><input type="hidden" name="projectId" value={project.id} /><p className="muted">Joins the project <strong>{project.displayName}</strong> (on {project.server}).</p></>
      ) : (
        <div className="field"><label htmlFor="projectId">Project</label>
          <select id="projectId" name="projectId" value={id} onChange={(e) => setId(Number(e.target.value))}>
            {allowNew && <option value={0}>A new project, named after it</option>}
            {projects.map((p) => <option key={p.id} value={p.id}>{p.displayName} ({p.server})</option>)}
          </select>
          <div className="help">Services in the same project reach each other by name; its databases are only reachable from inside it. The app runs on the project&apos;s server.</div></div>
      )}
      <DatabasePicker key={id} databases={project?.databases ?? []} extra={noNewDb ? undefined :
        <div style={{ padding: '4px 0' }}>
          <label htmlFor="newDb" style={{ fontWeight: 400 }}><input id="newDb" type="checkbox" name="newDb" checked={newDb} onChange={(e) => setNewDb(e.target.checked)} /> Create a new PostgreSQL database for it</label>
          {newDb && <div className="muted small" style={{ marginLeft: 24 }}>Named after the app with -db on the end (PostgreSQL 16, 256 MB, 5 GB quota, backed up daily), connected with no prefix.</div>}
        </div>
      } />
    </>
  )
}
