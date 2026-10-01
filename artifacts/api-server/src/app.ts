import cors from "cors";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import path from "path";
import { and, asc, desc, eq, gte, ilike, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { Server } from "socket.io";
import { db } from "@workspace/db";
import {
  assets,
  auditLogs,
  buildings,
  chatMessages,
  hotelInvitations,
  hotelMemberships,
  hotels,
  inventoryItems,
  inventoryTransactions,
  notifications,
  otpChallenges,
  refreshTokens,
  rooms,
  users,
  workOrderEvents,
  workOrders,
} from "@workspace/db/schema";
import {
  createAccessToken,
  createOtp,
  createQrToken,
  createRefreshToken,
  hashOtp,
  hashPassword,
  hashToken,
  signBackup,
  verifyAccessToken,
  verifyBackup,
  verifyOtp,
  verifyPassword,
  type AuthUser,
  type Role,
} from "./security";
import { getEmailErrorDetails, sendOtpEmail } from "./email";
import { listOnlineTechnicians } from "./realtime";

const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const roles: Role[] = ["MANAGER", "TECHNICIAN", "STAFF"];
const statuses = ["NEW", "ACCEPTED", "ON_THE_WAY", "STARTED", "FIXED", "CLOSED"] as const;
const transitions: Record<string, string[]> = {
  NEW: ["ACCEPTED"],
  ACCEPTED: ["ON_THE_WAY"],
  ON_THE_WAY: ["STARTED"],
  STARTED: ["FIXED"],
  FIXED: ["CLOSED"],
  CLOSED: [],
};
const defaultSlaHours: Record<string, number> = {
  CRITICAL: 2,
  HIGH: 4,
  MEDIUM: 24,
  LOW: 72,
};
const rateBuckets = new Map<string, { count: number; resetsAt: number }>();
const refreshCookie = "t-smart-refresh";
const refreshCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/api/auth",
  maxAge: REFRESH_TTL_MS,
};

type RequestWithUser = Request & { user?: AuthUser };

function userFrom(req: Request): AuthUser {
  const user = (req as RequestWithUser).user;
  if (!user) throw new Error("Authentication required");
  return user;
}

function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

function cleanText(value: unknown, maxLength = 500): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function positiveInt(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 70);
  return slug || `hotel-${Date.now().toString(36)}`;
}

