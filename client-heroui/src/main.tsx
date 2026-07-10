import ReactDOM from 'react-dom/client'
import { HeroUIProvider, ToastProvider } from "@heroui/react"
import Modal from 'react-modal'
import App from './App.tsx'
import './index.css'
import './utils/i18n'

const appElement = document.getElementById('root')!
Modal.setAppElement(appElement)

ReactDOM.createRoot(appElement).render(
  // <React.StrictMode>
    <HeroUIProvider>
      <ToastProvider />
      <App />
    </HeroUIProvider>
  // </React.StrictMode>,
)
