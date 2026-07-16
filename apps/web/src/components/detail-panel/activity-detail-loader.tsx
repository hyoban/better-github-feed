import { Spinner } from '@/components/ui/spinner'
import { useActivity } from '@/hooks/use-local-feed'

import { ActivityDetail } from './activity-detail'

export function ActivityDetailLoader({ id }: { id: string }) {
  const snapshot = useActivity(id)

  if (snapshot.kind === 'opening-local') {
    return <DetailMessage loading>Opening local activity…</DetailMessage>
  }

  if (snapshot.kind === 'failed') {
    return <DetailMessage>Local activity could not be read.</DetailMessage>
  }

  const result = snapshot.value
  switch (result.kind) {
    case 'available':
      return <ActivityDetail item={result.activity} />
    case 'unavailable':
      return (
        <DetailMessage>
          This activity is not in the local feed. It may be older than the synchronized cloud
          history or the ID may be unknown.
        </DetailMessage>
      )
  }
}

function DetailMessage({
  children,
  loading = false,
}: {
  children: React.ReactNode
  loading?: boolean
}) {
  return (
    <div className="flex h-full min-h-48 flex-col items-center justify-center gap-3 p-8 text-center">
      {loading && <Spinner className="text-muted-foreground" />}
      <p className="max-w-sm text-sm text-muted-foreground">{children}</p>
    </div>
  )
}
