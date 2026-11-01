import React from 'react'
import ReactDOM from 'react-dom/client'
import { ConfigProvider, App as AntdApp } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { RouterProvider } from 'react-router-dom'

import { router } from './router'
import { damTheme } from './theme/antd-theme'
import { bootstrapAuth } from './stores/authStore'
import './styles/global.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider locale={zhCN} theme={damTheme}>
      <AntdApp>
        <RouterProvider router={router} />
      </AntdApp>
    </ConfigProvider>
  </React.StrictMode>,
)

// Restore the session from the token kept in `localStorage`. This runs after
// the first paint on purpose: `/auth/me` is a network round-trip and must not
// delay the first render. The store is reactive, so the router re-renders as
// soon as the session state settles.
void bootstrapAuth()
