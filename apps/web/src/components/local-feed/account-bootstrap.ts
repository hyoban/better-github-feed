import type { AccountLifecycleState, CloseResult, LocalFeed } from '@/local-feed'

export type SessionResolution = 'pending' | 'authenticated' | 'signed-out' | 'unavailable'

export function createLoginIntent(createdAt: number, nonce: string) {
  if (!Number.isSafeInteger(createdAt) || createdAt < 0 || nonce.length < 1 || nonce.length > 200) {
    throw new Error('Invalid local login intent')
  }
  return `${createdAt}:${nonce}`
}

export function hasMatchingLoginIntent(
  storedIntent: string | null,
  callbackIntent: string | null,
  now: number,
  ttlMs: number,
) {
  if (!storedIntent || storedIntent !== callbackIntent) return false
  const separator = storedIntent.indexOf(':')
  if (separator < 1 || separator === storedIntent.length - 1) return false
  const createdAt = Number(storedIntent.slice(0, separator))
  const age = now - createdAt
  return Number.isSafeInteger(createdAt) && age >= 0 && age < ttlMs
}

export function persistLoginIntent(storage: Pick<Storage, 'setItem'>, key: string, intent: string) {
  storage.setItem(key, intent)
  return intent
}

export type AccountBootDecision =
  | { kind: 'retry-deletion'; ownerGithubId: string }
  | { kind: 'verify-session' }
  | { kind: 'open-active'; ownerGithubId: string }
  | { kind: 'lock-active'; ownerGithubId: string }
  | { kind: 'locked'; ownerGithubId: string }
  | { kind: 'wait-for-session' }
  | { kind: 'signed-out' }

export function decideAccountBoot(input: {
  session: SessionResolution
  online: boolean
  activeOwnerGithubId: string | null
  lockedOwnerGithubId: string | null
  deletingOwnerGithubId: string | null
  signedOutOwnerGithubId?: string | null
  explicitAuthIntent?: boolean
}): AccountBootDecision {
  if (input.deletingOwnerGithubId) {
    return { kind: 'retry-deletion', ownerGithubId: input.deletingOwnerGithubId }
  }
  if (
    input.session === 'authenticated' &&
    !input.activeOwnerGithubId &&
    !input.explicitAuthIntent
  ) {
    if (input.lockedOwnerGithubId) {
      return { kind: 'locked', ownerGithubId: input.lockedOwnerGithubId }
    }
    if (input.signedOutOwnerGithubId) return { kind: 'signed-out' }
  }
  if (input.session === 'authenticated') return { kind: 'verify-session' }
  if (
    input.activeOwnerGithubId &&
    (input.session === 'unavailable' || input.session === 'signed-out' || !input.online)
  ) {
    return { kind: 'open-active', ownerGithubId: input.activeOwnerGithubId }
  }
  if (input.session === 'pending') return { kind: 'wait-for-session' }
  if (input.activeOwnerGithubId) {
    return { kind: 'lock-active', ownerGithubId: input.activeOwnerGithubId }
  }
  if (input.lockedOwnerGithubId) {
    return { kind: 'locked', ownerGithubId: input.lockedOwnerGithubId }
  }
  return { kind: 'signed-out' }
}

export function requireNumericGithubId(value: string): string {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error('The sync gateway returned an invalid GitHub account ID')
  }
  return value
}

export function recoveryIdentityMatches(
  expectedOwnerGithubId: string | null,
  verifiedOwnerGithubId: string,
) {
  return expectedOwnerGithubId === null || expectedOwnerGithubId === verifiedOwnerGithubId
}

export function remoteAttentionForOfflineOpen(
  session: SessionResolution,
  online: boolean,
): 'reauth-required' | null {
  return online && session === 'signed-out' ? 'reauth-required' : null
}

export function activeAccountFallbackAfterVerificationFailure(
  activeOwnerGithubId: string | null,
): AccountBootDecision | null {
  return activeOwnerGithubId ? { kind: 'open-active', ownerGithubId: activeOwnerGithubId } : null
}

export class SingleFlightByKey<T> {
  readonly #inFlight = new Map<string, Promise<T>>()

