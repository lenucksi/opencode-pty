import React from 'react'
import ReactDOM from 'react-dom/client'
// Import the app stylesheet so Vite emits a content-hashed CSS asset (the
// xterm migration previously pulled in `@xterm/xterm/css/xterm.css`; ghostty-web
// has no stylesheet of its own).
import './index.css'
import { App } from './components/app.tsx'
import { ErrorBoundary } from './components/error-boundary.tsx'
import { initTheme } from './lib/theme.ts'

// Resolve light/dark before the first render so a light-mode user never sees a
// dark flash while React boots.
initTheme()

const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new Error('Could not find root element')
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
