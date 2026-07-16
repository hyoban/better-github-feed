export function shouldExtendActivityDemand(input: {
  hasMoreHistory: boolean
  itemCount: number
  lastVirtualIndex: number | undefined
}) {
  if (!input.hasMoreHistory) return false
  if (input.itemCount === 0) return true
  return input.lastVirtualIndex !== undefined && input.lastVirtualIndex >= input.itemCount
}
