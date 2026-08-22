import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { lazy, Suspense } from 'react';
import { createBrowserRouter, Navigate, RouterProvider, useLocation, useOutlet } from 'react-router';

import ErrorBoundary from './components/ErrorBoundary';
import ToastProvider from './components/Toast';
import { useAuth } from './hooks/useAuth';
import { pageVariants } from './lib/motion';
import Dashboard from './pages/Dashboard';
import Login from './pages/Login';

// 路由级代码分割：对账/设置为次级页面，懒加载减小首屏 bundle
const Reconciliation = lazy(() => import('./pages/Reconciliation'));
const Settings = lazy(() => import('./pages/Settings'));

function AuthGuard({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();
  const shouldReduceMotion = useReducedMotion() ?? false;

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center" role="status" aria-label="加载中">
        <motion.div
          animate={shouldReduceMotion ? undefined : { rotate: 360 }}
          transition={shouldReduceMotion ? undefined : { duration: 1, repeat: Infinity, ease: 'linear' }}
          className="rounded-full h-12 w-12 border-b-2 border-primary-600"
        />
      </div>
    );
  }

  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function AnimatedOutlet() {
  const location = useLocation();
  const outlet = useOutlet();
  const shouldReduceMotion = useReducedMotion() ?? false;

  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={location.pathname}
        variants={pageVariants(shouldReduceMotion)}
        initial="initial"
        animate="animate"
        exit="exit"
        className="min-h-screen"
      >
        {outlet}
      </motion.div>
    </AnimatePresence>
  );
}

const lazyPage = (node: React.ReactNode) => (
  <Suspense fallback={<div className="min-h-screen bg-gray-50 animate-pulse" />}>{node}</Suspense>
);

const router = createBrowserRouter([
  {
    element: <AnimatedOutlet />,
    children: [
      { path: '/login', element: <Login /> },
      { path: '/', element: <AuthGuard><Dashboard /></AuthGuard> },
      { path: '/settings', element: lazyPage(<AuthGuard><Settings /></AuthGuard>) },
      { path: '/reconciliation', element: lazyPage(<AuthGuard><Reconciliation /></AuthGuard>) },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);

export default function App() {
  return (
    <ErrorBoundary>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </ErrorBoundary>
  );
}
