import { useQuery } from "@tanstack/react-query";

import { orpc } from "@/utils/orpc";

export function useSubscriptionList(enabled: boolean) {
  const query = useQuery({
    ...orpc.subscription.list.queryOptions(),
    enabled,
  });

  return {
    follows: query.data ?? [],
    isLoading: query.isLoading,
  };
}
