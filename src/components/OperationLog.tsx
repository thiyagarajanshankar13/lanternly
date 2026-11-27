'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

type Op = { id: number; status: string; log: string }

/** Shows an operation's output and follows it while it's queued or running. */
export function OperationLog({ id, initialStatus, initialLog }: { id: number; initialStatus: string; initialLog: string }) {
  const [op, setOp] = useState<Op>({ id, status: initialStatus, log: initialLog })
  const router = useRouter()
  const box = useRef<HTMLPreElement>(null)
  const live = op.status === 'queued' || op.status === 'running'

  useEffect(() => {
    if (!live) return
    let stop = false
    const tick = async () => {
      try {
        const res = await fetch(`/api/admin/operations/${id}`, { cache: 'no-store' })
        if (res.ok && !stop) {
          const next = (await res.json()) as Op
          setOp(next)
          if (next.status !== 'queued' && next.status !== 'running') router.refresh()
        }
      } catch { /* try again on the next tick */ }
    }
    const timer = setInterval(tick, 1500)
    return () => { stop = true; clearInterval(timer) }
  }, [id, live, router])

  useEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight }, [op.log])

  return <pre className="log" ref={box} aria-live="polite">{op.log || (op.status === 'queued' ? 'Waiting to start…' : 'No output yet…')}</pre>
}
