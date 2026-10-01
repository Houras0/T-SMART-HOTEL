import crypto from "crypto";
import { promisify } from "util";
import * as jwt from "jsonwebtoken";

const scrypt = promisify(crypto.scrypt);
const jwtSecret = process.env.JWT_SECRET || process.env.SESSION_SECRET;

export type Role = "MANAGER" | "TECHNICIAN" | "STAFF";

export type AuthUser = {
  id: number;
  hotelId: number;
  email: string;
  name: string;
  role: Role;
  specialty: string | null;
};

function getJwtSecret(): string {
  if (!jwtSecret) {
    throw new Error("JWT_SECRET or SESSION_SECRET must be configured");
  }

  return jwtSecret;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString("hex");
  const derivedKey = (await scrypt(password, salt, 64)) as Buffer;
  return `${salt}:${derivedKey.toString("hex")}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [salt, expectedHex] = storedHash.split(":");
  if (!salt || !expectedHex) {
    return false;
  }

  const actual = (await scrypt(password, salt, 64)) as Buffer;
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function createAccessToken(user: AuthUser): string {
  return jwt.sign(
    {
      sub: String(user.id),
      hotelId: user.hotelId,
      email: user.email,
      name: user.name,
      role: user.role,
      specialty: user.specialty,
    },
    getJwtSecret(),
    { expiresIn: "15m" },
  );
}

export function createRefreshToken(): string {
  return crypto.randomBytes(48).toString("base64url");
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function signBackup(payload: string): string {
  return crypto.createHmac("sha256", getJwtSecret()).update(payload).digest("hex");
}

export function verifyBackup(payload: string, signature: string): boolean {
  const actual = Buffer.from(signBackup(payload), "hex");
  const expected = Buffer.from(signature, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function verifyAccessToken(token: string): AuthUser {
  const payload = jwt.verify(token, getJwtSecret()) as jwt.JwtPayload & {
    email?: string;
    name?: string;
    role?: Role;
    specialty?: string | null;
    hotelId?: number;
  };

  if (
    typeof payload.sub !== "string" ||
    !Number.isSafeInteger(Number(payload.sub)) ||
    Number(payload.sub) <= 0 ||
    !Number.isSafeInteger(payload.hotelId) ||
    Number(payload.hotelId) <= 0 ||
    typeof payload.email !== "string" ||
    typeof payload.name !== "string" ||
    !["MANAGER", "TECHNICIAN", "STAFF"].includes(payload.role ?? "")
  ) {
    throw new Error("Invalid access token");
  }

  return {
    id: Number(payload.sub),
    hotelId: payload.hotelId,
    email: payload.email,
    name: payload.name,
    role: payload.role as Role,
    specialty: payload.specialty ?? null,
  };
}

export function verifyOtp(email: string, otp: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashOtp(email, otp), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function hashOtp(email: string, otp: string): string {
  return crypto
    .createHmac("sha256", getJwtSecret())
    .update(`${email}:${otp}`)
    .digest("hex");
}

export function createOtp(): string {
  return crypto.randomInt(100000, 1000000).toString();
}

export function createQrToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}