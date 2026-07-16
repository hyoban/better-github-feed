import assert from 'node:assert/strict'

import { describe, it } from 'vite-plus/test'

import {
  AccountActivationRejectedError,
  advanceAccountDeletionIntent,
  advanceAccountLockIntent,
  createMemoryAccountRegistryTransactionPort,
  createTransactionalAccountGenerationPort,
  migrateLegacyAccountRegistry,
  StaleAccountGenerationError,
} from './account-generation'

describe('transactional account generation registry', () => {
  it('reapplies an explicit deletion intent after a concurrent lock generation wins', async () => {
    const base = createTransactionalAccountGenerationPort(
      createMemoryAccountRegistryTransactionPort(),
    )
    const active = await base.initialize('1')
    let lockedGeneration = -1
    let injectLockRace = true
    const generations = {
      ...base,
      async advance(expected: typeof active, state: typeof active.state) {
        if (injectLockRace && state === 'deleting') {
          injectLockRace = false
          const locked = await base.advance(expected, 'locked')
          lockedGeneration = locked.generation
        }
        return base.advance(expected, state)
      },
    }

    const deleting = await advanceAccountDeletionIntent(generations, '1')

    assert.equal(deleting.state, 'deleting')
    assert.ok(deleting.generation > lockedGeneration)
    assert.deepEqual(await generations.read('1'), deleting)
  })

  it('does not weaken deletion when a concurrent lock intent arrives', async () => {
    const generations = createTransactionalAccountGenerationPort(
      createMemoryAccountRegistryTransactionPort(),
    )
    const active = await generations.initialize('1')
    const deleting = await generations.advance(active, 'deleting')

    assert.deepEqual(await advanceAccountLockIntent(generations, '1'), deleting)
    assert.deepEqual(await generations.read('1'), deleting)
  })

  it('serializes concurrent account switches and never reuses a generation or nonce', async () => {
    const registry = createMemoryAccountRegistryTransactionPort()
    let nonce = 0
    const firstTab = createTransactionalAccountGenerationPort(registry, () => `nonce-${nonce++}`)
    const secondTab = createTransactionalAccountGenerationPort(registry, () => `nonce-${nonce++}`)

    const [firstA, accountB, secondA] = await Promise.all([
      firstTab.activateExclusive('1'),
      secondTab.activateExclusive('2'),
      firstTab.activateExclusive('1'),
    ])

    const accounts = await registry.read(value => Object.values(value.accounts))
    assert.equal(accounts.filter(account => account.state === 'active').length, 1)
    assert.equal((await firstTab.readActive())?.ownerGithubId, '1')

    const changed = [
      ...firstA.changedAccounts,
      ...accountB.changedAccounts,
      ...secondA.changedAccounts,
    ]
    assert.equal(new Set(changed.map(account => account.generation)).size, changed.length)
    assert.equal(new Set(changed.map(account => account.nonce)).size, changed.length)
    assert.equal(await secondTab.isCurrent(firstA.account), false)
    assert.equal(await secondTab.isCurrent(secondA.account), true)
  })

  it('migrates overlapping localStorage generations into one unique global sequence', () => {
    let nonce = 0
    const registry = migrateLegacyAccountRegistry(
      {
        getItem: () =>
          JSON.stringify({
            activeOwnerGithubId: '2',
            accounts: {
              '1': { ownerGithubId: '1', generation: 0, state: 'active' },
              '2': { ownerGithubId: '2', generation: 0, state: 'active' },
            },
          }),
      },
      'legacy',
      () => `migrated-${nonce++}`,
    )

    assert.equal(registry.activeOwnerGithubId, '2')
    assert.equal(registry.accounts['1']?.state, 'locked')
    assert.equal(registry.accounts['2']?.state, 'active')
    assert.deepEqual(
      Object.values(registry.accounts).map(account => [account.generation, account.nonce]),
      [
        [0, 'migrated-0'],
        [1, 'migrated-1'],
      ],
    )
    assert.equal(registry.nextGeneration, 2)
  })

  it('does not announce a no-op activation of the current account', async () => {
    const registry = createMemoryAccountRegistryTransactionPort()
    const generations = createTransactionalAccountGenerationPort(registry, () => 'stable-nonce')
    let notifications = 0
    registry.subscribe(() => {
      notifications += 1
    })

    const first = await generations.activateExclusive('1')
    const repeated = await generations.activateExclusive('1')

    assert.equal(notifications, 1)
    assert.deepEqual(repeated.account, first.account)
    assert.deepEqual(repeated.changedAccounts, [])
  })

  it('rejects a verification captured before another tab changed the active generation', async () => {
    const registry = createMemoryAccountRegistryTransactionPort()
    let nonce = 0
    const firstTab = createTransactionalAccountGenerationPort(registry, () => `nonce-${nonce++}`)
    const secondTab = createTransactionalAccountGenerationPort(registry, () => `nonce-${nonce++}`)
    const captured = (await firstTab.activateExclusive('1')).account

    await secondTab.activateExclusive('2')

    await assert.rejects(
      firstTab.activateVerified('1', {
        expectedActive: captured,
        explicitAuthIntent: false,
      }),
      StaleAccountGenerationError,
    )
    assert.equal((await firstTab.readActive())?.ownerGithubId, '2')
  })

  it('does not let a stale close overwrite a newer explicit activation', async () => {
    const registry = createMemoryAccountRegistryTransactionPort()
    let nonce = 0
    const generations = createTransactionalAccountGenerationPort(registry, () => `nonce-${nonce++}`)
    const oldAccount = (await generations.activateExclusive('1')).account
    const newerAccount = (
      await generations.activateVerified('1', {
        expectedActive: oldAccount,
        explicitAuthIntent: true,
      })
    ).account

    assert.deepEqual(newerAccount, oldAccount)
    const locked = await generations.advance(newerAccount, 'locked')
    const reactivated = (
      await generations.activateVerified('1', {
        expectedActive: null,
        explicitAuthIntent: true,
      })
    ).account

    await assert.rejects(generations.advance(locked, 'signed-out'), StaleAccountGenerationError)
    assert.deepEqual(await generations.readActive(), reactivated)
  })

  it('requires explicit authorization to unlock and never reactivates pending deletion', async () => {
    const registry = createMemoryAccountRegistryTransactionPort()
    let nonce = 0
    const generations = createTransactionalAccountGenerationPort(registry, () => `nonce-${nonce++}`)
    const active = (await generations.activateExclusive('1')).account
    const locked = await generations.advance(active, 'locked')

    await assert.rejects(
      generations.activateVerified('1', {
        expectedActive: null,
        explicitAuthIntent: false,
      }),
      (error: unknown) =>
        error instanceof AccountActivationRejectedError && error.reason === 'unlock-required',
    )
    const reactivated = (
      await generations.activateVerified('1', {
        expectedActive: null,
        explicitAuthIntent: true,
      })
    ).account
    const deleting = await generations.advance(reactivated, 'deleting')

    await assert.rejects(
      generations.activateVerified('1', {
        expectedActive: null,
        explicitAuthIntent: true,
      }),
      (error: unknown) =>
        error instanceof AccountActivationRejectedError && error.reason === 'deletion-pending',
    )
    assert.deepEqual(await generations.read('1'), deleting)
    assert.notDeepEqual(locked, reactivated)
  })
})
