'use client'

import { useFormStatus } from 'react-dom'

export function SubmitButton({ children, className, busy }: { children: React.ReactNode; className?: string; busy?: string }) {
  const { pending } = useFormStatus()
  return <button className={className} disabled={pending}>{pending ? busy ?? 'Working…' : children}</button>
}
