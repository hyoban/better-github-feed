type DevBackendSyncDependencies = {
  triggerBackendSync: () => Promise<unknown>
  requestLocalSync: () => void
}

export async function runDevBackendSync({
  triggerBackendSync,
  requestLocalSync,
}: DevBackendSyncDependencies): Promise<void> {
  await triggerBackendSync()
  requestLocalSync()
}

export async function triggerDevBackendSync(): Promise<void> {
  const response = await fetch('/api/dev/sync', {
    method: 'POST',
    credentials: 'include',
  })
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { message?: unknown } | null
    const message = typeof payload?.message === 'string' ? payload.message : 'Backend sync failed'
    throw new Error(message)
  }
}
