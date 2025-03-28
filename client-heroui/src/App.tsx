import { useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { MessagePage } from './pages/MessagePage';

export default function App() {
  // 添加动态视口高度状态
  const [viewportHeight, setViewportHeight] = useState(window.innerHeight);

  // 添加 useEffect 来处理视口高度更新
  useEffect(() => {
    // 更新视口高度的函数
    const updateViewportHeight = () => {
      setViewportHeight(window.innerHeight);
    };
    
    // 初始设置
    updateViewportHeight();
    
    // 监听事件
    window.addEventListener('resize', updateViewportHeight);
    window.addEventListener('orientationchange', updateViewportHeight);
    
    return () => {
      window.removeEventListener('resize', updateViewportHeight);
      window.removeEventListener('orientationchange', updateViewportHeight);
    };
  }, []);

  return (
    // 应用动态高度样式到根容器
    <div style={{ height: `${viewportHeight}px`, overflow: 'hidden' }}>
      <Router>
        <Routes>
          <Route path="/" element={<MessagePage />} />
        </Routes>
      </Router>
    </div>
  );
}