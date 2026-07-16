export function shouldExtendActivityDemand(input: {
  alreadyExtendedAtFrontier: boolean
  hasMoreHistory: boolean
  itemCount: number
  lastVirtualIndex: number | undefined
}) {
  if (input.alreadyExtendedAtFrontier) return false
  if (!input.hasMoreHistory) return false
  if (input.itemCount === 0) return true
  return input.lastVirtualIndex !== undefined && input.lastVirtualIndex >= input.itemCount
}
