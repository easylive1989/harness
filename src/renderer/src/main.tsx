import './styles/app.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* 側欄等 App 外框拋錯時的最後一道防線（主畫面在 App 裡另有一層） */}
    <ErrorBoundary className="m-3 h-[calc(100%-24px)]">
      <App />
    </ErrorBoundary>
  </StrictMode>
)
