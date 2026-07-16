import DOMPurify from 'dompurify'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { LocalFeedProvider } from '@/hooks/use-local-feed'
import { authClient } from '@/lib/auth-client'
import {
  activateVerifiedLocalAccount,
  advanceAccountDeletionIntent,
  advanceAccountLockIntent,
  AccountActivationRejectedError,
  createIndexedDbAccountGenerationPort,
  openLocalFeed,
  runBoundedDatabaseDelete,
  StaleAccountGenerationError,
} from '@/local-feed'
import type { AccountGeneration, AccountGenerationPort, LocalFeed } from '@/local-feed'
import { createOrpcCloudReplicaPort } from '@/local-feed/orpc-cloud-replica'
import { databaseNameForOwner, LocalFeedDatabase } from '@/local-feed/database'
import { clearPersistedCache, client } from '@/utils/orpc'

import {
  activeAccountFallbackAfterVerificationFailure,
  canReuseVerifiedRemoteAccount,
  createLoginIntent,
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

const ACCOUNT_REGISTRY_KEY = 'better-github-feed:local-accounts:v1'
const LOGIN_INTENT_STORAGE_KEY = 'better-github-feed:explicit-login-intent:v1'
const LOGIN_RECOVERY_OWNER_STORAGE_KEY = 'better-github-feed:recovery-owner:v1'
const LOGIN_INTENT_PARAM = 'localLoginIntent'
const LOGIN_INTENT_TTL_MS = 15 * 60 * 1000
const MEDIA_CACHE_PREFIX = 'better-github-feed-media-v1:'
const MEDIA_METADATA_CACHE_PREFIX = 'better-github-feed-media-metadata-v1:'
const MEDIA_CONTEXT_CACHE = 'better-github-feed-media-context-v1'
const MEDIA_CONTEXT_PATH = '/__better_github_feed_media_context__/'
const MEDIA_FENCE_PATH = '/__better_github_feed_media_fence__/'
const EXPECTED_SIGN_OUT_OWNER_HEADER = 'x-better-github-feed-owner'
const EXPECTED_SIGN_OUT_SESSION_HEADER = 'x-better-github-feed-session'

const feedFlights = new SingleFlightByKey<LocalFeed>()
let accountGenerations: AccountGenerationPort | null = null
let legacyCacheCutover: Promise<void> | null = null

function getAccountGenerations() {
  accountGenerations ??= createIndexedDbAccountGenerationPort(window.indexedDB, {
    legacyStorage: window.localStorage,
    legacyKey: ACCOUNT_REGISTRY_KEY,
  })
  return accountGenerations
}

function clearLegacyCacheAfterCutover() {
  legacyCacheCutover ??= clearPersistedCache().catch(error => {
    legacyCacheCutover = null
    throw error
  })
  return legacyCacheCutover
}

function feedFlightKey(
  account: Pick<AccountGeneration, 'ownerGithubId' | 'generation' | 'nonce'>,
  remoteEnabled: boolean,
) {
  return `${account.ownerGithubId}:${account.generation}:${account.nonce}:${remoteEnabled ? 'remote' : 'offline'}`
}

function mediaCacheNames(ownerGithubId: string) {
  const suffix = encodeURIComponent(ownerGithubId)
  return [`${MEDIA_CACHE_PREFIX}${suffix}`, `${MEDIA_METADATA_CACHE_PREFIX}${suffix}`]
}

type MediaAccountBinding = Pick<AccountGeneration, 'ownerGithubId' | 'generation' | 'nonce'>

type RemoteSignOutProof = {
  ownerGithubId: string
  sessionId: string
  sessionToken: string
}

type MediaFenceRecord = MediaAccountBinding & {
  kind: 'account-fence'
  state: 'active' | 'fenced'
}

type AuthoritativeMediaFence = Omit<MediaFenceRecord, 'state'> & {
  state: MediaFenceRecord['state'] | 'conflict'
}

function sameMediaAccount(left: Partial<MediaAccountBinding> | null, right: MediaAccountBinding) {
  return (
    left?.ownerGithubId === right.ownerGithubId &&
    left?.generation === right.generation &&
    left?.nonce === right.nonce
  )
}

function mediaFenceRequest(account: MediaAccountBinding, state: MediaFenceRecord['state']) {
  const suffix = [
    encodeURIComponent(account.ownerGithubId),
    account.generation,
    encodeURIComponent(account.nonce),
    state,
  ].join('/')
  return new Request(new URL(`${MEDIA_FENCE_PATH}${suffix}`, window.location.origin))
}

async function readAuthoritativeMediaFence(
  cache: Cache,
  ownerGithubId: string,
): Promise<AuthoritativeMediaFence | null> {
  const legacyPath = new URL(
    `${MEDIA_FENCE_PATH}${encodeURIComponent(ownerGithubId)}`,
    window.location.origin,
  ).pathname
  const prefix = `${legacyPath}/`
  const keys = (await cache.keys()).filter(request => {
    const path = new URL(request.url).pathname
    return path === legacyPath || path.startsWith(prefix)
  })
  const records = await Promise.all(
    keys.map(async key => {
      try {
        const candidate = (await (await cache.match(key))?.json()) as Partial<MediaFenceRecord>
        return candidate.kind === 'account-fence' &&
          (candidate.state === 'active' || candidate.state === 'fenced') &&
          candidate.ownerGithubId === ownerGithubId &&
          Number.isSafeInteger(candidate.generation) &&
          typeof candidate.nonce === 'string'
          ? (candidate as MediaFenceRecord)
          : null
      } catch {
        return null
      }
    }),
  )
  let current: AuthoritativeMediaFence | null = null
  for (const record of records) {
    if (!record) continue
    if (!current || record.generation > current.generation) {
      current = record
      continue
    }
    if (record.generation !== current.generation) continue
    if (record.nonce !== current.nonce) {
      current = { ...record, nonce: '', state: 'conflict' }
    } else if (current.state !== 'conflict' && record.state === 'fenced') {
      current = record
    }
  }
  return current
}

function postServiceWorkerMessage(message: unknown) {
  if (!('serviceWorker' in navigator)) return
  const controller = navigator.serviceWorker.controller
  if (controller) {
    controller.postMessage(message)
    return
  }
  void navigator.serviceWorker.ready.then(registration => {
    registration.active?.postMessage(message)
  })
}

function setMediaAccount(account: MediaAccountBinding | null) {
  postServiceWorkerMessage({
    type: 'SET_MEDIA_ACCOUNT',
    ownerGithubId: account?.ownerGithubId ?? null,
    generation: account?.generation,
    nonce: account?.nonce,
  })
}

async function requestServiceWorkerCleanup(message: unknown): Promise<boolean> {
  if (!('serviceWorker' in navigator)) return false
  const registration = await navigator.serviceWorker.getRegistration()
  const worker = navigator.serviceWorker.controller ?? registration?.active
  if (!worker) return false

  await new Promise<void>((resolve, reject) => {
    const messages = new MessageChannel()
    let settled = false
    let timeout: number | undefined
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      if (timeout !== undefined) window.clearTimeout(timeout)
      messages.port1.close()
      if (error) reject(error)
      else resolve()
    }
    timeout = window.setTimeout(
      () => finish(new Error('Service worker media deletion acknowledgement timed out')),
      1500,
    )
    messages.port1.addEventListener(
      'message',
      event => {
        if (event.data?.ok === true) finish()
        else finish(new Error('Service worker rejected media deletion'))
      },
      { once: true },
    )
    messages.port1.start()
    try {
      worker.postMessage(message, [messages.port2])
    } catch (cause) {
      finish(toError(cause))
    }
  })
  return true
}

