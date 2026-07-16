export function shouldExtendLocalActivityWindow(input: {
  alreadyExtendedAtFrontier: boolean
  hasMoreLocal: boolean
  itemCount: number
  lastVirtualIndex: number | undefined
}) {
  if (input.alreadyExtendedAtFrontier || !input.hasMoreLocal) return false
  return input.lastVirtualIndex !== undefined && input.lastVirtualIndex >= input.itemCount
}
