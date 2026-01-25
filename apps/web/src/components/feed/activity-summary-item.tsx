import { memo, useEffect, useRef } from "react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface ActivityItemData {
  id: string;
  source: string;
  title: string;
  link: string | null;
  content: string | null;
  publishedAt: Date | string | null;
  type: string;
}

interface ActivitySummaryItemProps {
  item: ActivityItemData;
  githubId?: string;
  isActive: boolean;
  isFocused: boolean;
  onClick: () => void;
  onFocus: () => void;
}

export const ActivitySummaryItem = memo(function ActivitySummaryItem({
  item,
  githubId,
  isActive,
  isFocused,
  onClick,
  onFocus,
}: ActivitySummaryItemProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const isClickRef = useRef(false);

  useEffect(() => {
    if (isFocused) {
      buttonRef.current?.focus();
    }
  }, [isFocused]);

  return (
    <button
      ref={buttonRef}
      type="button"
      onPointerDown={() => {
        isClickRef.current = true;
      }}
      onClick={() => {
        isClickRef.current = false;
        onClick();
      }}
      onFocus={() => {
        // Only trigger onFocus for keyboard navigation (Tab), not for clicks
        if (!isClickRef.current) {
          onFocus();
        }
      }}
      className={cn(
        "w-full border-b border-l px-4 py-3 text-left transition-colors",
        isFocused
          ? "border-l-primary bg-sidebar-accent"
          : isActive
            ? "border-l-primary/80 bg-sidebar-accent/80"
            : "border-l-transparent hover:bg-sidebar-accent/50",
      )}
    >
      <div className="flex gap-3">
        <Avatar className="size-8 shrink-0">
          <AvatarImage
            src={
              githubId
                ? `https://avatars-githubusercontent-webp.webp.se/u/${githubId}`
                : `https://github.com/${item.source}.png`
            }
            alt={`${item.source} avatar`}
            width={32}
            height={32}
          />
          <AvatarFallback className="text-xs">
            {item.source.slice(0, 2).toUpperCase()}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{item.source}</span>
            <span>&middot;</span>
            <span>{formatRelativeTime(item.publishedAt)}</span>
          </div>
          <p className="mt-1 line-clamp-2 text-sm leading-snug text-foreground/90">{item.title}</p>
        </div>
      </div>
    </button>
  );
});
