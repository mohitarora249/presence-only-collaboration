"use client";

import { FormEvent, MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";

type PresenceUser = {
  clientId: string;
  userId: string;
  name: string;
  color: string;
  roomId: string;
  x: number;
  y: number;
  updatedAt: number;
};

type ServerToClientEvents = {
  "presence:sync": (users: PresenceUser[]) => void;
  "presence:joined": (user: PresenceUser) => void;
  "presence:updated": (user: PresenceUser) => void;
  "presence:left": (payload: { clientId: string }) => void;
  "presence:error": (message: string) => void;
};

type ClientToServerEvents = {
  "presence:join": (payload: { name: string; roomId: string }) => void;
  "presence:move": (payload: { x: number; y: number; final?: boolean }) => void;
};

type PresenceSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const DEFAULT_NAME = `Guest ${Math.floor(100 + Math.random() * 900)}`;
const DEFAULT_ROOM = "team-room";
const MOVE_SEND_INTERVAL_MS = 35;
const MOVE_SETTLE_DELAY_MS = 100;
// Time constant for easing remote cursors toward their latest position. Roughly the
// send interval, so motion stays continuous between updates without adding much lag.
const REMOTE_SMOOTHING_MS = 40;
// Distance (in canvas %) below which a remote cursor snaps to its target and stops animating.
const REMOTE_SNAP_EPSILON = 0.01;

function initials(name: string) {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("") || "?";
}

function CursorArrow({ color }: { color: string }) {
  return (
    <svg className="cursor-arrow" viewBox="0 0 20 26" aria-hidden="true">
      <path d="M1.2 1.2L1.2 21.1L6.1 16.2L10.3 24.4L13.7 22.7L9.6 14.8L16.3 14.2Z" fill={color} stroke="white" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

export default function PresencePlayground() {
  const canvasRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<PresenceSocket | null>(null);
  const lastMoveSentAt = useRef(0);
  const pendingPosition = useRef<{ x: number; y: number } | null>(null);
  const frameRef = useRef<number | null>(null);
  const trailingTimerRef = useRef<number | null>(null);
  const settleTimerRef = useRef<number | null>(null);

  const [nameInput, setNameInput] = useState(DEFAULT_NAME);
  const [roomInput, setRoomInput] = useState(DEFAULT_ROOM);
  const [name, setName] = useState("");
  const [roomId, setRoomId] = useState("");
  const [connected, setConnected] = useState(false);
  const [joined, setJoined] = useState(false);
  const [users, setUsers] = useState<PresenceUser[]>([]);
  const [error, setError] = useState("");
  // The local cursor is moved by writing to the DOM directly, so mouse moves
  // don't re-render the whole component.
  const localCursorRef = useRef<HTMLDivElement>(null);
  const localPosition = useRef({ x: 50, y: 50 });
  // Remote cursors follow the same pattern: `users` state only holds the roster
  // (join/leave), while live positions live here and are written to the DOM.
  // remotePositions holds the latest target from the server; remoteRendered holds
  // where each cursor is currently drawn while it eases toward that target.
  const remotePositions = useRef(new Map<string, { x: number; y: number }>());
  const remoteRendered = useRef(new Map<string, { x: number; y: number }>());
  const remoteCursorEls = useRef(new Map<string, HTMLDivElement>());
  const smoothFrameRef = useRef<number | null>(null);

  const sortedUsers = useMemo(
    () => [...users].sort((a, b) => a.name.localeCompare(b.name)),
    [users]
  );

  useEffect(() => {
    const socket: PresenceSocket = io({
      autoConnect: false,
      transports: ["websocket", "polling"]
    });
    socketRef.current = socket;

    // Eases every remote cursor toward its target once per frame. The loop only runs
    // while some cursor is still moving, and stops itself once all have arrived.
    let lastSmoothTick = 0;
    const smoothTick = (now: number) => {
      // Frame-rate independent exponential easing; a long gap (e.g. a background tab)
      // makes alpha ~1 so cursors snap instead of crawling across the canvas.
      const alpha = 1 - Math.exp(-(now - lastSmoothTick) / REMOTE_SMOOTHING_MS);
      lastSmoothTick = now;
      let moving = false;

      for (const [clientId, target] of remotePositions.current) {
        const rendered = remoteRendered.current.get(clientId) ?? target;
        let x = rendered.x + (target.x - rendered.x) * alpha;
        let y = rendered.y + (target.y - rendered.y) * alpha;

        if (Math.abs(target.x - x) < REMOTE_SNAP_EPSILON && Math.abs(target.y - y) < REMOTE_SNAP_EPSILON) {
          x = target.x;
          y = target.y;
        } else {
          moving = true;
        }

        remoteRendered.current.set(clientId, { x, y });
        const el = remoteCursorEls.current.get(clientId);
        if (el) el.style.transform = `translate(${x}%, ${y}%)`;
      }

      smoothFrameRef.current = moving ? requestAnimationFrame(smoothTick) : null;
    };
    const startSmoothing = () => {
      if (smoothFrameRef.current !== null) return;
      lastSmoothTick = performance.now();
      smoothFrameRef.current = requestAnimationFrame(smoothTick);
    };

    socket.on("connect", () => {
      setConnected(true);
      setError("");
      // Rejoin after a reconnect because the server's in-memory session is new.
      const currentName = sessionStorage.getItem("presence-demo-name");
      const currentRoom = sessionStorage.getItem("presence-demo-room");
      if (currentName && currentRoom) {
        socket.emit("presence:join", { name: currentName, roomId: currentRoom });
      }
    });

    socket.on("disconnect", () => {
      setConnected(false);
      setUsers([]);
      remotePositions.current.clear();
      remoteRendered.current.clear();
    });

    socket.on("connect_error", () => {
      setError("Could not connect to the presence server. Check that npm run dev is running.");
    });

    socket.on("presence:sync", (incoming) => {
      remotePositions.current = new Map(
        incoming.map((user) => [user.clientId, { x: user.x, y: user.y }])
      );
      // Existing participants appear at their current spot rather than gliding in.
      remoteRendered.current = new Map(
        incoming.map((user) => [user.clientId, { x: user.x, y: user.y }])
      );
      setUsers(incoming);
      setJoined(true);
      setError("");
    });

    socket.on("presence:joined", (incoming) => {
      remotePositions.current.set(incoming.clientId, { x: incoming.x, y: incoming.y });
      remoteRendered.current.set(incoming.clientId, { x: incoming.x, y: incoming.y });
      setUsers((current) => current.some((user) => user.clientId === incoming.clientId)
        ? current
        : [...current, incoming]);
    });

    socket.on("presence:updated", (incoming) => {
      // Ignore updates for clients we haven't seen join, as before.
      if (!remotePositions.current.has(incoming.clientId)) return;
      remotePositions.current.set(incoming.clientId, { x: incoming.x, y: incoming.y });
      startSmoothing();
    });

    socket.on("presence:left", ({ clientId }) => {
      remotePositions.current.delete(clientId);
      remoteRendered.current.delete(clientId);
      setUsers((current) => current.filter((user) => user.clientId !== clientId));
    });

    socket.on("presence:error", (message) => setError(message));

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      if (smoothFrameRef.current !== null) cancelAnimationFrame(smoothFrameRef.current);
      if (trailingTimerRef.current !== null) clearTimeout(trailingTimerRef.current);
      if (settleTimerRef.current !== null) clearTimeout(settleTimerRef.current);
    };
  }, []);

  const joinRoom = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const cleanName = nameInput.trim().slice(0, 32);
    const cleanRoom = roomInput.trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);

    if (!cleanName || !cleanRoom) {
      setError("Please enter a display name and room ID.");
      return;
    }

    setName(cleanName);
    setRoomId(cleanRoom);
    sessionStorage.setItem("presence-demo-name", cleanName);
    sessionStorage.setItem("presence-demo-room", cleanRoom);
    setError("");
    setUsers([]);

    const socket = socketRef.current;
    if (!socket) {
      setError("The socket client is not ready yet. Try again in a moment.");
      return;
    }

    // If already connected, joining emits a new room request immediately.
    if (socket.connected) {
      socket.emit("presence:join", { name: cleanName, roomId: cleanRoom });
    } else {
      socket.connect();
    }
  }, [nameInput, roomInput]);

  const sendPendingMove = useCallback(() => {
    const position = pendingPosition.current;
    if (!position) return;
    // Volatile: if the transport isn't ready, drop this move rather than buffering it;
    // only the latest position matters and stale ones would replay as lag.
    socketRef.current?.volatile.emit("presence:move", position);
    pendingPosition.current = null;
    lastMoveSentAt.current = Date.now();
  }, []);

  const handleCanvasMove = useCallback((event: MouseEvent<HTMLDivElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || !joined) return;

    const rect = canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(100, ((event.clientX - rect.left) / rect.width) * 100));
    const y = Math.max(0, Math.min(100, ((event.clientY - rect.top) / rect.height) * 100));

    localPosition.current = { x, y };
    if (localCursorRef.current) {
      localCursorRef.current.style.transform = `translate(${x}%, ${y}%)`;
    }
    pendingPosition.current = { x, y };

    // Moves are volatile and may be dropped under congestion, so once the pointer
    // settles, send its resting position reliably.
    if (settleTimerRef.current !== null) clearTimeout(settleTimerRef.current);
    settleTimerRef.current = window.setTimeout(() => {
      settleTimerRef.current = null;
      socketRef.current?.emit("presence:move", { x, y, final: true });
    }, MOVE_SETTLE_DELAY_MS);

    // Coalesce high-frequency pointer events to at most one send per animation frame,
    // with a small time gate to avoid flooding the socket. A send already scheduled
    // (frame or trailing timer) will pick up the latest pendingPosition.
    if (frameRef.current !== null || trailingTimerRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const wait = MOVE_SEND_INTERVAL_MS - (Date.now() - lastMoveSentAt.current);
      if (wait <= 0) {
        sendPendingMove();
        return;
      }
      // Too soon to send: schedule a trailing send instead of dropping the position,
      // so the final resting point always reaches other clients.
      trailingTimerRef.current = window.setTimeout(() => {
        trailingTimerRef.current = null;
        sendPendingMove();
      }, wait);
    });
  }, [joined, sendPendingMove]);

  const leaveRoom = useCallback(() => {
    if (trailingTimerRef.current !== null) {
      clearTimeout(trailingTimerRef.current);
      trailingTimerRef.current = null;
    }
    if (settleTimerRef.current !== null) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
    pendingPosition.current = null;
    socketRef.current?.disconnect();
    setJoined(false);
    setConnected(false);
    setUsers([]);
    setName("");
    setRoomId("");
    sessionStorage.removeItem("presence-demo-name");
    sessionStorage.removeItem("presence-demo-room");
  }, []);

  const localUser = useMemo<Omit<PresenceUser, "x" | "y" | "updatedAt"> | null>(() => {
    if (!joined || !name || !roomId || !socketRef.current?.id) return null;
    return {
      clientId: socketRef.current.id,
      userId: "local",
      name,
      color: "#344054",
      roomId
    };
  }, [joined, name, roomId]);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">P</div>
          <div>
            <h1>Presence Playground</h1>
            <p>Real-time collaboration demo</p>
          </div>
        </div>
        <div className="connection-pill">
          <span className={`status-dot ${connected ? "online" : ""}`} />
          {connected ? "Connected to presence server" : "Not connected"}
        </div>
      </header>

      <div className="layout">
        <section className="panel document-panel">
          <div className="document-toolbar">
            <div className="document-heading">
              <div className="document-icon" aria-hidden="true">
                <svg width="20" height="22" viewBox="0 0 20 22" fill="none">
                  <path d="M3 1.5H12L17 6.5V20.5H3V1.5Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
                  <path d="M12 1.5V6.5H17M6 11H14M6 14.5H14M6 18H11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
                </svg>
              </div>
              <div>
                <h2>Shared workspace</h2>
                <p>Move your pointer around the canvas</p>
              </div>
            </div>
            {joined && <div className="room-label">Room: {roomId}</div>}
          </div>

          <div
            className="canvas"
            ref={canvasRef}
            onMouseMove={handleCanvasMove}
            onMouseLeave={() => {
              // Keep the last position visible, just like a cursor that stopped moving.
            }}
            aria-label="Shared presence canvas"
          >
            <div className="canvas-hint">
              {joined ? "Move your mouse — others see your cursor live" : "Join a room to start"}
            </div>

            <article className="demo-card one">
              <div className="eyebrow">Workspace / 01</div>
              <h3>Product direction</h3>
              <p>Align on the problem, define the user journey, and keep the team focused on outcomes.</p>
            </article>
            <article className="demo-card two">
              <div className="eyebrow">Workspace / 02</div>
              <h3>Next steps</h3>
              <p>Share feedback, review the plan, and coordinate work together in real time.</p>
            </article>

            {joined && localUser && (
              <div
                className="cursor-layer local"
                ref={localCursorRef}
                // Seeds the position on mount; afterwards handleCanvasMove updates it directly.
                style={{ transform: `translate(${localPosition.current.x}%, ${localPosition.current.y}%)` }}
              >
                <div className="remote-cursor" aria-label="Your pointer">
                  <CursorArrow color={localUser.color} />
                  <span className="cursor-label me" style={{ backgroundColor: localUser.color }}>
                    {localUser.name} (you)
                  </span>
                </div>
              </div>
            )}

            {users.map((user) => {
              // Use the drawn position so a re-render mid-glide doesn't jump the cursor.
              const position = remoteRendered.current.get(user.clientId)
                ?? remotePositions.current.get(user.clientId)
                ?? user;
              return (
                <div
                  className="cursor-layer"
                  key={user.clientId}
                  ref={(el) => {
                    if (el) remoteCursorEls.current.set(user.clientId, el);
                    else remoteCursorEls.current.delete(user.clientId);
                  }}
                  // Seeds the position on mount; the smoothing loop writes it directly afterwards.
                  style={{ transform: `translate(${position.x}%, ${position.y}%)` }}
                >
                  <div className="remote-cursor" aria-label={`${user.name}'s pointer`}>
                    <CursorArrow color={user.color} />
                    <span className="cursor-label" style={{ backgroundColor: user.color }}>
                      {user.name}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <aside className="panel sidebar">
          <div className="people-heading">
            <h2>In this room</h2>
            <span className="people-count">{joined ? users.length + 1 : users.length} {((joined ? users.length + 1 : users.length) === 1) ? "person" : "people"}</span>
          </div>
          <p className="sidebar-subtitle">Everyone in the same room sees live cursor positions.</p>

          <div className="people-list">
            {joined && (
              <div className="person">
                <div className="avatar" style={{ backgroundColor: "#344054" }}>{initials(name)}</div>
                <div className="person-copy">
                  <div className="person-name">{name}</div>
                  <div className="person-meta">You · active now</div>
                </div>
                <span className="you-tag">YOU</span>
              </div>
            )}
            {sortedUsers.map((user) => (
              <div className="person" key={user.clientId}>
                <div className="avatar" style={{ backgroundColor: user.color }}>{initials(user.name)}</div>
                <div className="person-copy">
                  <div className="person-name">{user.name}</div>
                  <div className="person-meta">Cursor sharing enabled</div>
                </div>
                <span className="status-dot online" />
              </div>
            ))}
            {!joined && (
              <div className="empty-state">
                Join a room to share your cursor. Open this app in another browser window and enter the same room ID to test multi-user presence.
              </div>
            )}
          </div>

          <div className="sidebar-divider" />
          <div className="howto">
            <h3>Try it out</h3>
            <p><strong>1.</strong> Join with a display name and room ID.</p>
            <p><strong>2.</strong> Open another tab or browser and join the same room.</p>
            <p><strong>3.</strong> Move each pointer around the canvas and watch the cursors update.</p>
            <p><strong>4.</strong> Close a tab; its presence should disappear for everyone else.</p>
          </div>

          {joined && (
            <>
              <div className="sidebar-divider" />
              <button className="primary-button" onClick={leaveRoom} type="button">Leave room</button>
            </>
          )}
        </aside>
      </div>

      <p className="footer-note">
        Demo only: presence is held in server memory and is cleared when the server restarts. Do not expose this prototype publicly without adding authentication, room authorization, rate limits, and a shared presence layer for multiple server instances.
      </p>

      {!joined && (
        <div className="join-backdrop">
          <form className="join-card" onSubmit={joinRoom}>
            <h2>Join the shared room</h2>
            <p>Give yourself a name and choose a room. Anyone using the same room ID will see your cursor in real time.</p>

            {error && <div className="error-message" role="alert">{error}</div>}

            <div className="form-field">
              <label htmlFor="display-name">Your display name</label>
              <input
                id="display-name"
                value={nameInput}
                onChange={(event) => setNameInput(event.target.value)}
                placeholder="e.g. Alice"
                maxLength={32}
                required
                autoFocus
              />
            </div>

            <div className="form-field">
              <label htmlFor="room-id">Room ID</label>
              <input
                id="room-id"
                value={roomInput}
                onChange={(event) => setRoomInput(event.target.value)}
                placeholder="e.g. team-room"
                maxLength={64}
                required
              />
            </div>

            <button className="primary-button" type="submit">
              {connected ? "Join room" : "Connect and join"}
            </button>
            <div className="demo-note">Tip: keep the room ID identical in every browser. Names are only demo labels; this version does not authenticate identities.</div>
          </form>
        </div>
      )}
    </main>
  );
}
