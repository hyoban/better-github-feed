export type AccountLifecycleState = 'active' | 'deleting' | 'locked' | 'signed-out'

export type AccountGeneration = {
  ownerGithubId: string
  generation: number
  nonce: string
  state: AccountLifecycleState
}

export type AccountActivation = {
  account: AccountGeneration
  /** Generations advanced by this activation and therefore fenced in other tabs. */
  changedAccounts: readonly AccountGeneration[]
}

export type VerifiedAccountActivation = {
  expectedActive: AccountGeneration | null
  explicitAuthIntent: boolean
}

export type AccountRegistryState = {
  activeOwnerGithubId: string | null
  nextGeneration: number
  accounts: Record<string, AccountGeneration>
}

export interface AccountRegistryTransactionPort {
  read<T>(operation: (registry: Readonly<AccountRegistryState>) => T): Promise<T>
  mutate<T>(operation: (registry: AccountRegistryState) => T): Promise<T>
  subscribe(listener: () => void): () => void
}

export interface AccountGenerationPort {
  read(ownerGithubId: string): Promise<AccountGeneration | null>
  list(): Promise<readonly AccountGeneration[]>
  readActive(): Promise<AccountGeneration | null>
  initialize(ownerGithubId: string): Promise<AccountGeneration>
  activateExclusive(ownerGithubId: string): Promise<AccountActivation>
  activateVerified(
    ownerGithubId: string,
    proof: VerifiedAccountActivation,
  ): Promise<AccountActivation>
  advance(expected: AccountGeneration, state: AccountLifecycleState): Promise<AccountGeneration>
  isCurrent(expected: AccountGeneration): Promise<boolean>
  subscribe(listener: () => void): () => void
}

export class StaleAccountGenerationError extends Error {
  constructor() {
    super('The local account generation is no longer current')
    this.name = 'StaleAccountGenerationError'
  }
}

export class AccountActivationRejectedError extends Error {
  constructor(readonly reason: 'account-mismatch' | 'unlock-required' | 'deletion-pending') {
    super(`Verified account activation rejected: ${reason}`)
    this.name = 'AccountActivationRejectedError'
  }
}

/**
 * Persist an explicit deletion intent against the latest owner generation.
 * A concurrent lock, retained sign-out, or account switch can invalidate the
 * generation held by the initiating tab, so each stale CAS is retried.
 */
export async function advanceAccountDeletionIntent(
  generations: AccountGenerationPort,
  ownerGithubId: string,
): Promise<AccountGeneration> {
  for (;;) {
    const current = await generations.read(ownerGithubId)
    if (!current) throw new StaleAccountGenerationError()
    if (current.state === 'deleting' || current.state === 'signed-out') return current
    try {
      return await generations.advance(current, 'deleting')
    } catch (error) {
      if (!(error instanceof StaleAccountGenerationError)) throw error
    }
  }
}

/** Persist a lock intent without weakening a concurrent deletion or sign-out. */
export async function advanceAccountLockIntent(
  generations: AccountGenerationPort,
  ownerGithubId: string,
): Promise<AccountGeneration> {
  for (;;) {
    const current = await generations.read(ownerGithubId)
    if (!current) throw new StaleAccountGenerationError()
    if (current.state !== 'active') return current
    try {
      return await generations.advance(current, 'locked')
    } catch (error) {
      if (!(error instanceof StaleAccountGenerationError)) throw error
    }
  }
}

function emptyRegistry(): AccountRegistryState {
  return { activeOwnerGithubId: null, nextGeneration: 0, accounts: {} }
}

function cloneRegistry(registry: AccountRegistryState): AccountRegistryState {
  return {
    activeOwnerGithubId: registry.activeOwnerGithubId,
    nextGeneration: registry.nextGeneration,
    accounts: Object.fromEntries(
      Object.entries(registry.accounts).map(([ownerGithubId, account]) => [
        ownerGithubId,
        { ...account },
      ]),
    ),
  }
}

export function accountRegistryStatesEqual(
  left: Readonly<AccountRegistryState>,
  right: Readonly<AccountRegistryState>,
) {
  if (
    left.activeOwnerGithubId !== right.activeOwnerGithubId ||
    left.nextGeneration !== right.nextGeneration
  ) {
    return false
  }
  const owners = new Set([...Object.keys(left.accounts), ...Object.keys(right.accounts)])
  for (const ownerGithubId of owners) {
    const leftAccount = left.accounts[ownerGithubId]
    const rightAccount = right.accounts[ownerGithubId]
    if (
      leftAccount?.ownerGithubId !== rightAccount?.ownerGithubId ||
      leftAccount?.generation !== rightAccount?.generation ||
      leftAccount?.nonce !== rightAccount?.nonce ||
      leftAccount?.state !== rightAccount?.state
    ) {
      return false
    }
  }
  return true
}

