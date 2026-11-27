'use client'

import { useState } from 'react'

/** A database, or an S3 storage (kind 'minio', with its buckets). */
type Db = { id: number; name: string; displayName: string; kind?: string; buckets?: string[] }

const VARS = ['DATABASE_URL', 'PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE']
const S3_VARS = ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']

/**
 * Which of the project's databases and storage an app gets the connection variables of.
 * Posts db[] (database or storage ids), prefix-<id> for each, and bucket-<id> for storage.
 */
export function DatabasePicker({ databases, linked = [], extra }: { databases: Db[]; linked?: { dbId: number; prefix: string; bucket?: string }[]; extra?: React.ReactNode }) {
  const [on, setOn] = useState(new Map(linked.map((l) => [l.dbId, l.prefix])))
  const [buckets, setBuckets] = useState(new Map(linked.map((l) => [l.dbId, l.bucket ?? ''])))
  if (!databases.length && !extra) return null
  const isS3 = (d: Db) => d.kind === 'minio'
  const hasStorage = databases.some(isS3)
  const hasDb = databases.some((d) => !isS3(d)) || !!extra
  const toggle = (id: number) => setOn((prev) => {
    const next = new Map(prev)
    const d = databases.find((x) => x.id === id)!
    // The first of each kind needs no prefix; a second one gets one made from its name.
    const sameKind = [...next.keys()].filter((k) => isS3(databases.find((x) => x.id === k)!) === isS3(d)).length
    if (next.has(id)) next.delete(id); else next.set(id, sameKind === 0 ? '' : `${d.name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_`)
    return next
  })
  return (
    <div className="field">
      <label>{hasStorage && hasDb ? 'Databases and storage' : hasStorage ? 'Storage' : 'Databases'}</label>
      <div className="site-pick">
        {databases.map((d) => (
          <div key={d.id} style={{ padding: '4px 0' }}>
            <label htmlFor={`db-${d.id}`} style={{ fontWeight: 400 }}>
              <input id={`db-${d.id}`} type="checkbox" name="db" value={d.id} checked={on.has(d.id)} onChange={() => toggle(d.id)} /> {d.displayName}{d.displayName !== d.name && <span className="muted mono small"> {d.name}</span>}
              {hasStorage && <span className="badge" style={{ marginLeft: 6 }}>{isS3(d) ? 'S3 storage' : 'PostgreSQL'}</span>}
            </label>
            {on.has(d.id) && (
              <div className="row" style={{ marginLeft: 24, marginTop: 4, alignItems: 'center', gap: 8 }}>
                {isS3(d) && (d.buckets?.length ?? 0) > 0 && <>
                  <label htmlFor={`bucket-${d.id}`} className="small muted" style={{ fontWeight: 400 }}>Bucket</label>
                  <select id={`bucket-${d.id}`} name={`bucket-${d.id}`} value={buckets.get(d.id) || d.buckets![0]} style={{ maxWidth: 180 }}
                    onChange={(e) => { const v = e.target.value; setBuckets((prev) => new Map(prev).set(d.id, v)) }}>
                    {d.buckets!.map((b) => <option key={b} value={b}>{b}</option>)}
                  </select>
                </>}
                <label htmlFor={`prefix-${d.id}`} className="small muted" style={{ fontWeight: 400 }}>Prefix</label>
                <input id={`prefix-${d.id}`} name={`prefix-${d.id}`} type="text" value={on.get(d.id)} placeholder="none" maxLength={31} spellCheck={false} autoCapitalize="characters" style={{ maxWidth: 140 }}
                  onChange={(e) => { const v = e.target.value.toUpperCase(); setOn((prev) => new Map(prev).set(d.id, v)) }} />
                <span className="muted small mono">{isS3(d)
                  ? `${on.get(d.id) || ''}${S3_VARS[0]}, ${on.get(d.id) || ''}S3_BUCKET…${on.get(d.id) ? '' : ' + AWS_*'}`
                  : `${on.get(d.id) || ''}${VARS[0]}, ${on.get(d.id) || ''}PGHOST…`}</span>
              </div>
            )}
          </div>
        ))}
        {extra}
      </div>
      <div className="help">
        {hasDb && <>A ticked database gives the app {VARS.join(', ')}. </>}
        {hasStorage && <>A ticked storage gives {S3_VARS.join(', ')}, S3_REGION, S3_PUBLIC_URL and S3_FORCE_PATH_STYLE, and with no prefix also the AWS_* names AWS SDKs read. </>}
        Leave the prefix empty for the main one; give a second one a prefix such as ANALYTICS_. Passwords and keys are filled in on the server.
      </div>
    </div>
  )
}
