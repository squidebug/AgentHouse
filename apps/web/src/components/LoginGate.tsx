import { Box, Typography } from '@mui/material';
import { useEffect, useState, type ReactNode } from 'react';
import { authToken, loginNeeded, onLoginChange, redeemLoginCode, type LoginNeeded } from '../api/auth';
import { api } from '../api/client';
import { t } from '../strings';
import { v } from '../theme/tokens';
import { CopyCommand } from './CopyCommand';

/** The workspace while the page holds a token the server takes; the login page otherwise. */
export function LoginGate({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [, setVersion] = useState(0);

  useEffect(() => {
    const unsubscribe = onLoginChange(() => setVersion((n) => n + 1));
    redeemLoginCode().then(() => {
      setReady(true);
      // Without a token the refusal still says what gives a new login address.
      if (!authToken() && !loginNeeded()?.command) api.auth().catch(() => {});
    });
    return unsubscribe;
  }, []);

  if (!ready) return null;
  const needed = loginNeeded();
  if (needed || !authToken()) return <LoginPage needed={needed} />;
  return children;
}

function LoginPage({ needed }: { needed: LoginNeeded | null }) {
  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', p: 2 }}>
      <Box sx={{ width: 'min(420px, 100%)', display: 'flex', flexDirection: 'column', gap: 1.5, p: 3, borderRadius: '16px', bgcolor: v.surface, boxShadow: v.shadow1 }}>
        <Typography sx={{ fontSize: 18, fontWeight: 600 }}>{t.appName}</Typography>
        <Typography sx={{ fontSize: 14 }}>{needed?.expired ? t.loginExpired : t.loginNeeded}</Typography>
        {needed?.command && <CopyCommand command={needed.command} />}
      </Box>
    </Box>
  );
}
