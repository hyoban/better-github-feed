import assert from 'node:assert/strict'

import { describe, it } from 'vite-plus/test'

import {
  activateVerifiedLocalAccount,
  advanceAccountDeletionIntent,
  createMemoryAccountGenerationPort,
  runBoundedDatabaseDelete,
} from '../../local-feed'

import {
  canReuseVerifiedRemoteAccount,
  createLoginIntent,
  activeAccountFallbackAfterVerificationFailure,
  decideAccountBoot,
  fenceAccountForLock,
  hasMatchingLoginIntent,
  persistLoginIntent,
  requireNumericGithubId,
  recoveryIdentityMatches,
  remoteAttentionForOfflineOpen,
  runSignOutSequence,
  SingleFlightByKey,
} from './account-bootstrap'

describe('account bootstrap', () => {
  it('reuses a verified remote account across session refetches for the same auth user', () => {
    const ready = {
      ownerGithubId: '38493346',
      generation: 2,
      nonce: 'generation-nonce',
      remoteBinding: { verifiedSessionUserId: 'auth-user' },
    }
    const active = {
      ownerGithubId: '38493346',
      generation: 2,
      nonce: 'generation-nonce',
    }

    assert.equal(
      canReuseVerifiedRemoteAccount({
        ready,
        active,
        sessionUserId: 'auth-user',
        deletingOwnerGithubId: null,
        explicitAuthIntent: false,
      }),
      true,
    )
    assert.equal(
      canReuseVerifiedRemoteAccount({
        ready,
        active,
        sessionUserId: 'different-auth-user',
        deletingOwnerGithubId: null,
        explicitAuthIntent: false,
      }),
      false,
    )
    assert.equal(
      canReuseVerifiedRemoteAccount({
        ready,
        active: { ...active, generation: 3 },
        sessionUserId: 'auth-user',
        deletingOwnerGithubId: null,
        explicitAuthIntent: false,
      }),
      false,
    )
    assert.equal(
      canReuseVerifiedRemoteAccount({
        ready,
        active,
        sessionUserId: 'auth-user',
        deletingOwnerGithubId: null,
        explicitAuthIntent: true,
      }),
      false,
    )
    assert.equal(
      canReuseVerifiedRemoteAccount({
        ready,
        active,
        sessionUserId: 'auth-user',
        deletingOwnerGithubId: 'pending-deletion',
        explicitAuthIntent: false,
      }),
      false,
    )
  })

  it('requires an exact, fresh, tab-local OAuth intent match', () => {
    const intent = createLoginIntent(1_000, 'nonce')
    assert.equal(hasMatchingLoginIntent(intent, intent, 1_500, 1_000), true)
    assert.equal(hasMatchingLoginIntent(intent, '1000:forged', 1_500, 1_000), false)
    assert.equal(hasMatchingLoginIntent(null, intent, 1_500, 1_000), false)
    assert.equal(hasMatchingLoginIntent(intent, intent, 2_000, 1_000), false)
    assert.throws(() =>
      persistLoginIntent(
        {
          setItem() {
            throw new Error('storage denied')
          },
        },
        'intent',
        intent,
      ),
    )
  })

  it('opens a verified active account while offline without waiting for the session request', () => {
    assert.deepEqual(
      decideAccountBoot({
        session: 'pending',
        online: false,
        activeOwnerGithubId: '38493346',
        lockedOwnerGithubId: null,
        deletingOwnerGithubId: null,
      }),
      { kind: 'open-active', ownerGithubId: '38493346' },
    )
  })

  it('does not expose an active database while an online session is still unresolved', () => {
    assert.deepEqual(
      decideAccountBoot({
        session: 'pending',
        online: true,
        activeOwnerGithubId: '38493346',
        lockedOwnerGithubId: null,
        deletingOwnerGithubId: null,
      }),
      { kind: 'wait-for-session' },
    )
  })

  it('never opens a locked account before online identity verification', () => {
    assert.deepEqual(
      decideAccountBoot({
        session: 'unavailable',
        online: false,
        activeOwnerGithubId: null,
        lockedOwnerGithubId: '38493346',
        deletingOwnerGithubId: null,
      }),
      { kind: 'locked', ownerGithubId: '38493346' },
    )
  })

  it('keeps an active local account readable when its online session naturally expires', () => {
    assert.deepEqual(
      decideAccountBoot({
        session: 'signed-out',
        online: true,
        activeOwnerGithubId: '38493346',
        lockedOwnerGithubId: null,
        deletingOwnerGithubId: null,
      }),
      { kind: 'open-active', ownerGithubId: '38493346' },
    )
  })

  it('marks an online expired-session fallback as recoverable without locking local data', () => {
    assert.equal(remoteAttentionForOfflineOpen('signed-out', true), 'reauth-required')
    assert.equal(remoteAttentionForOfflineOpen('signed-out', false), null)
    assert.equal(remoteAttentionForOfflineOpen('unavailable', true), null)
  })

  it('keeps a known active local account readable when online identity verification is unavailable', () => {
    assert.deepEqual(activeAccountFallbackAfterVerificationFailure('38493346'), {
      kind: 'open-active',
      ownerGithubId: '38493346',
    })
    assert.equal(activeAccountFallbackAfterVerificationFailure(null), null)
  })

  it('prioritizes completing a deletion over authentication', () => {
    assert.deepEqual(
      decideAccountBoot({
        session: 'authenticated',
        online: true,
        activeOwnerGithubId: null,
        lockedOwnerGithubId: null,
        deletingOwnerGithubId: '38493346',
      }),
      { kind: 'retry-deletion', ownerGithubId: '38493346' },
    )
  })

  it('does not let a stale authenticated cookie undo a cross-tab account lock', () => {
    assert.deepEqual(
      decideAccountBoot({
        session: 'authenticated',
        online: true,
        activeOwnerGithubId: null,
        lockedOwnerGithubId: '38493346',
        deletingOwnerGithubId: null,
        explicitAuthIntent: false,
      }),
      { kind: 'locked', ownerGithubId: '38493346' },
    )
    assert.deepEqual(
      decideAccountBoot({
        session: 'authenticated',
        online: true,
        activeOwnerGithubId: null,
        lockedOwnerGithubId: '38493346',
        deletingOwnerGithubId: null,
        explicitAuthIntent: true,
      }),
      { kind: 'verify-session' },
    )
  })

  it('accepts only numeric GitHub account IDs from the manifest', () => {
    assert.equal(requireNumericGithubId('38493346'), '38493346')
    assert.throws(() => requireNumericGithubId('github:38493346'))
    assert.throws(() => requireNumericGithubId('0'))
  })

  it('resumes an attention-halted sync only after the same numeric owner is verified', () => {
    assert.equal(recoveryIdentityMatches('38493346', '38493346'), true)
    assert.equal(recoveryIdentityMatches('38493346', '2'), false)
    assert.equal(recoveryIdentityMatches(null, '2'), true)
  })
})

