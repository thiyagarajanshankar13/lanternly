import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireOwner, requirePlugin } from '@/lib/guards'
import { getPlugin } from '@/plugins'
import { pluginParts } from '@/plugins/parts'

export const dynamic = 'force-dynamic'

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  return { title: getPlugin((await params).id)?.name ?? 'Plugin' }
}

/** Settings › Plugins › <plugin>: the settings only that plugin uses (its own Settings part). */
export default async function PluginSettingsPage({ params }: { params: Promise<{ id: string }> }) {
  await requireOwner()
  const plugin = getPlugin((await params).id)
  const Settings = plugin && pluginParts(plugin.id).Settings
  if (!plugin || !Settings) notFound()
  requirePlugin(plugin.id)
  return (
    <>
      <div className="page-head">
        <div>
          <p className="small" style={{ marginBottom: 4 }}><Link href="/admin/settings/plugins">← Plugins</Link></p>
          <h1>{plugin.name}</h1>
          <p className="muted">{plugin.settingsIntro ?? 'Where this plugin keeps its keys and choices.'}</p>
        </div>
      </div>
      <Settings />
    </>
  )
}