function readCookie(req: Request, key: string): string {
  const header = req.headers.cookie || "";
  const entry = header.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${key}=`));
  return entry ? decodeURIComponent(entry.slice(key.length + 1)) : "";
}

function setRefreshCookie(res: Response, token: string): void {
  res.cookie(refreshCookie, token, refreshCookieOptions);
}

function clearRefreshCookie(res: Response): void {
  res.clearCookie(refreshCookie, { ...refreshCookieOptions, maxAge: undefined });
}

function rateLimit(name: string, maxRequests: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    const key = `${name}:${req.ip || req.socket.remoteAddress || "unknown"}`;
    const current = rateBuckets.get(key);
    if (!current || current.resetsAt <= now) {
      rateBuckets.set(key, { count: 1, resetsAt: now + windowMs });
      next();
      return;
    }
    if (current.count >= maxRequests) {
      res.status(429).json({ success: false, message: "طلبات كثيرة. حاول مرة أخرى لاحقاً." });
      return;
    }
    current.count += 1;
    next();
  };
}

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ success: false, message: "تسجيل الدخول مطلوب" });
    return;
  }

  try {
    const claims = verifyAccessToken(header.slice(7));
    void getUserById(claims.id, claims.hotelId)
      .then((user) => {
        if (!user) {
          res.status(401).json({ success: false, message: "لم يعد لهذا الحساب وصول إلى الفندق" });
          return;
        }
        (req as RequestWithUser).user = user;
        next();
      })
      .catch(next);
  } catch {
    res.status(401).json({ success: false, message: "جلسة الدخول منتهية" });
  }
}

function requireRoles(...allowed: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = (req as RequestWithUser).user;
    if (!user || !allowed.includes(user.role)) {
      res.status(403).json({ success: false, message: "لا تملك صلاحية تنفيذ هذا الإجراء" });
      return;
    }
    next();
  };
}

async function getUserById(id: number, hotelId: number): Promise<AuthUser | null> {
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: hotelMemberships.role,
      specialty: hotelMemberships.specialty,
      hotelId: hotelMemberships.hotelId,
    })
    .from(users)
    .innerJoin(hotelMemberships, eq(hotelMemberships.userId, users.id))
    .where(and(eq(users.id, id), eq(hotelMemberships.hotelId, hotelId), eq(hotelMemberships.isActive, true)))
    .limit(1);
  const user = rows[0];
  if (!user || !roles.includes(user.role as Role)) return null;
  return { ...user, role: user.role as Role };
}

async function issueTokens(user: AuthUser, res: Response): Promise<{ accessToken: string }> {
  const refreshToken = createRefreshToken();
  await db.insert(refreshTokens).values({
    userId: user.id,
    tokenHash: hashToken(refreshToken),
    expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
  });
  setRefreshCookie(res, refreshToken);
  return { accessToken: createAccessToken(user) };
}

function allowedOrderCondition(user: AuthUser) {
  const membershipScope =
    user.role === "MANAGER"
      ? undefined
      : user.role === "TECHNICIAN"
        ? eq(workOrders.assignedTo, user.id)
        : eq(workOrders.createdBy, user.id);
  return and(eq(workOrders.hotelId, user.hotelId), membershipScope);
}

async function canAccessOrder(user: AuthUser, orderId: number): Promise<boolean> {
  const row = (
    await db
      .select({ id: workOrders.id })
      .from(workOrders)
      .where(and(eq(workOrders.id, orderId), allowedOrderCondition(user)))
      .limit(1)
  )[0];
  return Boolean(row);
}

async function writeAudit(
  user: AuthUser,
  action: string,
  entityType: string,
  entityId: number | string | null,
  details: Record<string, unknown> = {},
): Promise<void> {
  await db.insert(auditLogs).values({
    hotelId: user.hotelId,
    actorId: user.id,
    action,
    entityType,
    entityId: entityId === null ? null : String(entityId),
    details,
  });
}

async function chooseTechnician(hotelId: number, specialty: string): Promise<number | null> {
  const candidates = await db
    .select({ id: users.id, lastSeenAt: users.lastSeenAt, specialty: hotelMemberships.specialty })
    .from(hotelMemberships)
    .innerJoin(users, eq(users.id, hotelMemberships.userId))
    .where(
      and(
        eq(hotelMemberships.hotelId, hotelId),
        eq(hotelMemberships.role, "TECHNICIAN"),
        eq(hotelMemberships.isActive, true),
        or(eq(hotelMemberships.specialty, specialty), isNull(hotelMemberships.specialty)),
      ),
    )
    .orderBy(desc(users.lastSeenAt));
  const online = new Set(listOnlineTechnicians(hotelId).map((technician) => technician.id));
  const available = candidates.filter((candidate) => online.has(candidate.id));
  const choices = available.length ? available : candidates;
  if (!choices.length) return null;

  const loadRows = await db
    .select({ userId: workOrders.assignedTo, count: sql<number>`count(*)` })
    .from(workOrders)
    .where(
      and(
        eq(workOrders.hotelId, hotelId),
        inArray(workOrders.assignedTo, choices.map((candidate) => candidate.id)),
        ne(workOrders.status, "FIXED"),
        ne(workOrders.status, "CLOSED"),
      ),
    )
    .groupBy(workOrders.assignedTo);
  const loadById = new Map(loadRows.map((row) => [row.userId, Number(row.count)]));
  return [...choices].sort((a, b) => (loadById.get(a.id) ?? 0) - (loadById.get(b.id) ?? 0))[0].id;
}

function emitWorkOrder(io: Server, hotelId: number, workOrder: { id: number; assignedTo: number | null; status: string }) {
  io.to(`hotel:${hotelId}:role:MANAGER`).emit("work-order:update", workOrder);
  io.to(`hotel:${hotelId}:role:STAFF`).emit("work-order:update", workOrder);
  if (workOrder.assignedTo) {
    io.to(`user:${workOrder.assignedTo}`).emit("work-order:update", workOrder);
  }
}

function csvCell(value: unknown): string {
  const text = String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

export function createApp(io: Server): Express {
  const app: Express = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  const configuredOrigins = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const corsOptions = {
    credentials: true,
    origin(origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) {
      if (!origin || configuredOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      if (process.env.NODE_ENV !== "production" && /^https?:\/\/([a-z0-9-]+\.)?replit\.dev(?::\d+)?$/i.test(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("Origin not allowed"));
    },
  };
  app.use(cors(corsOptions));
  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: true, limit: "2mb" }));
  app.use(express.static(path.join(process.cwd(), "public"), { index: false }));

  app.get("/", (_req, res) => {
    const frontend = path.resolve(process.cwd(), "../login-app/dist/public");
    res.sendFile(path.join(frontend, "index.html"), (error) => {
      if (error) res.status(200).json({ service: "T-SMART Hotel Operations API", ui: "/api" });
    });
  });
  app.get(["/api", "/api/"], (_req, res) => res.sendFile(path.join(process.cwd(), "public", "index.html")));
  app.get("/api/health", (_req, res) => res.json({ ok: true, service: "t-smart-hotel-operations", version: "7" }));

  app.post("/api/send-otp", rateLimit("otp", 5, 10 * 60 * 1000), async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    if (!isValidEmail(email)) {
      res.status(400).json({ success: false, message: "يرجى إدخال بريد إلكتروني صحيح" });
      return;
    }
    const registered = (await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1))[0];
    if (registered) {
      res.status(409).json({ success: false, message: "البريد مسجل بالفعل. اطلب دعوة من مدير الفندق." });
      return;
    }
    const existing = (await db.select().from(otpChallenges).where(eq(otpChallenges.email, email)).limit(1))[0];
    if (existing && Date.now() - existing.lastSentAt.getTime() < OTP_RESEND_COOLDOWN_MS) {
      res.status(429).json({ success: false, message: "انتظر دقيقة قبل طلب رمز جديد" });
      return;
    }
    const otp = createOtp();
    const codeHash = hashOtp(email, otp);
    await db
      .insert(otpChallenges)
      .values({ email, codeHash, attempts: 0, expiresAt: new Date(Date.now() + OTP_TTL_MS), lastSentAt: new Date() })
      .onConflictDoUpdate({
        target: otpChallenges.email,
        set: {
          codeHash,
          attempts: 0,
          expiresAt: new Date(Date.now() + OTP_TTL_MS),
          lastSentAt: new Date(),
          updatedAt: new Date(),
        },
      });
    try {
      await sendOtpEmail(email, otp);
      res.json({ success: true, message: "تم إرسال رمز التحقق إلى بريدك الإلكتروني" });
    } catch (error) {
      await db.delete(otpChallenges).where(and(eq(otpChallenges.email, email), eq(otpChallenges.codeHash, codeHash)));
      console.error("OTP delivery failed:", getEmailErrorDetails(error));
      res.status(503).json({ success: false, message: "تعذر إرسال رمز التحقق حالياً" });
    }
  });

  app.post("/api/register", rateLimit("register", 5, 60 * 60 * 1000), async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const name = cleanText(req.body?.name, 100) || email.split("@")[0];
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const otp = typeof req.body?.otp === "string" ? req.body.otp.trim() : "";
    const hotelName = cleanText(req.body?.hotelName, 140);
    const logoUrl = cleanText(req.body?.logoUrl, 800);
    if (!isValidEmail(email) || password.length < 12 || !/^\d{6}$/.test(otp) || hotelName.length < 2) {
      res.status(400).json({ success: false, message: "أدخل اسم الفندق وبريداً صحيحاً وكلمة مرور من 12 حرفاً ورمز التحقق" });
      return;
    }
    try {
      const existingUser = (await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1))[0];
      if (existingUser) {
        res.status(409).json({ success: false, message: "هذا البريد مسجل بالفعل. اطلب دعوة من مدير الفندق." });
        return;
      }
      const challenge = (await db.select().from(otpChallenges).where(eq(otpChallenges.email, email)).limit(1))[0];
      if (!challenge || challenge.expiresAt.getTime() < Date.now() || challenge.attempts >= 5) {
        res.status(400).json({ success: false, message: "رمز التحقق منتهي أو تم تجاوز عدد المحاولات" });
        return;
      }
      if (!verifyOtp(email, otp, challenge.codeHash)) {
        await db.update(otpChallenges).set({ attempts: challenge.attempts + 1, updatedAt: new Date() }).where(eq(otpChallenges.id, challenge.id));
        res.status(400).json({ success: false, message: "رمز التحقق غير صحيح" });
        return;
      }

      const slugBase = slugify(cleanText(req.body?.slug, 100) || hotelName);
      const slug = `${slugBase}-${Date.now().toString(36)}`;
      const created = await db.transaction(async (tx) => {
        const [hotel] = await tx.insert(hotels).values({
          name: hotelName,
          slug,
          logoUrl: logoUrl || null,
          settings: { timezone: "Africa/Cairo", currency: "EGP", slaHours: defaultSlaHours },
        }).returning();
        const [account] = await tx.insert(users).values({
          email,
          name,
          passwordHash: await hashPassword(password),
          role: "MANAGER",
          emailVerified: true,
        }).returning();
        await tx.insert(hotelMemberships).values({
          hotelId: hotel.id,
          userId: account.id,
          role: "MANAGER",
          isActive: true,
        });
        await tx.delete(otpChallenges).where(eq(otpChallenges.email, email));
        await tx.insert(auditLogs).values({
          hotelId: hotel.id,
          actorId: account.id,
          action: "HOTEL_CREATED",
          entityType: "hotel",
          entityId: String(hotel.id),
          details: { slug: hotel.slug },
        });
        return { hotel, account };
      });
      const user: AuthUser = {
        id: created.account.id,
        hotelId: created.hotel.id,
        email: created.account.email,
        name: created.account.name,
        role: "MANAGER",
        specialty: null,
      };
      res.status(201).json({ success: true, user, hotel: created.hotel, ...(await issueTokens(user, res)) });
    } catch (error) {
      console.error("Hotel registration failed:", error);
      res.status(503).json({ success: false, message: "تعذر إنشاء الفندق حالياً" });
    }
  });

  app.post("/api/auth/login", rateLimit("login", 12, 15 * 60 * 1000), async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const record = (await db.select().from(users).where(eq(users.email, email)).limit(1))[0];
    if (!record || !(await verifyPassword(password, record.passwordHash))) {
      res.status(401).json({ success: false, message: "البريد أو كلمة المرور غير صحيحة" });
      return;
    }
    if (!record.emailVerified) {
      res.status(403).json({ success: false, message: "يجب تأكيد البريد الإلكتروني أولاً" });
      return;
    }
    const memberships = await db
      .select({ hotelId: hotelMemberships.hotelId, role: hotelMemberships.role })
      .from(hotelMemberships)
      .where(and(eq(hotelMemberships.userId, record.id), eq(hotelMemberships.isActive, true)));
    const requestedHotelId = positiveInt(req.body?.hotelId);
    const membership = requestedHotelId
      ? memberships.find((item) => item.hotelId === requestedHotelId)
      : memberships[0];
    if (!membership) {
      res.status(403).json({ success: false, message: "لا يوجد فندق نشط مرتبط بهذا الحساب" });
      return;
    }
    const user = await getUserById(record.id, membership.hotelId);
    if (!user) {
      res.status(403).json({ success: false, message: "عضوية الفندق غير نشطة" });
      return;
    }
    await db.update(users).set({ lastSeenAt: new Date(), updatedAt: new Date() }).where(eq(users.id, user.id));
    const hotelsForUser = await db
      .select({ id: hotels.id, name: hotels.name, logoUrl: hotels.logoUrl, role: hotelMemberships.role })
      .from(hotelMemberships)
      .innerJoin(hotels, eq(hotels.id, hotelMemberships.hotelId))
      .where(and(eq(hotelMemberships.userId, user.id), eq(hotelMemberships.isActive, true)));
    res.json({ success: true, user, hotels: hotelsForUser, ...(await issueTokens(user, res)) });
  });

  app.post("/api/auth/refresh", rateLimit("refresh", 30, 15 * 60 * 1000), async (req, res) => {
    const token = readCookie(req, refreshCookie) || (typeof req.body?.refreshToken === "string" ? req.body.refreshToken : "");
    if (!token) {
      clearRefreshCookie(res);
      res.status(401).json({ success: false, message: "رمز التجديد مطلوب" });
      return;
    }
    const tokenHash = hashToken(token);
    const replacement = createRefreshToken();
    const replacementHash = hashToken(replacement);
    const refreshed = await db.transaction(async (tx) => {
      const current = (
        await tx.select().from(refreshTokens)
          .where(and(eq(refreshTokens.tokenHash, tokenHash), isNull(refreshTokens.revokedAt), gte(refreshTokens.expiresAt, new Date())))
          .limit(1)
          .for("update")
      )[0];
      if (!current) return null;
      const [revoked] = await tx.update(refreshTokens)
        .set({ revokedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(refreshTokens.id, current.id), isNull(refreshTokens.revokedAt)))
        .returning({ id: refreshTokens.id });
      if (!revoked) return null;
      const user = await getUserById(current.userId, positiveInt(req.body?.hotelId) ?? 0);
      const requestedHotelId = positiveInt(req.body?.hotelId);
      const memberships = await tx.select({
        id: users.id,
        email: users.email,
        name: users.name,
        hotelId: hotelMemberships.hotelId,
        role: hotelMemberships.role,
        specialty: hotelMemberships.specialty,
      })
        .from(users)
        .innerJoin(hotelMemberships, eq(hotelMemberships.userId, users.id))
        .where(and(
          eq(users.id, current.userId),
          eq(hotelMemberships.isActive, true),
          requestedHotelId ? eq(hotelMemberships.hotelId, requestedHotelId) : undefined,
        ))
        .limit(1);
      const selected = memberships[0];
      if (!selected || !roles.includes(selected.role as Role)) return null;
      const authUser: AuthUser = { ...selected, role: selected.role as Role };
      await tx.insert(refreshTokens).values({
        userId: authUser.id,
        tokenHash: replacementHash,
        expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
      });
      return authUser;
    });
    if (!refreshed) {
      clearRefreshCookie(res);
      res.status(401).json({ success: false, message: "رمز التجديد غير صالح" });
      return;
    }
    setRefreshCookie(res, replacement);
    res.json({ success: true, user: refreshed, accessToken: createAccessToken(refreshed) });
  });

  app.post("/api/auth/logout", requireAuth, async (req, res) => {
    const token = readCookie(req, refreshCookie) || (typeof req.body?.refreshToken === "string" ? req.body.refreshToken : "");
    if (token) {
      await db.update(refreshTokens)
        .set({ revokedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(refreshTokens.tokenHash, hashToken(token)), isNull(refreshTokens.revokedAt)));
    }
    clearRefreshCookie(res);
    res.json({ success: true });
  });

  app.get("/api/auth/me", requireAuth, async (req, res) => {
    res.json({ success: true, user: userFrom(req) });
  });

  app.post("/api/auth/switch-hotel", requireAuth, async (req, res) => {
    const user = userFrom(req);
    const hotelId = positiveInt(req.body?.hotelId);
    if (!hotelId) {
      res.status(400).json({ success: false, message: "معرّف الفندق غير صالح" });
      return;
    }
    const next = await getUserById(user.id, hotelId);
    if (!next) {
      res.status(403).json({ success: false, message: "ليس لديك عضوية نشطة في هذا الفندق" });
      return;
    }
    res.json({ success: true, user: next, ...(await issueTokens(next, res)) });
  });

  app.get("/api/hotel", requireAuth, async (req, res) => {
    const user = userFrom(req);
    const hotel = (await db.select().from(hotels).where(eq(hotels.id, user.hotelId)).limit(1))[0];
    res.json({ hotel });
  });

  app.patch("/api/hotel", requireAuth, requireRoles("MANAGER"), async (req, res) => {
    const user = userFrom(req);
    const name = cleanText(req.body?.name, 140);
    const logoUrl = cleanText(req.body?.logoUrl, 800);
    if (!name || (logoUrl && !/^https:\/\/|^\//i.test(logoUrl))) {
      res.status(400).json({ success: false, message: "تحقق من اسم الفندق ورابط الشعار الآمن" });
      return;
    }
    const [hotel] = await db.update(hotels)
      .set({ name, logoUrl: logoUrl || null, updatedAt: new Date() })
      .where(eq(hotels.id, user.hotelId))
      .returning();
    await writeAudit(user, "HOTEL_SETTINGS_UPDATED", "hotel", hotel.id, { name, logoChanged: true });
    io.to(`hotel:${user.hotelId}`).emit("hotel:update", hotel);
    res.json({ success: true, hotel });
  });

  app.get("/api/hotel/members", requireAuth, requireRoles("MANAGER"), async (req, res) => {
    const user = userFrom(req);
    const members = await db.select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: hotelMemberships.role,
      specialty: hotelMemberships.specialty,
      isActive: hotelMemberships.isActive,
      lastSeenAt: users.lastSeenAt,
    })
      .from(hotelMemberships)
      .innerJoin(users, eq(users.id, hotelMemberships.userId))
      .where(eq(hotelMemberships.hotelId, user.hotelId))
      .orderBy(asc(users.name));
    res.json({ members });
  });

  app.post("/api/hotel/invitations", requireAuth, requireRoles("MANAGER"), rateLimit("invite", 20, 60 * 60 * 1000), async (req, res) => {
    const user = userFrom(req);
    const email = normalizeEmail(req.body?.email);
    const name = cleanText(req.body?.name, 100);
    const role = cleanText(req.body?.role, 20).toUpperCase() as Role;
    const specialty = cleanText(req.body?.specialty, 80) || null;
    if (!isValidEmail(email) || !name || !roles.includes(role) || role === "MANAGER") {
      res.status(400).json({ success: false, message: "بيانات الدعوة غير صالحة" });
      return;
    }
    const existingUser = (await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1))[0];
    if (existingUser) {
      res.status(409).json({ success: false, message: "الحساب موجود؛ أضف العضوية من لوحة إدارة الفريق" });
      return;
    }
    const otp = createOtp();
    const codeHash = hashOtp(email, otp);
    await db.insert(hotelInvitations).values({
      hotelId: user.hotelId,
      email,
      name,
      role,
      specialty,
      codeHash,
      expiresAt: new Date(Date.now() + OTP_TTL_MS),
      createdBy: user.id,
    }).onConflictDoUpdate({
      target: [hotelInvitations.hotelId, hotelInvitations.email],
      set: { name, role, specialty, codeHash, expiresAt: new Date(Date.now() + OTP_TTL_MS), updatedAt: new Date() },
    });
    try {
      await sendOtpEmail(email, otp);
    } catch (error) {
      console.error("Invitation delivery failed:", getEmailErrorDetails(error));
      res.status(503).json({ success: false, message: "تعذر إرسال دعوة الفريق" });
      return;
    }
    await writeAudit(user, "MEMBER_INVITED", "invitation", email, { role });
    res.status(201).json({ success: true, message: "أُرسلت دعوة التحقق إلى البريد." });
  });

  app.post("/api/hotel/invitations/accept", rateLimit("accept-invite", 6, 30 * 60 * 1000), async (req, res) => {
    const hotelId = positiveInt(req.body?.hotelId);
    const email = normalizeEmail(req.body?.email);
    const otp = cleanText(req.body?.otp, 6);
    const name = cleanText(req.body?.name, 100);
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!hotelId || !isValidEmail(email) || !/^\d{6}$/.test(otp) || name.length < 2 || password.length < 12) {
      res.status(400).json({ success: false, message: "بيانات قبول الدعوة غير صالحة" });
      return;
    }
    const invite = (await db.select().from(hotelInvitations)
      .where(and(eq(hotelInvitations.hotelId, hotelId), eq(hotelInvitations.email, email)))
      .limit(1))[0];
    if (!invite || invite.expiresAt.getTime() < Date.now() || !verifyOtp(email, otp, invite.codeHash)) {
      res.status(400).json({ success: false, message: "الدعوة منتهية أو الرمز غير صحيح" });
      return;
    }
    const existing = (await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1))[0];
    if (existing) {
      res.status(409).json({ success: false, message: "هذا البريد لديه حساب بالفعل؛ تواصل مع مدير الفندق لربطه." });
      return;
    }
    const account = await db.transaction(async (tx) => {
      const [created] = await tx.insert(users).values({
        email,
        name,
        passwordHash: await hashPassword(password),
        role: invite.role,
        specialty: invite.specialty,
        emailVerified: true,
      }).returning();
      await tx.insert(hotelMemberships).values({
        hotelId,
        userId: created.id,
        role: invite.role,
        specialty: invite.specialty,
        isActive: true,
      });
      await tx.delete(hotelInvitations).where(eq(hotelInvitations.id, invite.id));
      await tx.insert(auditLogs).values({
        hotelId,
        actorId: created.id,
        action: "INVITATION_ACCEPTED",
        entityType: "user",
        entityId: String(created.id),
        details: { role: invite.role },
      });
      return created;
    });
    const user: AuthUser = {
      id: account.id,
      hotelId,
      email: account.email,
      name: account.name,
      role: invite.role as Role,
      specialty: invite.specialty,
    };
    res.status(201).json({ success: true, user, ...(await issueTokens(user, res)) });
  });

  app.get("/api/technicians", requireAuth, async (req, res) => {
    const user = userFrom(req);
    const rows = await db.select({
      id: users.id,
      name: users.name,
      email: users.email,
      specialty: hotelMemberships.specialty,
      lastSeenAt: users.lastSeenAt,
    })
      .from(hotelMemberships)
      .innerJoin(users, eq(users.id, hotelMemberships.userId))
      .where(and(eq(hotelMemberships.hotelId, user.hotelId), eq(hotelMemberships.role, "TECHNICIAN"), eq(hotelMemberships.isActive, true)));
    res.json({ technicians: rows });
  });

  app.get("/api/presence", requireAuth, (req, res) => {
    res.json({ technicians: listOnlineTechnicians(userFrom(req).hotelId) });
  });

  app.get("/api/buildings", requireAuth, async (req, res) => {
    const user = userFrom(req);
    const rows = await db.select().from(buildings).where(eq(buildings.hotelId, user.hotelId)).orderBy(asc(buildings.name));
    res.json({ buildings: rows });
  });

  app.post("/api/buildings", requireAuth, requireRoles("MANAGER"), async (req, res) => {
    const user = userFrom(req);
    const name = cleanText(req.body?.name, 120);
    const code = cleanText(req.body?.code, 40).toUpperCase() || slugify(name).toUpperCase();
    const floors = Number(req.body?.floors ?? 1);
    if (!name || !Number.isInteger(floors) || floors < 1 || floors > 200) {
      res.status(400).json({ success: false, message: "اسم المبنى وعدد الطوابق مطلوبان" });
      return;
    }
    const [building] = await db.insert(buildings).values({ hotelId: user.hotelId, name, code, floors }).returning();
    await writeAudit(user, "BUILDING_CREATED", "building", building.id, { code });
    res.status(201).json({ success: true, building });
  });

  app.get("/api/rooms", requireAuth, async (req, res) => {
    const user = userFrom(req);
    const buildingId = positiveInt(req.query.buildingId);
    const condition = buildingId
      ? and(eq(rooms.hotelId, user.hotelId), eq(rooms.buildingId, buildingId))
      : eq(rooms.hotelId, user.hotelId);
    const rows = await db.select({
      id: rooms.id,
      hotelId: rooms.hotelId,
      buildingId: rooms.buildingId,
      buildingName: buildings.name,
      roomNumber: rooms.roomNumber,
      floor: rooms.floor,
      roomType: rooms.roomType,
      status: rooms.status,
    })
      .from(rooms)
      .innerJoin(buildings, eq(buildings.id, rooms.buildingId))
      .where(condition)
      .orderBy(asc(buildings.name), asc(rooms.roomNumber));
    res.json({ rooms: rows });
  });

  app.post("/api/rooms", requireAuth, requireRoles("MANAGER"), async (req, res) => {
    const user = userFrom(req);
    const buildingId = positiveInt(req.body?.buildingId);
    const roomNumber = cleanText(req.body?.roomNumber, 40);
    const building = buildingId
      ? (await db.select().from(buildings).where(and(eq(buildings.id, buildingId), eq(buildings.hotelId, user.hotelId))).limit(1))[0]
      : null;
    if (!building || !roomNumber) {
      res.status(400).json({ success: false, message: "اختر مبنى صالحاً وأدخل رقم الغرفة" });
      return;
    }
    const [room] = await db.insert(rooms).values({
      hotelId: user.hotelId,
      buildingId,
      roomNumber,
      floor: cleanText(req.body?.floor, 30) || null,
      roomType: cleanText(req.body?.roomType, 60) || null,
      status: cleanText(req.body?.status, 30).toUpperCase() || "OCCUPIED",
    }).returning();
    await writeAudit(user, "ROOM_CREATED", "room", room.id, { buildingId, roomNumber });
    res.status(201).json({ success: true, room });
  });

  app.get("/api/work-orders", requireAuth, async (req, res) => {
    const user = userFrom(req);
    const conditions = [allowedOrderCondition(user)];
    const status = cleanText(req.query.status, 30).toUpperCase();
    const priority = cleanText(req.query.priority, 20).toUpperCase();
    const specialty = cleanText(req.query.specialty, 80);
    const query = cleanText(req.query.q, 120);
    const assignedTo = positiveInt(req.query.assignedTo);
    const roomId = positiveInt(req.query.roomId);
    const from = req.query.from ? new Date(String(req.query.from)) : null;
    const to = req.query.to ? new Date(String(req.query.to)) : null;
    if (status && statuses.includes(status as (typeof statuses)[number])) conditions.push(eq(workOrders.status, status));
    if (priority && defaultSlaHours[priority]) conditions.push(eq(workOrders.priority, priority));
    if (specialty) conditions.push(eq(workOrders.specialty, specialty));
    if (user.role === "MANAGER" && assignedTo) conditions.push(eq(workOrders.assignedTo, assignedTo));
    if (roomId) conditions.push(eq(workOrders.roomId, roomId));
    if (from && !Number.isNaN(from.getTime())) conditions.push(gte(workOrders.createdAt, from));
    if (to && !Number.isNaN(to.getTime())) conditions.push(lt(workOrders.createdAt, new Date(to.getTime() + 24 * 60 * 60 * 1000)));
    if (query) {
      const pattern = `%${query.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
      conditions.push(or(ilike(workOrders.title, pattern), ilike(workOrders.description, pattern), ilike(workOrders.location, pattern))!);
    }
    const page = Math.max(1, Math.min(10000, Number(req.query.page) || 1));
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 50));
    const rows = await db.select({
      id: workOrders.id,
      title: workOrders.title,
      description: workOrders.description,
      location: workOrders.location,
      roomCode: workOrders.roomCode,
      roomId: workOrders.roomId,
      buildingName: buildings.name,
      category: workOrders.category,
      specialty: workOrders.specialty,
      priority: workOrders.priority,
      status: workOrders.status,
      createdBy: workOrders.createdBy,
      assignedTo: workOrders.assignedTo,
      assetId: workOrders.assetId,
      slaDueAt: workOrders.slaDueAt,
      createdAt: workOrders.createdAt,
      updatedAt: workOrders.updatedAt,
      assigneeName: users.name,
    })
      .from(workOrders)
      .leftJoin(users, eq(workOrders.assignedTo, users.id))
      .leftJoin(rooms, eq(workOrders.roomId, rooms.id))
      .leftJoin(buildings, eq(rooms.buildingId, buildings.id))
      .where(and(...conditions))
      .orderBy(desc(workOrders.createdAt))
      .limit(limit)
      .offset((page - 1) * limit);
    res.json({ workOrders: rows, page, limit, hasMore: rows.length === limit });
  });

  app.post("/api/work-orders", requireAuth, requireRoles("MANAGER", "STAFF"), async (req, res) => {
    const user = userFrom(req);
    const title = cleanText(req.body?.title, 160);
    const description = cleanText(req.body?.description, 2000);
    const location = cleanText(req.body?.location, 160);
    const category = cleanText(req.body?.category, 80) || "GENERAL";
    const specialty = cleanText(req.body?.specialty, 80) || category;
    const priority = cleanText(req.body?.priority, 20).toUpperCase() || "MEDIUM";
    const roomId = positiveInt(req.body?.roomId);
    const assetId = positiveInt(req.body?.assetId);
    if (!title || !description || !location || !defaultSlaHours[priority]) {
      res.status(400).json({ success: false, message: "بيانات أمر العمل غير مكتملة" });
      return;
    }
    if (roomId && !(await db.select({ id: rooms.id }).from(rooms).where(and(eq(rooms.id, roomId), eq(rooms.hotelId, user.hotelId))).limit(1))[0]) {
      res.status(400).json({ success: false, message: "الغرفة لا تنتمي إلى هذا الفندق" });
      return;
    }
    if (assetId && !(await db.select({ id: assets.id }).from(assets).where(and(eq(assets.id, assetId), eq(assets.hotelId, user.hotelId))).limit(1))[0]) {
      res.status(400).json({ success: false, message: "الأصل لا ينتمي إلى هذا الفندق" });
      return;
    }
    const assignedTo = await chooseTechnician(user.hotelId, specialty);
    const hotel = (await db.select({ settings: hotels.settings }).from(hotels).where(eq(hotels.id, user.hotelId)).limit(1))[0];
    const hotelSla = (hotel?.settings as { slaHours?: Record<string, number> } | undefined)?.slaHours;
    const hours = Number(hotelSla?.[priority]) || defaultSlaHours[priority];
    const created = await db.transaction(async (tx) => {
      const [order] = await tx.insert(workOrders).values({
        hotelId: user.hotelId,
        title,
        description,
        location,
        roomCode: cleanText(req.body?.roomCode, 80) || null,
        roomId,
        category,
        specialty,
        priority,
        status: "NEW",
        createdBy: user.id,
        assignedTo,
        assetId,
        slaDueAt: new Date(Date.now() + hours * 60 * 60 * 1000),
      }).returning();
      await tx.insert(workOrderEvents).values({
        hotelId: user.hotelId,
        workOrderId: order.id,
        actorId: user.id,
        eventType: "CREATED",
        toStatus: "NEW",
        metadata: { assignedTo, specialty },
      });
      await tx.insert(auditLogs).values({
        hotelId: user.hotelId,
        actorId: user.id,
        action: "WORK_ORDER_CREATED",
        entityType: "work_order",
        entityId: String(order.id),
        details: { priority, assignedTo },
      });
      return order;
    });
    if (assignedTo) {
      io.to(`user:${assignedTo}`).emit("notification:new", {
        kind: "WORK_ORDER_ASSIGNED",
        title: "أمر عمل جديد",
        body: created.title,
        workOrderId: created.id,
      });
    }
    emitWorkOrder(io, user.hotelId, created);
    res.status(201).json({ success: true, workOrder: created });
  });

  app.patch("/api/work-orders/:id/assign", requireAuth, requireRoles("MANAGER"), async (req, res) => {
    const user = userFrom(req);
    const id = positiveInt(req.params.id);
    const technicianId = positiveInt(req.body?.technicianId);
    if (!id || !technicianId) {
      res.status(400).json({ success: false, message: "معرّفات الإسناد غير صالحة" });
      return;
    }
    const technician = (await db.select({ id: users.id }).from(hotelMemberships)
      .innerJoin(users, eq(users.id, hotelMemberships.userId))
      .where(and(
        eq(hotelMemberships.hotelId, user.hotelId),
        eq(hotelMemberships.userId, technicianId),
        eq(hotelMemberships.role, "TECHNICIAN"),
        eq(hotelMemberships.isActive, true),
      )).limit(1))[0];
    if (!technician) {
      res.status(400).json({ success: false, message: "الفني غير نشط في هذا الفندق" });
      return;
    }
    const updated = await db.transaction(async (tx) => {
      const [order] = await tx.update(workOrders)
        .set({ assignedTo: technician.id, updatedAt: new Date() })
        .where(and(eq(workOrders.id, id), eq(workOrders.hotelId, user.hotelId)))
        .returning();
      if (!order) return null;
      await tx.insert(workOrderEvents).values({
        hotelId: user.hotelId,
        workOrderId: id,
        actorId: user.id,
        eventType: "ASSIGNED",
        metadata: { assignedTo: technician.id },
      });
      await tx.insert(auditLogs).values({
        hotelId: user.hotelId,
        actorId: user.id,
        action: "WORK_ORDER_ASSIGNED",
        entityType: "work_order",
        entityId: String(id),
        details: { assignedTo: technician.id },
      });
      return order;
    });
    if (!updated) {
      res.status(404).json({ success: false, message: "أمر العمل غير موجود" });
      return;
    }
    emitWorkOrder(io, user.hotelId, updated);
    io.to(`user:${technician.id}`).emit("notification:new", {
      kind: "WORK_ORDER_ASSIGNED",
      title: "أُسند إليك أمر عمل",
      body: updated.title,
      workOrderId: updated.id,
    });
    res.json({ success: true, workOrder: updated });
  });

  app.patch("/api/work-orders/:id/status", requireAuth, async (req, res) => {
    const user = userFrom(req);
    const id = positiveInt(req.params.id);
    const nextStatus = cleanText(req.body?.status, 30).toUpperCase();
    if (!id || !statuses.includes(nextStatus as (typeof statuses)[number])) {
      res.status(400).json({ success: false, message: "معرّف أمر العمل أو الحالة غير صالح" });
      return;
    }
    if (user.role === "STAFF") {
      res.status(403).json({ success: false, message: "تحديث الحالات متاح للفني المسند أو المدير" });
      return;
    }
    const updated = await db.transaction(async (tx) => {
      const current = (await tx.select().from(workOrders)
        .where(and(eq(workOrders.id, id), eq(workOrders.hotelId, user.hotelId)))
        .limit(1)
        .for("update"))[0];
      if (!current) return { error: "not_found" as const };
      if (user.role === "TECHNICIAN" && current.assignedTo !== user.id) return { error: "forbidden" as const };
      if (current.status === nextStatus || !transitions[current.status]?.includes(nextStatus)) {
        return { error: "transition" as const, from: current.status };
      }
      const now = new Date();
      const changes: Partial<typeof workOrders.$inferInsert> = { status: nextStatus, updatedAt: now };
      if (nextStatus === "ACCEPTED") changes.acceptedAt = now;
      if (nextStatus === "STARTED") changes.startedAt = now;
      if (nextStatus === "FIXED") changes.fixedAt = now;
      if (nextStatus === "CLOSED") changes.closedAt = now;
      const [order] = await tx.update(workOrders)
        .set(changes)
        .where(and(eq(workOrders.id, id), eq(workOrders.hotelId, user.hotelId), eq(workOrders.status, current.status)))
        .returning();
      if (!order) return { error: "conflict" as const };
      await tx.insert(workOrderEvents).values({
        hotelId: user.hotelId,
        workOrderId: id,
        actorId: user.id,
        fromStatus: current.status,
        toStatus: nextStatus,
        eventType: "STATUS_CHANGED",
      });
      await tx.insert(auditLogs).values({
        hotelId: user.hotelId,
        actorId: user.id,
        action: "WORK_ORDER_STATUS_CHANGED",
        entityType: "work_order",
        entityId: String(id),
        details: { from: current.status, to: nextStatus },
      });
      return { order };
    });
    if ("error" in updated) {
      if (updated.error === "not_found") res.status(404).json({ success: false, message: "أمر العمل غير موجود" });
      else if (updated.error === "forbidden") res.status(403).json({ success: false, message: "هذا الأمر غير مسند إليك" });
      else if (updated.error === "transition") res.status(400).json({ success: false, message: `لا يمكن الانتقال من ${updated.from} إلى ${nextStatus}` });
      else res.status(409).json({ success: false, message: "تغير أمر العمل بالتزامن؛ أعد تحميله" });
      return;
    }
    emitWorkOrder(io, user.hotelId, updated.order);
    res.json({ success: true, workOrder: updated.order });
  });

  app.get("/api/work-orders/:id/events", requireAuth, async (req, res) => {
    const user = userFrom(req);
    const id = positiveInt(req.params.id);
    if (!id || !(await canAccessOrder(user, id))) {
      res.status(404).json({ success: false, message: "أمر العمل غير موجود" });
      return;
    }
    const events = await db.select({
      id: workOrderEvents.id,
      eventType: workOrderEvents.eventType,
      fromStatus: workOrderEvents.fromStatus,
      toStatus: workOrderEvents.toStatus,
      metadata: workOrderEvents.metadata,
      createdAt: workOrderEvents.createdAt,
      actorName: users.name,
    }).from(workOrderEvents)
      .leftJoin(users, eq(users.id, workOrderEvents.actorId))
      .where(and(eq(workOrderEvents.hotelId, user.hotelId), eq(workOrderEvents.workOrderId, id)))
      .orderBy(asc(workOrderEvents.createdAt));
    res.json({ events });
  });

  app.get("/api/assets", requireAuth, async (req, res) => {
    const user = userFrom(req);
    res.json({ assets: await db.select().from(assets).where(eq(assets.hotelId, user.hotelId)).orderBy(desc(assets.createdAt)) });
  });

  app.post("/api/assets", requireAuth, requireRoles("MANAGER", "STAFF"), async (req, res) => {
    const user = userFrom(req);
    const name = cleanText(req.body?.name, 160);
    if (!name) {
      res.status(400).json({ success: false, message: "اسم الأصل مطلوب" });
      return;
    }
    const assetCode = cleanText(req.body?.assetCode, 80) || `ASSET-${Date.now()}`;
    const roomId = positiveInt(req.body?.roomId);
    if (roomId && !(await db.select({ id: rooms.id }).from(rooms).where(and(eq(rooms.id, roomId), eq(rooms.hotelId, user.hotelId))).limit(1))[0]) {
      res.status(400).json({ success: false, message: "الغرفة لا تنتمي إلى هذا الفندق" });
      return;
    }
    const [asset] = await db.insert(assets).values({
      hotelId: user.hotelId,
      roomId,
      assetCode,
      name,
      category: cleanText(req.body?.category, 80) || null,
      roomCode: cleanText(req.body?.roomCode, 80) || null,
      qrToken: createQrToken(),
    }).returning();
    await writeAudit(user, "ASSET_CREATED", "asset", asset.id, { assetCode });
    res.status(201).json({ success: true, asset, qrUrl: `/assets/qr/${asset.qrToken}` });
  });

  app.get("/api/assets/:id/qr", requireAuth, async (req, res) => {
    const user = userFrom(req);
    const id = positiveInt(req.params.id);
    const asset = id
      ? (await db.select().from(assets).where(and(eq(assets.id, id), eq(assets.hotelId, user.hotelId))).limit(1))[0]
      : null;
    if (!asset) {
      res.status(404).json({ success: false, message: "الأصل غير موجود" });
      return;
    }
    res.json({ assetId: asset.id, assetCode: asset.assetCode, qrPayload: `${req.protocol}://${req.get("host")}/assets/qr/${asset.qrToken}` });
  });

  app.get("/assets/qr/:token", async (req, res) => {
    const token = cleanText(req.params.token, 100);
    const asset = (await db.select({
      id: assets.id,
      assetCode: assets.assetCode,
      name: assets.name,
      category: assets.category,
      roomCode: assets.roomCode,
    }).from(assets).where(eq(assets.qrToken, token)).limit(1))[0];
    if (!asset) {
      res.status(404).json({ success: false, message: "رمز الأصل غير صالح" });
      return;
    }
    res.json({ asset, createWorkOrderUrl: `/?assetId=${asset.id}` });
  });

  app.get("/api/inventory/items", requireAuth, async (req, res) => {
    const user = userFrom(req);
    const items = await db.select().from(inventoryItems)
      .where(eq(inventoryItems.hotelId, user.hotelId))
      .orderBy(asc(inventoryItems.name));
    res.json({ items });
  });

  app.post("/api/inventory/items", requireAuth, requireRoles("MANAGER", "STAFF"), async (req, res) => {
    const user = userFrom(req);
    const name = cleanText(req.body?.name, 140);
    const sku = cleanText(req.body?.sku, 60).toUpperCase();
    const quantity = Number(req.body?.quantity ?? 0);
    const reorderAt = Number(req.body?.reorderAt ?? 0);
    if (!name || !sku || !Number.isFinite(quantity) || quantity < 0 || !Number.isFinite(reorderAt) || reorderAt < 0) {
      res.status(400).json({ success: false, message: "تحقق من اسم المادة ورمزها والكميات" });
      return;
    }
    const item = await db.transaction(async (tx) => {
      const [created] = await tx.insert(inventoryItems).values({
        hotelId: user.hotelId,
        name,
        sku,
        unit: cleanText(req.body?.unit, 30) || "unit",
        quantity,
        reorderAt,
        location: cleanText(req.body?.location, 100) || null,
      }).returning();
      if (quantity > 0) {
        await tx.insert(inventoryTransactions).values({
          hotelId: user.hotelId,
          itemId: created.id,
          actorId: user.id,
          quantityDelta: quantity,
          reason: "INITIAL_STOCK",
        });
      }
      await tx.insert(auditLogs).values({
        hotelId: user.hotelId,
        actorId: user.id,
        action: "INVENTORY_ITEM_CREATED",
        entityType: "inventory_item",
        entityId: String(created.id),
        details: { sku, quantity },
      });
      return created;
    });
    res.status(201).json({ success: true, item });
  });

  app.post("/api/inventory/items/:id/adjust", requireAuth, requireRoles("MANAGER", "STAFF"), async (req, res) => {
    const user = userFrom(req);
    const id = positiveInt(req.params.id);
    const delta = Number(req.body?.quantityDelta);
    const reason = cleanText(req.body?.reason, 120);
    if (!id || !Number.isFinite(delta) || delta === 0 || !reason) {
      res.status(400).json({ success: false, message: "الكمية والسبب مطلوبان" });
      return;
    }
    const result = await db.transaction(async (tx) => {
      const current = (await tx.select().from(inventoryItems)
        .where(and(eq(inventoryItems.id, id), eq(inventoryItems.hotelId, user.hotelId)))
        .limit(1)
        .for("update"))[0];
      if (!current) return null;
      if (current.quantity + delta < 0) return { insufficient: true as const };
      const [updated] = await tx.update(inventoryItems)
        .set({ quantity: current.quantity + delta, updatedAt: new Date() })
        .where(eq(inventoryItems.id, id))
        .returning();
      await tx.insert(inventoryTransactions).values({
        hotelId: user.hotelId,
        itemId: id,
        actorId: user.id,
        quantityDelta: delta,
        reason,
      });
      await tx.insert(auditLogs).values({
        hotelId: user.hotelId,
        actorId: user.id,
        action: "INVENTORY_ADJUSTED",
        entityType: "inventory_item",
        entityId: String(id),
        details: { quantityDelta: delta, reason },
      });
      return { item: updated };
    });
    if (!result) {
      res.status(404).json({ success: false, message: "مادة المخزون غير موجودة" });
      return;
    }
    if ("insufficient" in result) {
      res.status(409).json({ success: false, message: "الكمية المتاحة لا تكفي" });
      return;
    }
    res.json({ success: true, item: result.item });
  });

  app.post("/api/work-orders/:id/materials", requireAuth, async (req, res) => {
    const user = userFrom(req);
    const orderId = positiveInt(req.params.id);
    const itemId = positiveInt(req.body?.itemId);
    const quantity = Number(req.body?.quantity);
    if (!orderId || !itemId || !Number.isFinite(quantity) || quantity <= 0) {
      res.status(400).json({ success: false, message: "أمر العمل والمادة والكمية مطلوبة" });
      return;
    }
    if (!(await canAccessOrder(user, orderId)) || user.role === "STAFF") {
      res.status(403).json({ success: false, message: "لا يمكنك صرف مواد لهذا الأمر" });
      return;
    }
    const result = await db.transaction(async (tx) => {
      const item = (await tx.select().from(inventoryItems)
        .where(and(eq(inventoryItems.id, itemId), eq(inventoryItems.hotelId, user.hotelId)))
        .limit(1)
        .for("update"))[0];
      if (!item) return { missing: true as const };
      if (item.quantity < quantity) return { insufficient: true as const };
      const [updated] = await tx.update(inventoryItems)
        .set({ quantity: item.quantity - quantity, updatedAt: new Date() })
        .where(eq(inventoryItems.id, itemId))
        .returning();
      await tx.insert(inventoryTransactions).values({
        hotelId: user.hotelId,
        itemId,
        actorId: user.id,
        workOrderId: orderId,
        quantityDelta: -quantity,
        reason: "WORK_ORDER_USAGE",
      });
      await tx.insert(workOrderEvents).values({
        hotelId: user.hotelId,
        workOrderId: orderId,
        actorId: user.id,
        eventType: "MATERIALS_USED",
        metadata: { itemId, quantity },
      });
      await tx.insert(auditLogs).values({
        hotelId: user.hotelId,
        actorId: user.id,
        action: "MATERIALS_ISSUED",
        entityType: "work_order",
        entityId: String(orderId),
        details: { itemId, quantity },
      });
      return { item: updated };
    });
    if ("missing" in result) {
      res.status(404).json({ success: false, message: "مادة المخزون غير موجودة" });
      return;
    }
    if ("insufficient" in result) {
      res.status(409).json({ success: false, message: "الكمية المتاحة لا تكفي" });
      return;
    }
    res.json({ success: true, item: result.item });
  });

  app.get("/api/notifications", requireAuth, async (req, res) => {
    const user = userFrom(req);
    const rows = await db.select().from(notifications)
      .where(and(eq(notifications.hotelId, user.hotelId), or(eq(notifications.recipientId, user.id), isNull(notifications.recipientId))))
      .orderBy(desc(notifications.createdAt))
      .limit(100);
    res.json({ notifications: rows });
  });

  app.patch("/api/notifications/:id/read", requireAuth, async (req, res) => {
    const user = userFrom(req);
    const id = positiveInt(req.params.id);
    if (!id) {
      res.status(400).json({ success: false, message: "معرّف الإشعار غير صالح" });
      return;
    }
    const [updated] = await db.update(notifications).set({ readAt: new Date() })
      .where(and(eq(notifications.id, id), eq(notifications.hotelId, user.hotelId), or(eq(notifications.recipientId, user.id), isNull(notifications.recipientId))))
      .returning({ id: notifications.id });
    if (!updated) {
      res.status(404).json({ success: false, message: "الإشعار غير موجود" });
      return;
    }
    res.json({ success: true });
  });

  app.get("/api/chat/messages", requireAuth, async (req, res) => {
    const user = userFrom(req);
    const workOrderId = positiveInt(req.query.workOrderId);
    if (!workOrderId || !(await canAccessOrder(user, workOrderId))) {
      res.status(404).json({ success: false, message: "المحادثة غير موجودة" });
      return;
    }
    const messages = await db.select().from(chatMessages)
      .where(and(eq(chatMessages.hotelId, user.hotelId), eq(chatMessages.workOrderId, workOrderId)))
      .orderBy(desc(chatMessages.createdAt))
      .limit(100);
    res.json({ messages });
  });

  app.post("/api/chat/messages", requireAuth, async (req, res) => {
    const user = userFrom(req);
    const body = cleanText(req.body?.body, 2000);
    const workOrderId = positiveInt(req.body?.workOrderId);
    if (!body || !workOrderId) {
      res.status(400).json({ success: false, message: "نص الرسالة وأمر العمل مطلوبان" });
      return;
    }
    if (!(await canAccessOrder(user, workOrderId))) {
      res.status(403).json({ success: false, message: "ليس لديك صلاحية لهذه المحادثة" });
      return;
    }
    const recipientId = positiveInt(req.body?.recipientId);
    if (recipientId && !(await db.select({ id: hotelMemberships.id }).from(hotelMemberships)
      .where(and(eq(hotelMemberships.userId, recipientId), eq(hotelMemberships.hotelId, user.hotelId), eq(hotelMemberships.isActive, true)))
      .limit(1))[0]) {
      res.status(400).json({ success: false, message: "المستلم ليس عضواً في هذا الفندق" });
      return;
    }
    const [message] = await db.insert(chatMessages).values({
      hotelId: user.hotelId,
      body,
      senderId: user.id,
      workOrderId,
      recipientId,
    }).returning();
    io.to(`hotel:${user.hotelId}:work-order:${workOrderId}`).emit("chat:message", message);
    if (recipientId) io.to(`user:${recipientId}`).emit("chat:message", message);
    await writeAudit(user, "CHAT_MESSAGE_SENT", "work_order", workOrderId, { messageId: message.id });
    res.status(201).json({ success: true, message });
  });

  app.get("/api/analytics/summary", requireAuth, async (req, res) => {
    const user = userFrom(req);
    const scope = allowedOrderCondition(user);
    const total = await db.select({ count: sql<number>`count(*)` }).from(workOrders).where(scope);
    const byStatus = await db.select({ status: workOrders.status, count: sql<number>`count(*)` })
      .from(workOrders).where(scope).groupBy(workOrders.status);
    const overdue = await db.select({ count: sql<number>`count(*)` }).from(workOrders)
      .where(and(scope, lt(workOrders.slaDueAt, new Date()), ne(workOrders.status, "FIXED"), ne(workOrders.status, "CLOSED")));
    res.json({
      total: Number(total[0]?.count ?? 0),
      overdue: Number(overdue[0]?.count ?? 0),
      byStatus: byStatus.map((row) => ({ status: row.status, count: Number(row.count) })),
      onlineTechnicians: listOnlineTechnicians(user.hotelId).length,
    });
  });

  app.get("/api/reports/work-orders.csv", requireAuth, requireRoles("MANAGER"), async (req, res) => {
    const user = userFrom(req);
    const from = req.query.from ? new Date(String(req.query.from)) : null;
    const to = req.query.to ? new Date(String(req.query.to)) : null;
    const conditions = [eq(workOrders.hotelId, user.hotelId)];
    if (from && !Number.isNaN(from.getTime())) conditions.push(gte(workOrders.createdAt, from));
    if (to && !Number.isNaN(to.getTime())) conditions.push(lt(workOrders.createdAt, new Date(to.getTime() + 86400000)));
    const rows = await db.select({
      id: workOrders.id,
      title: workOrders.title,
      location: workOrders.location,
      roomCode: workOrders.roomCode,
      priority: workOrders.priority,
      status: workOrders.status,
      specialty: workOrders.specialty,
      createdAt: workOrders.createdAt,
      slaDueAt: workOrders.slaDueAt,
    }).from(workOrders).where(and(...conditions)).orderBy(desc(workOrders.createdAt)).limit(10000);
    const header = ["id", "title", "location", "room", "priority", "status", "specialty", "createdAt", "slaDueAt"];
    const lines = rows.map((row) => [
      row.id, row.title, row.location, row.roomCode, row.priority, row.status, row.specialty, row.createdAt?.toISOString(), row.slaDueAt?.toISOString(),
    ].map(csvCell).join(","));
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="hotel-${user.hotelId}-work-orders.csv"`);
    res.send(`\uFEFF${header.map(csvCell).join(",")}\r\n${lines.join("\r\n")}`);
  });

  app.get("/api/audit-logs", requireAuth, requireRoles("MANAGER"), async (req, res) => {
    const user = userFrom(req);
    const rows = await db.select({
      id: auditLogs.id,
      action: auditLogs.action,
      entityType: auditLogs.entityType,
      entityId: auditLogs.entityId,
      details: auditLogs.details,
      createdAt: auditLogs.createdAt,
      actorName: users.name,
      actorEmail: users.email,
    }).from(auditLogs)
      .leftJoin(users, eq(users.id, auditLogs.actorId))
      .where(eq(auditLogs.hotelId, user.hotelId))
      .orderBy(desc(auditLogs.createdAt))
      .limit(200);
    res.json({ auditLogs: rows });
  });

  app.get("/api/admin/backup", requireAuth, requireRoles("MANAGER"), async (req, res) => {
    const user = userFrom(req);
    const [hotel] = await db.select().from(hotels).where(eq(hotels.id, user.hotelId)).limit(1);
    const [members, buildingRows, roomRows, assetRows, orderRows, eventRows, itemRows, transactionRows] = await Promise.all([
      db.select({ userId: hotelMemberships.userId, role: hotelMemberships.role, specialty: hotelMemberships.specialty, isActive: hotelMemberships.isActive })
        .from(hotelMemberships).where(eq(hotelMemberships.hotelId, user.hotelId)),
      db.select().from(buildings).where(eq(buildings.hotelId, user.hotelId)),
      db.select().from(rooms).where(eq(rooms.hotelId, user.hotelId)),
      db.select().from(assets).where(eq(assets.hotelId, user.hotelId)),
      db.select().from(workOrders).where(eq(workOrders.hotelId, user.hotelId)),
      db.select().from(workOrderEvents).where(eq(workOrderEvents.hotelId, user.hotelId)),
      db.select().from(inventoryItems).where(eq(inventoryItems.hotelId, user.hotelId)),
      db.select().from(inventoryTransactions).where(eq(inventoryTransactions.hotelId, user.hotelId)),
    ]);
    const snapshot = {
      format: "t-smart-hotel-backup",
      version: 1,
      exportedAt: new Date().toISOString(),
      hotelId: user.hotelId,
      hotel,
      members,
      buildings: buildingRows,
      rooms: roomRows,
      assets: assetRows,
      workOrders: orderRows,
      workOrderEvents: eventRows,
      inventoryItems: itemRows,
      inventoryTransactions: transactionRows,
    };
    const envelope = { snapshot, signature: signBackup(JSON.stringify(snapshot)) };
    await writeAudit(user, "BACKUP_EXPORTED", "hotel", user.hotelId, { exportedAt: snapshot.exportedAt });
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="t-smart-hotel-${user.hotelId}-backup.json"`);
    res.send(JSON.stringify(envelope));
  });

  app.post("/api/admin/restore", requireAuth, requireRoles("MANAGER"), async (req, res) => {
    const user = userFrom(req);
    const snapshot = req.body?.snapshot;
    const signature = cleanText(req.body?.signature, 128);
    if (
      !snapshot ||
      snapshot.format !== "t-smart-hotel-backup" ||
      snapshot.version !== 1 ||
      Number(snapshot.hotelId) !== user.hotelId ||
      !signature ||
      !verifyBackup(JSON.stringify(snapshot), signature)
    ) {
      res.status(400).json({ success: false, message: "ملف النسخة غير صالح أو لا يخص هذا الفندق" });
      return;
    }
    const requiredArrays = ["buildings", "rooms", "assets", "workOrders", "workOrderEvents", "inventoryItems", "inventoryTransactions"];
    if (requiredArrays.some((key) => !Array.isArray(snapshot[key]))) {
      res.status(400).json({ success: false, message: "بيانات النسخة غير مكتملة" });
      return;
    }
    await db.transaction(async (tx) => {
      for (const row of snapshot.buildings) {
        await tx.insert(buildings).values({ ...row, hotelId: user.hotelId })
          .onConflictDoUpdate({ target: buildings.id, set: { name: row.name, code: row.code, floors: row.floors, updatedAt: new Date() }, setWhere: eq(buildings.hotelId, user.hotelId) });
      }
      for (const row of snapshot.rooms) {
        await tx.insert(rooms).values({ ...row, hotelId: user.hotelId })
          .onConflictDoUpdate({ target: rooms.id, set: { buildingId: row.buildingId, roomNumber: row.roomNumber, floor: row.floor, roomType: row.roomType, status: row.status, updatedAt: new Date() }, setWhere: eq(rooms.hotelId, user.hotelId) });
      }
      for (const row of snapshot.assets) {
        await tx.insert(assets).values({ ...row, hotelId: user.hotelId })
          .onConflictDoUpdate({ target: assets.id, set: { roomId: row.roomId, assetCode: row.assetCode, name: row.name, category: row.category, roomCode: row.roomCode, qrToken: row.qrToken, updatedAt: new Date() }, setWhere: eq(assets.hotelId, user.hotelId) });
      }
      for (const row of snapshot.workOrders) {
        await tx.insert(workOrders).values({ ...row, hotelId: user.hotelId })
          .onConflictDoUpdate({ target: workOrders.id, set: {
            title: row.title, description: row.description, location: row.location, roomCode: row.roomCode, roomId: row.roomId,
            category: row.category, specialty: row.specialty, priority: row.priority, status: row.status, createdBy: row.createdBy,
            assignedTo: row.assignedTo, assetId: row.assetId, slaDueAt: row.slaDueAt, acceptedAt: row.acceptedAt,
            startedAt: row.startedAt, fixedAt: row.fixedAt, closedAt: row.closedAt, updatedAt: new Date(),
          }, setWhere: eq(workOrders.hotelId, user.hotelId) });
      }
      for (const row of snapshot.inventoryItems) {
        await tx.insert(inventoryItems).values({ ...row, hotelId: user.hotelId })
          .onConflictDoUpdate({ target: inventoryItems.id, set: { sku: row.sku, name: row.name, unit: row.unit, quantity: row.quantity, reorderAt: row.reorderAt, location: row.location, updatedAt: new Date() }, setWhere: eq(inventoryItems.hotelId, user.hotelId) });
      }
      for (const row of snapshot.workOrderEvents) {
        await tx.insert(workOrderEvents).values({ ...row, hotelId: user.hotelId }).onConflictDoNothing();
      }
      for (const row of snapshot.inventoryTransactions) {
        await tx.insert(inventoryTransactions).values({ ...row, hotelId: user.hotelId }).onConflictDoNothing();
      }
      await tx.insert(auditLogs).values({
        hotelId: user.hotelId,
        actorId: user.id,
        action: "BACKUP_RESTORED",
        entityType: "hotel",
        entityId: String(user.hotelId),
        details: { exportedAt: snapshot.exportedAt },
      });
    });
    res.json({ success: true, message: "اكتملت استعادة بيانات التشغيل من النسخة الموقعة." });
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error("Unhandled API error:", error);
    if (res.headersSent) return;
    res.status(500).json({ success: false, message: "حدث خطأ داخلي؛ لم يتم إكمال العملية" });
  });
  return app;
}

