import {
  getInitialSettings,
  updateSettingsForSource,
} from '../../utils/settings/settings.js'

export function readPoorModeSetting(): boolean {
  return getInitialSettings().poorMode === true
}

export function writePoorModeSetting(active: boolean): void {
  updateSettingsForSource('userSettings', {
    poorMode: active || undefined,
  })
}
