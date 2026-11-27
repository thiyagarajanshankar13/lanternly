'use client'

import { useActionState } from 'react'
import { codeAction } from '../../auth-actions'

export function CodeForm({ label }: { label: string }) {
  const [state, action, pending] = useActionState(codeAction, undefined)
  return (
    <form action={action}>
      {state?.error && <div className="notice bad" role="alert">{state.error}</div>}
      <div className="field">
        <label htmlFor="code">{label}</label>
        <input id="code" name="code" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} required autoFocus />
      </div>
      <button className="primary" style={{ width: '100%' }} disabled={pending}>{pending ? 'Checking…' : 'Sign in'}</button>
    </form>
  )
}
