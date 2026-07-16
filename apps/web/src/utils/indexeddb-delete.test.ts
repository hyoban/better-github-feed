import assert from 'node:assert/strict'

import { describe, it } from 'vite-plus/test'

import { deleteIndexedDbDatabase } from './indexeddb-delete'

class DeleteRequest extends EventTarget {
  error: DOMException | null = null
}

function factoryFor(request: DeleteRequest) {
  return {
    deleteDatabase: () => request as unknown as IDBOpenDBRequest,
  }
}

describe('deleteIndexedDbDatabase', () => {
  it('only resolves after a successful physical deletion', async () => {
    const request = new DeleteRequest()
    const deletion = deleteIndexedDbDatabase(factoryFor(request), 'legacy', 100)
    request.dispatchEvent(new Event('success'))
    await deletion
  })

  it('rejects blocked and failed deletions', async () => {
    const blocked = new DeleteRequest()
    const blockedDeletion = deleteIndexedDbDatabase(factoryFor(blocked), 'legacy', 100)
    blocked.dispatchEvent(new Event('blocked'))
    await assert.rejects(blockedDeletion, /blocked/)

    const failed = new DeleteRequest()
    failed.error = new DOMException('failed', 'UnknownError')
    const failedDeletion = deleteIndexedDbDatabase(factoryFor(failed), 'legacy', 100)
    failed.dispatchEvent(new Event('error'))
    await assert.rejects(failedDeletion, /failed/)
  })
})
