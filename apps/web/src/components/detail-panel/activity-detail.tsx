import DOMPurify from 'dompurify'
import { useMemo } from 'react'

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { ScrollArea } from '@/components/ui/scroll-area'
import { convertRelativeLinksToAbsolute, formatRelativeTime } from '@/lib/format'
import type { RawAtomActivity } from '@/local-feed'

type ActivityDetailProps = {
  item: RawAtomActivity
  showContext?: boolean
}

export function ActivityDetail({ item, showContext = true }: ActivityDetailProps) {
  const sanitizedContent = useMemo(() => {
    if (!item.content) return null

    const cleanContent = DOMPurify.sanitize(item.content, {
      FORBID_ATTR: ['target'],
      USE_PROFILES: { html: true },
    })
    const content = convertRelativeLinksToAbsolute(cleanContent).replace(/\s*·\s*/g, ' ')
    return content
  }, [item.content])

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      {showContext && (
        <div className="border-b bg-background/50 p-5">
          <div className="flex items-start gap-3">
            <Avatar className="size-12 ring-2 ring-background">
              <AvatarImage
                src={
                  item.actorAvatarUrl ??
                  (item.actorGithubId
                    ? `https://avatars-githubusercontent-webp.webp.se/u/${item.actorGithubId}`
                    : `https://github.com/${item.actor}.png`)
                }
                alt={`${item.actor} avatar`}
              />
              <AvatarFallback>{item.actor.slice(0, 2).toUpperCase()}</AvatarFallback>
            </Avatar>
            <div className="flex-1 overflow-hidden">
              <div className="flex items-center gap-2">
                <a
                  href={`https://github.com/${item.actor}`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-semibold text-foreground hover:underline"
                >
                  {item.actor}
                </a>
                <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">
                  {item.type}
                </span>
              </div>
              <div className="flex items-center gap-2 text-muted-foreground">
                {item.repo && (
                  <a
                    href={`https://github.com/${item.repo}`}
                    target="_blank"
                    rel="noreferrer"
                    className="hover:text-foreground hover:underline"
                  >
                    {item.repo}
                  </a>
                )}
                <span>{formatRelativeTime(new Date(item.publishedAt))}</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Title */}
      {showContext && (
        <div className="border-b bg-background/50 p-5">
          {item.link ? (
            <a
              href={item.link}
              target="_blank"
              rel="noreferrer"
              className="block leading-tight font-medium text-foreground transition-colors hover:text-primary"
            >
              {item.title}
            </a>
          ) : (
            <h1 className="leading-tight font-medium text-foreground">{item.title}</h1>
          )}
        </div>
      )}

      {/* Content */}
      <ScrollArea className="flex-1">
        {sanitizedContent ? (
          <div className="p-6">
            <div
              className="activity-content max-w-none [&_a]:text-primary [&_a]:underline [&_a:hover]:no-underline [&_blockquote]:border-l [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:italic [&_code]:rounded [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-0.5 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-4"
              dangerouslySetInnerHTML={{
                __html: sanitizedContent,
              }}
            />
          </div>
        ) : (
          <div className="flex h-full items-center justify-center p-8 text-center">
            <p className="text-muted-foreground">No additional details</p>
          </div>
        )}
      </ScrollArea>
    </div>
  )
}
