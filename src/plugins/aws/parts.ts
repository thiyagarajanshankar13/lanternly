import type { PluginParts } from '../types'
import { AwsSettings } from './components/AwsSettings'
import { AwsServerDelete, AwsServerNote, AwsServersFooter, AwsServersNotices, AwsServersToolbar, awsServersBusy, madeHere } from './components/ServersParts'

/** Lightsail on the Servers page, and the plugin's settings page. */
export const awsParts: PluginParts = {
  servers: {
    Toolbar: AwsServersToolbar,
    Notices: AwsServersNotices,
    busy: awsServersBusy,
    owns: madeHere,
    Note: AwsServerNote,
    Danger: AwsServerDelete,
    Footer: AwsServersFooter,
  },
  Settings: AwsSettings,
}
