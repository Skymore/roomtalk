import { useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { MessagePage } from './pages/MessagePage';
import { installAppViewportSizing } from './utils/appViewport';

export default function App() {
  useEffect(() => {
    return installAppViewportSizing();
  }, []);

  return (
    <div className="app-shell">
      <Router future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Routes>
          <Route path="/" element={<MessagePage />} />
        </Routes>
      </Router>
    </div>
  );
}