  get(key: string, factory: () => Promise<T>): Promise<T> {
    const current = this.#inFlight.get(key)
    if (current) return current

    const created = factory().finally(() => {
      if (this.#inFlight.get(key) === created) this.#inFlight.delete(key)
    })
    this.#inFlight.set(key, created)
    return created
  }

  forget(key: string): void {
    this.#inFlight.delete(key)
  }
}

export async function fenceAccountForLock(input: {
  readyFeed: Pick<LocalFeed, 'close'> | null
  advanceRegistryLocked: () => Promise<unknown>
}): Promise<'feed' | 'registry'> {
  if (input.readyFeed) {
    await input.readyFeed.close({ kind: 'sign-out', localData: 'retain-locked' })
    return 'feed'
  }

  await input.advanceRegistryLocked()
  return 'registry'
}

export async function runSignOutSequence(input: {
  localData: 'delete' | 'retain-locked'
  closeLocalFeed: () => Promise<CloseResult>
  readLocalState: () => Promise<AccountLifecycleState | null>
  clearLegacyCache: () => Promise<void>
  fenceAccountMedia: () => Promise<void>
  clearAccountMedia: () => Promise<void>
  markDeletionPending: () => Promise<void>
  completeDeletion: () => Promise<void>
  remoteSignOut: () => Promise<void>
}): Promise<{
  closeResult: CloseResult | null
  closeError: Error | null
  fencedState: AccountLifecycleState | null
  legacyCleanupError: Error | null
  mediaFenceError: Error | null
  mediaCleanupError: Error | null
  deletionStateError: Error | null
  remoteSignOutError: Error | null
}> {
  let closeResult: CloseResult | null = null
  let closeError: Error | null = null
  let fencedState: AccountLifecycleState | null = null
  try {
    closeResult = await input.closeLocalFeed()
    try {
      fencedState = await input.readLocalState()
    } catch {
      fencedState = null
    }
  } catch (cause) {
    closeError = cause instanceof Error ? cause : new Error(String(cause))
    try {
      fencedState = await input.readLocalState()
    } catch {
      fencedState = null
    }
  }

  if (closeError && (fencedState === null || fencedState === 'active')) {
    return {
      closeResult,
      closeError,
      fencedState,
      legacyCleanupError: null,
      mediaFenceError: null,
      mediaCleanupError: null,
      deletionStateError: null,
      remoteSignOutError: null,
    }
  }

  let deletionStateError: Error | null = null
  if (input.localData === 'delete' && fencedState === 'locked') {
    try {
      await input.markDeletionPending()
      fencedState = 'deleting'
    } catch (cause) {
      deletionStateError = cause instanceof Error ? cause : new Error(String(cause))
    }
  }

  const cleanup = [
    Promise.resolve().then(input.clearLegacyCache),
    Promise.resolve().then(
      input.localData === 'delete' ? input.clearAccountMedia : input.fenceAccountMedia,
    ),
  ]
  const cleanupResults = await Promise.allSettled(cleanup)
  const legacyResult = cleanupResults[0]
  const mediaResult = cleanupResults[1]
  const legacyCleanupError =
    legacyResult?.status === 'rejected'
      ? legacyResult.reason instanceof Error
        ? legacyResult.reason
        : new Error(String(legacyResult.reason))
      : null
  const mediaError =
    mediaResult?.status === 'rejected'
      ? mediaResult.reason instanceof Error
        ? mediaResult.reason
        : new Error(String(mediaResult.reason))
      : null
  const mediaFenceError = input.localData === 'retain-locked' ? mediaError : null
  const mediaCleanupError = input.localData === 'delete' ? mediaError : null
  if (input.localData === 'delete' && (legacyCleanupError || mediaCleanupError)) {
    try {
      await input.markDeletionPending()
      fencedState = 'deleting'
      deletionStateError = null
    } catch (cause) {
      deletionStateError = cause instanceof Error ? cause : new Error(String(cause))
    }
  } else if (input.localData === 'delete' && closeResult?.kind === 'deleted') {
    try {
      await input.completeDeletion()
      fencedState = 'signed-out'
    } catch (cause) {
      deletionStateError = cause instanceof Error ? cause : new Error(String(cause))
      try {
        fencedState = await input.readLocalState()
      } catch {
        fencedState = null
      }
    }
  }
  let remoteSignOutError: Error | null = null
  if (!mediaError) {
    try {
      await input.remoteSignOut()
    } catch (cause) {
      remoteSignOutError = cause instanceof Error ? cause : new Error(String(cause))
    }
  }
  return {
    closeResult,
    closeError,
    fencedState,
    legacyCleanupError,
    mediaFenceError,
    mediaCleanupError,
    deletionStateError,
    remoteSignOutError,
  }
}
