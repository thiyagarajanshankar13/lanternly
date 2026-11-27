'use client'

import { useActionState } from 'react'
import { inviteAction } from '../../auth-actions'

export function InviteForm({ token, email }: { token: string; email: string }) {
  const [state, action, pending] = useActionState(inviteAction, undefined)
  return (
    <form action={action}>
      {state?.error && <div className="notice bad" role="alert">{state.error}</div>}
      <input type="hidden" name="token" value={token} />
      <input type="email" name="email" value={email} autoComplete="username" readOnly hidden />
      <div className="field">
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" autoComplete="new-password" minLength={12} required autoFocus />
        <div className="help">At least 12 characters.</div>
      </div>
      <div className="field">
        <label htmlFor="password2">Password again</label>
        <input id="password2" name="password2" type="password" autoComplete="new-password" minLength={12} required />
      </div>
      <button className="primary" style={{ width: '100%' }} disabled={pending}>{pending ? 'Saving…' : 'Set password and continue'}</button>
    </form>
  )
}
