export function deleteIndexedDbDatabase(
  factory: Pick<IDBFactory, 'deleteDatabase'>,
  name: string,
  timeoutMs = 1_500,
) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    return Promise.reject(new RangeError('Invalid IndexedDB deletion timeout'))
  }
  return new Promise<void>((resolve, reject) => {
    const request = factory.deleteDatabase(name)
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      if (error) reject(error)
      else resolve()
    }
    timer = setTimeout(
      () => finish(new Error(`IndexedDB deletion timed out for ${name}`)),
      timeoutMs,
    )
    request.addEventListener('success', () => finish(), { once: true })
    request.addEventListener(
      'error',
      () => finish(request.error ?? new Error(`IndexedDB deletion failed for ${name}`)),
      { once: true },
    )
    request.addEventListener(
      'blocked',
      () => finish(new Error(`IndexedDB deletion is blocked for ${name}`)),
      { once: true },
    )
  })
}
