import { describe, expect, it } from 'vite-plus/test'

import { signedOutFeed } from './signed-out-feed'

describe('signedOutFeed', () => {
  it('exposes ready empty projections so the application layout can render', () => {
    const following = signedOutFeed.observe({ kind: 'following', sort: 'latest' }).getSnapshot()
    const activity = signedOutFeed
      .observe({
        kind: 'visible-feed',
        view: { actors: 'following', types: 'all' },
        first: 40,
      })
      .getSnapshot()
    const status = signedOutFeed.observe({ kind: 'sync-status' }).getSnapshot()

    expect(following).toMatchObject({ kind: 'ready', value: { items: [] } })
    expect(activity).toMatchObject({ kind: 'ready', value: { items: [] } })
    expect(status).toMatchObject({
      kind: 'ready',
      value: { kind: 'quiet', pendingUserOperations: 0 },
    })
  })

  it('does not accept local mutations while signed out', async () => {
    await expect(signedOutFeed.commit({ kind: 'feed.clear' })).rejects.toThrow(
      'Sign in with GitHub',
    )
  })
})
