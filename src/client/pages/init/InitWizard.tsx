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
 */
import { useEffect, useState } from 'react';
import { Alert, Button, Card, Input, Space, Spin, Steps, Typography } from 'antd';
import { KeyOutlined } from '@ant-design/icons';
import InitDatabase from './InitDatabase';
import InitAdmin from './InitAdmin';
import InitReview from './InitReview';
import { describeInitError, initApi, setInitToken } from './initApi';
import type { AdminInput, DatabaseInput } from './initApi';

const { Paragraph, Text, Title } = Typography;

/** Which page is showing. */
type Step = 0 | 1 | 2;

/** Where the token is remembered between reloads of the wizard only. */
const TOKEN_STORAGE_KEY = 'dam_init_token';

export default function InitWizard(): JSX.Element {
  const [checking, setChecking] = useState(true);
  const [alreadyInitialized, setAlreadyInitialized] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_STORAGE_KEY) || '');
  const [tokenAccepted, setTokenAccepted] = useState(false);
  const [step, setStep] = useState<Step>(0);
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
    localStorage.setItem(TOKEN_STORAGE_KEY, trimmed);
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
                  setStep(1);
                }}
              />
            ) : null}

            {step === 1 && database ? (
              <InitAdmin
                onBack={() => setStep(0)}
                onDone={(values) => {
                  setAdmin(values);
                  setStep(2);
                }}
              />
            ) : null}

            {step === 2 && database && admin ? (
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
