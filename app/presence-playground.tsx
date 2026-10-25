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
  "presence:move": (payload: { x: number; y: number }) => void;
};

type PresenceSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const DEFAULT_NAME = `Guest ${Math.floor(100 + Math.random() * 900)}`;
const DEFAULT_ROOM = "team-room";

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

  const [nameInput, setNameInput] = useState(DEFAULT_NAME);
  const [roomInput, setRoomInput] = useState(DEFAULT_ROOM);
  const [name, setName] = useState("");
  const [roomId, setRoomId] = useState("");
  const [connected, setConnected] = useState(false);
  const [joined, setJoined] = useState(false);
  const [users, setUsers] = useState<PresenceUser[]>([]);
  const [error, setError] = useState("");
  const [localPosition, setLocalPosition] = useState({ x: 50, y: 50 });

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
    });

    socket.on("connect_error", () => {
      setError("Could not connect to the presence server. Check that npm run dev is running.");
    });

    socket.on("presence:sync", (incoming) => {
      setUsers(incoming);
      setJoined(true);
      setError("");
    });

    socket.on("presence:joined", (incoming) => {
      setUsers((current) => current.some((user) => user.clientId === incoming.clientId)
        ? current
        : [...current, incoming]);
    });

    socket.on("presence:updated", (incoming) => {
      setUsers((current) => current.map((user) =>
        user.clientId === incoming.clientId ? incoming : user
      ));
    });

    socket.on("presence:left", ({ clientId }) => {
      setUsers((current) => current.filter((user) => user.clientId !== clientId));
    });

    socket.on("presence:error", (message) => setError(message));

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
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

  const handleCanvasMove = useCallback((event: MouseEvent<HTMLDivElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || !joined) return;

    const rect = canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(100, ((event.clientX - rect.left) / rect.width) * 100));
    const y = Math.max(0, Math.min(100, ((event.clientY - rect.top) / rect.height) * 100));

    setLocalPosition({ x, y });
    pendingPosition.current = { x, y };

    // Coalesce high-frequency pointer events to at most one send per animation frame,
    // with a small time gate to avoid flooding the socket.
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const now = Date.now();
      if (now - lastMoveSentAt.current < 35) return;
      const position = pendingPosition.current;
      if (!position) return;
      socketRef.current?.emit("presence:move", position);
      lastMoveSentAt.current = now;
    });
  }, [joined]);

  const leaveRoom = useCallback(() => {
    socketRef.current?.disconnect();
    setJoined(false);
    setConnected(false);
    setUsers([]);
    setName("");
    setRoomId("");
    sessionStorage.removeItem("presence-demo-name");
    sessionStorage.removeItem("presence-demo-room");
  }, []);

  const localUser = useMemo<PresenceUser | null>(() => {
    if (!joined || !name || !roomId || !socketRef.current?.id) return null;
    return {
      clientId: socketRef.current.id,
      userId: "local",
      name,
      color: "#344054",
      roomId,
      x: localPosition.x,
      y: localPosition.y,
      updatedAt: Date.now()
    };
  }, [joined, name, roomId, localPosition]);

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
                className="remote-cursor"
                style={{ left: `${localUser.x}%`, top: `${localUser.y}%` }}
                aria-label="Your pointer"
              >
                <CursorArrow color={localUser.color} />
                <span className="cursor-label me" style={{ backgroundColor: localUser.color }}>
                  {localUser.name} (you)
                </span>
              </div>
            )}

            {users.map((user) => (
              <div
                className="remote-cursor"
                key={user.clientId}
                style={{ left: `${user.x}%`, top: `${user.y}%` }}
                aria-label={`${user.name}'s pointer`}
              >
                <CursorArrow color={user.color} />
                <span className="cursor-label" style={{ backgroundColor: user.color }}>
                  {user.name}
                </span>
              </div>
            ))}
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
