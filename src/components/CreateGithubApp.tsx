'use client'

import { useRef, useState } from 'react'
import { prepareGithubAppAction } from '@/app/admin/(console)/apps/actions'

/**
 * "Create GitHub app": asks the server for the app manifest, then posts it to
 * GitHub's new-app page in this tab (GitHub only takes the manifest as a form post).
 */
export function CreateGithubApp({ owner, buildRepo, label = 'Create GitHub app', replacing }: { owner: string; buildRepo: string; label?: string; replacing?: boolean }) {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const form = useRef<HTMLFormElement>(null)
  const [target, setTarget] = useState({ url: '', manifest: '' })

  async function go(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (busy) return
    const data = new FormData(e.currentTarget)
    setBusy(true); setError('')
    const res = await prepareGithubAppAction({ owner: String(data.get('ghOwner') ?? ''), buildRepo: String(data.get('ghBuildRepo') ?? '') })
    if ('error' in res) { setError(res.error); setBusy(false); return }
    setTarget(res)
    // Let React put the manifest into the hidden form, then send it.
    requestAnimationFrame(() => form.current?.submit())
  }

  return (
    <>
      <form onSubmit={go}>
        {error && <div className="notice bad" role="alert">{error}</div>}
        <div className="grid cols-2">
          <div className="field"><label htmlFor="ghOwner">GitHub organisation or user</label><input id="ghOwner" name="ghOwner" type="text" defaultValue={owner} placeholder="my-company" required /><div className="help">Only its repos can be deployed.</div></div>
          <div className="field"><label htmlFor="ghBuildRepo">Builds run in</label><input id="ghBuildRepo" name="ghBuildRepo" type="text" defaultValue={buildRepo} placeholder="my-company/deployer" required /><div className="help">Your copy of the deployer&apos;s repo (it holds the build workflow).</div></div>
        </div>
        {replacing && <p className="muted small">The app in use now keeps working until the new one is installed.</p>}
        <div className="row end form-foot" style={{ marginTop: 6 }}>
          <button className="primary" disabled={busy}>{busy ? 'Opening GitHub…' : label}</button>
        </div>
      </form>
      <form ref={form} method="post" action={target.url} hidden>
        <input type="hidden" name="manifest" value={target.manifest} readOnly />
      </form>
    </>
  )
}
