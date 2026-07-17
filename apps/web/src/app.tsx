import { NuqsAdapter } from 'nuqs/adapters/react'
import { Component } from 'react'
import type { ReactNode } from 'react'

import { LocalFirstAccountBoundary } from './components/local-feed/local-first-account'
import { Toaster } from './components/ui/sonner'
import { Home } from './pages/home'

export function App() {
  return (
    <NuqsAdapter>
      <LocalFirstAccountBoundary>
        <div className="min-h-svh md:h-svh md:overflow-hidden">
          <Home />
        </div>
      </LocalFirstAccountBoundary>
      <Toaster richColors />
    </NuqsAdapter>
  )
}

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return {
      error: error instanceof Error ? error : new Error('An unexpected error occurred.'),
    }
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <main className="container mx-auto p-4 pt-16">
        <h1>Oops!</h1>
        <p>{import.meta.env.DEV ? error.message : 'An unexpected error occurred.'}</p>
        {import.meta.env.DEV && error.stack && (
          <pre className="w-full overflow-x-auto p-4">
            <code>{error.stack}</code>
          </pre>
        )}
      </main>
    )
  }
}
