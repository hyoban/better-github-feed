import { useMemo } from 'react'

import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { toActorSelection } from '@/hooks/feed-view'
import { useLocalFeedStatistics } from '@/hooks/use-local-feed'
import { useActiveTypes, useActiveUsers } from '@/hooks/use-query-state'
import { formatTypeLabel } from '@/lib/format'

import { Button } from '../ui/button'
import { FilterManagementDialog } from './filter-rules-list'

export function TypeFilter() {
  const [activeTypes, setActiveTypes] = useActiveTypes()
  const [activeUsers] = useActiveUsers()
  const statistics = useLocalFeedStatistics({ actors: toActorSelection(activeUsers) })
  const typeCounts = useMemo(
    () => new Map(Object.entries(statistics.kind === 'ready' ? statistics.value.typeCounts : {})),
    [statistics],
  )
  const types = useMemo(
    () => [...new Set([...typeCounts.keys(), ...activeTypes])],
    [typeCounts, activeTypes],
  )
  const activeTypeSet = useMemo(() => new Set(activeTypes), [activeTypes])

  const pinnedTypes = ['star', 'pr_merged']
  const sortedTypes = [...types].sort((a, b) => {
    const aPinned = pinnedTypes.indexOf(a)
    const bPinned = pinnedTypes.indexOf(b)
    // Both pinned: sort by pinned order
    if (aPinned !== -1 && bPinned !== -1) return aPinned - bPinned
    // Only a is pinned: a comes first
    if (aPinned !== -1) return -1
    // Only b is pinned: b comes first
    if (bPinned !== -1) return 1
    // Neither pinned: sort by count
    return (typeCounts.get(b) ?? 0) - (typeCounts.get(a) ?? 0)
  })

  return (
    <ScrollArea className="w-full">
      <div className="flex items-center gap-2 p-2 text-xs">
        <FilterManagementDialog />
        <Button
          size="sm"
          variant={activeTypes.length === 0 ? 'default' : 'outline'}
          className="h-7 shrink-0 rounded-full"
          onClick={() => void setActiveTypes([])}
        >
          All
        </Button>
        <Separator orientation="vertical" />
        {sortedTypes.map(type => {
          const isActive = activeTypeSet.has(type)
          return (
            <Button
              key={type}
              size="sm"
              variant={isActive ? 'default' : 'outline'}
              className="flex h-7 shrink-0 gap-1 rounded-full"
              onClick={e => {
                const isMultiSelect = e.metaKey || e.ctrlKey
                if (isMultiSelect) {
                  void setActiveTypes(
                    isActive ? activeTypes.filter(t => t !== type) : [...activeTypes, type],
                  )
                } else {
                  void setActiveTypes(isActive ? [] : [type])
                }
              }}
            >
              {formatTypeLabel(type)}
              <span>{typeCounts.get(type) ?? 0}</span>
            </Button>
          )
        })}
      </div>
    </ScrollArea>
  )
}
