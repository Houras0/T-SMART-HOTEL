import "dotenv/config";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  assets,
  chatMessages,
  hotelMemberships,
  hotels,
  users,
  workOrderEvents,
  workOrders,
} from "@workspace/db/schema";

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Demo seeding is disabled in production");
  }

  const hotelName = process.env.LEGACY_HOTEL_NAME?.trim() || "T-SMART Legacy Hotel";
  let hotel = (await db.select().from(hotels).where(eq(hotels.slug, "legacy-hotel")).limit(1))[0];
  if (!hotel) {
    [hotel] = await db.insert(hotels).values({
      name: hotelName,
      slug: "legacy-hotel",
      settings: { timezone: "Africa/Cairo", currency: "EGP" },
    }).returning();
  }

  const existingUsers = await db.select().from(users);
  for (const user of existingUsers) {
    const role = ["MANAGER", "TECHNICIAN", "STAFF"].includes(user.role) ? user.role : "STAFF";
    await db.insert(hotelMemberships).values({
      hotelId: hotel.id,
      userId: user.id,
      role,
      specialty: user.specialty,
      isActive: true,
    }).onConflictDoNothing();
  }

  await db.update(assets).set({ hotelId: hotel.id }).where(isNull(assets.hotelId));
  await db.update(workOrders).set({ hotelId: hotel.id }).where(isNull(workOrders.hotelId));
  await db.update(chatMessages).set({ hotelId: hotel.id }).where(isNull(chatMessages.hotelId));
  await db.update(workOrderEvents).set({ hotelId: hotel.id }).where(isNull(workOrderEvents.hotelId));

  if (process.env.SEED_DEMO_USERS === "true") {
    const demoPassword = process.env.DEMO_PASSWORD;
    if (!demoPassword || demoPassword.length < 12) {
      throw new Error("Set DEMO_PASSWORD to at least 12 characters when SEED_DEMO_USERS=true");
    }
    throw new Error("Create demo users only through the hotel invitation flow; fixed demo identities are disabled");
  }

  console.log(`Legacy development records assigned to hotel "${hotel.name}" (${hotel.id}).`);
  await db.$client.end();
}

void main().catch(async (error) => {
  console.error(error);
  await db.$client.end().catch(() => undefined);
  process.exitCode = 1;
});