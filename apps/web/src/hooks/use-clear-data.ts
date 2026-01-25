import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

import { orpc, queryClient } from "@/utils/orpc";

export function useClearData() {
  const clearActivityMutation = useMutation(
    orpc.feed.clear.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: orpc.feed.list.key() });
        queryClient.invalidateQueries({ queryKey: orpc.subscription.list.queryKey() });
        toast.success("Activity data cleared");
      },
      onError: (error) => {
        toast.error(error.message);
      },
    }),
  );

  return {
    clearActivity: clearActivityMutation.mutate,
    isClearPending: clearActivityMutation.isPending,
  };
}
