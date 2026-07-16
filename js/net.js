// Peer-to-peer rooms over WebRTC (PeerJS).
//
// This is the only file that knows how players reach each other. Everything
// above it talks in terms of "room", "send", "onMessage" — so swapping WebRTC
// for a real server later means rewriting this file and nothing else.
//
// Topology: star, host at the centre.
//
//     client A ──┐
//     client B ──┼──► host (authoritative: owns game state)
//     client C ──┘
//
// Clients never talk to each other. They send intents to the host; the host
// validates them, updates state, and broadcasts the result back out.
//
// The room code IS the peer id (namespaced). The host registers as
// `mrdn-ludo-AB3K9` and joiners connect straight to that id, so there is no
// database and no code→peer lookup table anywhere.
//
// Known limits of this design, by choice:
//   - The host's browser is the authority. If they close the tab, the game ends.
//   - Signalling uses the free public PeerJS broker, which is rate-limited and
//     occasionally flaky. Swap in your own via the PEER_OPTS below if it bites.

const NS = 'mrdn';

// No 0/O/1/I/L — these get misread when someone reads a code out over voice
// chat. 32 chars ^ 5 = ~33.5M codes, which is plenty for concurrent rooms.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LEN = 5;

// Point this at your own PeerServer if the public broker gets unreliable.
//
// The broker only introduces peers; game data goes browser-to-browser, which
// needs a real network path between the two. Two tabs on one machine always
// have one (loopback), which is why local testing never exercises this.
//
// Two *different* machines often have no direct path — including, awkwardly, on
// the same wifi: Chrome hides local IPs behind mDNS `.local` candidates that
// many routers won't resolve, and the STUN-discovered public address is the
// same for both, so it only works if the router hairpins. When both fail the
// only route left is a TURN relay.
//
// The relay is a named account rather than a free public one on purpose. Every
// anonymous relay we relied on has since been switched off — PeerJS's own
// bundled defaults no longer resolve, and openrelay's host now answers 502. A
// relay carries every byte of the game, so an unauthenticated one is a free
// proxy for the whole internet and gets abused until it dies. A key tied to an
// account can be revoked, which is the only reason a free tier survives.
//
// These credentials are public by construction: this file ships to every
// player's browser, so anyone can read them. That is accepted — the blast
// radius is relay quota, not the account. Rotate them in the Metered dashboard
// if they get abused. Do NOT put the dashboard's *API key* here; it can mint
// fresh credentials, which makes it worth more than the quota it protects.
const PEER_OPTS = {
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun.relay.metered.ca:80' },
      {
        urls: [
          'turn:global.relay.metered.ca:80',
          'turn:global.relay.metered.ca:80?transport=tcp',
          'turn:global.relay.metered.ca:443',
          // Port 443/TLS last: it is the slowest to connect but the hardest to
          // block, so it survives networks that only allow HTTPS out.
          'turns:global.relay.metered.ca:443?transport=tcp',
        ],
        username: 'f0d13d045100fd93f41fbe79',
        credential: 'T33BfYL61leMuacm',
      },
    ],
  },
};

export function randomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LEN));
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

export const normaliseCode = (raw) => (raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LEN);
export const isValidCode = (raw) => {
  const c = normaliseCode(raw);
  return c.length === CODE_LEN && [...c].every((ch) => ALPHABET.includes(ch));
};

const peerId = (game, code) => `${NS}-${game}-${code}`;

function newPeer(id) {
  if (typeof window.Peer !== 'function') {
    throw new Error('PeerJS failed to load — check your connection or an ad blocker.');
  }
  return id ? new window.Peer(id, PEER_OPTS) : new window.Peer(PEER_OPTS);
}

// Resolves once the peer is registered with the broker, rejects on fatal error.
function peerReady(peer) {
  return new Promise((resolve, reject) => {
    const ok = () => { cleanup(); resolve(peer); };
    const fail = (err) => { cleanup(); reject(err); };
    const cleanup = () => { peer.off('open', ok); peer.off('error', fail); };
    peer.on('open', ok);
    peer.on('error', fail);
  });
}

/**
 * Host a room. Retries with a fresh code if the broker says the id is taken
 * (someone else already holds that code, or a stale session still owns it).
 *
 * @returns {Promise<Room>} isHost: true
 */
export async function createRoom(game, handlers = {}) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode();
    const peer = newPeer(peerId(game, code));
    try {
      await peerReady(peer);
      return hostRoom(peer, code, handlers);
    } catch (err) {
      peer.destroy();
      if (err?.type === 'unavailable-id') continue; // code collision, try again
      throw friendly(err);
    }
  }
  throw new Error('Could not create a room — every code we tried was taken. Try again.');
}

