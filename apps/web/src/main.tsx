import './index.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App, ErrorBoundary } from './app'
import { registerServiceWorker } from './lib/register-service-worker'

registerServiceWorker()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
