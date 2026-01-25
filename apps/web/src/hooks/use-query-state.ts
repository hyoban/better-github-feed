import { parseAsArrayOf, parseAsString, parseAsStringLiteral, useQueryState } from "nuqs";

export type SortOption = "name" | "latest";

export function useActiveId() {
  return useQueryState("id", parseAsString);
}

export function useActiveTypes() {
  return useQueryState("types", parseAsArrayOf(parseAsString).withDefault([]));
}

export function useActiveUsers() {
  return useQueryState("users", parseAsArrayOf(parseAsString).withDefault([]));
}

export function useSortBy() {
  return useQueryState(
    "sort",
    parseAsStringLiteral(["name", "latest"] as const).withDefault("latest"),
  );
}
