'use client'

import { useActionState } from 'react'
import { loginAction } from '../auth-actions'

export function LoginForm() {
  const [state, action, pending] = useActionState(loginAction, undefined)
  return (
    <form action={action}>
      {state?.error && <div className="notice bad" role="alert">{state.error}</div>}
      <div className="field">
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" autoComplete="username" required autoFocus />
      </div>
      <div className="field">
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required />
      </div>
      <button className="primary" style={{ width: '100%' }} disabled={pending}>{pending ? 'Checking…' : 'Continue'}</button>
    </form>
  )
}
