import type { Server } from "socket.io";
import { and, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { hotelMemberships, users, workOrders } from "@workspace/db/schema";
import { verifyAccessToken, type AuthUser } from "./security";

type Presence = AuthUser & {
  connectedAt: string;
  socketId: string;
};

const onlineUsers = new Map<number, Presence>();

export function userRoom(hotelId: number, userId: number): string {
  return `hotel:${hotelId}:user:${userId}`;
}

export function attachRealtime(io: Server): void {
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (typeof token !== "string") {
      next(new Error("Authentication required"));
      return;
    }

    void (async () => {
      try {
        const claims = verifyAccessToken(token);
        const membership = (await db.select({
          id: users.id,
          email: users.email,
          name: users.name,
          role: hotelMemberships.role,
          specialty: hotelMemberships.specialty,
          hotelId: hotelMemberships.hotelId,
        }).from(users)
          .innerJoin(hotelMemberships, eq(hotelMemberships.userId, users.id))
          .where(and(
            eq(users.id, claims.id),
            eq(hotelMemberships.hotelId, claims.hotelId),
            eq(hotelMemberships.isActive, true),
          )).limit(1))[0];
        if (!membership || membership.role !== claims.role) {
          next(new Error("Hotel membership is inactive"));
          return;
        }
        socket.data.user = { ...membership, role: membership.role as AuthUser["role"] };
        next();
      } catch {
        next(new Error("Invalid access token"));
      }
    })();
  });

  io.on("connection", (socket) => {
    const user = socket.data.user as AuthUser;
    socket.join(userRoom(user.hotelId, user.id));
    socket.join(`hotel:${user.hotelId}`);
    socket.join(`hotel:${user.hotelId}:role:${user.role}`);

    const presence: Presence = {
      ...user,
      connectedAt: new Date().toISOString(),
      socketId: socket.id,
    };
    onlineUsers.set(user.id, presence);
    io.to(`hotel:${user.hotelId}`).emit("presence:update", listOnlineTechnicians(user.hotelId));

    socket.on("work-order:join", async (workOrderId: number | string) => {
      const id = Number(workOrderId);
      if (!Number.isSafeInteger(id) || id <= 0) return;
      try {
        const conditions = [
          eq(workOrders.id, id),
          eq(workOrders.hotelId, user.hotelId),
          ...(user.role === "MANAGER"
            ? []
            : [user.role === "TECHNICIAN" ? eq(workOrders.assignedTo, user.id) : eq(workOrders.createdBy, user.id)]),
        ];
        const order = (await db.select({ id: workOrders.id }).from(workOrders).where(and(...conditions)).limit(1))[0];
        if (order) socket.join(`hotel:${user.hotelId}:work-order:${id}`);
      } catch {
        socket.emit("error:message", { message: "تعذر الانضمام إلى محادثة أمر العمل" });
      }
    });

    socket.on("disconnect", () => {
      const current = onlineUsers.get(user.id);
      if (current?.socketId === socket.id) {
        onlineUsers.delete(user.id);
        io.to(`hotel:${user.hotelId}`).emit("presence:update", listOnlineTechnicians(user.hotelId));
      }
    });
  });
}

export function listOnlineTechnicians(hotelId?: number) {
  return [...onlineUsers.values()]
    .filter((user) => user.role === "TECHNICIAN" && (hotelId === undefined || user.hotelId === hotelId))
    .map(({ socketId: _socketId, ...user }) => user);
}