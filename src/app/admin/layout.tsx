import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'

/** Everything under /admin (console, sign-in, setup) gets the console look; the public pages keep theirs. */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <div className="adm">{children}</div>
}
