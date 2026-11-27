'use client'

import { startTransition, useActionState, useEffect, useRef } from 'react'
import { usePopup } from './Popup'

type State = { error?: string; ok?: string } | undefined

/** A form bound to a server action that shows the action's error or success line. */
export function ActionForm({ action, children, submit, busy, className, danger, extra }: {
  action: (prev: State, form: FormData) => Promise<State>
  children: React.ReactNode
  submit: string
  busy?: string
  className?: string
  danger?: boolean
  /** More buttons in the footer, left of the main one (e.g. a second submit with name/value). */
  extra?: React.ReactNode
}) {
  const [state, formAction, pending] = useActionState(action, undefined)
  const popup = usePopup()
  // In a popup, success closes it and the message moves to a toast.
  const handled = useRef<State>(undefined)
  useEffect(() => {
    if (!popup || !state?.ok || handled.current === state) return
    handled.current = state
    popup.done(state.ok)
  }, [popup, state])
  // Submitted by hand rather than through `<form action>`: React resets a form after
  // every form action, which wiped what people typed when the server said no. Now the
  // values stay on an error and the form only clears after a success.
  const formRef = useRef<HTMLFormElement>(null)
  const cleared = useRef<State>(undefined)
  useEffect(() => {
    if (popup || !state?.ok || cleared.current === state) return
    cleared.current = state
    formRef.current?.reset()
  }, [popup, state])
  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (pending) return
    const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLElement | null
    const data = new FormData(e.currentTarget, submitter)
    startTransition(() => formAction(data))
  }
  return (
    <form ref={formRef} onSubmit={onSubmit} className={className} data-action-form="">
      {state?.error && <div className="notice bad" role="alert">{state.error}</div>}
      {state?.ok && !popup && <div className="notice ok" role="status">{state.ok}</div>}
      {children}
      <div className="row end form-foot" style={{ marginTop: 6 }}>
        {extra}
        <button className={danger ? 'danger' : 'primary'} disabled={pending}>{pending ? busy ?? 'Working…' : submit}</button>
      </div>
    </form>
  )
}
