import { lazy, Suspense } from 'react';
import { Navigate, createBrowserRouter, Outlet } from 'react-router-dom';
import { Spin } from 'antd';
import MainLayout from '@/components/layout/MainLayout';
import { useAuthStore } from '@/stores/authStore';

const Login = lazy(() => import('@/pages/Login'));
const Dashboard = lazy(() => import('@/pages/Dashboard'));
const Library = lazy(() => import('@/pages/Library'));
const AssetDetail = lazy(() => import('@/pages/AssetDetail'));
const Import = lazy(() => import('@/pages/Import'));
const Jobs = lazy(() => import('@/pages/Jobs'));
const Organize = lazy(() => import('@/pages/Organize'));
const Integrations = lazy(() => import('@/pages/Integrations'));
const Settings = lazy(() => import('@/pages/Settings'));
const Users = lazy(() => import('@/pages/Users'));
const NotFound = lazy(() => import('@/pages/NotFound'));

function Protected() {
  const user = useAuthStore((s) => s.user);
  if (!user) return <Navigate to="/login" replace />;
  return <Outlet />;
}

function AdminOnly() {
  const user = useAuthStore((s) => s.user);
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== 'admin') return <Navigate to="/" replace />;
  return <Outlet />;
}

function PageLoader() {
  return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 320 }}><Spin size="large" tip="加载中…" /></div>;
}
const lazyPage = (C: React.LazyExoticComponent<React.ComponentType>) => <Suspense fallback={<PageLoader />}><C /></Suspense>;

export const router = createBrowserRouter([
  { path: '/login', element: lazyPage(Login) },
  { element: <Protected />, children: [
    { element: <MainLayout />, children: [
      { index: true, element: lazyPage(Dashboard) },
      { path: 'library', element: lazyPage(Library) },
      { path: 'library/:id', element: lazyPage(AssetDetail) },
      { path: 'import', element: lazyPage(Import) },
      // Back-compat: the legacy /assets/upload route now lands on /import.
      { path: 'assets/upload', element: <Navigate to="/import" replace /> },
      { path: 'jobs', element: lazyPage(Jobs) },
      { path: 'organize', element: lazyPage(Organize) },
      { path: 'integrations', element: lazyPage(Integrations) },
      { path: 'settings', element: lazyPage(Settings) },
      { element: <AdminOnly />, children: [{ path: 'users', element: lazyPage(Users) }] },
      { path: '*', element: lazyPage(NotFound) },
    ] },
  ] },
]);