describe('account lifecycle ordering', () => {
  it('uses a ready feed to write the inner and outer lock fence', async () => {
    const events: string[] = []
    const result = await fenceAccountForLock({
      readyFeed: {
        close: async reason => {
          assert.deepEqual(reason, { kind: 'sign-out', localData: 'retain-locked' })
          events.push('feed-fence')
          return { kind: 'retained-locked' }
        },
      },
      advanceRegistryLocked: async () => {
        events.push('registry-only-fence')
      },
    })

    assert.equal(result, 'feed')
    assert.deepEqual(events, ['feed-fence'])
  })

  it('uses the registry fence when no ready feed can write the database fence', async () => {
    const events: string[] = []
    const result = await fenceAccountForLock({
      readyFeed: null,
      advanceRegistryLocked: async () => {
        events.push('registry-only-fence')
      },
    })

    assert.equal(result, 'registry')
    assert.deepEqual(events, ['registry-only-fence'])
  })

  it('exclusively fences account A when switching to B and advances A again on return', async () => {
    const generations = createMemoryAccountGenerationPort()
    const firstA = await activateVerifiedLocalAccount(generations, '1', {
      expectedActive: null,
      explicitAuthIntent: true,
    })
    const accountB = await activateVerifiedLocalAccount(generations, '2', {
      expectedActive: firstA,
      explicitAuthIntent: true,
    })

    assert.equal((await generations.read('1'))?.state, 'locked')
    assert.equal((await generations.readActive())?.ownerGithubId, '2')
    assert.equal(await generations.isCurrent(firstA), false)

    const secondA = await activateVerifiedLocalAccount(generations, '1', {
      expectedActive: accountB,
      explicitAuthIntent: true,
    })
    assert.equal((await generations.read('2'))?.state, 'locked')
    assert.equal((await generations.readActive())?.ownerGithubId, '1')
    assert.ok(secondA.generation > firstA.generation)
    assert.equal(await generations.isCurrent(accountB), false)
  })

  it('bounds a blocked database deletion without claiming it succeeded', async () => {
    assert.equal(await runBoundedDatabaseDelete(async () => undefined, 0), 'deleted')
    assert.equal(await runBoundedDatabaseDelete(() => new Promise(() => {}), 0), 'pending')
  })

  it('reuses the same open promise and retries after a rejected open', async () => {
    const flights = new SingleFlightByKey<object>()
    let opens = 0
    const factory = async () => {
      opens += 1
      return {}
    }

    const first = flights.get('38493346:1', factory)
    const second = flights.get('38493346:1', factory)
    assert.equal(first, second)
    await first
    assert.equal(opens, 1)
    await flights.get('38493346:1', factory)
    assert.equal(opens, 2)

    const failure = flights.get('other', async () => {
      throw new Error('open failed')
    })
    await assert.rejects(failure)
    await flights.get('other', factory)
    assert.equal(opens, 3)
  })

  it('finishes the local fence and cache cleanup before remote sign out', async () => {
    const events: string[] = []
    const result = await runSignOutSequence({
      localData: 'delete',
      closeLocalFeed: async () => {
        events.push('close')
        return { kind: 'deletion-pending' }
      },
      readLocalState: async () => 'deleting',
      clearLegacyCache: async () => {
        events.push('legacy-cache')
      },
      fenceAccountMedia: async () => undefined,
      clearAccountMedia: async () => {
        events.push('media-cache')
      },
      markDeletionPending: async () => {
        events.push('mark-deletion-pending')
      },
      completeDeletion: async () => {
        events.push('complete-deletion')
      },
      remoteSignOut: async () => {
        events.push('remote-sign-out')
      },
    })

    assert.deepEqual(result.closeResult, { kind: 'deletion-pending' })
    assert.equal(result.closeError, null)
    assert.equal(events[0], 'close')
    assert.equal(events.at(-1), 'remote-sign-out')
    assert.deepEqual(new Set(events.slice(1, -1)), new Set(['legacy-cache', 'media-cache']))
  })

  it('keeps the deleting fence until every local namespace is removed', async () => {
    const generations = createMemoryAccountGenerationPort()
    const initial = await generations.initialize('38493346')
    const events: string[] = []
    const result = await runSignOutSequence({
      localData: 'delete',
      closeLocalFeed: async () => {
        await generations.advance(initial, 'deleting')
        events.push('dexie-deleted')
        return { kind: 'deleted' }
      },
      readLocalState: async () => (await generations.read('38493346'))?.state ?? null,
      clearLegacyCache: async () => {
        events.push('legacy-cache')
      },
      fenceAccountMedia: async () => undefined,
      clearAccountMedia: async () => {
        events.push('media-cache')
      },
      markDeletionPending: async () => {
        events.push('mark-deletion-pending')
      },
      completeDeletion: async () => {
        const deleting = await generations.read('38493346')
        assert.equal(deleting?.state, 'deleting')
        assert.ok(deleting)
        await generations.advance(deleting, 'signed-out')
        events.push('complete-deletion')
      },
      remoteSignOut: async () => {
        events.push('remote-sign-out')
      },
    })

    assert.equal(result.fencedState, 'signed-out')
    assert.equal((await generations.read('38493346'))?.state, 'signed-out')
    assert.equal(events[0], 'dexie-deleted')
    assert.ok(events.indexOf('legacy-cache') < events.indexOf('complete-deletion'))
    assert.ok(events.indexOf('media-cache') < events.indexOf('complete-deletion'))
    assert.ok(events.indexOf('complete-deletion') < events.indexOf('remote-sign-out'))
  })

  it('retains account media only for the explicit locked sign-out path', async () => {
    const events: string[] = []
    await runSignOutSequence({
      localData: 'retain-locked',
      closeLocalFeed: async () => ({ kind: 'retained-locked' }),
      readLocalState: async () => 'locked',
      clearLegacyCache: async () => {
        events.push('legacy-cache')
      },
      fenceAccountMedia: async () => {
        events.push('media-fence')
      },
      clearAccountMedia: async () => {
        events.push('media-cache')
      },
      markDeletionPending: async () => {
        events.push('mark-deletion-pending')
      },
      completeDeletion: async () => {
        events.push('complete-deletion')
      },
      remoteSignOut: async () => {
        events.push('remote-sign-out')
      },
    })

    assert.deepEqual(new Set(events.slice(0, -1)), new Set(['legacy-cache', 'media-fence']))
    assert.equal(events.at(-1), 'remote-sign-out')
  })

  it('keeps retained data locked when legacy cache cleanup needs a retry', async () => {
    const events: string[] = []
    const result = await runSignOutSequence({
      localData: 'retain-locked',
      closeLocalFeed: async () => ({ kind: 'retained-locked' }),
      readLocalState: async () => 'locked',
      clearLegacyCache: async () => {
        events.push('legacy-cache')
        throw new Error('legacy cache is blocked')
      },
      fenceAccountMedia: async () => {
        events.push('media-fence')
      },
      clearAccountMedia: async () => {
        events.push('media-cache')
      },
      markDeletionPending: async () => {
        events.push('mark-deletion-pending')
      },
      completeDeletion: async () => {
        events.push('complete-deletion')
      },
      remoteSignOut: async () => {
        events.push('remote-sign-out')
      },
    })

    assert.equal(result.legacyCleanupError?.message, 'legacy cache is blocked')
    assert.equal(result.deletionStateError, null)
    assert.deepEqual(new Set(events.slice(0, -1)), new Set(['legacy-cache', 'media-fence']))
    assert.equal(events.at(-1), 'remote-sign-out')
  })

  it('finishes a fenced partial sign-out even when closing Dexie throws', async () => {
    const events: string[] = []
    const result = await runSignOutSequence({
      localData: 'delete',
      closeLocalFeed: async () => {
        events.push('close')
        throw new Error('blocked after fence')
      },
      readLocalState: async () => {
        events.push('read-state')
        return 'deleting'
      },
      clearLegacyCache: async () => {
        events.push('legacy-cache')
      },
      fenceAccountMedia: async () => undefined,
      clearAccountMedia: async () => {
        events.push('media-cache')
      },
      markDeletionPending: async () => {
        events.push('mark-deletion-pending')
      },
      completeDeletion: async () => {
        events.push('complete-deletion')
      },
      remoteSignOut: async () => {
        events.push('remote-sign-out')
      },
    })

    assert.equal(result.closeResult, null)
    assert.equal(result.closeError?.message, 'blocked after fence')
    assert.equal(result.fencedState, 'deleting')
    assert.equal(events[0], 'close')
    assert.equal(events[1], 'read-state')
    assert.equal(events.at(-1), 'remote-sign-out')
  })

  it('reapplies deletion after a concurrent retained lock invalidates the closing feed', async () => {
    const generations = createMemoryAccountGenerationPort()
    const active = await generations.initialize('38493346')
    await generations.advance(active, 'locked')

    const result = await runSignOutSequence({
      localData: 'delete',
      closeLocalFeed: async () => {
        throw new Error('the retained lock won first')
      },
      readLocalState: async () => (await generations.read('38493346'))?.state ?? null,
      clearLegacyCache: async () => undefined,
      fenceAccountMedia: async () => undefined,
      clearAccountMedia: async () => undefined,
      markDeletionPending: async () => {
        await advanceAccountDeletionIntent(generations, '38493346')
      },
      completeDeletion: async () => undefined,
      remoteSignOut: async () => undefined,
    })

    assert.equal(result.closeError?.message, 'the retained lock won first')
    assert.equal(result.fencedState, 'deleting')
    assert.equal((await generations.read('38493346'))?.state, 'deleting')
  })

  it('does not clear or remotely sign out before the external fence exists', async () => {
    const events: string[] = []
    const result = await runSignOutSequence({
      localData: 'delete',
      closeLocalFeed: async () => {
        events.push('close')
        throw new Error('fence write failed')
      },
      readLocalState: async () => 'active',
      clearLegacyCache: async () => {
        events.push('legacy-cache')
      },
      fenceAccountMedia: async () => undefined,
      clearAccountMedia: async () => {
        events.push('media-cache')
      },
      markDeletionPending: async () => {
        events.push('mark-deletion-pending')
      },
      completeDeletion: async () => {
        events.push('complete-deletion')
      },
      remoteSignOut: async () => {
        events.push('remote-sign-out')
      },
    })

    assert.equal(result.fencedState, 'active')
    assert.deepEqual(events, ['close'])
  })

  it('keeps the same deleting generation when media cleanup fails', async () => {
    const generations = createMemoryAccountGenerationPort()
    const initial = await generations.initialize('38493346')
    const events: string[] = []
    let deletingGeneration = -1

    const result = await runSignOutSequence({
      localData: 'delete',
      closeLocalFeed: async () => {
        const deleting = await generations.advance(initial, 'deleting')
        deletingGeneration = deleting.generation
        events.push('close')
        return { kind: 'deleted' }
      },
      readLocalState: async () => (await generations.read('38493346'))?.state ?? null,
      clearLegacyCache: async () => {
        events.push('legacy-cache')
      },
      fenceAccountMedia: async () => undefined,
      clearAccountMedia: async () => {
        events.push('media-cache')
        throw new Error('service worker acknowledgement timed out')
      },
      markDeletionPending: async () => {
        events.push('mark-deletion-pending')
        const expected = await generations.read('38493346')
        assert.ok(expected)
        await generations.advance(expected, 'deleting')
      },
      completeDeletion: async () => {
        events.push('complete-deletion')
      },
      remoteSignOut: async () => {
        events.push('remote-sign-out')
      },
    })

    const pending = await generations.read('38493346')
    assert.equal(result.closeResult?.kind, 'deleted')
    assert.equal(result.mediaCleanupError?.message, 'service worker acknowledgement timed out')
    assert.equal(result.fencedState, 'deleting')
    assert.equal(pending?.state, 'deleting')
    assert.equal(pending?.generation, deletingGeneration)
    assert.ok(deletingGeneration > initial.generation)
    assert.equal(events.includes('complete-deletion'), false)
    assert.equal(events.includes('remote-sign-out'), false)
    assert.ok(events.indexOf('mark-deletion-pending') > events.indexOf('media-cache'))
  })

  it('does not report a retained account as secured or sign out remotely before media ACK', async () => {
    const events: string[] = []
    const result = await runSignOutSequence({
      localData: 'retain-locked',
      closeLocalFeed: async () => ({ kind: 'retained-locked' }),
      readLocalState: async () => 'locked',
      clearLegacyCache: async () => undefined,
      fenceAccountMedia: async () => {
        events.push('media-fence')
        throw new Error('media fence ACK timed out')
      },
      clearAccountMedia: async () => undefined,
      markDeletionPending: async () => undefined,
      completeDeletion: async () => undefined,
      remoteSignOut: async () => {
        events.push('remote-sign-out')
      },
    })

    assert.equal(result.fencedState, 'locked')
    assert.equal(result.mediaFenceError?.message, 'media fence ACK timed out')
    assert.deepEqual(events, ['media-fence'])
  })

  it('keeps default sign-out deletion pending when the legacy cache is blocked', async () => {
    const generations = createMemoryAccountGenerationPort()
    const initial = await generations.initialize('38493346')
    const result = await runSignOutSequence({
      localData: 'delete',
      closeLocalFeed: async () => {
        await generations.advance(initial, 'deleting')
        return { kind: 'deleted' }
      },
      readLocalState: async () => (await generations.read('38493346'))?.state ?? null,
      clearLegacyCache: async () => {
        throw new Error('legacy cache deletion is blocked')
      },
      fenceAccountMedia: async () => undefined,
      clearAccountMedia: async () => undefined,
      markDeletionPending: async () => {
        const expected = await generations.read('38493346')
        assert.ok(expected)
        await generations.advance(expected, 'deleting')
      },
      completeDeletion: async () => undefined,
      remoteSignOut: async () => undefined,
    })

    assert.equal(result.legacyCleanupError?.message, 'legacy cache deletion is blocked')
    assert.equal(result.fencedState, 'deleting')
    assert.equal((await generations.read('38493346'))?.state, 'deleting')
  })
})
