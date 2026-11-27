'use client'

import Link from 'next/link'
import { useState } from 'react'
import { Icon, type IconName } from './Icon'

/**
 * The body of a project's "New service" pane. It opens on one question (what to add);
 * site, GitHub app and Docker image go to their own setup pages, the database form opens
 * here as a second step with a way back. The pane remounts this on every open, so it
 * always starts on the list.
 */
export function NewServicePicker({ pluginChoices = [], githubHref, imageHref, databases, storages = [], storageForm, children }: {
  /** Service kinds of the plugins that are on, that this person may add (owners only). Shown under "From plugins". */
  pluginChoices?: { href: string; icon: IconName; title: string; text: string; from: string }[]
  githubHref: string
  imageHref: string
  /** Names of the project's existing databases. */
  databases: string[]
  /** Names of the project's existing S3 storages. */
  storages?: string[]
  /** The storage form, shown on the second step. */
  storageForm?: React.ReactNode
  /** The database form, shown on the second step. */
  children: React.ReactNode
}) {
  const [step, setStep] = useState<'pick' | 'database' | 'storage'>('pick')

  if (step === 'storage') {
    return (
      <div className="svc-step">
        <button type="button" className="svc-back" onClick={() => setStep('pick')}><Icon name="back" size={16} /> All service types</button>
        <div className="svc-title">
          <span className="svc-icon data"><Icon name="bucket" size={20} /></span>
          <div>
            <h3>New S3 storage</h3>
            <p>Its own MinIO server. Files stay on this project&apos;s server and are backed up like a site.</p>
          </div>
        </div>
        {storages.length > 0 && (
          <div className="notice warn">
            This project already has {storages.length === 1 ? <span className="mono">{storages[0]}</span> : `${storages.length} storages`}. Apps can share it, each with its own bucket: add a bucket on its page. Add another storage only when you want separate files and keys.
          </div>
        )}
        {storageForm}
      </div>
    )
  }

  if (step === 'database') {
    return (
      <div className="svc-step">
        <button type="button" className="svc-back" onClick={() => setStep('pick')}><Icon name="back" size={16} /> All service types</button>
        <div className="svc-title">
          <span className="svc-icon data"><Icon name="db" size={20} /></span>
          <div>
            <h3>New PostgreSQL database</h3>
            <p>Its own container, backed up every day like a site.</p>
          </div>
        </div>
        {databases.length > 0 && (
          <div className="notice warn">
            This project already has {databases.length === 1 ? <span className="mono">{databases[0]}</span> : `${databases.length} databases`}. Several apps can share {databases.length === 1 ? 'it' : 'one'}: tick it under Databases in each app&apos;s settings. Add another only when you want separate data.
          </div>
        )}
        {children}
      </div>
    )
  }

  return (
    <div className="svc-pick">
      <p className="svc-group">Run something</p>
      <Choice href={githubHref} icon="rocket" title="App from GitHub" text="Any repo and branch with a Dockerfile. It can use this project's databases." />
      <Choice href={imageHref} icon="box" title="Docker image" text="A ready-made image from Docker Hub or another registry, like nginx or redis." />
      <p className="svc-group">Store data</p>
      <button type="button" className="svc-choice" onClick={() => setStep('database')}>
        <span className="svc-icon data"><Icon name="db" size={20} /></span>
        <span className="svc-text">
          <strong>PostgreSQL database</strong>
          <span>{databases.length ? 'Add another database for separate data. Apps can share the one you have.' : 'Its own container and data, reachable only inside this project.'}</span>
          {databases.length > 0 && (
            <span className="svc-has"><span className="dot" />Already has {databases.length === 1 ? <span className="mono">{databases[0]}</span> : `${databases.length} databases`}</span>
          )}
        </span>
        <Icon name="next" size={16} />
      </button>
      {storageForm && (
        <button type="button" className="svc-choice" onClick={() => setStep('storage')}>
          <span className="svc-icon data"><Icon name="bucket" size={20} /></span>
          <span className="svc-text">
            <strong>S3 storage <span className="muted" style={{ fontWeight: 500 }}>(MinIO)</span></strong>
            <span>Buckets for files, images and uploads. Works with any AWS S3 library.</span>
            {storages.length > 0 && (
              <span className="svc-has"><span className="dot" />Already has {storages.length === 1 ? <span className="mono">{storages[0]}</span> : `${storages.length} storages`}</span>
            )}
          </span>
          <Icon name="next" size={16} />
        </button>
      )}
      {pluginChoices.length > 0 && (
        <>
          <p className="svc-group">From plugins</p>
          {pluginChoices.map((c) => <Choice key={c.href} {...c} />)}
        </>
      )}
    </div>
  )
}

function Choice({ href, icon, title, text, from }: { href: string; icon: IconName; title: string; text: string; from?: string }) {
  return (
    <Link className={from ? 'svc-choice plugin' : 'svc-choice'} href={href}>
      <span className="svc-icon"><Icon name={icon} size={20} /></span>
      <span className="svc-text"><strong>{title}</strong><span>{text}</span>{from && <span className="svc-from">{from}</span>}</span>
      <span className="svc-go">Setup page <Icon name="next" size={16} /></span>
    </Link>
  )
}
