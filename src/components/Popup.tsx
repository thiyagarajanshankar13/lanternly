'use client'

import { createContext, useActionState, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon, type IconName } from './Icon'

type Ctx = { done: (message?: string) => void }
const PopupContext = createContext<Ctx | null>(null)
/** Inside a popup: lets a form close it and hand its success line to the page as a toast. */
export const usePopup = () => useContext(PopupContext)

/** Dialogs live inside the console's .adm wrapper so they keep its colours. */
function useHost() {
  const [host, setHost] = useState<Element | null>(null)
  useEffect(() => setHost(document.querySelector('.adm') ?? document.body), [])
  return host
}

/**
 * A toolbar button (or a More-menu item) that opens its form in a popup.
 * `panel` slides in from the side for long forms; on phones both come up from the bottom.
 * An ActionForm inside closes it on success and its message shows as a toast; errors keep it open.
 * A plain form inside (Delete, Stop watching…) closes it as it's sent.
 * `sticky` keeps the toast until it's closed (for messages holding a key).
 */
export function Popup({ label, short, title, subtitle, icon, primary, danger, panel, menu, sticky, children }: {
  label: string
  /** A shorter label for the phone toolbar. */
  short?: string
  title?: string
  subtitle?: React.ReactNode
  icon?: IconName
  primary?: boolean
  danger?: boolean
  panel?: boolean
  menu?: boolean
  sticky?: boolean
  children: React.ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const host = useHost()
  const [round, setRound] = useState(0)
  const [toast, setToast] = useState<string | null>(null)

  const open = () => { setRound((r) => r + 1); ref.current?.showModal() }
  const close = useCallback(() => ref.current?.close(), [])
  const done = useCallback((message?: string) => { close(); if (message) setToast(message) }, [close])
  const ctx = useMemo(() => ({ done }), [done])

  useEffect(() => {
    if (!toast || sticky) return
    const t = setTimeout(() => setToast(null), Math.min(14000, 5000 + toast.length * 40))
    return () => clearTimeout(t)
  }, [toast, sticky])

  // A plain form (not an ActionForm) closes the popup when it's sent.
  const onSubmit = (e: React.FormEvent<HTMLDivElement>) => {
    const form = e.target as HTMLFormElement
    if (!form.hasAttribute('data-action-form')) setTimeout(close, 0)
  }

  const cls = menu ? `menu-item${danger ? ' danger' : ''}` : `${primary ? 'primary' : ''}${danger ? ' danger' : ''}`.trim()
  return (
    <>
      <button type="button" className={cls || undefined} onClick={open} aria-haspopup="dialog">
        {icon && <Icon name={icon} size={16} />}<Label label={label} short={short} />
      </button>
      {host && createPortal(
        <>
          <dialog ref={ref} className={panel ? 'popup panel' : 'popup'} aria-label={title ?? label}
            onClick={(e) => { if (e.target === ref.current) close() }}>
            <header className="popup-head">
              <div><h3>{title ?? label}</h3>{subtitle && <p>{subtitle}</p>}</div>
              <button type="button" className="popup-x" onClick={close} aria-label="Close"><Icon name="close" size={18} /></button>
            </header>
            <PopupContext.Provider value={ctx}>
              <div className="popup-body" key={round} onSubmit={onSubmit}>{round > 0 && children}</div>
            </PopupContext.Provider>
          </dialog>
          {toast && <Toast text={toast} onClose={() => setToast(null)} />}
        </>,
        host,
      )}
    </>
  )
}

/** Less-used actions behind a "More" button. Children are Popup (with `menu`) or MenuForm items. */
export function MoreMenu({ children, label = 'More' }: { children: React.ReactNode; label?: string }) {
  const [openMenu, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!openMenu) return
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', away); document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc) }
  }, [openMenu])
  return (
    <div className="more" ref={ref}>
      <button type="button" aria-haspopup="menu" aria-expanded={openMenu} onClick={() => setOpen((o) => !o)}>
        <Icon name="more" size={16} /><span className="tb-label">{label}</span>
      </button>
      {/* Kept mounted so a popup opened from it stays open after the menu closes. */}
      <div className="menu" role="menu" hidden={!openMenu} onClick={(e) => { if ((e.target as Element).closest('button, a')) setOpen(false) }}>
        {children}
      </div>
    </div>
  )
}

/** Toolbar buttons under a page's title. */
export function Toolbar({ children }: { children: React.ReactNode }) {
  return <div className="toolbar" role="toolbar">{children}</div>
}

function Toast({ text, bad, onClose }: { text: string; bad?: boolean; onClose: () => void }) {
  return (
    <div className={bad ? 'toast bad' : 'toast'} role={bad ? 'alert' : 'status'}>
      <Icon name={bad ? 'close' : 'check'} size={16} /><span>{text}</span>
      <button type="button" onClick={onClose} aria-label="Dismiss"><Icon name="close" size={14} /></button>
    </div>
  )
}

type State = { error?: string; ok?: string } | undefined

/** A toolbar button that runs a server action straight away and shows its answer as a toast. */
export function ActionButton({ action, label, short, busy, icon, children }: {
  action: (prev: State, form: FormData) => Promise<State>
  label: string
  short?: string
  busy?: string
  icon?: IconName
  children?: React.ReactNode
}) {
  const [state, formAction, pending] = useActionState(action, undefined)
  const host = useHost()
  const [shown, setShown] = useState<State>(undefined)
  useEffect(() => { setShown(state) }, [state])
  useEffect(() => {
    if (!shown?.ok) return
    const t = setTimeout(() => setShown(undefined), 9000)
    return () => clearTimeout(t)
  }, [shown])
  return (
    <form action={formAction}>
      {children}
      <button disabled={pending}>{icon && <Icon name={icon} size={16} />}{pending ? <span className="tb-label">{busy ?? 'Working…'}</span> : <Label label={label} short={short} />}</button>
      {host && shown && (shown.ok || shown.error) && createPortal(<Toast text={(shown.ok || shown.error)!} bad={!!shown.error} onClose={() => setShown(undefined)} />, host)}
    </form>
  )
}

/** A toolbar label, with an optional shorter one that the phone toolbar shows instead. */
function Label({ label, short }: { label: string; short?: string }) {
  if (!short) return <span className="tb-label">{label}</span>
  return <span className="tb-label"><span className="tb-long">{label}</span><span className="tb-short" aria-hidden="true">{short}</span></span>
}
