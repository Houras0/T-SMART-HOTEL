import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
};

export const hotels = pgTable(
  "hotels",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    logoUrl: text("logo_url"),
    settings: jsonb("settings").$type<Record<string, unknown>>().default({}).notNull(),
    ...timestamps,
  },
  (table) => [uniqueIndex("hotels_slug_unique").on(table.slug)],
);

export const users = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: text("role").notNull().default("STAFF"),
    specialty: text("specialty"),
    emailVerified: boolean("email_verified").notNull().default(false),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [uniqueIndex("users_email_unique").on(table.email), index("users_role_idx").on(table.role)],
);

export const hotelMemberships = pgTable(
  "hotel_memberships",
  {
    id: serial("id").primaryKey(),
    hotelId: integer("hotel_id").notNull().references(() => hotels.id, { onDelete: "cascade" }),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("STAFF"),
    specialty: text("specialty"),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("hotel_memberships_hotel_user_unique").on(table.hotelId, table.userId),
    index("hotel_memberships_user_idx").on(table.userId),
    index("hotel_memberships_hotel_role_idx").on(table.hotelId, table.role),
  ],
);

export const hotelInvitations = pgTable(
  "hotel_invitations",
  {
    id: serial("id").primaryKey(),
    hotelId: integer("hotel_id").notNull().references(() => hotels.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    name: text("name").notNull(),
    role: text("role").notNull(),
    specialty: text("specialty"),
    codeHash: text("code_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdBy: integer("created_by").notNull().references(() => users.id),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("hotel_invitations_hotel_email_unique").on(table.hotelId, table.email),
    index("hotel_invitations_expires_idx").on(table.expiresAt),
  ],
);

export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [uniqueIndex("refresh_tokens_hash_unique").on(table.tokenHash), index("refresh_tokens_user_idx").on(table.userId)],
);

export const otpChallenges = pgTable(
  "otp_challenges",
  {
    id: serial("id").primaryKey(),
    email: text("email").notNull(),
    codeHash: text("code_hash").notNull(),
    attempts: integer("attempts").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSentAt: timestamp("last_sent_at", { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => [uniqueIndex("otp_challenges_email_unique").on(table.email)],
);

export const buildings = pgTable(
  "buildings",
  {
    id: serial("id").primaryKey(),
    hotelId: integer("hotel_id").notNull().references(() => hotels.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    code: text("code").notNull(),
    floors: integer("floors").notNull().default(1),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("buildings_hotel_code_unique").on(table.hotelId, table.code),
    index("buildings_hotel_idx").on(table.hotelId),
  ],
);

export const rooms = pgTable(
  "rooms",
  {
    id: serial("id").primaryKey(),
    hotelId: integer("hotel_id").notNull().references(() => hotels.id, { onDelete: "cascade" }),
    buildingId: integer("building_id").notNull().references(() => buildings.id, { onDelete: "cascade" }),
    roomNumber: text("room_number").notNull(),
    floor: text("floor"),
    roomType: text("room_type"),
    status: text("status").notNull().default("OCCUPIED"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("rooms_building_number_unique").on(table.buildingId, table.roomNumber),
    index("rooms_hotel_idx").on(table.hotelId),
  ],
);

export const assets = pgTable(
  "assets",
  {
    id: serial("id").primaryKey(),
    hotelId: integer("hotel_id").references(() => hotels.id, { onDelete: "cascade" }),
    roomId: integer("room_id").references(() => rooms.id, { onDelete: "set null" }),
    assetCode: text("asset_code").notNull(),
    name: text("name").notNull(),
    category: text("category"),
    roomCode: text("room_code"),
    qrToken: text("qr_token").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("assets_hotel_code_unique").on(table.hotelId, table.assetCode),
    uniqueIndex("assets_qr_token_unique").on(table.qrToken),
    index("assets_hotel_idx").on(table.hotelId),
  ],
);

export const workOrders = pgTable(
  "work_orders",
  {
    id: serial("id").primaryKey(),
    hotelId: integer("hotel_id").references(() => hotels.id, { onDelete: "cascade" }),
    roomId: integer("room_id").references(() => rooms.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    description: text("description").notNull(),
    location: text("location").notNull(),
    roomCode: text("room_code"),
    category: text("category").notNull(),
    specialty: text("specialty").notNull(),
    priority: text("priority").notNull().default("MEDIUM"),
    status: text("status").notNull().default("NEW"),
    createdBy: integer("created_by").notNull().references(() => users.id),
    assignedTo: integer("assigned_to").references(() => users.id),
    assetId: integer("asset_id").references(() => assets.id),
    slaDueAt: timestamp("sla_due_at", { withTimezone: true }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    fixedAt: timestamp("fixed_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("work_orders_status_idx").on(table.status),
    index("work_orders_assigned_idx").on(table.assignedTo),
    index("work_orders_sla_idx").on(table.slaDueAt),
    index("work_orders_hotel_idx").on(table.hotelId),
  ],
);

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: serial("id").primaryKey(),
    hotelId: integer("hotel_id").references(() => hotels.id, { onDelete: "cascade" }),
    workOrderId: integer("work_order_id").references(() => workOrders.id, { onDelete: "cascade" }),
    senderId: integer("sender_id").notNull().references(() => users.id),
    recipientId: integer("recipient_id").references(() => users.id),
    body: text("body").notNull(),
    ...timestamps,
  },
  (table) => [index("chat_messages_work_order_idx").on(table.workOrderId), index("chat_messages_created_idx").on(table.createdAt)],
);

export const workOrderEvents = pgTable(
  "work_order_events",
  {
    id: serial("id").primaryKey(),
    hotelId: integer("hotel_id").references(() => hotels.id, { onDelete: "cascade" }),
    workOrderId: integer("work_order_id").notNull().references(() => workOrders.id, { onDelete: "cascade" }),
    actorId: integer("actor_id").notNull().references(() => users.id),
    fromStatus: text("from_status"),
    toStatus: text("to_status"),
    eventType: text("event_type").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
    ...timestamps,
  },
  (table) => [index("work_order_events_order_idx").on(table.workOrderId), index("work_order_events_created_idx").on(table.createdAt)],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: serial("id").primaryKey(),
    hotelId: integer("hotel_id").notNull().references(() => hotels.id, { onDelete: "cascade" }),
    actorId: integer("actor_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    details: jsonb("details").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("audit_logs_hotel_created_idx").on(table.hotelId, table.createdAt),
    index("audit_logs_entity_idx").on(table.entityType, table.entityId),
  ],
);

export const inventoryItems = pgTable(
  "inventory_items",
  {
    id: serial("id").primaryKey(),
    hotelId: integer("hotel_id").notNull().references(() => hotels.id, { onDelete: "cascade" }),
    sku: text("sku").notNull(),
    name: text("name").notNull(),
    unit: text("unit").notNull().default("unit"),
    quantity: doublePrecision("quantity").notNull().default(0),
    reorderAt: doublePrecision("reorder_at").notNull().default(0),
    location: text("location"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("inventory_items_hotel_sku_unique").on(table.hotelId, table.sku),
    index("inventory_items_hotel_idx").on(table.hotelId),
  ],
);

export const inventoryTransactions = pgTable(
  "inventory_transactions",
  {
    id: serial("id").primaryKey(),
    hotelId: integer("hotel_id").notNull().references(() => hotels.id, { onDelete: "cascade" }),
    itemId: integer("item_id").notNull().references(() => inventoryItems.id, { onDelete: "restrict" }),
    actorId: integer("actor_id").notNull().references(() => users.id),
    workOrderId: integer("work_order_id").references(() => workOrders.id, { onDelete: "set null" }),
    quantityDelta: doublePrecision("quantity_delta").notNull(),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("inventory_transactions_hotel_idx").on(table.hotelId),
    index("inventory_transactions_item_idx").on(table.itemId, table.createdAt),
  ],
);

export const notifications = pgTable(
  "notifications",
  {
    id: serial("id").primaryKey(),
    hotelId: integer("hotel_id").notNull().references(() => hotels.id, { onDelete: "cascade" }),
    recipientId: integer("recipient_id").references(() => users.id, { onDelete: "cascade" }),
    workOrderId: integer("work_order_id").references(() => workOrders.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("notifications_order_kind_recipient_unique").on(table.workOrderId, table.kind, table.recipientId),
    index("notifications_hotel_created_idx").on(table.hotelId, table.createdAt),
    index("notifications_recipient_idx").on(table.recipientId, table.readAt),
  ],
);