export async function runSlaMonitor(io: Server): Promise<void> {
  const now = new Date();
  const upcoming = await db.select({
    id: workOrders.id,
    hotelId: workOrders.hotelId,
    title: workOrders.title,
    status: workOrders.status,
    slaDueAt: workOrders.slaDueAt,
    assignedTo: workOrders.assignedTo,
  }).from(workOrders)
    .where(and(
      lt(workOrders.slaDueAt, new Date(now.getTime() + 60 * 60 * 1000)),
      ne(workOrders.status, "FIXED"),
      ne(workOrders.status, "CLOSED"),
    ))
    .limit(1000);
  for (const order of upcoming) {
    if (!order.hotelId || !order.slaDueAt) continue;
    const kind = order.slaDueAt.getTime() <= now.getTime() ? "SLA_OVERDUE" : "SLA_WARNING";
    const managers = await db.select({ userId: hotelMemberships.userId }).from(hotelMemberships)
      .where(and(eq(hotelMemberships.hotelId, order.hotelId), eq(hotelMemberships.role, "MANAGER"), eq(hotelMemberships.isActive, true)));
    for (const manager of managers) {
      const [created] = await db.insert(notifications).values({
        hotelId: order.hotelId,
        recipientId: manager.userId,
        workOrderId: order.id,
        kind,
        title: kind === "SLA_OVERDUE" ? "تجاوز أمر العمل مهلة SLA" : "اقتراب مهلة SLA",
        body: order.title,
      }).onConflictDoNothing().returning();
      if (created) io.to(`user:${manager.userId}`).emit("notification:new", created);
    }
    if (order.assignedTo && kind === "SLA_OVERDUE") {
      const [created] = await db.insert(notifications).values({
        hotelId: order.hotelId,
        recipientId: order.assignedTo,
        workOrderId: order.id,
        kind,
        title: "تجاوز أمر العمل مهلة SLA",
        body: order.title,
      }).onConflictDoNothing().returning();
      if (created) io.to(`user:${order.assignedTo}`).emit("notification:new", created);
    }
  }
}