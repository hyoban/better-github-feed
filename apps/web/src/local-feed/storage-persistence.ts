export type StoragePersistenceResult = 'granted' | 'denied' | 'unsupported'

export interface StoragePersistencePort {
  request(): Promise<StoragePersistenceResult>
}

export function createBrowserStoragePersistencePort(): StoragePersistencePort {
  return {
    async request() {
      if (!navigator.storage?.persist) return 'unsupported'
      try {
        return (await navigator.storage.persist()) ? 'granted' : 'denied'
      } catch {
        return 'denied'
      }
    },
  }
}
