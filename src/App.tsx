import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';

import ErrorBoundary from './components/ErrorBoundary';
import ToastProvider from './components/Toast';
import { useAuth } from './hooks/useAuth';
import Dashboard from './pages/Dashboard';
import Login from './pages/Login';
import Reconciliation from './pages/Reconciliation';
import Settings from './pages/Settings';

function AuthGuard({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600"></div>
      </div>
    );
  }

  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <ErrorBoundary>
      <ToastProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/" element={<AuthGuard><Dashboard /></AuthGuard>} />
            <Route path="/settings" element={<AuthGuard><Settings /></AuthGuard>} />
            <Route path="/reconciliation" element={<AuthGuard><Reconciliation /></AuthGuard>} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </ErrorBoundary>
  );
}
