'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/** Uploads a pg_dump file for a database; the server loads it in place of the data. */
export function DumpUpload({ id, name }: { id: number; name: string }) {
  const router = useRouter()
  const [file, setFile] = useState<File | null>(null)
  const [confirm, setConfirm] = useState('')
  const [state, setState] = useState<{ busy?: boolean; error?: string; ok?: string }>({})
  const send = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!file) return setState({ error: 'Pick the dump file first.' })
    setState({ busy: true })
    try {
      const res = await fetch(`/api/admin/clubs/${id}/dump?confirm=${encodeURIComponent(confirm)}`, { method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream' } })
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) return setState({ error: body.error || `The upload failed (${res.status}).` })
      setState({ ok: 'Uploaded. Loading it now: follow it at the top of this page.' })
      router.refresh()
    } catch {
      setState({ error: 'The upload broke off. Try again.' })
    }
  }
  return (
    <form onSubmit={send} data-action-form="">
      {state.error && <div className="notice bad" role="alert">{state.error}</div>}
      {state.ok && <div className="notice ok" role="status">{state.ok}</div>}
      <div className="field"><label htmlFor="dump-file">Dump file</label><input id="dump-file" type="file" accept=".dump,.backup,application/octet-stream" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <div className="help">Made with <span className="mono">pg_dump -Fc</span> (custom format), up to 2 GB.</div></div>
      <div className="field"><label htmlFor="dump-confirm">Type <span className="mono">{name}</span> to confirm</label><input id="dump-confirm" type="text" autoComplete="off" value={confirm} onChange={(e) => setConfirm(e.target.value)} style={{ maxWidth: 260 }} /></div>
      <div className="row end form-foot"><button className="danger" disabled={state.busy}>{state.busy ? 'Uploading…' : 'Upload and replace the data'}</button></div>
    </form>
  )
}
