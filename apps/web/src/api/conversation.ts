import { useEffect, useState } from 'react';
import type { ConversationEntry, ConversationServerMessage, ConversationTurn } from '@agenthouse/protocol';
import { socketUrl } from './client';

export interface Conversation {
  turns: ConversationTurn[];
  /** In the order they happened. */
  entries: ConversationEntry[];
  /** The first full copy has arrived. */
  ready: boolean;
}

const EMPTY: Conversation = { turns: [], entries: [], ready: false };

/** A session's conversation (or a sub-agent's) from /ws/conversation: a full copy first, then changes; reconnects with backoff. */
export function useConversation(sessionId: string | null, agentId: string | null = null, turnsOnly = false): Conversation {
  const [conversation, setConversation] = useState<Conversation>(EMPTY);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let delay = 500;
    let stopped = false;
    let turns: ConversationTurn[] = [];
    let order: string[] = [];
    let byId = new Map<string, ConversationEntry>();
    setConversation(EMPTY);
    // Nothing to read (no transcript): no socket at all.
    if (!sessionId) return;

    const connect = () => {
      ws = new WebSocket(socketUrl(`/ws/conversation?id=${encodeURIComponent(sessionId)}${agentId ? `&agent=${encodeURIComponent(agentId)}` : ''}${turnsOnly ? '&turns=only' : ''}`));
      ws.onopen = () => {
        delay = 500;
      };
      ws.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as ConversationServerMessage;
        if (message.type === 'reset') {
          turns = [];
          order = [];
          byId = new Map();
        }
        for (const turn of message.turns) turns[turn.index] = turn;
        for (const entry of message.entries) {
          if (!byId.has(entry.id)) order.push(entry.id);
          byId.set(entry.id, entry);
        }
        setConversation({ turns: turns.filter(Boolean), entries: order.map((id) => byId.get(id)!), ready: true });
      };
      ws.onclose = () => {
        if (stopped) return;
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
  }, [sessionId, agentId, turnsOnly]);

  return conversation;
}
