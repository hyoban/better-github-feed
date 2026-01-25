import type { FilterGroup } from "@fn-sphere/filter";

import { countNumberOfRules } from "@fn-sphere/filter";
import { PencilIcon, PlusIcon, TrashIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useDeleteFilter, useFilters } from "@/hooks/use-filters";

import { Badge } from "../ui/badge";
import { FilterBuilderDialog } from "./filter-builder-dialog";

interface FilterRule {
  id: string;
  name: string;
  filterRule: FilterGroup;
  createdAt: Date;
  updatedAt: Date;
}

function FilterRuleItem({
  filter,
  onEdit,
  onDelete,
}: {
  filter: FilterRule;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const ruleCount = countNumberOfRules(filter.filterRule);

  return (
    <div className="flex items-center justify-between gap-2 rounded-md border bg-card p-3">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="truncate font-medium">{filter.name}</span>
        <span className="text-xs text-muted-foreground">
          {ruleCount} {ruleCount === 1 ? "rule" : "rules"}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button variant="ghost" size="icon-sm" onClick={onEdit}>
          <PencilIcon className="size-4" />
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={onDelete}>
          <TrashIcon className="size-4" />
        </Button>
      </div>
    </div>
  );
}

export function FilterRulesList() {
  const { data: filters, isLoading } = useFilters();
  const deleteFilter = useDeleteFilter();

  const [editingFilter, setEditingFilter] = useState<FilterRule | null>(null);
  const [deletingFilter, setDeletingFilter] = useState<FilterRule | null>(null);
  const [isCreateOpen, setIsCreateOpen] = useState(false);

  const handleDelete = async () => {
    if (!deletingFilter) return;

    try {
      await deleteFilter.mutateAsync({ id: deletingFilter.id });
      toast.success("Filter deleted");
      setDeletingFilter(null);
    } catch {
      toast.error("Failed to delete filter");
    }
  };

  return (
    <>
      <div className="flex flex-col gap-3">
        <Button variant="outline" size="sm" onClick={() => setIsCreateOpen(true)}>
          <PlusIcon className="mr-1 size-4" />
          Add Filter
        </Button>

        <span className="text-sm font-medium">Your Filters</span>

        {isLoading ? (
          <div className="text-sm text-muted-foreground">Loading filters...</div>
        ) : filters && filters.length > 0 ? (
          <ScrollArea className="max-h-[300px]">
            <div className="flex flex-col gap-2">
              {filters.map((filter) => (
                <FilterRuleItem
                  key={filter.id}
                  filter={filter}
                  onEdit={() => setEditingFilter(filter)}
                  onDelete={() => setDeletingFilter(filter)}
                />
              ))}
            </div>
          </ScrollArea>
        ) : (
          <div className="rounded-md border bg-muted/30 py-4 text-center text-sm text-muted-foreground">
            No custom filters yet. Add a filter to hide specific feed items.
          </div>
        )}
      </div>

      {/* Create Filter Dialog */}
      <FilterBuilderDialog
        open={isCreateOpen}
        onOpenChange={setIsCreateOpen}
        editingFilter={null}
      />

      {/* Edit Filter Dialog */}
      <FilterBuilderDialog
        open={!!editingFilter}
        onOpenChange={(open) => !open && setEditingFilter(null)}
        editingFilter={editingFilter}
      />

      {/* Delete Confirmation Dialog */}
      <AlertDialog
        open={!!deletingFilter}
        onOpenChange={(open) => !open && setDeletingFilter(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Filter</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{deletingFilter?.name}"? This action cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} disabled={deleteFilter.isPending}>
              {deleteFilter.isPending ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function FilterManagementDialog() {
  const { data: filters } = useFilters();
  const filterCount = filters?.length ?? 0;

  return (
    <Dialog>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm" className="h-7 gap-1 rounded-full">
            Filters
            {filterCount > 0 && <Badge variant="secondary">{filterCount}</Badge>}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Manage Filters</DialogTitle>
          <DialogDescription>
            Create and manage filters to hide feed items that match certain criteria. These filters
            are always applied to your feed.
          </DialogDescription>
        </DialogHeader>
        <FilterRulesList />
      </DialogContent>
    </Dialog>
  );
}
