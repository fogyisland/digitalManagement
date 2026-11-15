/**
 * Setup wizard — the shell.
 *
 * Three pages behind one route: the database, the administrator, and the
 * confirmation. The shell owns the wizard's shared state (the token, the two
 * collected step values) and the step indicator; each page owns only its own
 * form.
 *
 * The token is asked for up front because the backend requires `X-Init-Token`
 * on every step but the status probe. It is printed by the backend on boot,
 * so the operator copies it from the console — the wizard cannot discover it
 * on its own, by design.
 *
 * The token lives in React state and in the api module's memory, and nowhere
 * else. It is the credential that creates the platform administrator, minted
 * per boot and handed over once; `localStorage` survives the tab, so a token
 * written there would still be waiting after the operator closed the browser.
 * The cost is that a reload asks for it again — which is the same event that
 * loses the backend's boot-time value anyway when the process restarted.
 *
 * The token is checked before the wizard opens. `GET /api/init/status` is the
 * one route the backend leaves open (it answers before the token gate), so it
 * cannot tell a good token from a bad one; the existing token-gated
 * `GET /api/init/env-preview` can — it answers 403 `Invalid init token` for a
 * wrong token — so it doubles as the probe. A wrong token is caught here
 * instead of on the first submit.
 *
 * The wizard also has to survive a reload. `GET /api/init/status` reports how
 * far the installation got, and the wizard opens on the first step the
 * backend has not finished (`stepFromStatus`). Without that, an operator who
 * closed the browser after the database step came back to a form for a
 * database that already exists and could not get past it. A page reached this
 * way has no collected values — they belonged to the previous session — so
 * the pages below accept them as `null` and say so rather than refusing to
 * render.
 */
import { useEffect, useState } from 'react';
import { Alert, Button, Input, Space, Spin, Steps } from 'antd';
import { KeyOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import InitDatabase from './InitDatabase';
import InitAdmin from './InitAdmin';
import InitSeed from './InitSeed';
import { describeInitError, initApi, setInitToken } from './initApi';
import { stepFromStatus } from './initSteps';
import type { InitStep } from './initSteps';
import type { AdminInput, DatabaseInput } from './initApi';
import { PageHeader, Panel } from '@/components/ui';
import { tokens } from '@/theme/tokens';

/** Which page is showing. */
type Step = InitStep;

/**
 * The HTTP status of a failed wizard request, when the server answered.
 *
 * The wizard's own axios instance is not the shared one, so the shared
 * `isUnauthorized()` helper does not apply to it.
 *
 * @param error the caught value
 * @returns the status code, or `undefined` when the request never landed
 */
function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('response' in error)) return undefined;
  const response = (error as { response?: { status?: number } }).response;
  return response?.status;
}

