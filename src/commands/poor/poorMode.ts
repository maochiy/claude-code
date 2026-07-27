/**
 * Poor mode state — when active, skips extract_memories and prompt_suggestion
 * to reduce token consumption.
 *
 * Persisted to settings.json so it survives session restarts.
 */

import {
  readPoorModeSetting,
  writePoorModeSetting,
} from './poorModeSettings.js'

let poorModeActive: boolean | null = null

export function isPoorModeActive(): boolean {
  if (poorModeActive === null) {
    poorModeActive = readPoorModeSetting()
  }
  return poorModeActive
}

export function setPoorMode(active: boolean): void {
  poorModeActive = active
  writePoorModeSetting(active)
}
