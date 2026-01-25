import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { orpc } from "@/utils/orpc";

export function useActivity(enabled: boolean, activeUsers: string[], activeTypes: string[]) {
  const usersParam = activeUsers.length > 0 ? activeUsers : undefined;
  const typesParam = activeTypes.length > 0 ? activeTypes : undefined;

  const query = useInfiniteQuery(
    orpc.feed.list.infiniteOptions({
      input: (cursor: number | undefined) => ({
        cursor,
        limit: 50,
        users: usersParam,
        types: typesParam,
      }),
      initialPageParam: undefined,
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
      enabled,
      placeholderData: keepPreviousData,
    }),
  );

  const items = useMemo(() => query.data?.pages.flatMap((page) => page.items) ?? [], [query.data]);

  const types = query.data?.pages[0]?.types ?? [];

  const typeCounts = useMemo(() => {
    const counts = query.data?.pages[0]?.typeCounts ?? {};
    return new Map(Object.entries(counts));
  }, [query.data]);

  return {
    items,
    types,
    typeCounts,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    hasNextPage: query.hasNextPage ?? false,
    isFetchingNextPage: query.isFetchingNextPage,
    fetchNextPage: () => query.fetchNextPage(),
  };
}
