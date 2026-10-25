# Presence Playground

A runnable, presence-only collaboration demo: multiple users open the same Next.js page, join the same room, and see each other's named, colored cursor pointers in real time.

## Included

- Next.js App Router + TypeScript
- Tailwind CSS
- Socket.IO over WebSockets (with polling fallback)
- Custom Node server that hosts Next.js and Socket.IO on the same port
- In-memory room/session registry
- Join/leave lifecycle and disconnect cleanup
- Live named cursor overlays and participant roster
- Reconnect handling
- No database required

## Requirements

- Node.js 20.9+ (Node.js 22 LTS recommended)
- npm

## Run locally

```bash
npm install
npm run dev
```

Open <http://localhost:3000>.

1. Enter a display name and room ID, e.g. `Alice` / `team-room`.
2. Open a second browser tab or a separate browser window at `http://localhost:3000`.
3. Join using `Bob` and the exact same room ID: `team-room`.
4. Move each mouse around the canvas. Both clients should see each other's named cursor.
5. Close one tab or click **Leave room**; the remaining client should see that participant disappear.

For a meaningful test, use two separate browser windows side by side. You can also test with different browsers on the same machine.

## How it works

- `server.ts` starts Next.js and Socket.IO on one HTTP server.
- When a client joins, the server sends the client a snapshot of existing room participants.
- The server announces new participants to existing room members.
- Pointer positions are sent as percentages relative to the canvas, not raw screen pixels. Each client can therefore render the pointer relative to its own canvas size.
- Incoming presence updates are broadcast to other room members.
- When a socket disconnects, the server removes its presence and broadcasts a leave event.

## Important limitations

This is a learning/demo implementation, not a production-ready collaboration service.

- The room ID is not a security boundary. Anyone who knows a room ID can join it.
- Display names are user-provided and not authenticated.
- Presence lives in process memory. Restarting the server clears all sessions.
- A single in-memory registry only works for one server process. Multiple instances require shared state and cross-instance message fan-out (for example, a Socket.IO Redis adapter and suitable session handling).
- This tracks pointer position on a shared canvas. It does not synchronize document edits or text selections.
- Cursor position is updated while the pointer is over the canvas; it remains at the last known position when the pointer leaves the canvas.

Before deploying publicly, add authentication, authorize room membership on the server, enforce per-user connection limits, validate payloads, add rate limiting, and configure appropriate transport/security settings.

## Useful commands

```bash
npm run typecheck
npm run build
npm start
```

`npm start` uses the custom server in production mode. Run `npm run build` before `npm start`.

## Project structure

```text
app/
  globals.css
  layout.tsx
  page.tsx
  presence-playground.tsx
server.ts
package.json
tsconfig.json
tailwind.config.ts
postcss.config.mjs
```
