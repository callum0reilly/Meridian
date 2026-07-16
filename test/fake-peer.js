// An in-memory stand-in for PeerJS, for driving two players in one page.
//
// It mimics the parts of the PeerJS surface net.js actually uses — id
// registration, unavailable-id, peer-unavailable, connection/open/data/close —
// so the real net.js and the real game code run unmodified against it. Only the
// WebRTC transport is faked.
//
// Test-only. Never loaded by index.html.

const registry = new Map(); // id -> FakePeer

class Emitter {
  #handlers = new Map();
  on(ev, fn) { (this.#handlers.get(ev) ?? this.#handlers.set(ev, []).get(ev)).push(fn); return this; }
  off(ev, fn) {
    const list = this.#handlers.get(ev);
    if (list) this.#handlers.set(ev, list.filter((f) => f !== fn));
    return this;
  }
  emit(ev, ...args) { for (const fn of [...(this.#handlers.get(ev) ?? [])]) fn(...args); }
  // Deliver on a later tick, the way a real network would.
  later(ev, ...args) { setTimeout(() => this.emit(ev, ...args), 0); }
}

class FakeConn extends Emitter {
  constructor(peer, remoteId) {
    super();
    this.peer = remoteId;       // PeerJS: conn.peer is the *other* end's id
    this._peer = peer;
    this._open = false;
  }
  send(data) {
    if (!this._open) return;
    // Structured-clone to catch anything unserialisable being put on the wire.
    const copy = structuredClone(data);
    this._other?.later('data', copy);
  }
  close() {
    if (!this._open) return;
    this._open = false;
    this._other._open = false;
    this.later('close');
    this._other.later('close');
  }
}

export class FakePeer extends Emitter {
  constructor(id, _opts) {
    super();
    this.id = typeof id === 'string' ? id : 'anon-' + Math.random().toString(36).slice(2, 9);
    this.destroyed = false;
    if (typeof id === 'string' && registry.has(id)) {
      this.later('error', Object.assign(new Error('ID is taken'), { type: 'unavailable-id' }));
      return;
    }
    registry.set(this.id, this);
    this.later('open', this.id);
  }

  connect(targetId) {
    const target = registry.get(targetId);
    const local = new FakeConn(this, targetId);
    if (!target) {
      this.later('error', Object.assign(new Error('peer unavailable'), { type: 'peer-unavailable' }));
      return local; // never opens, exactly like PeerJS
    }
    const remote = new FakeConn(target, this.id);
    local._other = remote;
    remote._other = local;
    setTimeout(() => {
      local._open = true;
      remote._open = true;
      // Host learns about the connection first, then both ends open.
      target.emit('connection', remote);
      setTimeout(() => { remote.emit('open'); local.emit('open'); }, 0);
    }, 0);
    return local;
  }

  reconnect() {}
  destroy() { this.destroyed = true; registry.delete(this.id); }
}

export const install = () => { window.Peer = FakePeer; };
export const reset = () => registry.clear();
