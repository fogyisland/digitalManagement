import { lazy, Suspense } from 'react'
import { Navigate, createBrowserRouter, Outlet } from 'react-router-dom'
import { Spin } from 'antd'
import MainLayout from '@/components/layout/MainLayout'
import { useAuthStore } from '@/stores/authStore'

const Login = lazy(() => import('@/pages/Login'))
const Dashboard = lazy(() => import('@/pages/Dashboard'))
const Assets = lazy(() => import('@/pages/Assets'))
const AssetDetail = lazy(() => import('@/pages/AssetDetail'))
const Upload = lazy(() => import('@/pages/Upload'))
const Categories = lazy(() => import('@/pages/Categories'))
const Tags = lazy(() => import('@/pages/Tags'))
const ApiKeys = lazy(() => import('@/pages/ApiKeys'))
const Users = lazy(() => import('@/pages/Users'))
const Settings = lazy(() => import('@/pages/Settings'))
const NotFound = lazy(() => import('@/pages/NotFound'))

function Protected() {
  const user = useAuthStore((s) => s.user)
  if (!user) return <Navigate to="/login" replace />
  return <Outlet />
}

function AdminOnly() {
  const user = useAuthStore((s) => s.user)
  if (!user) return <Navigate to="/login" replace />
  if (user.role !== 'admin') return <Navigate to="/" replace />
  return <Outlet />
}

function PageLoader() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 300 }}>
      <Spin size="large" tip="加载中..." />
    </div>
  )
}

function lazyPage(Component: React.LazyExoticComponent<React.ComponentType>) {
  return (
    <Suspense fallback={<PageLoader />}>
      <Component />
    </Suspense>
  )
}

export const router = createBrowserRouter([
  { path: '/login', element: lazyPage(Login) },
  {
    element: <Protected />,
    children: [
      {
        element: <MainLayout />,
        children: [
          { index: true, element: lazyPage(Dashboard) },
          { path: 'assets', element: lazyPage(Assets) },
          { path: 'assets/upload', element: lazyPage(Upload) },
          { path: 'assets/:id', element: lazyPage(AssetDetail) },
          { path: 'categories', element: lazyPage(Categories) },
          { path: 'tags', element: lazyPage(Tags) },
          { path: 'api-keys', element: lazyPage(ApiKeys) },
          { path: 'settings', element: lazyPage(Settings) },
          {
            element: <AdminOnly />,
            children: [
              { path: 'users', element: lazyPage(Users) },
            ],
          },
          { path: '*', element: lazyPage(NotFound) },
        ],
      },
    ],
  },
])
