import type { Club } from '@/lib/clubs'
import { listProjects } from '@/lib/projects'
import { moveServiceAction } from '@/app/admin/(console)/projects/actions'
import { ActionForm } from './ActionForm'
import { Popup } from './Popup'

/** "Move to project…" for a More menu: projects on the same server only. Owners only. */
export function MoveProject({ club }: { club: Club }) {
  const choices = listProjects().filter((p) => p.serverId === club.serverId && p.id !== club.projectId)
  return (
    <Popup menu label="Move to project…" title="Move to another project" icon="project">
      {choices.length === 0 ? <p className="muted">There is no other project on this server yet. Make one on the Projects page first.</p> : (
        <ActionForm action={moveServiceAction} submit="Move" busy="Moving…">
          <input type="hidden" name="id" value={club.id} />
          <p className="muted small">It joins the other project&apos;s private network and leaves this one&apos;s, without restarting. Services left behind can no longer reach it by name.</p>
          <div className="field"><label htmlFor={`move-${club.id}`}>Project</label>
            <select id={`move-${club.id}`} name="projectId">{choices.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}</select></div>
        </ActionForm>
      )}
    </Popup>
  )
}