async function withinMediaFenceTimeout<T>(operation: Promise<T>, message: string): Promise<T> {
  let timeout: number | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = window.setTimeout(() => reject(new Error(message)), 1500)
      }),
    ])
  } finally {
    if (timeout !== undefined) window.clearTimeout(timeout)
  }
}

async function deleteAccountMediaWithoutWorker(account: MediaAccountBinding) {
  if (!('caches' in window)) return true
  const { ownerGithubId } = account
  if (!(await fenceAccountMediaWithoutWorker(account))) return false
  const contexts = await window.caches.open(MEDIA_CONTEXT_CACHE)
  const keys = await contexts.keys()
  await Promise.all(
    keys.map(async request => {
      if (!new URL(request.url).pathname.startsWith(MEDIA_CONTEXT_PATH)) return
      try {
        const record = (await (await contexts.match(request))?.json()) as
          | Partial<MediaAccountBinding>
          | undefined
        if (
          record?.ownerGithubId === ownerGithubId &&
          typeof record.generation === 'number' &&
          record.generation <= account.generation
        ) {
          await contexts.delete(request)
        }
      } catch {
        await contexts.delete(request)
      }
    }),
  )
  await Promise.all(mediaCacheNames(ownerGithubId).map(name => window.caches.delete(name)))
  return true
}

async function fenceAccountMediaWithoutWorker(account: MediaAccountBinding) {
  if (!('caches' in window)) return true
  const contexts = await window.caches.open(MEDIA_CONTEXT_CACHE)
  const currentFence = await readAuthoritativeMediaFence(contexts, account.ownerGithubId)
  if (
    typeof currentFence?.generation === 'number' &&
    (currentFence.generation > account.generation ||
      (currentFence.generation === account.generation && currentFence.nonce !== account.nonce))
  ) {
    return false
  }
  await contexts.put(
    mediaFenceRequest(account, 'fenced'),
    new Response(JSON.stringify({ kind: 'account-fence', state: 'fenced', ...account }), {
      headers: { 'content-type': 'application/json' },
    }),
  )
  const persistedFence = await readAuthoritativeMediaFence(contexts, account.ownerGithubId)
  if (persistedFence?.state !== 'fenced' || !sameMediaAccount(persistedFence, account)) return false

  const legacyPath = new URL(
    `${MEDIA_FENCE_PATH}${encodeURIComponent(account.ownerGithubId)}`,
    window.location.origin,
  ).pathname
  const prefix = `${legacyPath}/`
  const keys = await contexts.keys()
  await Promise.allSettled(
    keys.map(async request => {
      const path = new URL(request.url).pathname
      if (path !== legacyPath && !path.startsWith(prefix)) return
      try {
        const record = (await (await contexts.match(request))?.json()) as Partial<MediaFenceRecord>
        if (
          !Number.isSafeInteger(record.generation) ||
          Number(record.generation) < account.generation
        ) {
          await contexts.delete(request)
        }
      } catch {
        await contexts.delete(request)
      }
    }),
  )
  return true
}

async function fenceAccountMedia(account: MediaAccountBinding) {
  const handledByWorker = await withinMediaFenceTimeout(
    requestServiceWorkerCleanup({
      type: 'FENCE_MEDIA_ACCOUNT',
      ...account,
    }),
    'Service worker media fence acknowledgement timed out',
  )
  if (
    !handledByWorker &&
    !(await withinMediaFenceTimeout(
      fenceAccountMediaWithoutWorker(account),
      'Fallback media fence acknowledgement timed out',
    ))
  ) {
    throw new Error('Local media fencing could not acquire the current account generation')
  }
}

async function signOutExpectedRemoteAccount(proof: RemoteSignOutProof) {
  const response = await authClient.revokeSession({
    token: proof.sessionToken,
    fetchOptions: {
      headers: {
        [EXPECTED_SIGN_OUT_OWNER_HEADER]: proof.ownerGithubId,
        [EXPECTED_SIGN_OUT_SESSION_HEADER]: proof.sessionId,
      },
    },
  })
  if (response.error) throw toError(response.error)
}

async function deleteAccountMedia(account: MediaAccountBinding) {
  const handledByWorker = await withinMediaFenceTimeout(
    requestServiceWorkerCleanup({
      type: 'DELETE_MEDIA_ACCOUNT',
      ...account,
    }),
    'Service worker media deletion acknowledgement timed out',
  )
  if (
    !handledByWorker &&
    !(await withinMediaFenceTimeout(
      deleteAccountMediaWithoutWorker(account),
      'Fallback media deletion acknowledgement timed out',
    ))
  ) {
    throw new Error('Local media deletion could not acquire the current account fence')
  }
}

const atomSanitizer = {
  version: 'dompurify-html-v1',
  sanitizeHtml(html: string) {
    return DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ['base', 'embed', 'form', 'iframe', 'object', 'script', 'style'],
      FORBID_ATTR: ['srcdoc', 'style'],
    })
  },
}

type SessionProfile = {
  name: string
  email: string
}

type ReadyAccount = {
  ownerGithubId: string
  generation: number
  nonce: string
  remoteBinding: { verifiedSessionUserId: string } | null
  feed: LocalFeed
  remoteAttention?: 'reauth-required' | 'account-mismatch'
}

type AccountShellState =
  | { kind: 'opening-database' }
  | { kind: 'signing-out'; localData: 'delete' | 'retain-locked' }
  | { kind: 'deleting-local-data'; ownerGithubId: string; remoteSignOutError?: Error }
  | {
      kind: 'locked-awaiting-auth'
      ownerGithubId: string
      remoteSignOutError?: Error
      legacyCleanupError?: Error
      mediaFenceError?: Error
    }
  | { kind: 'signed-out'; remoteSignOutError?: Error }
  | { kind: 'ready'; account: ReadyAccount }
  | {
      kind: 'failed'
      issue: 'migration-failed' | 'database-unavailable' | 'identity-verification-failed'
      error: Error
      recoverableOwnerGithubId?: string
    }