function allocateGeneration(
  registry: AccountRegistryState,
  ownerGithubId: string,
  state: AccountLifecycleState,
  createNonce: () => string,
): AccountGeneration {
  if (!Number.isSafeInteger(registry.nextGeneration) || registry.nextGeneration < 0) {
    throw new Error('The local account generation registry is exhausted')
  }
  const account = {
    ownerGithubId,
    generation: registry.nextGeneration,
    nonce: createNonce(),
    state,
  }
  registry.nextGeneration += 1
  return account
}

function activateRegistry(
  registry: AccountRegistryState,
  ownerGithubId: string,
  createNonce: () => string,
): AccountActivation {
  const target = registry.accounts[ownerGithubId]
  const activeAccounts = Object.values(registry.accounts).filter(
    account => account.state === 'active',
  )
  if (
    registry.activeOwnerGithubId === ownerGithubId &&
    target?.state === 'active' &&
    activeAccounts.length === 1 &&
    activeAccounts[0]?.ownerGithubId === ownerGithubId
  ) {
    return { account: target, changedAccounts: [] }
  }

  const changedAccounts: AccountGeneration[] = []
  for (const account of activeAccounts) {
    if (account.ownerGithubId === ownerGithubId) continue
    const locked = allocateGeneration(registry, account.ownerGithubId, 'locked', createNonce)
    registry.accounts[account.ownerGithubId] = locked
    changedAccounts.push(locked)
  }

  const activated = allocateGeneration(registry, ownerGithubId, 'active', createNonce)
  registry.accounts[ownerGithubId] = activated
  registry.activeOwnerGithubId = ownerGithubId
  changedAccounts.push(activated)
  return { account: activated, changedAccounts }
}

function accountGenerationMatches(
  current: AccountGeneration | undefined,
  expected: AccountGeneration,
) {
  return (
    current?.ownerGithubId === expected.ownerGithubId &&
    current.generation === expected.generation &&
    current.nonce === expected.nonce &&
    current.state === expected.state
  )
}

function activateVerifiedRegistry(
  registry: AccountRegistryState,
  ownerGithubId: string,
  proof: VerifiedAccountActivation,
  createNonce: () => string,
) {
  const activeAccounts = Object.values(registry.accounts).filter(
    account => account.state === 'active',
  )
  if (proof.expectedActive) {
    const expected = proof.expectedActive
    if (
      expected.state !== 'active' ||
      registry.activeOwnerGithubId !== expected.ownerGithubId ||
      activeAccounts.length !== 1 ||
      !accountGenerationMatches(registry.accounts[expected.ownerGithubId], expected)
    ) {
      throw new StaleAccountGenerationError()
    }
    if (ownerGithubId !== expected.ownerGithubId && !proof.explicitAuthIntent) {
      throw new AccountActivationRejectedError('account-mismatch')
    }
  } else if (registry.activeOwnerGithubId !== null || activeAccounts.length !== 0) {
    throw new StaleAccountGenerationError()
  }

  const target = registry.accounts[ownerGithubId]
  if (target?.state === 'deleting') {
    throw new AccountActivationRejectedError('deletion-pending')
  }
  if (target && target.state !== 'active' && !proof.explicitAuthIntent) {
    throw new AccountActivationRejectedError('unlock-required')
  }
  return activateRegistry(registry, ownerGithubId, createNonce)
}

