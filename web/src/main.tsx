import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import './app.css'
import './lib/viewport.ts'

createRoot(document.getElementById('root')!).render(<App />)