export default function InitWizard(): JSX.Element {
  const [checking, setChecking] = useState(true);
  const [alreadyInitialized, setAlreadyInitialized] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [token, setToken] = useState('');
  const [tokenAccepted, setTokenAccepted] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [checkingToken, setCheckingToken] = useState(false);
  const [step, setStep] = useState<Step>(0);
  const [resumed, setResumed] = useState(false);
  const [database, setDatabase] = useState<DatabaseInput | null>(null);
  const [admin, setAdmin] = useState<AdminInput | null>(null);
  const navigate = useNavigate();

  // Ask the backend where the installation stands. `status` never requires
  // the token, so this runs before the operator has typed one.
  useEffect(() => {
    let cancelled = false;
    initApi
      .status()
      .then((status) => {
        if (cancelled) return;
        setAlreadyInitialized(status.initialized);
        // A half-finished installation resumes where it stopped: the backend
        // knows which steps are done, and the wizard has no other way to.
        const resumeAt = stepFromStatus(status.steps);
        setStep(resumeAt);
        setResumed(resumeAt > 0);
      })
      .catch((err: unknown) => {
        if (!cancelled) setCheckError(describeInitError(err));
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Take the token the operator pasted and check it before opening the steps.
   *
   * A wrong token is refused here (the backend answers 403 `Invalid init
   * token`); a request that never reached the server is reported but does not
   * block the wizard — the token is checked again when the first step is
   * submitted.
   */
  const onUseToken = async (): Promise<void> => {
    const trimmed = token.trim();
    if (!trimmed) return;
    setCheckingToken(true);
    setTokenError(null);
    setInitToken(trimmed);
    try {
      await initApi.envPreview();
      setTokenAccepted(true);
    } catch (err) {
      if (statusOf(err) === 403) {
        setTokenError('令牌无效，请核对后端启动时打印的 X-Init-Token');
      } else {
        setTokenError(`无法即时校验令牌（${describeInitError(err)}），令牌将在提交第一步时校验`);
        setTokenAccepted(true);
      }
    } finally {
      setCheckingToken(false);
    }
  };

  if (checking) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: tokens.space[5],
        }}
      >
        <Spin size="large" tip="正在检查安装状态…" />
      </div>
    );
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: `${tokens.space[6]} ${tokens.space[4]}`,
      }}
    >
      <div style={{ width: '100%', maxWidth: 680 }}>
        <PageHeader
          title="初始化 DAM"
          subtitle="三步把空数据库变成一个可以登录的实例。"
        />

        <Panel style={{ marginTop: tokens.space[5] }}>
          {checkError ? (
            <Alert
              type="error"
              showIcon
              style={{ marginTop: tokens.space[4] }}
              message="无法读取安装状态"
              description={checkError}
            />
          ) : null}

          {alreadyInitialized ? (
            <Alert
              type="info"
              showIcon
              style={{ marginTop: tokens.space[4] }}
              message="这个实例已经初始化过了"
              description={
                <p style={{ marginBottom: 0 }}>
                  初始化接口已关闭。请直接
                  <Button type="link" onClick={() => navigate('/')} style={{ padding: 0 }}>
                    进入系统
                  </Button>
                  。
                </p>
              }
            />
          ) : null}

          {!alreadyInitialized && !tokenAccepted ? (
            <div style={{ marginTop: tokens.space[5] }}>
              <Alert
                type="warning"
                showIcon
                icon={<KeyOutlined />}
                message="需要初始化令牌"
                description={
                  <p style={{ marginBottom: 0 }}>
                    后端启动时会在控制台打印一行 <code>X-Init-Token</code>，把它粘贴到这里。
                    也可以通过环境变量 <code>INIT_TOKEN</code> 固定这个值。
                  </p>
                }
              />
              <label
                htmlFor="init-token"
                style={{
                  display: 'block',
                  marginTop: tokens.space[4],
                  marginBottom: tokens.space[2],
                  color: tokens.color.textMuted,
                  fontSize: tokens.fontSize.sm,
                }}
              >
                初始化令牌
              </label>
              <Space.Compact style={{ width: '100%' }}>
                <Input.Password
                  id="init-token"
                  aria-label="初始化令牌"
                  placeholder="粘贴初始化令牌"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  onPressEnter={() => void onUseToken()}
                  allowClear
                  autoComplete="off"
                />
                <Button
                  type="primary"
                  onClick={() => void onUseToken()}
                  loading={checkingToken}
                  disabled={!token.trim()}
                >
                  使用此令牌
                </Button>
              </Space.Compact>
              {tokenError ? (
                <Alert
                  type="error"
                  showIcon
                  style={{ marginTop: tokens.space[3] }}
                  message={tokenError}
                />
              ) : null}
            </div>
          ) : null}

          {!alreadyInitialized && tokenAccepted ? (
            <>
              {resumed ? (
                <Alert
                  type="info"
                  showIcon
                  style={{ marginTop: tokens.space[5] }}
                  message="从上次停下的地方继续"
                  description="后端报告前面的步骤已经完成，向导直接打开在尚未完成的那一页。"
                />
              ) : null}

              <Steps
                current={step}
                style={{ marginTop: tokens.space[5], marginBottom: tokens.space[5] }}
                items={[
                  { title: '数据库' },
                  { title: '管理员' },
                  { title: '种子数据' },
                ]}
              />

              {step === 0 ? (
                <InitDatabase
                  onDone={(values) => {
                    setDatabase(values);
                    setResumed(false);
                    setStep(1);
                  }}
                />
              ) : null}

              {step === 1 ? (
                <InitAdmin
                  onBack={() => setStep(0)}
                  onDone={(values) => {
                    setAdmin(values);
                    setResumed(false);
                    setStep(2);
                  }}
                />
              ) : null}

              {step === 2 ? (
                <InitSeed
                  database={database}
                  admin={admin}
                  onBack={() => setStep(1)}
                  onFinished={() => navigate('/')}
                />
              ) : null}
            </>
          ) : null}
        </Panel>
      </div>
    </div>
  );
}