type LocalFirstAccountContextValue = {
  ownerGithubId: string
  sessionProfile: SessionProfile | null
  signOut(localData?: 'delete' | 'retain-locked'): Promise<void>
  remoteAttention?: 'reauth-required' | 'account-mismatch'
  recoverRemoteSync(): Promise<void>
}

const LocalFirstAccountContext = createContext<LocalFirstAccountContextValue | null>(null)

export function useLocalFirstAccount() {
  const value = useContext(LocalFirstAccountContext)
  if (!value) throw new Error('useLocalFirstAccount must be used within LocalFirstAccountBoundary')
  return value
}

function toError(cause: unknown) {
  return cause instanceof Error ? cause : new Error(String(cause))
}

function databaseFailure(
  cause: unknown,
  recoverableOwnerGithubId?: string,
): Extract<AccountShellState, { kind: 'failed' }> {
  const error = toError(cause)
  const migrationNames = new Set(['UpgradeError', 'VersionError'])
  return {
    kind: 'failed',
    issue: migrationNames.has(error.name) ? 'migration-failed' : 'database-unavailable',
    error,
    ...(recoverableOwnerGithubId ? { recoverableOwnerGithubId } : {}),
  }
}

async function verifyViewerGithubId() {
  const response = await client.localFeedV1.getManifest({})
  return requireNumericGithubId(
    response.kind === 'manifest' ? response.manifest.viewerGithubId : response.viewerGithubId,
  )
}

async function deletePendingAccount(generations: AccountGenerationPort, ownerGithubId: string) {
  const account = await generations.read(ownerGithubId)
  if (!account || account.state !== 'deleting') {
    throw new Error('Local account deletion lost its generation fence')
  }
  const database = new LocalFeedDatabase(databaseNameForOwner(ownerGithubId))
  try {
    const result = await runBoundedDatabaseDelete(() => database.delete())
    if (result === 'pending') {
      throw new Error('Local data deletion is still blocked by another tab')
    }
    await deleteAccountMedia(account)
    await clearPersistedCache()
    await generations.advance(account, 'signed-out')
  } finally {
    database.close()
  }
}

async function startGithubSignIn(expectedOwnerGithubId?: string) {
  const authIntent = createLoginIntent(Date.now(), crypto.randomUUID())
  try {
    persistLoginIntent(window.sessionStorage, LOGIN_INTENT_STORAGE_KEY, authIntent)
    if (expectedOwnerGithubId) {
      window.sessionStorage.setItem(LOGIN_RECOVERY_OWNER_STORAGE_KEY, expectedOwnerGithubId)
    } else {
      window.sessionStorage.removeItem(LOGIN_RECOVERY_OWNER_STORAGE_KEY)
    }
  } catch (cause) {
    throw new Error(
      'This browser blocked session storage, so a secure sign-in handoff cannot be created. Allow site storage and try again.',
      { cause },
    )
  }
  const callback = new URL(window.location.href)
  callback.searchParams.set(LOGIN_INTENT_PARAM, authIntent)
  const response = await authClient.signIn.social({
    provider: 'github',
    callbackURL: callback.href,
  })
  if (response.error) throw toError(response.error)
}

function AccountGate({
  state,
  retry,
  retryRemoteSignOut,
  recoverFailedAccount,
  switchFailedAccount,
  deleteLockedAccount,
}: {
  state: AccountShellState
  retry: () => void
  retryRemoteSignOut: () => Promise<void>
  recoverFailedAccount: (localData: 'delete' | 'retain-locked') => Promise<void>
  switchFailedAccount: () => Promise<void>
  deleteLockedAccount: (ownerGithubId: string) => Promise<void>
}) {
  const [signInError, setSignInError] = useState<Error | null>(null)
  const beginGithubSignIn = () => {
    setSignInError(null)
    void startGithubSignIn(
      state.kind === 'locked-awaiting-auth' ? state.ownerGithubId : undefined,
    ).catch(cause => setSignInError(toError(cause)))
  }
  const remoteSignOutError = 'remoteSignOutError' in state ? state.remoteSignOutError : undefined
  const remoteWarning = remoteSignOutError ? (
    <div className="space-y-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
      <p className="text-muted-foreground">
        Local data is secured, but remote sign out could not be confirmed. This account will not
        reopen without an explicit sign-in.
      </p>
      <Button variant="outline" size="sm" onClick={() => void retryRemoteSignOut()}>
        Retry remote sign out
      </Button>
    </div>
  ) : null
  if (state.kind === 'opening-database' || state.kind === 'signing-out') {
    return <main className="h-svh" aria-hidden />
  }

  if (state.kind === 'deleting-local-data') {
    return (
      <main className="grid h-svh place-items-center p-6">
        <div className="max-w-md space-y-3 text-center">
          <h1 className="font-medium">Finishing local data deletion</h1>
          <p className="text-muted-foreground">
            You are signed out. Another tab may still be closing this account database; local
            deletion is not reported as complete yet.
          </p>
          {remoteWarning}
          <Button variant="outline" onClick={() => void deleteLockedAccount(state.ownerGithubId)}>
            Retry deletion
          </Button>
        </div>
      </main>
    )
  }

  if (state.kind === 'locked-awaiting-auth') {
    const legacyWarning = state.legacyCleanupError ? (
      <div className="space-y-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
        <p className="text-muted-foreground">
          The retained database is locked, but the legacy browser cache could not be removed yet.
          Retry cleanup before leaving this device.
        </p>
        <Button variant="outline" size="sm" onClick={retry}>
          Retry legacy cache cleanup
        </Button>
      </div>
    ) : null
    const mediaWarning = state.mediaFenceError ? (
      <div className="space-y-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
        <p className="text-muted-foreground">
          The account generation is locked, but its account-wide media fence is still awaiting an
          authoritative acknowledgement. Cleanup remains retryable and remote sign out is paused.
        </p>
        <Button variant="outline" size="sm" onClick={retry}>
          Retry media fence
        </Button>
      </div>
    ) : null
    return (
      <main className="grid h-svh place-items-center p-6">
        <div className="max-w-md space-y-3 text-center">
          <h1 className="font-medium">Local feed is locked</h1>
          <p className="text-muted-foreground">
            Sign in with the same GitHub account to unlock retained local data. The database stays
            closed until the server verifies GitHub ID {state.ownerGithubId}.
          </p>
          {remoteWarning}
          {mediaWarning}
          {legacyWarning}
          {signInError ? <p className="text-destructive">{signInError.message}</p> : null}
          <Button onClick={beginGithubSignIn}>Sign in with GitHub</Button>
          <Button
            variant="destructive"
            onClick={() => void deleteLockedAccount(state.ownerGithubId)}
          >
            Delete Retained Local Data
          </Button>
        </div>
      </main>
    )
  }

  if (state.kind === 'failed') {
    const title =
      state.issue === 'migration-failed'
        ? 'Local database migration failed'
        : state.issue === 'identity-verification-failed'
          ? 'Could not verify this GitHub account'
          : 'Local database is unavailable'
    return (
      <main className="grid h-svh place-items-center p-6">
        <div className="max-w-md space-y-3 text-center">
          <h1 className="font-medium">{title}</h1>
          <p className="text-muted-foreground">{state.error.message}</p>
          <Button variant="outline" onClick={retry}>
            Try again
          </Button>
          {state.recoverableOwnerGithubId ? (
            <div className="flex flex-wrap justify-center gap-2">
              <Button variant="destructive" onClick={() => void recoverFailedAccount('delete')}>
                Delete &amp; Sign Out
              </Button>
              <Button variant="outline" onClick={() => void recoverFailedAccount('retain-locked')}>
                Keep Local Data Locked
              </Button>
              <Button variant="outline" onClick={() => void switchFailedAccount()}>
                Sign In with Another Account
              </Button>
            </div>
          ) : null}
        </div>
      </main>
    )
  }

  return (
    <main className="grid h-svh place-items-center p-6">
      <div className="space-y-3 text-center">
        <h1 className="font-medium">Better GitHub Feed</h1>
        <p className="text-muted-foreground">Sign in to create or unlock your local feed.</p>
        {remoteWarning}
        {signInError ? <p className="text-destructive">{signInError.message}</p> : null}
        <Button onClick={beginGithubSignIn}>Sign in with GitHub</Button>
      </div>
    </main>
  )
}

