import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './lib/monaco'
import App from './App'

const container = document.getElementById('root')
if (!container) throw new Error('Missing #root element.')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
