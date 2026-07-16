# Meridian

Browser games to play with friends. Static site — no build step, no server, no database.

- **Meridian** — guess the mystery country; warmer means closer. Single player.
- **Ludo** — classic rules, 2–4 players, online via a room code.

## Running it locally

The app uses native ES modules, which browsers refuse to load over `file://`. So
opening `index.html` by double-clicking **will not work** — you need to serve it:

```bash
npm start                  # http://localhost:8080
# or, with no npm at all:
python -m http.server 8080
```

Deployment is unchanged: upload the folder to any static host. There is nothing
to build.

## Tests

```bash
npm test                   # rules engine (node, no browser needed)
```

Then, with a server running, open:

- `test/harness.html` — runs two Ludo players side by side in one page against a
  fake PeerJS broker, and checks they stay in sync. Prints pass/fail.
- `test/smoke-real.html` — the same handshake against the **real** PeerJS
  network. Needs working UDP, so it's manual and not part of `npm test`.

## How multiplayer works

There is no backend. Players connect directly to each other over WebRTC
(PeerJS). **The room code is the peer id**: the host registers itself as
`mrdn-ludo-<CODE>`, and joiners connect straight to that id. That's why no
database or code→room lookup exists anywhere.

The host is authoritative — it owns the game state. Everyone else sends
*intents* ("roll", "move token 2"); the host validates them, applies the rules,
and broadcasts the whole room back:

```
client: click ──► {t:'move', i} ──► host: validate → apply → broadcast
client: render ◄────── {t:'room', room} ◄──────────────────┘
```

The host runs its own clicks through the same path, so there is only one code
path and the host can't accidentally cheat.

### Trade-offs you should know about

- **If the host closes their tab, the game ends.** The room's identity *is* the
  host's peer. Nobody can take over.
- Signalling uses the free public PeerJS broker. It's rate-limited and
  occasionally flaky. Point `PEER_OPTS` in `js/net.js` at your own PeerServer if
  it becomes a problem.
- Strict corporate firewalls / some VPNs block WebRTC entirely.
- **Players on different networks usually can't reach each other directly**, so
  their traffic is relayed by a TURN server — a Metered account, configured in
  `PEER_OPTS`. It has a monthly bandwidth quota. If joining starts failing with
  *"Found room … but couldn't open a connection"* for everyone at once, check
  the quota and the key first: that message means signalling worked and only the
  relay path is broken. The credentials in that file are public by design (they
  ship to every browser); rotate them in the dashboard if abused. Don't replace
  them with a free anonymous relay — the last two we used, PeerJS's bundled
  defaults and openrelay, were both shut down.

To move to a real backend later, rewrite `js/net.js` and nothing else — it's the
only file that knows how players reach each other.

## Ludo rules implemented

- Need a **6** to bring a token out of the yard.
- Roll a **6** → extra turn. **Three 6s in a row** → turn forfeited, third roll void.
- Landing on a lone enemy sends it home and grants an **extra turn**.
- **Safe squares** (the 4 start squares + 4 stars): no captures there.
- **Blocks**: two of your tokens on one square can't be captured. They do *not*
  bar passage — others may move through and land on them.
- Home needs an **exact** roll; overshooting isn't a legal move.
- First player to get all four tokens home wins.

## Layout

```
index.html            shell: header + tab strip
css/app.css           design tokens, header, tabs, shared controls
css/meridian.css      \ per-game styling, scoped to #panel-<game>
css/ludo.css          /
js/app.js             tab router + game registry
js/net.js             room layer (the only networking code)
js/data/countries.js  generated country geometry blob
js/games/meridian.js
js/games/ludo/
  rules.js            pure game logic — no DOM, no network
  board.js            15x15 board coordinates
  index.js            lobby, board UI, net glue
test/
```

### Adding a game

1. Write a module exporting `{ id, title, init(root, header) }`. `init` runs once,
   lazily, the first time its tab is opened.
2. Add it to `GAMES` in `js/app.js`.
3. Style it in `css/<id>.css`, scoped to `#panel-<id>`, and link it in `index.html`.

Panels stay in the DOM once opened, so switching tabs never destroys a game in
progress. **Don't set `display` on `#panel-<id>`** — an id selector outranks the
shell's `.panel[hidden]` rule and your game will leak onto every other tab.

For a multiplayer game, reuse `js/net.js`: `createRoom(gameId, handlers)` /
`joinRoom(gameId, code, handlers)`. The game id namespaces the peer ids, so the
same code in two different games never collides.
