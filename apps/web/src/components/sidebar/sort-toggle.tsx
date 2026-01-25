import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { type SortOption, useActiveId, useActiveUsers, useSortBy } from "@/hooks/use-query-state";

export function SortToggle() {
  const [sortBy, setSortBy] = useSortBy();
  const [, setActiveUsers] = useActiveUsers();
  const [, setActiveId] = useActiveId();

  const handleSortChange = (value: string) => {
    void setSortBy(value as SortOption);
    void setActiveUsers([]);
    void setActiveId(null);
  };

  return (
    <Tabs value={sortBy} onValueChange={handleSortChange} className="w-full">
      <TabsList className="grid w-full grid-cols-2 group-data-horizontal/tabs:h-11" variant="line">
        <TabsTrigger value="latest">Latest</TabsTrigger>
        <TabsTrigger value="name">Name</TabsTrigger>
      </TabsList>
    </Tabs>
  );
}
