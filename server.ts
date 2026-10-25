import { createServer } from "node:http";
import next from "next";
import { Server as SocketIOServer, type Socket } from "socket.io";
import { randomUUID } from "node:crypto";

const dev = process.env.NODE_ENV !== "production";
const hostname = "0.0.0.0";
const port = Number.parseInt(process.env.PORT ?? "3000", 10);

type CursorPresence = {
  clientId: string;
  userId: string;
  name: string;
  color: string;
  roomId: string;
  x: number;
  y: number;
  updatedAt: number;
};

type ClientToServerEvents = {
  "presence:join": (payload: { name: string; roomId: string }) => void;
  "presence:move": (payload: { x: number; y: number; final?: boolean }) => void;
};

type ServerToClientEvents = {
  "presence:sync": (users: CursorPresence[]) => void;
  "presence:joined": (user: CursorPresence) => void;
  "presence:updated": (user: CursorPresence) => void;
  "presence:left": (payload: { clientId: string }) => void;
  "presence:error": (message: string) => void;
};

type InterServerEvents = Record<string, never>;
type SocketData = { presence?: CursorPresence };

const COLORS = [
  "#2563eb", "#db2777", "#059669", "#ea580c",
  "#7c3aed", "#0891b2", "#ca8a04", "#4f46e5"
];

async function main() {
  const app = next({ dev, hostname, port });
  const handle = app.getRequestHandler();

  await app.prepare();

  const httpServer = createServer((req, res) => handle(req, res));

  const io = new SocketIOServer<
    ClientToServerEvents,
    ServerToClientEvents,
    InterServerEvents,
    SocketData
  >(httpServer, {
    serveClient: false,
    maxHttpBufferSize: 1e5
  });

  // In-memory registry for this single-process demo.
  const rooms = new Map<string, Map<string, CursorPresence>>();
  const roomColorCounters = new Map<string, number>();

  function cleanText(value: unknown, maxLength: number): string {
    if (typeof value !== "string") return "";
    return value.trim().replace(/\s+/g, " ").slice(0, maxLength);
  }

  function clampPercent(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(100, value));
  }

  function getRoom(roomId: string): Map<string, CursorPresence> {
    let room = rooms.get(roomId);

    if (!room) {
      room = new Map();
      rooms.set(roomId, room);
    }

    return room;
  }

  function getNextColor(roomId: string): string {
    const nextIndex = roomColorCounters.get(roomId) ?? 0;
    roomColorCounters.set(roomId, nextIndex + 1);
    return COLORS[nextIndex % COLORS.length];
  }

  function removePresence(
    socket: Socket<
      ClientToServerEvents,
      ServerToClientEvents,
      InterServerEvents,
      SocketData
    >
  ) {
    const current = socket.data.presence;
    if (!current) return;

    const room = rooms.get(current.roomId);
    room?.delete(current.clientId);

    socket.to(current.roomId).emit("presence:left", {
      clientId: current.clientId
    });

    if (room && room.size === 0) {
      rooms.delete(current.roomId);
      roomColorCounters.delete(current.roomId);
    }

    delete socket.data.presence;
  }

  io.on("connection", (socket) => {
    socket.on("presence:join", (payload) => {
      // Remove any previous session associated with this socket.
      removePresence(socket);

      const name = cleanText(payload?.name, 32);
      const roomId = cleanText(payload?.roomId, 64)
        .replace(/[^a-zA-Z0-9_-]/g, "");

      if (!name || !roomId) {
        socket.emit(
          "presence:error",
          "Enter a display name and a room ID."
        );
        return;
      }

      const room = getRoom(roomId);

      const user: CursorPresence = {
        clientId: socket.id,
        userId: randomUUID(),
        name,
        color: getNextColor(roomId),
        roomId,
        x: 50,
        y: 50,
        updatedAt: Date.now()
      };

      socket.join(roomId);
      socket.data.presence = user;

      // Send existing participants to the joining client.
      socket.emit("presence:sync", Array.from(room.values()));

      // Tell existing participants about the new client.
      socket.to(roomId).emit("presence:joined", user);

      room.set(user.clientId, user);
    });

    socket.on("presence:move", (payload) => {
      const current = socket.data.presence;
      if (!current) return;

      const updated: CursorPresence = {
        ...current,
        x: clampPercent(payload?.x),
        y: clampPercent(payload?.y),
        updatedAt: Date.now()
      };

      socket.data.presence = updated;
      rooms.get(updated.roomId)?.set(updated.clientId, updated);

      // The sender already renders its own local cursor. In-flight moves are
      // volatile so a slow receiver skips stale positions instead of queueing
      // them; the final resting position is delivered reliably.
      const broadcast = payload?.final === true
        ? socket.to(updated.roomId)
        : socket.volatile.to(updated.roomId);
      broadcast.emit("presence:updated", updated);
    });

    socket.on("disconnect", () => {
      removePresence(socket);
    });
  });

  httpServer.listen(port, hostname, () => {
    console.log(`> Presence demo ready at http://localhost:${port}`);
    console.log(
      "> Open the URL in two browser windows and join the same room."
    );
  });
}

main().catch((error) => {
  console.error("Failed to start presence server:", error);
  process.exitCode = 1;
});