function useLocalFirstAccountController() {
  const {
    data: sessionData,
    error: sessionError,
    isPending: sessionIsPending,
    refetch: refetchSession,
  } = authClient.useSession()
  const [state, setState] = useState<AccountShellState>({ kind: 'opening-database' })
  const [bootAttempt, setBootAttempt] = useState(0)
  const operation = useRef(0)
  const readyAccount = useRef<ReadyAccount | null>(null)
  const desiredOpenKey = useRef<string | null>(null)
  const mounted = useRef(true)
  const pendingRemoteSignOut = useRef<RemoteSignOutProof | null>(null)
  const lastKnownOwnerGithubId = useRef<string | null>(null)
  const remoteAttention = useRef<{
    ownerGithubId: string
    issue: 'reauth-required' | 'account-mismatch'
  } | null>(null)

  const takeReadyAccount = useCallback(() => {
    const current = readyAccount.current
    if (!current) return null
    readyAccount.current = null
    desiredOpenKey.current = null
    feedFlights.forget(feedFlightKey(current, current.remoteBinding !== null))
    return current
  }, [])

  const closeReadyAccount = useCallback(
    async (kind: 'shutdown' | 'account-switch') => {
      const current = takeReadyAccount()
      if (!current) return
      await current.feed.close({ kind })
    },
    [takeReadyAccount],
  )

  const lockReadyAccount = useCallback(
    async (ownerGithubId: string, generations: AccountGenerationPort) => {
      const current = readyAccount.current
      const readyForOwner = current?.ownerGithubId === ownerGithubId ? takeReadyAccount() : null
      try {
        await fenceAccountForLock({
          readyFeed: readyForOwner?.feed ?? null,
          advanceRegistryLocked: async () => {
            await advanceAccountLockIntent(generations, ownerGithubId)
          },
        })
      } catch (error) {
        if (!(error instanceof StaleAccountGenerationError)) throw error
      }
      const fenced = await generations.read(ownerGithubId)
      if (!fenced || fenced.state === 'active') {
        return new Error('Local account lock lost its generation fence')
      }
      try {
        await fenceAccountMedia(fenced)
        return null
      } catch (cause) {
        return toError(cause)
      }
    },
    [takeReadyAccount],
  )

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      desiredOpenKey.current = null
      queueMicrotask(() => {
        if (!mounted.current) void closeReadyAccount('shutdown')
      })
    }
  }, [closeReadyAccount])

  useEffect(() => {
    const retry = () => setBootAttempt(value => value + 1)
    const onRegistryChange = async () => {
      const current = readyAccount.current
      if (current) {
        try {
          const account = await getAccountGenerations().read(current.ownerGithubId)
          if (readyAccount.current !== current) return
          if (
            account?.generation !== current.generation ||
            account.nonce !== current.nonce ||
            account.state !== 'active'
          ) {
            operation.current += 1
            setMediaAccount(null)
            if (account?.state === 'deleting') {
              setState({ kind: 'deleting-local-data', ownerGithubId: current.ownerGithubId })
            } else if (account?.state === 'locked') {
              const mediaFenceError = await lockReadyAccount(
                current.ownerGithubId,
                getAccountGenerations(),
              )
              setState({
                kind: 'locked-awaiting-auth',
                ownerGithubId: current.ownerGithubId,
                ...(mediaFenceError ? { mediaFenceError } : {}),
              })
            } else if (account?.state === 'active') {
              setState({ kind: 'opening-database' })
            } else {
              setState({ kind: 'signed-out' })
            }
            if (account?.state !== 'locked') {
              void closeReadyAccount('shutdown')
            }
          } else {
            return
          }
        } catch {
          if (readyAccount.current !== current) return
          setState({ kind: 'opening-database' })
          void closeReadyAccount('shutdown')
        }
      }
      retry()
    }
    const onOnline = () => {
      void refetchSession().finally(retry)
    }
    const onFocus = () => {
      void onRegistryChange()
      if (!readyAccount.current?.remoteBinding) void refetchSession().finally(retry)
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void onRegistryChange()
    }
    const unsubscribeRegistry = getAccountGenerations().subscribe(() => {
      void onRegistryChange()
    })
    window.addEventListener('online', onOnline)
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    const verificationInterval = window.setInterval(
      () => {
        if (
          document.visibilityState === 'visible' &&
          readyAccount.current &&
          !readyAccount.current.remoteBinding
        ) {
          void refetchSession().finally(retry)
        }
      },
      5 * 60 * 1000,
    )
    return () => {
      unsubscribeRegistry()
      window.removeEventListener('online', onOnline)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
      window.clearInterval(verificationInterval)
    }
  }, [closeReadyAccount, lockReadyAccount, refetchSession])

  useEffect(() => {
    if (state.kind !== 'ready') {
      setMediaAccount(null)
      return
    }

    setMediaAccount(state.account)
    const restoreContext = () => setMediaAccount(state.account)
    navigator.serviceWorker?.addEventListener('controllerchange', restoreContext)
    return () => navigator.serviceWorker?.removeEventListener('controllerchange', restoreContext)
  }, [state])

  useEffect(() => {
    let storedIntent: string | null = null
    try {
      storedIntent = window.sessionStorage.getItem(LOGIN_INTENT_STORAGE_KEY)
    } catch {
      // A full OAuth redirect still starts a fresh boot when session storage is unavailable.
    }
    const callbackIntent = new URL(window.location.href).searchParams.get(LOGIN_INTENT_PARAM)
    const hasExplicitAuthIntent = hasMatchingLoginIntent(
      storedIntent,
      callbackIntent,
      Date.now(),
      LOGIN_INTENT_TTL_MS,
    )
    let recoveryOwnerGithubId: string | null = null
    if (hasExplicitAuthIntent) {
      try {
        const candidate = window.sessionStorage.getItem(LOGIN_RECOVERY_OWNER_STORAGE_KEY)
        recoveryOwnerGithubId = candidate && /^[1-9]\d*$/.test(candidate) ? candidate : null
      } catch {
        recoveryOwnerGithubId = null
      }
    }
    const currentOperation = ++operation.current
    let cancelled = false
    const isCurrent = () => !cancelled && operation.current === currentOperation

    async function openAccount(
      account: AccountGeneration,
      remoteBinding: ReadyAccount['remoteBinding'],
    ) {
      if (!isCurrent()) return
      lastKnownOwnerGithubId.current = account.ownerGithubId
      const remoteEnabled = remoteBinding !== null
      const key = feedFlightKey(account, remoteEnabled)
      const current = readyAccount.current
      if (
        current?.ownerGithubId === account.ownerGithubId &&
        current.generation === account.generation &&
        current.nonce === account.nonce &&
        (current.remoteBinding !== null) === remoteEnabled
      ) {
        const rebound =
          current.remoteBinding?.verifiedSessionUserId === remoteBinding?.verifiedSessionUserId
            ? current
            : { ...current, remoteBinding }
        readyAccount.current = rebound
        setState({ kind: 'ready', account: rebound })
        return
      }

      setState({ kind: 'opening-database' })
      if (current) await closeReadyAccount('account-switch')
      desiredOpenKey.current = key
      const feed = await feedFlights.get(key, () => {
        const remoteOptions = remoteEnabled
          ? { cloud: createOrpcCloudReplicaPort(client), sanitizer: atomSanitizer }
          : {}
        return openLocalFeed({
          ownerGithubId: account.ownerGithubId,
          generations: getAccountGenerations(),
          onAccountInvalidated: () => {
            const opened = readyAccount.current
            if (
              !mounted.current ||
              (desiredOpenKey.current !== key &&
                (opened?.ownerGithubId !== account.ownerGithubId ||
                  opened.generation !== account.generation ||
                  opened.nonce !== account.nonce))
            ) {
              return
            }
            operation.current += 1
            desiredOpenKey.current = null
            setMediaAccount(null)
            setState({ kind: 'opening-database' })
            setBootAttempt(value => value + 1)
          },
          onAccountAttention: issue => {
            queueMicrotask(() => {
              const opened = readyAccount.current
              if (
                !mounted.current ||
                (desiredOpenKey.current !== key &&
                  (opened?.ownerGithubId !== account.ownerGithubId ||
                    opened.generation !== account.generation ||
                    opened.nonce !== account.nonce))
              ) {
                return
              }
              remoteAttention.current = { ownerGithubId: account.ownerGithubId, issue }
              setBootAttempt(value => value + 1)
            })
          },
          ...remoteOptions,
        })
      })

      if (!(await getAccountGenerations().isCurrent(account))) {
        feedFlights.forget(key)
        await feed.close({ kind: 'shutdown' })
        throw new Error('The local account changed while its database was opening')
      }
      if (!isCurrent()) {
        if (desiredOpenKey.current !== key || !mounted.current) {
          await feed.close({ kind: 'shutdown' })
        }
        return
      }

      const opened = {
        ownerGithubId: account.ownerGithubId,
        generation: account.generation,
        nonce: account.nonce,
        remoteBinding,
        feed,
        ...(remoteAttention.current?.ownerGithubId === account.ownerGithubId
          ? { remoteAttention: remoteAttention.current.issue }
          : {}),
      }
      readyAccount.current = opened
      setState({ kind: 'ready', account: opened })
      void clearLegacyCacheAfterCutover().catch(() => undefined)
    }

    async function boot() {
      const generations = getAccountGenerations()
      const [accounts, active] = await Promise.all([generations.list(), generations.readActive()])
      const locked = accounts.find(account => account.state === 'locked') ?? null
      const deleting = accounts.find(account => account.state === 'deleting') ?? null
      const signedOutAccount = accounts.find(account => account.state === 'signed-out') ?? null
      const retryLockedCleanup = async (account: AccountGeneration) => {
        if (account.state !== 'locked') {
          return {
            mediaFenceError: new StaleAccountGenerationError(),
            legacyCleanupError: null,
          }
        }
        let mediaFenceError: Error | null = null
        try {
          await fenceAccountMedia(account)
        } catch (cause) {
          mediaFenceError = toError(cause)
        }
        let legacyCleanupError: Error | null = null
        try {
          await clearLegacyCacheAfterCutover()
        } catch (cause) {
          legacyCleanupError = toError(cause)
        }
        return { mediaFenceError, legacyCleanupError }
      }
      if (
        remoteAttention.current &&
        active?.ownerGithubId === remoteAttention.current.ownerGithubId &&
        !hasExplicitAuthIntent
      ) {
        await openAccount(active, null)
        return
      }
      if (
        canReuseVerifiedRemoteAccount({
          ready: readyAccount.current,
          active,
          sessionUserId: sessionData?.user.id ?? null,
          deletingOwnerGithubId: deleting?.ownerGithubId ?? null,
          explicitAuthIntent: hasExplicitAuthIntent,
        })
      ) {
        return
      }
      const sessionResolution = sessionData
        ? 'authenticated'
        : sessionIsPending
          ? 'pending'
          : sessionError
            ? 'unavailable'
            : 'signed-out'
      const decision = decideAccountBoot({
        session: sessionResolution,
        online: navigator.onLine,
        activeOwnerGithubId: active?.ownerGithubId ?? null,
        lockedOwnerGithubId: locked?.ownerGithubId ?? null,
        deletingOwnerGithubId: deleting?.ownerGithubId ?? null,
        signedOutOwnerGithubId: signedOutAccount?.ownerGithubId ?? null,
        explicitAuthIntent: hasExplicitAuthIntent,
      })

      if (!isCurrent()) return
      if (decision.kind === 'wait-for-session') {
        if (!readyAccount.current) setState({ kind: 'opening-database' })
        return
      }
      if (decision.kind === 'retry-deletion') {
        setState({ kind: 'deleting-local-data', ownerGithubId: decision.ownerGithubId })
        if (readyAccount.current?.ownerGithubId === decision.ownerGithubId) {
          await closeReadyAccount('shutdown')
        }
        try {
          await deletePendingAccount(generations, decision.ownerGithubId)
        } catch {
          return
        }
        if (isCurrent()) setBootAttempt(value => value + 1)
        return
      }

      if (decision.kind === 'verify-session') {
        if (!sessionData) return
        let ownerGithubId: string
        try {
          ownerGithubId = await verifyViewerGithubId()
        } catch (cause) {
          const fallback = activeAccountFallbackAfterVerificationFailure(
            active?.ownerGithubId ?? null,
          )
          if (fallback && active) {
            await openAccount(active, null)
            return
          }
          await closeReadyAccount('shutdown')
          if (isCurrent()) {
            setState({
              kind: 'failed',
              issue: 'identity-verification-failed',
              error: toError(cause),
            })
          }
          return
        }
        if (!isCurrent()) return
        const expectedRecoveryOwner = recoveryOwnerGithubId
        if (
          expectedRecoveryOwner &&
          !recoveryIdentityMatches(expectedRecoveryOwner, ownerGithubId)
        ) {
          remoteAttention.current = {
            ownerGithubId: expectedRecoveryOwner,
            issue: 'account-mismatch',
          }
          try {
            window.sessionStorage.removeItem(LOGIN_INTENT_STORAGE_KEY)
            window.sessionStorage.removeItem(LOGIN_RECOVERY_OWNER_STORAGE_KEY)
          } catch {
            // The in-memory expected owner remains the recovery fence.
          }
          if (active?.ownerGithubId === expectedRecoveryOwner) {
            await openAccount(active, null)
          } else if (isCurrent()) {
            setState({
              kind: 'locked-awaiting-auth',
              ownerGithubId: expectedRecoveryOwner,
            })
          }
          return
        }
        setState({ kind: 'opening-database' })
        const previousOwnerGithubId = readyAccount.current?.ownerGithubId ?? null
        let verified: AccountGeneration
        try {
          verified = await activateVerifiedLocalAccount(generations, ownerGithubId, {
            expectedActive: active,
            explicitAuthIntent: hasExplicitAuthIntent,
          })
        } catch (error) {
          if (error instanceof AccountActivationRejectedError) {
            if (error.reason === 'deletion-pending') {
              setState({ kind: 'deleting-local-data', ownerGithubId })
            } else {
              const mediaFenceError = active
                ? await lockReadyAccount(active.ownerGithubId, generations)
                : null
              if (isCurrent()) {
                setState({
                  kind: 'locked-awaiting-auth',
                  ownerGithubId: active?.ownerGithubId ?? ownerGithubId,
                  ...(mediaFenceError ? { mediaFenceError } : {}),
                })
              }
            }
            return
          }
          if (!(error instanceof StaleAccountGenerationError)) throw error
          const latestActive = await generations.readActive()
          const registryChanged = active
            ? latestActive?.generation !== active.generation || latestActive.nonce !== active.nonce
            : latestActive !== null
          if (isCurrent() && registryChanged) setBootAttempt(value => value + 1)
          return
        }
        try {
          window.sessionStorage.removeItem(LOGIN_INTENT_STORAGE_KEY)
          window.sessionStorage.removeItem(LOGIN_RECOVERY_OWNER_STORAGE_KEY)
        } catch {
          // The verified registry transition has already consumed the one-time authorization.
        }
        const callback = new URL(window.location.href)
        callback.searchParams.delete(LOGIN_INTENT_PARAM)
        window.history.replaceState(window.history.state, '', callback)
        remoteAttention.current = null
        const previousOwner =
          active && active.ownerGithubId !== ownerGithubId
            ? active.ownerGithubId
            : previousOwnerGithubId && previousOwnerGithubId !== ownerGithubId
              ? previousOwnerGithubId
              : null
        if (previousOwner) {
          const mediaFenceError = await lockReadyAccount(previousOwner, generations)
          if (mediaFenceError) {
            if (isCurrent()) {
              setState({
                kind: 'locked-awaiting-auth',
                ownerGithubId: previousOwner,
                mediaFenceError,
              })
            }
            return
          }
        }
        for (const account of accounts) {
          if (account.ownerGithubId === previousOwner || account.state !== 'locked') continue
          const mediaFenceError = await lockReadyAccount(account.ownerGithubId, generations)
          if (mediaFenceError) {
            if (isCurrent()) {
              setState({
                kind: 'locked-awaiting-auth',
                ownerGithubId: account.ownerGithubId,
                mediaFenceError,
              })
            }
            return
          }
        }
        await openAccount(verified, { verifiedSessionUserId: sessionData.user.id })
        return
      }

      if (decision.kind === 'open-active') {
        const account = await generations.read(decision.ownerGithubId)
        if (account?.state === 'active') {
          const issue = remoteAttentionForOfflineOpen(sessionResolution, navigator.onLine)
          if (issue) remoteAttention.current = { ownerGithubId: account.ownerGithubId, issue }
          await openAccount(account, null)
        }
        return
      }

      if (decision.kind === 'lock-active') {
        const mediaFenceError = await lockReadyAccount(decision.ownerGithubId, generations)
        const lockedAccount = await generations.read(decision.ownerGithubId)
        const cleanup =
          lockedAccount && lockedAccount.state === 'locked'
            ? await retryLockedCleanup(lockedAccount)
            : { mediaFenceError: null, legacyCleanupError: null }
        const legacyCleanupError = cleanup.legacyCleanupError
        if (isCurrent()) {
          setState({
            kind: 'locked-awaiting-auth',
            ownerGithubId: decision.ownerGithubId,
            ...(legacyCleanupError ? { legacyCleanupError } : {}),
            ...(mediaFenceError || cleanup.mediaFenceError
              ? { mediaFenceError: mediaFenceError ?? cleanup.mediaFenceError ?? undefined }
              : {}),
          })
        }
        return
      }

      await closeReadyAccount('shutdown')
      if (!isCurrent()) return
      const lockedCleanup =
        decision.kind === 'locked'
          ? await retryLockedCleanup(
              (await generations.read(decision.ownerGithubId)) ??
                (() => {
                  throw new StaleAccountGenerationError()
                })(),
            )
          : { legacyCleanupError: null, mediaFenceError: null }
      if (!isCurrent()) return
      let staleRemoteSignOutError: Error | undefined
      if (
        !lockedCleanup.mediaFenceError &&
        sessionData &&
        navigator.onLine &&
        !hasExplicitAuthIntent &&
        !active &&
        (decision.kind === 'locked' || decision.kind === 'signed-out')
      ) {
        try {
          const viewerGithubId = await verifyViewerGithubId()
          const viewerIsFenced = accounts.some(
            account =>
              account.ownerGithubId === viewerGithubId &&
              (account.state === 'locked' || account.state === 'signed-out'),
          )
          if (viewerIsFenced) {
            const proof = {
              ownerGithubId: viewerGithubId,
              sessionId: sessionData.session.id,
              sessionToken: sessionData.session.token,
            }
            pendingRemoteSignOut.current = proof
            try {
              await signOutExpectedRemoteAccount(proof)
              pendingRemoteSignOut.current = null
            } catch (cause) {
              staleRemoteSignOutError = toError(cause)
            }
          }
        } catch {
          // Without a verified numeric ID, never revoke a possibly different remote account.
        }
      }
      const remoteWarning = staleRemoteSignOutError
        ? { remoteSignOutError: staleRemoteSignOutError }
        : {}
      setState(
        decision.kind === 'locked'
          ? {
              kind: 'locked-awaiting-auth',
              ownerGithubId: decision.ownerGithubId,
              ...remoteWarning,
              ...(lockedCleanup.legacyCleanupError
                ? { legacyCleanupError: lockedCleanup.legacyCleanupError }
                : {}),
              ...(lockedCleanup.mediaFenceError
                ? { mediaFenceError: lockedCleanup.mediaFenceError }
                : {}),
            }
          : { kind: 'signed-out', ...remoteWarning },
      )
    }

    void boot().catch(cause => {
      if (isCurrent()) {
        setState(databaseFailure(cause, lastKnownOwnerGithubId.current ?? undefined))
      }
    })
    return () => {
      cancelled = true
    }
  }, [
    bootAttempt,
    closeReadyAccount,
    lockReadyAccount,
    sessionData,
    sessionError,
    sessionIsPending,
  ])

  const signOut = useCallback(
    async (localData: 'delete' | 'retain-locked' = 'delete') => {
      const current = readyAccount.current
      if (!current) return
      operation.current += 1
      desiredOpenKey.current = null
      setState({ kind: 'signing-out', localData })
      const remoteProof = sessionData
        ? {
            ownerGithubId: current.ownerGithubId,
            sessionId: sessionData.session.id,
            sessionToken: sessionData.session.token,
          }
        : null
      pendingRemoteSignOut.current = remoteProof

      const outcome = await runSignOutSequence({
        localData,
        closeLocalFeed: () => current.feed.close({ kind: 'sign-out', localData }),
        readLocalState: async () =>
          (await getAccountGenerations().read(current.ownerGithubId))?.state ?? null,
        clearLegacyCache: clearPersistedCache,
        fenceAccountMedia: async () => {
          const fenced = await getAccountGenerations().read(current.ownerGithubId)
          if (!fenced || fenced.state === 'active') {
            throw new Error('Local media fencing lost its account generation fence')
          }
          await fenceAccountMedia(fenced)
        },
        clearAccountMedia: async () => {
          const fenced = await getAccountGenerations().read(current.ownerGithubId)
          if (!fenced || fenced.state === 'active') {
            throw new Error('Local media deletion lost its account generation fence')
          }
          await deleteAccountMedia(fenced)
        },
        markDeletionPending: async () => {
          await advanceAccountDeletionIntent(getAccountGenerations(), current.ownerGithubId)
        },
        completeDeletion: async () => {
          const expected = await getAccountGenerations().read(current.ownerGithubId)
          if (expected?.state === 'signed-out') return
          if (!expected || expected.state !== 'deleting') throw new StaleAccountGenerationError()
          await getAccountGenerations().advance(expected, 'signed-out')
        },
        remoteSignOut: async () => {
          if (remoteProof) await signOutExpectedRemoteAccount(remoteProof)
        },
      })
      if (!outcome.remoteSignOutError && !outcome.mediaFenceError && !outcome.mediaCleanupError) {
        pendingRemoteSignOut.current = null
      }
      feedFlights.forget(feedFlightKey(current, current.remoteBinding !== null))
      readyAccount.current = null
      setMediaAccount(null)

      if (
        outcome.closeError &&
        (outcome.fencedState === null || outcome.fencedState === 'active')
      ) {
        await current.feed.close({ kind: 'shutdown' }).catch(() => undefined)
        setState(databaseFailure(outcome.closeError, current.ownerGithubId))
        return
      }

      const remoteWarning = outcome.remoteSignOutError
        ? { remoteSignOutError: outcome.remoteSignOutError }
        : {}
      if (
        outcome.fencedState === 'deleting' ||
        outcome.closeResult?.kind === 'deletion-pending' ||
        (localData === 'delete' &&
          (outcome.legacyCleanupError ||
            outcome.mediaCleanupError ||
            outcome.deletionStateError ||
            outcome.fencedState !== 'signed-out'))
      ) {
        setState({
          kind: 'deleting-local-data',
          ownerGithubId: current.ownerGithubId,
          ...remoteWarning,
        })
      } else if (outcome.fencedState === 'locked') {
        setState({
          kind: 'locked-awaiting-auth',
          ownerGithubId: current.ownerGithubId,
          ...remoteWarning,
          ...(outcome.legacyCleanupError ? { legacyCleanupError: outcome.legacyCleanupError } : {}),
          ...(outcome.mediaFenceError ? { mediaFenceError: outcome.mediaFenceError } : {}),
        })
      } else {
        setState({ kind: 'signed-out', ...remoteWarning })
      }
    },
    [sessionData],
  )

  const retryRemoteSignOut = useCallback(async () => {
    try {
      const proof = pendingRemoteSignOut.current
      if (!proof) return
      await signOutExpectedRemoteAccount(proof)
      pendingRemoteSignOut.current = null
      setState(current => {
        if (current.kind === 'deleting-local-data') {
          return { kind: current.kind, ownerGithubId: current.ownerGithubId }
        }
        if (current.kind === 'locked-awaiting-auth') {
          return {
            kind: current.kind,
            ownerGithubId: current.ownerGithubId,
            ...(current.legacyCleanupError
              ? { legacyCleanupError: current.legacyCleanupError }
              : {}),
            ...(current.mediaFenceError ? { mediaFenceError: current.mediaFenceError } : {}),
          }
        }
        if (current.kind === 'signed-out') return { kind: current.kind }
        return current
      })
    } catch {
      // Keep the explicit warning and local fence in place until a retry succeeds.
    }
  }, [])

  const recoverUnopenedAccount = useCallback(
    async (ownerGithubId: string, localData: 'delete' | 'retain-locked') => {
      operation.current += 1
      desiredOpenKey.current = null
      setState({ kind: 'signing-out', localData })
      const generations = getAccountGenerations()
      const remoteProof = sessionData
        ? {
            ownerGithubId,
            sessionId: sessionData.session.id,
            sessionToken: sessionData.session.token,
          }
        : null
      pendingRemoteSignOut.current = remoteProof

      const outcome = await runSignOutSequence({
        localData,
        closeLocalFeed: async () => {
          if (localData === 'retain-locked') {
            await advanceAccountLockIntent(generations, ownerGithubId)
            return { kind: 'retained-locked' }
          }
          await advanceAccountDeletionIntent(generations, ownerGithubId)
          const database = new LocalFeedDatabase(databaseNameForOwner(ownerGithubId))
          try {
            const result = await runBoundedDatabaseDelete(() => database.delete())
            return result === 'deleted' ? { kind: 'deleted' } : { kind: 'deletion-pending' }
          } finally {
            database.close()
          }
        },
        readLocalState: async () => (await generations.read(ownerGithubId))?.state ?? null,
        clearLegacyCache: clearPersistedCache,
        fenceAccountMedia: async () => {
          const account = await generations.read(ownerGithubId)
          if (!account || account.state === 'active') throw new StaleAccountGenerationError()
          await fenceAccountMedia(account)
        },
        clearAccountMedia: async () => {
          const account = await generations.read(ownerGithubId)
          if (!account || account.state === 'active') throw new StaleAccountGenerationError()
          await deleteAccountMedia(account)
        },
        markDeletionPending: async () => {
          await advanceAccountDeletionIntent(generations, ownerGithubId)
        },
        completeDeletion: async () => {
          const account = await generations.read(ownerGithubId)
          if (account?.state === 'signed-out') return
          if (!account || account.state !== 'deleting') throw new StaleAccountGenerationError()
          await generations.advance(account, 'signed-out')
        },
        remoteSignOut: async () => {
          if (remoteProof) await signOutExpectedRemoteAccount(remoteProof)
        },
      })

      if (!outcome.remoteSignOutError && !outcome.mediaFenceError && !outcome.mediaCleanupError) {
        pendingRemoteSignOut.current = null
      }
      const remoteWarning = outcome.remoteSignOutError
        ? { remoteSignOutError: outcome.remoteSignOutError }
        : {}
      if (
        outcome.fencedState === 'deleting' ||
        outcome.closeResult?.kind === 'deletion-pending' ||
        (localData === 'delete' && outcome.fencedState !== 'signed-out')
      ) {
        setState({ kind: 'deleting-local-data', ownerGithubId, ...remoteWarning })
      } else if (outcome.fencedState === 'locked' && !outcome.mediaFenceError) {
        setState({
          kind: 'locked-awaiting-auth',
          ownerGithubId,
          ...remoteWarning,
          ...(outcome.legacyCleanupError ? { legacyCleanupError: outcome.legacyCleanupError } : {}),
        })
      } else if (outcome.fencedState === 'locked') {
        setState({
          kind: 'locked-awaiting-auth',
          ownerGithubId,
          ...(outcome.mediaFenceError ? { mediaFenceError: outcome.mediaFenceError } : {}),
          ...(outcome.legacyCleanupError ? { legacyCleanupError: outcome.legacyCleanupError } : {}),
        })
      } else if (outcome.fencedState === 'signed-out') {
        setState({ kind: 'signed-out', ...remoteWarning })
      } else {
        setState(
          databaseFailure(
            outcome.closeError ?? new Error('Account recovery failed'),
            ownerGithubId,
          ),
        )
      }
    },
    [sessionData],
  )

  const recoverFailedAccount = useCallback(
    async (localData: 'delete' | 'retain-locked') => {
      const ownerGithubId = lastKnownOwnerGithubId.current
      if (ownerGithubId) await recoverUnopenedAccount(ownerGithubId, localData)
    },
    [recoverUnopenedAccount],
  )

  const deleteLockedAccount = useCallback(
    async (ownerGithubId: string) => recoverUnopenedAccount(ownerGithubId, 'delete'),
    [recoverUnopenedAccount],
  )

  const switchFailedAccount = useCallback(async () => {
    await startGithubSignIn()
  }, [])

  const sessionProfile = useMemo<SessionProfile | null>(() => {
    if (!sessionData || state.kind !== 'ready' || !state.account.remoteBinding) return null
    return { name: sessionData.user.name, email: sessionData.user.email }
  }, [sessionData, state])

  const retryBoot = useCallback(() => {
    setBootAttempt(value => value + 1)
  }, [])
  const recoverRemoteSync = useCallback(async () => {
    const current = readyAccount.current
    if (!current?.remoteAttention) return
    await startGithubSignIn(current.ownerGithubId)
  }, [])
  return {
    state,
    sessionProfile,
    signOut,
    retryBoot,
    retryRemoteSignOut,
    recoverRemoteSync,
    recoverFailedAccount,
    switchFailedAccount,
    deleteLockedAccount,
  }
}

