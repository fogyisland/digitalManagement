import React from 'react'
import ReactDOM from 'react-dom/client'
import { ConfigProvider, App as AntdApp } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { RouterProvider } from 'react-router-dom'

import { router } from './router'
import { damTheme } from './theme/antd-theme'
import { bootstrapAuth } from './stores/authStore'
import { initApi } from './pages/init/initApi'
import './styles/global.css'

/**
 * Send an unconfigured installation to the wizard.
 *
 * A backend that has never been set up has no database and no credentials, so
 * the application has nothing to show — `/` would answer 401 on every call
 * and the operator would see a login page that cannot work. Asking the status
 * endpoint first is what turns "broken" into "not set up yet".
 *
 * The check is skipped on `/init` itself, so the wizard is reachable without
 * a round trip, and a failure of the check (an unreachable backend, a proxy
 * that does not forward `/api`) leaves the current route alone rather than
 * bouncing the operator to a wizard that cannot reach anything either.
 *
 * @returns {Promise<void>}
 */
async function redirectToWizardIfNeeded(): Promise<void> {
  if (window.location.pathname.startsWith('/init')) return
  try {
    const status = await initApi.status()
    if (!status.initialized) {
      window.location.replace('/init')
    }
  } catch {
    // Leave the route as it is; the login page explains the rest.
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider locale={zhCN} theme={damTheme}>
      <AntdApp>
        <RouterProvider router={router} />
      </AntdApp>
    </ConfigProvider>
  </React.StrictMode>,
)

// The wizard check runs first: bootstrapping a session against an
// uninitialized installation would only produce a 401 and a redirect to a
// login page nobody can use.
void redirectToWizardIfNeeded()

// Restore the session from the token kept in `localStorage`. This runs after
// the first paint on purpose: `/auth/me` is a network round-trip and must not
// delay the first render. The store is reactive, so the router re-renders as
// soon as the session state settles.
void bootstrapAuth()
