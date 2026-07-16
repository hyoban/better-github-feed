export function isStorageQuotaError(error: unknown) {
  return error instanceof Error && error.name === 'QuotaExceededError'
}
