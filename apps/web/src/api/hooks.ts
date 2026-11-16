import { useCallback, useEffect, useRef, useState } from 'react';
import type { AccountLimits, DelegationInfo, EnvReport, EventServerMessage, SessionInfo, SessionLink } from '@agenthouse/protocol';
import { keepUnchanged } from '../workspace/sessions';
import { api, openSocket } from './client';

/**
 * Live sessions, plan usage and session links from /ws/events, reconnecting with backoff while the server restarts.
 * `onSessions` is given every list as it arrives, in order: lists that arrive together are drawn as
 * one, so what is drawn can skip a state a session was in for a moment.
 */
export function useSessions(onSessions?: (sessions: SessionInfo[]) => void): {
  sessions: SessionInfo[];
  limits: AccountLimits[];
  links: SessionLink[];
  delegations: DelegationInfo[];
  connected: boolean;
  loaded: boolean;
} {
  const arrived = useRef(onSessions);
  arrived.current = onSessions;
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [limits, setLimits] = useState<AccountLimits[]>([]);
  const [links, setLinks] = useState<SessionLink[]>([]);
  const [delegations, setDelegations] = useState<DelegationInfo[]>([]);
  const [connected, setConnected] = useState(true);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let delay = 500;
    let stopped = false;

    const connect = () => {
      ws = openSocket('/ws/events');
      ws.onopen = () => {
        delay = 500;
        setConnected(true);
      };
      ws.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as EventServerMessage;
        if (message.type === 'sessions') {
          arrived.current?.(message.sessions);
          setSessions((current) => keepUnchanged(current, message.sessions));
          setLoaded(true);
        } else if (message.type === 'limits') {
          setLimits(message.limits);
        } else if (message.type === 'links') {
          setLinks(message.links);
        } else if (message.type === 'delegations') {
          setDelegations(message.delegations);
        }
      };
      ws.onclose = () => {
        if (stopped) return;
        setConnected(false);
        // A refused socket looks like a lost server; the API tells the two apart (and shows the login page).
        api.auth().catch(() => {});
        retry = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 8000);
      };
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      ws?.close();
    };
  }, []);

  return { sessions, limits, links, delegations, connected, loaded };
}

export function useEnv(): { env: EnvReport | null; refresh: () => Promise<void>; loading: boolean } {
  const [env, setEnv] = useState<EnvReport | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (refresh: boolean) => {
    setLoading(true);
    try {
      setEnv(await api.env(refresh));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(false).catch(() => {});
  }, [load]);

  return { env, loading, refresh: () => load(true) };
}
