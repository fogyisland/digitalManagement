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
import { Alert, Button, Card, Input, Space, Spin, Steps, Typography } from 'antd';
import { KeyOutlined } from '@ant-design/icons';
import InitDatabase from './InitDatabase';
import InitAdmin from './InitAdmin';
import InitReview from './InitReview';
import { describeInitError, initApi, setInitToken } from './initApi';
import { stepFromStatus } from './initSteps';
import type { InitStep } from './initSteps';
import type { AdminInput, DatabaseInput } from './initApi';

const { Paragraph, Text, Title } = Typography;

/** Which page is showing. */
type Step = InitStep;

export default function InitWizard(): JSX.Element {
  const [checking, setChecking] = useState(true);
  const [alreadyInitialized, setAlreadyInitialized] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [token, setToken] = useState('');
  const [tokenAccepted, setTokenAccepted] = useState(false);
  const [step, setStep] = useState<Step>(0);
  const [resumed, setResumed] = useState(false);
  const [database, setDatabase] = useState<DatabaseInput | null>(null);
  const [admin, setAdmin] = useState<AdminInput | null>(null);

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

  const onUseToken = (): void => {
    const trimmed = token.trim();
    if (!trimmed) return;
    setInitToken(trimmed);
    setTokenAccepted(true);
  };

  if (checking) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 120 }}>
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
        padding: '48px 16px',
      }}
    >
      <Card style={{ width: '100%', maxWidth: 680 }}>
        <Title level={2} style={{ marginBottom: 4 }}>
          初始化 DAM
        </Title>
        <Text type="secondary">
          三步把空数据库变成一个可以登录的实例。
        </Text>

        {checkError ? (
          <Alert
            type="error"
            showIcon
            style={{ marginTop: 16 }}
            message="无法读取安装状态"
            description={checkError}
          />
        ) : null}

        {alreadyInitialized ? (
          <Alert
            type="info"
            showIcon
            style={{ marginTop: 16 }}
            message="这个实例已经初始化过了"
            description={
              <Paragraph style={{ marginBottom: 0 }}>
                初始化接口已关闭。请直接<Button type="link" href="/" style={{ padding: 0 }}>进入系统</Button>。
              </Paragraph>
            }
          />
        ) : null}

        {!alreadyInitialized && !tokenAccepted ? (
          <div style={{ marginTop: 24 }}>
            <Alert
              type="warning"
              showIcon
              icon={<KeyOutlined />}
              message="需要初始化令牌"
              description={
                <Paragraph style={{ marginBottom: 0 }}>
                  后端启动时会在控制台打印一行 <code>X-Init-Token</code>，把它粘贴到这里。
                  也可以通过环境变量 <code>INIT_TOKEN</code> 固定这个值。
                </Paragraph>
              }
            />
            <Space.Compact style={{ width: '100%', marginTop: 16 }}>
              <Input
                placeholder="粘贴初始化令牌"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                onPressEnter={onUseToken}
                allowClear
              />
              <Button type="primary" onClick={onUseToken}>
                使用
              </Button>
            </Space.Compact>
          </div>
        ) : null}

        {!alreadyInitialized && tokenAccepted ? (
          <>
            {resumed ? (
              <Alert
                type="info"
                showIcon
                style={{ marginTop: 24 }}
                message="从上次停下的地方继续"
                description="后端报告前面的步骤已经完成，向导直接打开在尚未完成的那一页。"
              />
            ) : null}

            <Steps
              current={step}
              style={{ marginTop: 24, marginBottom: 24 }}
              items={[
                { title: '数据库' },
                { title: '管理员' },
                { title: '确认' },
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
              <InitReview
                database={database}
                admin={admin}
                onBack={() => setStep(1)}
                onFinished={() => {
                  window.location.href = '/';
                }}
              />
            ) : null}
          </>
        ) : null}
      </Card>
    </div>
  );
}
