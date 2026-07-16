import { NuqsAdapter } from 'nuqs/adapters/react-router'
import { isRouteErrorResponse, Outlet, useRouteError } from 'react-router-dom'

import { LocalFirstAccountBoundary } from './components/local-feed/local-first-account'
import { Toaster } from './components/ui/sonner'

export function App() {
  return (
    <NuqsAdapter>
      <LocalFirstAccountBoundary>
        <div className="min-h-svh lg:h-svh lg:overflow-hidden">
          <Outlet />
        </div>
      </LocalFirstAccountBoundary>
      <Toaster richColors />
    </NuqsAdapter>
  )
}

export function ErrorBoundary() {
  const error = useRouteError()

  let message = 'Oops!'
  let details = 'An unexpected error occurred.'
  let stack: string | undefined

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? '404' : 'Error'
    details =
      error.status === 404 ? 'The requested page could not be found.' : error.statusText || details
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message
    stack = error.stack
  }

  return (
    <main className="container mx-auto p-4 pt-16">
      <h1>{message}</h1>
      <p>{details}</p>
      {stack && (
        <pre className="w-full overflow-x-auto p-4">
          <code>{stack}</code>
        </pre>
      )}
    </main>
  )
}
