import { useEffect, useRef, useState } from 'react';
import type { ConversationEntry, ConversationServerMessage, ConversationTurn } from '@agenthouse/protocol';
import { openSocket } from './client';

export interface Conversation {
  turns: ConversationTurn[];
  /** In the order they happened. */
  entries: ConversationEntry[];
  /** The first full copy has arrived. */
  ready: boolean;
}

const EMPTY: Conversation = { turns: [], entries: [], ready: false };

/**
 * Follows a session's conversation (or a sub-agent's) over /ws/conversation: a full copy first, then
 * changes, each told as the whole of it so far; reconnects with backoff. Returns how to stop.
 */
function follow(sessionId: string, agentId: string | null, turnsOnly: boolean, tell: (conversation: Conversation) => void): () => void {
  let ws: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let delay = 500;
  let stopped = false;
  let turns: ConversationTurn[] = [];
  let order: string[] = [];
  let byId = new Map<string, ConversationEntry>();

  const connect = () => {
    ws = openSocket(`/ws/conversation?id=${encodeURIComponent(sessionId)}${agentId ? `&agent=${encodeURIComponent(agentId)}` : ''}${turnsOnly ? '&turns=only' : ''}`);
    ws.onopen = () => {
      delay = 500;
    };
    ws.onmessage = (event) => {
      // What was on its way when the following stopped is told to nobody.
      if (stopped) return;
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
      tell({ turns: turns.filter(Boolean), entries: order.map((id) => byId.get(id)!), ready: true });
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
}

/** A session's conversation (or a sub-agent's) from /ws/conversation: a full copy first, then changes; reconnects with backoff. */
export function useConversation(sessionId: string | null, agentId: string | null = null, turnsOnly = false): Conversation {
  const [conversation, setConversation] = useState<Conversation>(EMPTY);

  useEffect(() => {
    setConversation(EMPTY);
    // Nothing to read (no transcript): no socket at all.
    if (!sessionId) return undefined;
    return follow(sessionId, agentId, turnsOnly, setConversation);
  }, [sessionId, agentId, turnsOnly]);

  return conversation;
}

/**
 * The turns of several sessions at once, by session: for a view that lays the work of all of them
 * side by side. Each is followed for as long as it is asked for; one no longer asked for is let go,
 * and the others stay as they are.
 */
export function useTurns(sessionIds: string[]): ReadonlyMap<string, ConversationTurn[]> {
  const [turns, setTurns] = useState<ReadonlyMap<string, ConversationTurn[]>>(new Map());
  const followed = useRef(new Map<string, () => void>());
  const wanted = sessionIds.join('\n');

  useEffect(() => {
    const ids = new Set(wanted ? wanted.split('\n') : []);
    for (const [id, stop] of followed.current) {
      if (ids.has(id)) continue;
      stop();
      followed.current.delete(id);
      setTurns((current) => new Map([...current].filter(([known]) => known !== id)));
    }
    for (const id of ids) {
      if (followed.current.has(id)) continue;
      followed.current.set(
        id,
        follow(id, null, true, (conversation) => setTurns((current) => new Map(current).set(id, conversation.turns))),
      );
    }
  }, [wanted]);

  // Let go of all of them with the view.
  useEffect(() => {
    const all = followed.current;
    return () => {
      for (const stop of all.values()) stop();
      all.clear();
    };
  }, []);

  return turns;
}