export function createTransactionalAccountGenerationPort(
  transactions: AccountRegistryTransactionPort,
  createNonce: () => string = createAccountGenerationNonce,
): AccountGenerationPort {
  return {
    async read(ownerGithubId) {
      return transactions.read(registry => registry.accounts[ownerGithubId] ?? null)
    },
    async list() {
      return transactions.read(registry => Object.values(registry.accounts))
    },
    async readActive() {
      return transactions.read(registry => {
        if (!registry.activeOwnerGithubId) return null
        const account = registry.accounts[registry.activeOwnerGithubId] ?? null
        return account?.state === 'active' ? account : null
      })
    },
    async initialize(ownerGithubId) {
      return transactions.mutate(registry => {
        const current = registry.accounts[ownerGithubId]
        if (current) return current
        return activateRegistry(registry, ownerGithubId, createNonce).account
      })
    },
    async activateExclusive(ownerGithubId) {
      return transactions.mutate(registry => activateRegistry(registry, ownerGithubId, createNonce))
    },
    async activateVerified(ownerGithubId, proof) {
      return transactions.mutate(registry =>
        activateVerifiedRegistry(registry, ownerGithubId, proof, createNonce),
      )
    },
    async advance(expected, state) {
      return transactions.mutate(registry => {
        const current = registry.accounts[expected.ownerGithubId]
        if (!current || !accountGenerationMatches(current, expected)) {
          throw new StaleAccountGenerationError()
        }
        if (current.state === state) return current
        if (state === 'active')
          return activateRegistry(registry, expected.ownerGithubId, createNonce).account
        const advanced = allocateGeneration(registry, expected.ownerGithubId, state, createNonce)
        registry.accounts[expected.ownerGithubId] = advanced
        if (registry.activeOwnerGithubId === expected.ownerGithubId) {
          registry.activeOwnerGithubId = null
        }
        return advanced
      })
    },
    async isCurrent(expected) {
      return transactions.read(registry => {
        const current = registry.accounts[expected.ownerGithubId]
        return (
          current?.generation === expected.generation &&
          current.nonce === expected.nonce &&
          current.ownerGithubId === expected.ownerGithubId &&
          current.state === expected.state
        )
      })
    },
    subscribe(listener) {
      return transactions.subscribe(listener)
    },
  }
}

export function createMemoryAccountRegistryTransactionPort(
  initial: AccountRegistryState = emptyRegistry(),
): AccountRegistryTransactionPort {
  let registry = cloneRegistry(initial)
  let queue = Promise.resolve()
  const listeners = new Set<() => void>()

  return {
    read(operation) {
      return queue.then(() => operation(cloneRegistry(registry)))
    },
    mutate(operation) {
      const result = queue.then(() => {
        const draft = cloneRegistry(registry)
        const value = operation(draft)
        if (!accountRegistryStatesEqual(registry, draft)) {
          registry = draft
          for (const listener of listeners) listener()
        }
        return value
      })
      queue = result.then(
        () => undefined,
        () => undefined,
      )
      return result
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export function createMemoryAccountGenerationPort(): AccountGenerationPort {
  return createTransactionalAccountGenerationPort(createMemoryAccountRegistryTransactionPort())
}

type StoredRegistry = { key: 'global'; value: AccountRegistryState }

type LegacyRegistry = {
  activeOwnerGithubId?: unknown
  accounts?: Record<string, Partial<AccountGeneration>>
}

export type IndexedDbAccountGenerationOptions = {
  databaseName?: string
  legacyStorage?: Pick<Storage, 'getItem'>
  legacyKey?: string
  createNonce?: () => string
}

const ACCOUNT_REGISTRY_STORE = 'registry'
const ACCOUNT_REGISTRY_RECORD_KEY = 'global'

function createAccountGenerationNonce(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('')
}

export function migrateLegacyAccountRegistry(
  storage: Pick<Storage, 'getItem'> | undefined,
  key: string | undefined,
  createNonce: () => string,
): AccountRegistryState {
  if (!storage || !key) return emptyRegistry()
  let parsed: LegacyRegistry
  try {
    const raw = storage.getItem(key)
    if (!raw) return emptyRegistry()
    parsed = JSON.parse(raw) as LegacyRegistry
  } catch {
    return emptyRegistry()
  }

  const candidates = Object.entries(parsed.accounts ?? {})
    .filter(
      ([ownerGithubId, account]) =>
        /^[1-9]\d*$/.test(ownerGithubId) &&
        account &&
        ['active', 'deleting', 'locked', 'signed-out'].includes(account.state ?? ''),
    )
    .sort(([leftOwner, left], [rightOwner, right]) => {
      const generationDifference = (left.generation ?? -1) - (right.generation ?? -1)
      return generationDifference || leftOwner.localeCompare(rightOwner)
    })

  const requestedActiveOwner =
    typeof parsed.activeOwnerGithubId === 'string' ? parsed.activeOwnerGithubId : null
  const activeOwnerGithubId = candidates.some(
    ([ownerGithubId, account]) =>
      ownerGithubId === requestedActiveOwner && account.state === 'active',
  )
    ? requestedActiveOwner
    : (candidates.find(([, account]) => account.state === 'active')?.[0] ?? null)
  const registry = emptyRegistry()
  for (const [ownerGithubId, account] of candidates) {
    const state =
      account.state === 'active' && ownerGithubId !== activeOwnerGithubId
        ? 'locked'
        : (account.state as AccountLifecycleState)
    registry.accounts[ownerGithubId] = allocateGeneration(
      registry,
      ownerGithubId,
      state,
      createNonce,
    )
  }
  registry.activeOwnerGithubId = activeOwnerGithubId
  return registry
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result), { once: true })
    request.addEventListener('error', () => reject(request.error), { once: true })
  })
}

