// Entry point: mounts the React app into <div id="root"> in index.html.
// StrictMode runs extra checks in development only (e.g. effects run twice to
// surface missing cleanups); it has no effect on production builds.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Company theme first: Tailwind's base/utilities plus the --rhodex-* font hook.
// Page styles come after so they can build on it.
import './theme/index.css'
import './global.css' // app shell + landing-page styles; the historical page imports its own CSS
import { ThemeProvider } from './theme/ThemeProvider.jsx'
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {/* Writes the active theme (Lapis or Ghost) onto :root as --rhodex-* variables */}
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </StrictMode>,
)
