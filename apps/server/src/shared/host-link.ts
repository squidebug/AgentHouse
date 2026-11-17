import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { HOST_PROTOCOL, validHostProof, WEB_PROOF_SINCE, webProof, type HostMessage, type HostState } from './host-protocol';

export type Hello = Extract<HostMessage, { type: 'hello' }>;

/** The control channel to a session host that proved itself, and what it said first. */
export interface ControlLink {
  ws: WebSocket;
  hello: Hello;
}

/**
 * The headers of a connection to the host of this state, and the nonce in
 * them: a new one each time, with the proof that the caller holds the host's
 * token. Only a host from before such proofs is sent the token itself.
 */
export function hostAuth(state: HostState): { nonce: string; headers: Record<string, string> } {
  const nonce = randomBytes(24).toString('base64url');
  const presented = state.protocol >= WEB_PROOF_SINCE ? webProof(state.token, nonce) : state.token;
  return { nonce, headers: { authorization: `Bearer ${presented}`, 'x-agenthouse-nonce': nonce } };
}

/**
 * Opens the control channel and waits for the host's hello; null if nothing
 * usable answers. The hello must prove the host knows the token, before
 * anything is sent to it or taken from it; what listens there is not sent the
 * token to make that proof with. Used by web servers, and by a starting host
 * to see whether one already runs.
 */
export function openControl(state: HostState, timeoutMs: number, protocol = HOST_PROTOCOL): Promise<ControlLink | null> {
  return new Promise((resolve) => {
    const { nonce, headers } = hostAuth(state);
    const ws = new WebSocket(`ws://127.0.0.1:${state.port}/control`, { headers });
    const fail = () => {
      clearTimeout(timer);
      ws.removeAllListeners();
      ws.on('error', () => {});
      ws.terminate();
      resolve(null);
    };
    const timer = setTimeout(fail, timeoutMs);
    ws.once('error', fail);
    ws.once('message', (raw) => {
      let message: HostMessage | null = null;
      try {
        message = JSON.parse(raw.toString()) as HostMessage;
      } catch {
        // not a host
      }
      if (message?.type !== 'hello' || message.protocol !== protocol || !validHostProof(state.token, nonce, message.proof)) return fail();
      clearTimeout(timer);
      ws.removeAllListeners();
      ws.on('error', () => {});
      resolve({ ws, hello: message });
    });
  });
}

/** True when a host answers at this state (a starting host asks, so two never run). */
export async function probeHost(state: HostState): Promise<boolean> {
  const link = await openControl(state, 1500, state.protocol);
  link?.ws.close();
  return Boolean(link);
}
