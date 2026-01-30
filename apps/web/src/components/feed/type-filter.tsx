import { useMemo } from 'react'

import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { useActivity } from '@/hooks/use-activity'
import { useActiveTypes, useActiveUsers } from '@/hooks/use-query-state'
import { authClient } from '@/lib/auth-client'
import { formatTypeLabel } from '@/lib/format'

import { Button } from '../ui/button'
import { FilterManagementDialog } from './filter-rules-list'

export function TypeFilter() {
  const { data: session } = authClient.useSession()
  const [activeTypes, setActiveTypes] = useActiveTypes()
  const [activeUsers] = useActiveUsers()

  const isAuthenticated = !!session
  const { types, typeCounts } = useActivity(isAuthenticated, activeUsers, activeTypes)

  // Filter activeTypes to only include valid types
  const validActiveTypes = useMemo(() => {
    if (types.length === 0)
      return []
    const available = new Set(types)
    return activeTypes.filter(type => available.has(type))
  }, [types, activeTypes])

  const sortedTypes = [...types].sort(
    (a, b) => (typeCounts.get(b) ?? 0) - (typeCounts.get(a) ?? 0),
  )

  return (
    <ScrollArea className="w-full">
      <div className="flex items-center gap-2 p-2 text-xs">
        <FilterManagementDialog />
        <Button
          size="sm"
          variant={validActiveTypes.length === 0 ? 'default' : 'outline'}
          className="h-7 shrink-0 rounded-full"
          onClick={() => setActiveTypes([])}
        >
          All
        </Button>
        <Separator orientation="vertical" />
        {sortedTypes.map((type) => {
          const isActive = validActiveTypes.includes(type)
          return (
            <Button
              key={type}
              size="sm"
              variant={isActive ? 'default' : 'outline'}
              className="flex h-7 shrink-0 gap-1 rounded-full"
              onClick={(e) => {
                const isMultiSelect = e.metaKey || e.ctrlKey
                if (isMultiSelect) {
                  setActiveTypes(
                    isActive
                      ? validActiveTypes.filter(t => t !== type)
                      : [...validActiveTypes, type],
                  )
                }
                else {
                  setActiveTypes(isActive ? [] : [type])
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
