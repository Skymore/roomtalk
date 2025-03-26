import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { MessagePage } from './pages/MessagePage';

export default function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<MessagePage />} />
      </Routes>
    </Router>
  );
}