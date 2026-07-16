import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { sortSelectionTransition } from '@/hooks/feed-selection-transition'
import type { SortOption } from '@/hooks/use-query-state'
import { useActiveId, useActiveUsers, useSortBy } from '@/hooks/use-query-state'

export function SortToggle() {
  const [sortBy, setSortBy] = useSortBy()
  const [, setActiveUsers] = useActiveUsers()
  const [, setActiveId] = useActiveId()

  const handleSortChange = (value: string) => {
    const transition = sortSelectionTransition(sortBy, value as SortOption)
    if (!transition) return
    void Promise.all([
      setSortBy(transition.sort),
      setActiveUsers(transition.users),
      setActiveId(transition.id),
    ])
  }

  const handleSelectedSortClick = (value: SortOption) => {
    if (value !== sortBy) return
    void Promise.all([setActiveUsers([]), setActiveId(null)])
  }

  return (
    <Tabs value={sortBy} onValueChange={handleSortChange} className="w-full">
      <TabsList className="grid w-full grid-cols-2 group-data-horizontal/tabs:h-12" variant="line">
        <TabsTrigger value="latest" onClick={() => handleSelectedSortClick('latest')}>
          Latest
        </TabsTrigger>
        <TabsTrigger value="name" onClick={() => handleSelectedSortClick('name')}>
          Name
        </TabsTrigger>
      </TabsList>
    </Tabs>
  )
}
