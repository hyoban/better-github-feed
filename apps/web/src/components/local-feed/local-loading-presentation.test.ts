import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { describe, it } from 'vite-plus/test'

const localUiSources = [
  '../detail-panel/activity-detail-loader.tsx',
  '../feed/activity-list.tsx',
  '../feed/filter-builder-dialog.tsx',
  '../feed/filter-rules-list.tsx',
  '../sidebar/follow-list.tsx',
  '../user-menu.tsx',
  './local-first-account.tsx',
] as const

const localLoadingMarkers = [
  '<Spinner',
  '<Skeleton',
  'animate-pulse',
  'Opening local',
  'Loading filters',
  'Loading older activity',
  "? 'Saving...'",
  "? 'Deleting...'",
  "? 'Deleting…'",
  "? 'Locking…'",
] as const

describe('local loading presentation', () => {
  it('does not render loading indicators for local operations', () => {
    for (const relativePath of localUiSources) {
      const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8')
      for (const marker of localLoadingMarkers) {
        assert.equal(source.includes(marker), false, `${relativePath} contains ${marker}`)
      }
    }
  })
})
