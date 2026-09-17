import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import ThemeEditorWindow from './components/ThemeEditorWindow'
import './styles/tokens.css'
import './styles/global.css'
import './styles/weekly-plan.css'
import './components/daily-notes/daily-notes.css'

const root = document.getElementById('root') as HTMLElement

// The theme-editor sub-window loads the same index.html but with a #theme-editor
// hash. Render a lightweight standalone editor instead of the full App.
if (window.location.hash === '#theme-editor') {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <ThemeEditorWindow />
    </React.StrictMode>
  )
} else {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}