function RemoteAttentionNotice({
  issue,
  recover,
}: {
  issue: 'reauth-required' | 'account-mismatch'
  recover: () => Promise<void>
}) {
  const [error, setError] = useState<Error | null>(null)
  return (
    <div className="fixed inset-x-0 top-0 z-50 border-b bg-background/95 p-3 shadow-sm backdrop-blur">
      <div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium">
            {issue === 'reauth-required'
              ? 'Cloud sync needs GitHub authentication again'
              : 'Cloud sync paused because the remote account changed'}
          </p>
          <p className="text-muted-foreground">
            Local data remains available. Verify the same GitHub account to rebuild cloud sync.
          </p>
          {error ? <p className="text-destructive">{error.message}</p> : null}
        </div>
        <Button
          size="sm"
          onClick={() => {
            setError(null)
            void recover().catch(cause => setError(toError(cause)))
          }}
        >
          Verify account
        </Button>
      </div>
    </div>
  )
}

export function LocalFirstAccountBoundary({ children }: { children: ReactNode }) {
  const controller = useLocalFirstAccountController()
  if (controller.state.kind !== 'ready') {
    return (
      <AccountGate
        state={controller.state}
        retry={controller.retryBoot}
        retryRemoteSignOut={controller.retryRemoteSignOut}
        recoverFailedAccount={controller.recoverFailedAccount}
        switchFailedAccount={controller.switchFailedAccount}
        deleteLockedAccount={controller.deleteLockedAccount}
      />
    )
  }

  const context = {
    ownerGithubId: controller.state.account.ownerGithubId,
    sessionProfile: controller.sessionProfile,
    signOut: controller.signOut,
    remoteAttention: controller.state.account.remoteAttention,
    recoverRemoteSync: controller.recoverRemoteSync,
  }
  return (
    <LocalFirstAccountContext.Provider value={context}>
      {controller.state.account.remoteAttention ? (
        <RemoteAttentionNotice
          issue={controller.state.account.remoteAttention}
          recover={controller.recoverRemoteSync}
        />
      ) : null}
      <LocalFeedProvider feed={controller.state.account.feed}>{children}</LocalFeedProvider>
    </LocalFirstAccountContext.Provider>
  )
}