function hostRoom(peer, code, handlers) {
  const conns = new Map(); // peerId -> DataConnection

  peer.on('connection', (conn) => {
    conn.on('open', () => {
      conns.set(conn.peer, conn);
      handlers.onJoin?.(conn.peer);
    });
    conn.on('data', (msg) => handlers.onMessage?.(msg, conn.peer));
    const drop = () => {
      if (conns.delete(conn.peer)) handlers.onLeave?.(conn.peer);
    };
    conn.on('close', drop);
    conn.on('error', drop);
  });

  // A host peer that dies mid-game (network drop, broker hiccup) cannot be
  // recovered — the room's identity was that peer. Surface it, don't hide it.
  peer.on('error', (err) => {
    if (err?.type === 'peer-unavailable') return; // a client vanished; not fatal
    handlers.onError?.(friendly(err));
  });
  peer.on('disconnected', () => peer.reconnect());

  return {
    isHost: true,
    code,
    selfId: peer.id,
    peerIds: () => [...conns.keys()],
    send(toId, msg) { conns.get(toId)?.send(msg); },
    broadcast(msg) { for (const c of conns.values()) c.send(msg); },
    close() { for (const c of conns.values()) c.close(); peer.destroy(); },
  };
}

/**
 * Join an existing room by code.
 *
 * @returns {Promise<Room>} isHost: false
 */
export async function joinRoom(game, rawCode, handlers = {}) {
  const code = normaliseCode(rawCode);
  if (!isValidCode(code)) throw new Error('That code doesn\'t look right — it should be 5 letters and numbers.');

  const peer = newPeer(null);
  try {
    await peerReady(peer);
  } catch (err) {
    peer.destroy();
    throw friendly(err);
  }

  const conn = peer.connect(peerId(game, code), { reliable: true });

  await new Promise((resolve, reject) => {
    // peer.connect() to a nonexistent id neither opens nor errors promptly, so
    // a "no such room" only ever shows up as silence. Time it out ourselves.
    //
    // A room that exists but is unreachable is *also* silence, so a timeout on
    // its own can't tell "wrong code" from "can't get there" — and blaming the
    // code sends people hunting for a typo that isn't there. The host's answer
    // to our offer is what separates them: an answer can only come from a live
    // host holding that id, so anything failing afterwards is the network path,
    // not the code. signalingState leaves 'have-local-offer' when it lands.
    const pc = conn.peerConnection;
    let answered = false;

    const noRoom = () => new Error(`No room "${code}" — check the code, or ask the host if they're still on the page.`);
    const noPath = () => new Error(`Found room "${code}", but couldn't open a connection to the host. A firewall, VPN, or a router that blocks devices from talking directly will do this.`);

    const timer = setTimeout(() => {
      cleanup();
      peer.destroy();
      reject(answered ? noPath() : noRoom());
    }, 12000);

    const onSignalling = () => { if (pc.signalingState === 'stable') answered = true; };
    const onIceState = () => {
      // 'failed' means ICE ran out of candidate pairs — no timeout needed.
      if (pc.iceConnectionState !== 'failed') return;
      cleanup();
      peer.destroy();
      reject(noPath());
    };

    const ok = () => { cleanup(); resolve(); };
    const fail = (err) => {
      cleanup();
      peer.destroy();
      reject(err?.type === 'peer-unavailable' ? noRoom() : friendly(err));
    };
    const cleanup = () => {
      clearTimeout(timer);
      conn.off('open', ok);
      peer.off('error', fail);
      pc?.removeEventListener('signalingstatechange', onSignalling);
      pc?.removeEventListener('iceconnectionstatechange', onIceState);
    };

    pc?.addEventListener('signalingstatechange', onSignalling);
    pc?.addEventListener('iceconnectionstatechange', onIceState);
    conn.on('open', ok);
    peer.on('error', fail);
  });

  conn.on('data', (msg) => handlers.onMessage?.(msg, conn.peer));
  conn.on('close', () => handlers.onLeave?.(conn.peer));
  peer.on('error', (err) => handlers.onError?.(friendly(err)));
  peer.on('disconnected', () => peer.reconnect());

  return {
    isHost: false,
    code,
    selfId: peer.id,
    peerIds: () => [conn.peer],
    send(_toId, msg) { conn.send(msg); },   // clients only ever talk to the host
    broadcast(msg) { conn.send(msg); },
    close() { conn.close(); peer.destroy(); },
  };
}

// PeerJS error messages are developer-facing ("Could not connect to peer
// mrdn-ludo-XK29P"). Translate the ones players can actually hit.
function friendly(err) {
  const type = err?.type;
  if (type === 'browser-incompatible') return new Error('This browser can\'t do WebRTC — try Chrome, Edge, Firefox or Safari.');
  if (type === 'network' || type === 'server-error' || type === 'socket-error' || type === 'socket-closed') {
    return new Error('Lost contact with the matchmaking server. Check your connection and try again.');
  }
  if (type === 'unavailable-id') return new Error('That room code is already taken.');
  if (type === 'webrtc') return new Error('Couldn\'t open a direct connection. A strict firewall or VPN can block this.');
  return err instanceof Error ? err : new Error(String(err?.message || err || 'Unknown network error'));
}
