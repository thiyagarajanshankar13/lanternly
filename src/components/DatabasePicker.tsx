'use client'

import { useState } from 'react'

type Db = { id: number; name: string; displayName: string }

const VARS = ['DATABASE_URL', 'PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE']

/**
 * Which of the project's databases an app gets the connection variables of.
 * Posts db[] (database ids) and prefix-<id> for each.
 */
export function DatabasePicker({ databases, linked = [], extra }: { databases: Db[]; linked?: { dbId: number; prefix: string }[]; extra?: React.ReactNode }) {
  const [on, setOn] = useState(new Map(linked.map((l) => [l.dbId, l.prefix])))
  if (!databases.length && !extra) return null
  const toggle = (id: number) => setOn((prev) => {
    const next = new Map(prev)
    if (next.has(id)) next.delete(id); else next.set(id, next.size === 0 ? '' : `${databases.find((d) => d.id === id)!.name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_`)
    return next
  })
  return (
    <div className="field">
      <label>Databases</label>
      <div className="site-pick">
        {databases.map((d) => (
          <div key={d.id} style={{ padding: '4px 0' }}>
            <label htmlFor={`db-${d.id}`} style={{ fontWeight: 400 }}>
              <input id={`db-${d.id}`} type="checkbox" name="db" value={d.id} checked={on.has(d.id)} onChange={() => toggle(d.id)} /> {d.displayName}{d.displayName !== d.name && <span className="muted mono small"> {d.name}</span>}
            </label>
            {on.has(d.id) && (
              <div className="row" style={{ marginLeft: 24, marginTop: 4, alignItems: 'center', gap: 8 }}>
                <label htmlFor={`prefix-${d.id}`} className="small muted" style={{ fontWeight: 400 }}>Prefix</label>
                <input id={`prefix-${d.id}`} name={`prefix-${d.id}`} type="text" value={on.get(d.id)} placeholder="none" maxLength={31} spellCheck={false} autoCapitalize="characters" style={{ maxWidth: 160 }}
                  onChange={(e) => { const v = e.target.value.toUpperCase(); setOn((prev) => new Map(prev).set(d.id, v)) }} />
                <span className="muted small mono">{on.get(d.id) || ''}{VARS[0]}, {on.get(d.id) || ''}PGHOST…</span>
              </div>
            )}
          </div>
        ))}
        {extra}
      </div>
      <div className="help">A ticked database gives the app {VARS.join(', ')}. Leave the prefix empty for the main one; give a second one a prefix such as ANALYTICS_. The password is filled in on the server.</div>
    </div>
  )
}
