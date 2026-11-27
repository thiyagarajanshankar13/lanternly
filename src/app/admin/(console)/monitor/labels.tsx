'use client'

import { useState } from 'react'
import { Icon } from '@/components/Icon'

export type LabelInfo = { id: number; name: string; color: string; sites: number }

const COLORS = ['green', 'amber', 'blue', 'purple', 'red', 'grey']
const MAX_LENGTH = 30

/** A label as a small coloured pill. */
export function LabelChip({ name, color }: { name: string; color: string }) {
  return <span className={`lbl lbl-${color}`}>{name}</span>
}

/**
 * The Labels field of a site's Edit popup: the site's labels as chips, a box
 * to type a new one (Enter or comma adds it) and the other labels to pick.
 * Sends `labelsField` plus one `labels` value per chip.
 */
export function LabelPicker({ all, initial, id = 'labels' }: { all: LabelInfo[]; initial: string[]; id?: string }) {
  const [picked, setPicked] = useState<string[]>(initial)
  const [typed, setTyped] = useState('')
  const colorOf = (name: string) => all.find((l) => l.name.toLowerCase() === name.toLowerCase())?.color ?? 'grey'
  const add = (raw: string) => {
    const name = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_LENGTH).trim()
    if (name && !picked.some((p) => p.toLowerCase() === name.toLowerCase())) setPicked([...picked, name])
    setTyped('')
  }
  const others = all.filter((l) => !picked.some((p) => p.toLowerCase() === l.name.toLowerCase()))
  return (
    <div className="field">
      <label htmlFor={id}>Labels</label>
      <input type="hidden" name="labelsField" value="1" />
      {picked.map((p) => <input key={p} type="hidden" name="labels" value={p} />)}
      <div className="lbl-box" onClick={(e) => { if (e.target === e.currentTarget) document.getElementById(id)?.focus() }}>
        {picked.map((p) => (
          <span key={p} className={`lbl lbl-${colorOf(p)}`}>{p}
            <button type="button" className="lbl-x" aria-label={`Remove ${p}`} onClick={() => setPicked(picked.filter((x) => x !== p))}><Icon name="close" size={12} /></button>
          </span>
        ))}
        <input id={id} type="text" value={typed} maxLength={MAX_LENGTH} placeholder={picked.length ? 'Add another' : 'Type a label, like Production'}
          onChange={(e) => { const v = e.target.value; if (v.endsWith(',')) add(v.slice(0, -1)); else setTyped(v) }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); add(typed) }
            if (e.key === 'Backspace' && !typed && picked.length) setPicked(picked.slice(0, -1))
          }}
          onBlur={() => { if (typed.trim()) add(typed) }} />
      </div>
      {others.length > 0 && (
        <div className="lbl-pick">
          {others.map((l) => <button key={l.id} type="button" className={`lbl lbl-${l.color}`} onClick={() => add(l.name)}>+ {l.name}</button>)}
        </div>
      )}
      <div className="help">Sites with the same label are shown together in one table. A site can have more than one label.</div>
    </div>
  )
}

/** The rows of the Labels popup: name, colour, move up/down, delete. The order sent is the order of the tables. */
export function LabelsEditor({ labels }: { labels: LabelInfo[] }) {
  const [order, setOrder] = useState(labels.map((l) => l.id))
  const byId = new Map(labels.map((l) => [l.id, l]))
  const move = (i: number, by: number) => {
    const next = [...order]; const j = i + by
    if (j < 0 || j >= next.length) return
    ;[next[i], next[j]] = [next[j], next[i]]
    setOrder(next)
  }
  return (
    <>
      {labels.length === 0 && <p className="muted">No labels yet. Add one below, or type one in a site&apos;s Edit popup.</p>}
      <div className="lbl-rows">
        {order.map((id, i) => {
          const l = byId.get(id)!
          return (
            <div key={id} className="lbl-row">
              <input type="hidden" name="labelId" value={id} />
              <input type="text" name={`name-${id}`} defaultValue={l.name} maxLength={MAX_LENGTH} aria-label="Label name" required />
              <div className="lbl-swatches" role="radiogroup" aria-label={`Colour of ${l.name}`}>
                {COLORS.map((c) => (
                  <label key={c} className={`lbl-swatch lbl-${c}`} title={c}>
                    <input type="radio" name={`color-${id}`} value={c} defaultChecked={l.color === c} aria-label={c} />
                  </label>
                ))}
              </div>
              <div className="lbl-moves">
                <button type="button" aria-label={`Move ${l.name} up`} disabled={i === 0} onClick={() => move(i, -1)}><Icon name="up" size={14} /></button>
                <button type="button" aria-label={`Move ${l.name} down`} disabled={i === order.length - 1} onClick={() => move(i, 1)}><Icon name="chevron" size={14} /></button>
              </div>
              <label className="lbl-del small"><input type="checkbox" name={`remove-${id}`} /> Delete</label>
              <div className="muted small lbl-count">{l.sites} site{l.sites === 1 ? '' : 's'}</div>
            </div>
          )
        })}
      </div>
      <div className="field" style={{ marginTop: 14 }}>
        <label htmlFor="newLabel">Add a label</label>
        <input id="newLabel" name="newLabel" type="text" maxLength={MAX_LENGTH} placeholder="New label name" />
      </div>
      <div className="help">The order here is the order of the tables on Monitoring. Deleting a label takes it off its sites; the sites stay watched.</div>
    </>
  )
}
