'use client'

import { useEffect, useState } from 'react'

type Repo = { fullName: string; defaultBranch: string }

/** Repo list from the server; the chosen repo's branches are fetched as it changes. */
export function RepoBranchPicker({ repos, error, initialRepo = '', initialBranch = '' }: { repos: Repo[]; error?: string; initialRepo?: string; initialBranch?: string }) {
  const [repo, setRepo] = useState(initialRepo)
  const [branch, setBranch] = useState(initialBranch)
  const [branches, setBranches] = useState<string[] | null>(null)
  const [problem, setProblem] = useState('')

  useEffect(() => {
    if (!repo) { setBranches(null); return }
    let cancelled = false
    setBranches(null); setProblem('')
    fetch(`/api/admin/github/branches?repo=${encodeURIComponent(repo)}`)
      .then((r) => r.json())
      .then((body: { branches?: string[]; error?: string }) => {
        if (cancelled) return
        if (body.error) { setProblem(body.error); setBranches([]); return }
        const list = body.branches ?? []
        setBranches(list)
        setBranch((b) => (b && list.includes(b) ? b : repos.find((r) => r.fullName === repo)?.defaultBranch ?? list[0] ?? ''))
      })
      .catch(() => { if (!cancelled) { setProblem("Couldn't load the branches."); setBranches([]) } })
    return () => { cancelled = true }
  }, [repo, repos])

  return (
    <div className="grid cols-2">
      <div className="field">
        <label htmlFor="appRepo">GitHub repo</label>
        {repos.length ? (
          <select id="appRepo" name="appRepo" value={repo} onChange={(e) => setRepo(e.target.value)} required>
            <option value="">Pick a repo</option>
            {repos.map((r) => <option key={r.fullName} value={r.fullName}>{r.fullName}</option>)}
          </select>
        ) : (
          <input id="appRepo" name="appRepo" type="text" value={repo} onChange={(e) => setRepo(e.target.value.trim())} placeholder="my-org/my-app" required autoCapitalize="none" spellCheck={false} />
        )}
        <div className="help">{error ? <strong>{error}</strong> : 'Only repos the GitHub App is installed on are listed.'}</div>
      </div>
      <div className="field">
        <label htmlFor="appBranch">Branch</label>
        {branches && branches.length ? (
          <select id="appBranch" name="appBranch" value={branch} onChange={(e) => setBranch(e.target.value)} required>
            {branches.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        ) : (
          <input id="appBranch" name="appBranch" type="text" value={branch} onChange={(e) => setBranch(e.target.value.trim())} placeholder={repo && !branches ? 'Loading…' : 'main'} required autoCapitalize="none" spellCheck={false} />
        )}
        <div className="help">{problem ? <strong>{problem}</strong> : 'Each push to this branch can deploy the app.'}</div>
      </div>
    </div>
  )
}