function transactionCompletion(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve(), { once: true })
    transaction.addEventListener('abort', () => reject(transaction.error), { once: true })
    transaction.addEventListener('error', () => reject(transaction.error), { once: true })
  })
}

export function createIndexedDbAccountGenerationPort(
  factory: IDBFactory = globalThis.indexedDB,
  options: IndexedDbAccountGenerationOptions = {},
): AccountGenerationPort {
  if (!factory) throw new Error('IndexedDB is required for the local account registry')
  const databaseName = options.databaseName ?? 'better-github-feed:account-registry:v1'
  const createNonce = options.createNonce ?? createAccountGenerationNonce
  const seed = () =>
    migrateLegacyAccountRegistry(options.legacyStorage, options.legacyKey, createNonce)
  const listeners = new Set<() => void>()
  const channel =
    typeof BroadcastChannel === 'function' ? new BroadcastChannel(`${databaseName}:changes`) : null
  channel?.addEventListener('message', () => {
    for (const listener of listeners) listener()
  })

  const database = new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(databaseName, 1)
    request.addEventListener(
      'upgradeneeded',
      () => {
        const store = request.result.createObjectStore(ACCOUNT_REGISTRY_STORE, { keyPath: 'key' })
        const initial: StoredRegistry = { key: ACCOUNT_REGISTRY_RECORD_KEY, value: seed() }
        store.put(initial)
      },
      { once: true },
    )
    request.addEventListener('success', () => resolve(request.result), { once: true })
    request.addEventListener('error', () => reject(request.error), { once: true })
    request.addEventListener(
      'blocked',
      () => reject(new Error('Account registry upgrade blocked')),
      {
        once: true,
      },
    )
  })

  async function readStoredRegistry(mode: IDBTransactionMode): Promise<{
    transaction: IDBTransaction
    store: IDBObjectStore
    registry: AccountRegistryState
  }> {
    const db = await database
    const transaction = db.transaction(ACCOUNT_REGISTRY_STORE, mode, { durability: 'strict' })
    const store = transaction.objectStore(ACCOUNT_REGISTRY_STORE)
    const stored = await requestResult(
      store.get(ACCOUNT_REGISTRY_RECORD_KEY) as IDBRequest<StoredRegistry | undefined>,
    )
    if (stored) return { transaction, store, registry: stored.value }
    if (mode !== 'readwrite') {
      transaction.abort()
      throw new Error('The local account registry record is missing')
    }
    return { transaction, store, registry: seed() }
  }

  const transactions: AccountRegistryTransactionPort = {
    async read(operation) {
      const { transaction, registry } = await readStoredRegistry('readonly')
      const result = operation(cloneRegistry(registry))
      await transactionCompletion(transaction)
      return result
    },
    async mutate<T>(operation: (registry: AccountRegistryState) => T) {
      const { transaction, store, registry } = await readStoredRegistry('readwrite')
      let result: T
      let changed = false
      try {
        const draft = cloneRegistry(registry)
        result = operation(draft)
        changed = !accountRegistryStatesEqual(registry, draft)
        if (changed) {
          const stored: StoredRegistry = { key: ACCOUNT_REGISTRY_RECORD_KEY, value: draft }
          store.put(stored)
        }
      } catch (error) {
        transaction.abort()
        throw error
      }
      await transactionCompletion(transaction)
      if (changed) channel?.postMessage({ kind: 'account-registry-changed' })
      return result
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }

  return createTransactionalAccountGenerationPort(transactions, createNonce)
}

export async function readOfflineActiveAccount(
  generations: AccountGenerationPort,
): Promise<AccountGeneration | null> {
  return generations.readActive()
}

export async function readPendingAccountDeletions(
  generations: AccountGenerationPort,
): Promise<readonly AccountGeneration[]> {
  return (await generations.list()).filter(account => account.state === 'deleting')
}
