'use client'

import { useActionState } from 'react'
import { setupAction } from '../auth-actions'

export function SetupForm() {
  const [state, action, pending] = useActionState(setupAction, undefined)
  return (
    <form action={action}>
      {state?.error && <div className="notice bad" role="alert">{state.error}</div>}
      <div className="field">
        <label htmlFor="token">Setup code</label>
        <input id="token" name="token" type="password" autoComplete="off" required autoFocus />
        <div className="help">The DEPLOYER_SETUP_TOKEN value from the server&apos;s settings.</div>
      </div>
      <div className="field">
        <label htmlFor="name">Your name</label>
        <input id="name" name="name" type="text" autoComplete="name" required />
      </div>
      <div className="field">
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" autoComplete="username" required />
      </div>
      <div className="field">
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" autoComplete="new-password" minLength={12} required />
        <div className="help">At least 12 characters.</div>
      </div>
      <button className="primary" style={{ width: '100%' }} disabled={pending}>{pending ? 'Creating…' : 'Create admin'}</button>
    </form>
  )
}
