import { useCallback, useEffect, useState } from 'react';
import type { EnvReport, EventServerMessage, SessionInfo } from '@agenthouse/protocol';
import { api, socketUrl } from './client';

/** Live session list from /ws/events, reconnecting with backoff while the server restarts. */
export function useSessions(): { sessions: SessionInfo[]; connected: boolean; loaded: boolean } {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [connected, setConnected] = useState(true);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let delay = 500;
    let stopped = false;

    const connect = () => {
      ws = new WebSocket(socketUrl('/ws/events'));
      ws.onopen = () => {
        delay = 500;
        setConnected(true);
      };
      ws.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as EventServerMessage;
        if (message.type === 'sessions') {
          setSessions(message.sessions);
          setLoaded(true);
        }
      };
      ws.onclose = () => {
        if (stopped) return;
        setConnected(false);
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

  return { sessions, connected, loaded };
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
