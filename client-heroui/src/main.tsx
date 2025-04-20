import React from 'react'
import ReactDOM from 'react-dom/client'
import { HeroUIProvider, ToastProvider } from "@heroui/react"
import App from './App.tsx'
import './index.css'
import './utils/i18n'

ReactDOM.createRoot(document.getElementById('root')!).render(
  // <React.StrictMode>
    <HeroUIProvider>
      <ToastProvider />
      <App />
    </HeroUIProvider>
  // </React.StrictMode>,
)