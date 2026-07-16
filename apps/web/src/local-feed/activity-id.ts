export const MAX_ACTIVITY_ID_LENGTH = 1000

export function isValidActivityProjectionId(id: string) {
  return id.length > 0 && id.length <= MAX_ACTIVITY_ID_LENGTH
}

export function normalizeActivityProjectionId(id: string) {
  return isValidActivityProjectionId(id) ? id : ''
}
