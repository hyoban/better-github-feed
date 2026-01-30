import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { ScrollArea } from '@/components/ui/scroll-area'
import { convertRelativeLinksToAbsolute, formatRelativeTime } from '@/lib/format'

type ActivityItemData = {
  id: string
  source: string
  title: string
  link: string | null
  content: string | null
  publishedAt: Date | string | null
  type: string
  repo: string | null
}

type ActivityDetailProps = {
  item: ActivityItemData
}

export function ActivityDetail({ item }: ActivityDetailProps) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="border-b bg-background/50 p-4">
        <div className="flex items-start gap-3">
          <Avatar className="size-12 ring-2 ring-background">
            <AvatarImage
              src={`https://github.com/${item.source}.png`}
              alt={`${item.source} avatar`}
            />
            <AvatarFallback>{item.source.slice(0, 2).toUpperCase()}</AvatarFallback>
          </Avatar>
          <div className="flex-1 overflow-hidden">
            <div className="flex items-center gap-2">
              <a
                href={`https://github.com/${item.source}`}
                target="_blank"
                rel="noreferrer"
                className="font-semibold text-foreground hover:underline"
              >
                {item.source}
              </a>
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                {item.type}
              </span>
            </div>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              {item.repo && (
                <>
                  <a
                    href={`https://github.com/${item.repo}`}
                    target="_blank"
                    rel="noreferrer"
                    className="hover:text-foreground hover:underline"
                  >
                    {item.repo}
                  </a>
                  <span>&middot;</span>
                </>
              )}
              <span>{formatRelativeTime(item.publishedAt)}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Title */}
      <div className="border-b bg-background/50 p-4">
        {item.link
          ? (
              <a
                href={item.link}
                target="_blank"
                rel="noreferrer"
                className="block text-lg leading-tight font-semibold text-foreground transition-colors hover:text-primary"
              >
                {item.title}
              </a>
            )
          : (
              <h1 className="text-lg leading-tight font-semibold text-foreground">{item.title}</h1>
            )}
      </div>

      {/* Content */}
      <ScrollArea className="flex-1">
        {item.content
          ? (
              <div className="p-4">
                <div
                  className="activity-content prose prose-sm dark:prose-invert max-w-none [&_a]:text-primary [&_a]:underline [&_a:hover]:no-underline [&_blockquote]:border-l [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:italic [&_code]:rounded [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-0.5 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-4"
                  dangerouslySetInnerHTML={{
                    __html: convertRelativeLinksToAbsolute(item.content),
                  }}
                />
              </div>
            )
          : (
              <div className="flex h-full items-center justify-center p-8 text-center">
                <p className="text-sm text-muted-foreground">No additional content available</p>
              </div>
            )}
      </ScrollArea>
    </div>
  )
}
