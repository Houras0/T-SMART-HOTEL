import { useEffect, useMemo, useState, type FormEvent } from "react";
import { io, type Socket } from "socket.io-client";
import "./app.css";

type Role = "MANAGER" | "TECHNICIAN" | "STAFF";
type User = { id: number; hotelId: number; name: string; email: string; role: Role; specialty: string | null };
type Hotel = { id: number; name: string; logoUrl: string | null; role?: Role; settings?: Record<string, unknown> };
type Member = { id: number; name: string; email: string; role: Role; specialty: string | null; isActive: boolean; lastSeenAt: string | null };
type Building = { id: number; name: string; code: string; floors: number };
type Room = { id: number; buildingId: number; buildingName: string; roomNumber: string; floor: string | null; roomType: string | null; status: string };
type InventoryItem = { id: number; sku: string; name: string; unit: string; quantity: number; reorderAt: number; location: string | null };
type Notice = { id: number; kind: string; title: string; body: string; workOrderId: number | null; readAt: string | null; createdAt: string };
type AuditEntry = { id: number; action: string; entityType: string; entityId: string | null; actorName: string | null; createdAt: string };
type WorkOrder = {
  id: number;
  title: string;
  description: string;
  location: string;
  roomCode: string | null;
  category: string;
  specialty: string;
  priority: string;
  status: string;
  assignedTo: number | null;
  assigneeName?: string | null;
  slaDueAt: string | null;
  createdAt: string;
};
type Technician = { id: number; name: string; email: string; specialty: string | null; lastSeenAt: string | null };
type Asset = { id: number; assetCode: string; name: string; category: string | null; roomCode: string | null; qrToken: string };
type Message = { id: number; body: string; senderId: number; workOrderId: number | null; createdAt: string };
type Analytics = { total: number; overdue: number; onlineTechnicians: number; byStatus: { status: string; count: number }[] };

const tokenKey = "t-smart-access-token";

async function request<T>(path: string, options: RequestInit = {}, token?: string): Promise<T> {
  const send = (access?: string) => {
    const headers = new Headers(options.headers);
    if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    if (access) headers.set("Authorization", `Bearer ${access}`);
    return fetch(path, { ...options, headers, credentials: "include" });
  };
  let response = await send(token || localStorage.getItem(tokenKey) || undefined);
  if (response.status === 401 && path !== "/api/auth/refresh" && path !== "/api/auth/login") {
    const refresh = await fetch("/api/auth/refresh", { method: "POST", credentials: "include" });
    const session = await refresh.json().catch(() => ({}));
    if (refresh.ok && session.accessToken) {
      localStorage.setItem(tokenKey, session.accessToken);
      window.dispatchEvent(new CustomEvent("t-smart:token-refreshed", { detail: session.accessToken }));
      response = await send(session.accessToken);
    } else {
      localStorage.removeItem(tokenKey);
      window.dispatchEvent(new Event("t-smart:session-expired"));
    }
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || "حدث خطأ في الطلب");
  return payload as T;
}

const roleLabels: Record<Role, string> = {
  MANAGER: "مدير",
  TECHNICIAN: "فني",
  STAFF: "موظف",
};

const statusLabels: Record<string, string> = {
  NEW: "جديد",
  ACCEPTED: "تم القبول",
  ON_THE_WAY: "في الطريق",
  STARTED: "بدأ العمل",
  FIXED: "تم الإصلاح",
  CLOSED: "مغلق",
};

const transitions: Record<string, string[]> = {
  NEW: ["ACCEPTED"],
  ACCEPTED: ["ON_THE_WAY"],
  ON_THE_WAY: ["STARTED"],
  STARTED: ["FIXED"],
  FIXED: ["CLOSED"],
  CLOSED: [],
};

function AuthScreen({ onLogin }: { onLogin: (user: User, access: string, hotels?: Hotel[]) => void }) {
  const [mode, setMode] = useState<"login" | "register" | "join">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [hotelName, setHotelName] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [hotelId, setHotelId] = useState("");
  const [otp, setOtp] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (mode === "register") {
        const result = await request<{ user: User; accessToken: string }>("/api/register", {
          method: "POST",
          body: JSON.stringify({ email, password, name, hotelName, logoUrl, otp }),
        });
        onLogin(result.user, result.accessToken, [{ id: result.user.hotelId, name: hotelName, logoUrl }]);
      } else if (mode === "join") {
        const result = await request<{ user: User; accessToken: string }>("/api/hotel/invitations/accept", {
          method: "POST",
          body: JSON.stringify({ hotelId: Number(hotelId), email, password, name, otp }),
        });
        onLogin(result.user, result.accessToken, result.hotels);
      } else {
        const result = await request<{ user: User; accessToken: string; hotels: Hotel[] }>("/api/auth/login", {
          method: "POST",
          body: JSON.stringify({ email, password }),
        });
        onLogin(result.user, result.accessToken, result.hotels);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "تعذر تسجيل الدخول");
    } finally {
      setBusy(false);
    }
  }

  async function sendOtp() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await request<{ message: string }>("/api/send-otp", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
      setMessage(result.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : "تعذر إرسال الرمز");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-brand">
        <span className="brand-mark">TS</span>
        <p className="eyebrow">T-SMART V7</p>
        <h1>إدارة الصيانة بوضوح.</h1>
        <p>تابع أوامر العمل، وزّع المهام، وتواصل مع فريق الصيانة من لوحة واحدة.</p>
        <div className="feature-list">
          <span>✓ متابعة SLA لحظياً</span>
          <span>✓ إشعارات فورية للفريق</span>
          <span>✓ مسارات عمل حسب التخصص</span>
        </div>
      </section>
      <section className="auth-card">
        <p className="eyebrow">{mode === "login" ? "دخول الفريق" : mode === "register" ? "إعداد فندق جديد" : "الانضمام إلى فريق"}</p>
        <h2>{mode === "login" ? "مرحباً بعودتك" : mode === "register" ? "ابدأ تشغيل فندقك" : "قبول دعوة الفريق"}</h2>
        <p className="muted">{mode === "login" ? "استخدم بريدك وكلمة المرور للدخول إلى مساحة العمل." : "البيانات والإعدادات خاصة بفندقك ويمكن تغييرها من لوحة الإدارة."}</p>
        <form onSubmit={submit} className="stack">
          {mode !== "login" && <label>اسم المسؤول<input value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" /></label>}
          {mode === "register" && <label>اسم الفندق<input value={hotelName} onChange={(e) => setHotelName(e.target.value)} required /></label>}
          {mode === "register" && <label>رابط الشعار (اختياري)<input type="url" value={logoUrl} onChange={(e) => setLogoUrl(e.target.value)} placeholder="https://example.com/logo.png" /></label>}
          {mode === "join" && <label>رقم الفندق<input inputMode="numeric" value={hotelId} onChange={(e) => setHotelId(e.target.value)} required /></label>}
          <label>البريد الإلكتروني<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required placeholder="name@company.com" /></label>
          <label>كلمة المرور<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={mode === "login" ? undefined : 1} autoComplete={mode === "login" ? "current-password" : "new-password"} placeholder={mode === "login" ? "كلمة المرور" : "12 حرفاً للحساب الجديد"} /></label>
          {mode !== "login" && <label>رمز البريد الإلكتروني<input inputMode="numeric" pattern="[0-9]{6}" value={otp} onChange={(e) => setOtp(e.target.value)} required maxLength={6} /></label>}
          {mode === "register" && <button type="button" className="secondary-button" onClick={sendOtp} disabled={busy || !email}>إرسال رمز التحقق</button>}
          {error && <div className="alert error">{error}</div>}
          {message && <div className="alert info">{message}</div>}
          <button className="primary-button" disabled={busy}>{busy ? "جارٍ التحقق..." : mode === "login" ? "تسجيل الدخول" : mode === "register" ? "إنشاء الفندق والحساب" : "قبول الدعوة"}</button>
        </form>
        <div className="auth-switch">
          <button onClick={() => { setMode(mode === "register" ? "login" : "register"); setError(""); setMessage(""); }}>
            {mode === "register" ? "لديك حساب؟ تسجيل الدخول" : "إعداد فندق جديد"}
          </button>
          <button onClick={() => { setMode(mode === "join" ? "login" : "join"); setError(""); setMessage(""); }}>
            {mode === "join" ? "العودة للدخول" : "لديك دعوة فريق؟"}
          </button>
        </div>
      </section>
    </main>
  );
}

function Dashboard({
  user,
  token,
  hotelOptions,
  onLogout,
  onHotelChange,
}: {
  user: User;
  token: string;
  hotelOptions: Hotel[];
  onLogout: () => void;
  onHotelChange: (user: User, token: string) => void;
}) {
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([]);
  const [technicians, setTechnicians] = useState<Technician[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [analytics, setAnalytics] = useState<Analytics>({ total: 0, overdue: 0, onlineTechnicians: 0, byStatus: [] });
  const [online, setOnline] = useState<User[]>([]);
  const [selectedOrder, setSelectedOrder] = useState<number | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [chatBody, setChatBody] = useState("");
  const [notice, setNotice] = useState("");
  const [socket, setSocket] = useState<Socket | null>(null);
  const [hotel, setHotel] = useState<Hotel | null>(null);
  const [hotelForm, setHotelForm] = useState({
    name: "",
    logoUrl: "",
    timezone: "Africa/Cairo",
    currency: "EGP",
    slaHours: { CRITICAL: "2", HIGH: "4", MEDIUM: "24", LOW: "72" },
  });
  const [buildings, setBuildings] = useState<Building[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [notifications, setNotifications] = useState<Notice[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditEntry[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [eventHistory, setEventHistory] = useState<{ eventType: string; toStatus: string | null; actorName: string | null; createdAt: string }[]>([]);
  const [searchText, setSearchText] = useState("");
  const [buildingForm, setBuildingForm] = useState({ name: "", code: "", floors: "1" });
  const [roomForm, setRoomForm] = useState({ buildingId: "", roomNumber: "", floor: "", roomType: "غرفة نزيل" });
  const [inventoryForm, setInventoryForm] = useState({ name: "", sku: "", unit: "قطعة", quantity: "0", reorderAt: "0", location: "" });
  const [materialForm, setMaterialForm] = useState({ itemId: "", quantity: "1" });
  const [inviteForm, setInviteForm] = useState({ name: "", email: "", role: "TECHNICIAN", specialty: "HVAC" });
  const [backupFile, setBackupFile] = useState<File | null>(null);
  const [orderForm, setOrderForm] = useState({ title: "", description: "", location: "", specialty: "HVAC", priority: "MEDIUM", roomCode: "", roomId: "" });
  const [assetForm, setAssetForm] = useState({ name: "", assetCode: "", category: "", roomCode: "", roomId: "" });

  const canCreate = user.role === "MANAGER" || user.role === "STAFF";
  const selected = useMemo(() => workOrders.find((order) => order.id === selectedOrder), [workOrders, selectedOrder]);

  async function loadData() {
    try {
      const query = searchText ? `?q=${encodeURIComponent(searchText)}` : "";
      const [orders, stats, presence, hotelResult, noticeResult] = await Promise.all([
        request<{ workOrders: WorkOrder[] }>(`/api/work-orders${query}`, {}, token),
        request<Analytics>("/api/analytics/summary", {}, token),
        request<{ technicians: User[] }>("/api/presence", {}, token),
        request<{ hotel: Hotel }>("/api/hotel", {}, token),
        request<{ notifications: Notice[] }>("/api/notifications", {}, token),
      ]);
      setWorkOrders(orders.workOrders);
      setAnalytics(stats);
      setOnline(presence.technicians);
      setHotel(hotelResult.hotel);
      const settings = hotelResult.hotel.settings || {};
      const sla = settings.slaHours && typeof settings.slaHours === "object" ? settings.slaHours as Record<string, number> : {};
      setHotelForm({
        name: hotelResult.hotel.name,
        logoUrl: hotelResult.hotel.logoUrl || "",
        timezone: String(settings.timezone || "Africa/Cairo"),
        currency: String(settings.currency || "EGP"),
        slaHours: {
          CRITICAL: String(sla.CRITICAL ?? 2),
          HIGH: String(sla.HIGH ?? 4),
          MEDIUM: String(sla.MEDIUM ?? 24),
          LOW: String(sla.LOW ?? 72),
        },
      });
      setNotifications(noticeResult.notifications);
      const [buildingResult, roomResult, inventoryResult] = await Promise.all([
        request<{ buildings: Building[] }>("/api/buildings", {}, token),
        request<{ rooms: Room[] }>("/api/rooms", {}, token),
        request<{ items: InventoryItem[] }>("/api/inventory/items", {}, token),
      ]);
      setBuildings(buildingResult.buildings);
      setRooms(roomResult.rooms);
      setInventory(inventoryResult.items);
      if (user.role !== "TECHNICIAN") {
        const [techResult, assetResult] = await Promise.all([
          request<{ technicians: Technician[] }>("/api/technicians", {}, token),
          request<{ assets: Asset[] }>("/api/assets", {}, token),
        ]);
        setTechnicians(techResult.technicians);
        setAssets(assetResult.assets);
      }
      if (user.role === "MANAGER") {
        const [auditResult, memberResult] = await Promise.all([
          request<{ auditLogs: AuditEntry[] }>("/api/audit-logs", {}, token),
          request<{ members: Member[] }>("/api/hotel/members", {}, token),
        ]);
        setAuditLogs(auditResult.auditLogs);
        setMembers(memberResult.members);
      }
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "تعذر تحميل البيانات");
    }
  }

  useEffect(() => {
    void loadData();
    const nextSocket = io("/", { auth: { token }, transports: ["websocket", "polling"] });
    nextSocket.on("work-order:update", () => void loadData());
    nextSocket.on("presence:update", setOnline);
    nextSocket.on("notification:new", (notice: Notice) => {
      setNotifications((current) => [notice, ...current]);
    });
    nextSocket.on("chat:message", (message: Message) => {
      if (message.workOrderId === selectedOrder) setMessages((current) => [...current, message]);
    });
    setSocket(nextSocket);
    return () => nextSocket.disconnect();
  }, [token]);

  useEffect(() => {
    if (!selectedOrder || !socket) return;
    socket.emit("work-order:join", selectedOrder);
    void request<{ messages: Message[] }>(`/api/chat/messages?workOrderId=${selectedOrder}`, {}, token)
      .then((result) => setMessages(result.messages.reverse()))
      .catch(() => setMessages([]));
    void request<{ events: typeof eventHistory }>(`/api/work-orders/${selectedOrder}/events`, {}, token)
      .then((result) => setEventHistory(result.events))
      .catch(() => setEventHistory([]));
  }, [selectedOrder, socket, token]);

  async function createOrder(event: FormEvent) {
    event.preventDefault();
    try {
      await request("/api/work-orders", { method: "POST", body: JSON.stringify({ ...orderForm, roomId: orderForm.roomId ? Number(orderForm.roomId) : null, category: orderForm.specialty }) }, token);
      setOrderForm({ title: "", description: "", location: "", specialty: "HVAC", priority: "MEDIUM", roomCode: "", roomId: "" });
      setNotice("تم إنشاء أمر العمل وتوجيهه حسب التخصص.");
      await loadData();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "تعذر إنشاء أمر العمل");
    }
  }

  async function createAsset(event: FormEvent) {
    event.preventDefault();
    try {
      await request("/api/assets", { method: "POST", body: JSON.stringify(assetForm) }, token);
      setAssetForm({ name: "", assetCode: "", category: "", roomCode: "" });
      setNotice("تم إنشاء الأصل مع رمز QR جاهز.");
      await loadData();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "تعذر إنشاء الأصل");
    }
  }

  async function createBuilding(event: FormEvent) {
    event.preventDefault();
    try {
      await request("/api/buildings", { method: "POST", body: JSON.stringify({ ...buildingForm, floors: Number(buildingForm.floors) }) }, token);
      setBuildingForm({ name: "", code: "", floors: "1" });
      setNotice("تمت إضافة المبنى.");
      await loadData();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "تعذرت إضافة المبنى");
    }
  }

  async function createRoom(event: FormEvent) {
    event.preventDefault();
    try {
      await request("/api/rooms", { method: "POST", body: JSON.stringify({ ...roomForm, buildingId: Number(roomForm.buildingId) }) }, token);
      setRoomForm({ buildingId: "", roomNumber: "", floor: "", roomType: "غرفة نزيل" });
      setNotice("تمت إضافة الغرفة.");
      await loadData();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "تعذرت إضافة الغرفة");
    }
  }

  async function createInventoryItem(event: FormEvent) {
    event.preventDefault();
    try {
      await request("/api/inventory/items", {
        method: "POST",
        body: JSON.stringify({ ...inventoryForm, quantity: Number(inventoryForm.quantity), reorderAt: Number(inventoryForm.reorderAt) }),
      }, token);
      setInventoryForm({ name: "", sku: "", unit: "قطعة", quantity: "0", reorderAt: "0", location: "" });
      setNotice("تمت إضافة المادة إلى المخزون.");
      await loadData();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "تعذر تحديث المخزون");
    }
  }

  async function consumeMaterials(event: FormEvent) {
    event.preventDefault();
    if (!selectedOrder || !materialForm.itemId) return;
    try {
      await request(`/api/work-orders/${selectedOrder}/materials`, {
        method: "POST",
        body: JSON.stringify({ itemId: Number(materialForm.itemId), quantity: Number(materialForm.quantity) }),
      }, token);
      setNotice("تم صرف المواد وتسجيلها في سجل أمر العمل.");
      await loadData();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "تعذر صرف المواد");
    }
  }

  async function inviteMember(event: FormEvent) {
    event.preventDefault();
    try {
      await request("/api/hotel/invitations", { method: "POST", body: JSON.stringify(inviteForm) }, token);
      setInviteForm({ name: "", email: "", role: "TECHNICIAN", specialty: "HVAC" });
      setNotice("تم إرسال دعوة التحقق إلى البريد.");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "تعذر إرسال الدعوة");
    }
  }

  async function saveHotel(event: FormEvent) {
    event.preventDefault();
    try {
      const { name, logoUrl, timezone, currency, slaHours } = hotelForm;
      const result = await request<{ hotel: Hotel }>("/api/hotel", {
        method: "PATCH",
        body: JSON.stringify({
          name,
          logoUrl,
          settings: {
            timezone,
            currency,
            slaHours: Object.fromEntries(Object.entries(slaHours).map(([key, value]) => [key, Number(value)])),
          },
        }),
      }, token);
      setHotel(result.hotel);
      setNotice("تم حفظ إعدادات الفندق.");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "تعذر حفظ إعدادات الفندق");
    }
  }

  async function updateMember(member: Member) {
    try {
      await request(`/api/hotel/members/${member.id}`, {
        method: "PATCH",
        body: JSON.stringify({ role: member.role, specialty: member.specialty, isActive: member.isActive }),
      }, token);
      setNotice("تم تحديث صلاحيات العضو. سيطلب منه تسجيل الدخول مجدداً.");
      await loadData();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "تعذر تحديث صلاحيات العضو");
    }
  }

  async function downloadFile(path: string, filename: string) {
    try {
      const response = await fetch(path, { headers: { Authorization: `Bearer ${token}` }, credentials: "include" });
      if (!response.ok) throw new Error("تعذر تنزيل الملف");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "تعذر تنزيل الملف");
    }
  }

  async function restoreBackup(event: FormEvent) {
    event.preventDefault();
    if (!backupFile) return;
    try {
      const payload = JSON.parse(await backupFile.text());
      await request("/api/admin/restore", { method: "POST", body: JSON.stringify(payload) }, token);
      setBackupFile(null);
      setNotice("اكتملت استعادة النسخة الموقعة.");
      await loadData();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "تعذرت استعادة النسخة");
    }
  }

  async function switchHotel(hotelId: number) {
    try {
      const result = await request<{ user: User; accessToken: string }>("/api/auth/switch-hotel", {
        method: "POST",
        body: JSON.stringify({ hotelId }),
      }, token);
      localStorage.setItem(tokenKey, result.accessToken);
      onHotelChange(result.user, result.accessToken);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "تعذر التبديل بين الفنادق");
    }
  }

  async function markRead(id: number) {
    await request(`/api/notifications/${id}/read`, { method: "PATCH" }, token).catch(() => undefined);
    setNotifications((current) => current.map((item) => item.id === id ? { ...item, readAt: new Date().toISOString() } : item));
  }

  async function updateStatus(order: WorkOrder, status: string) {
    try {
      await request(`/api/work-orders/${order.id}/status`, { method: "PATCH", body: JSON.stringify({ status }) }, token);
      await loadData();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "تعذر تحديث الحالة");
    }
  }

  async function assign(order: WorkOrder, technicianId: string) {
    if (!technicianId) return;
    try {
      await request(`/api/work-orders/${order.id}/assign`, { method: "PATCH", body: JSON.stringify({ technicianId: Number(technicianId) }) }, token);
      setNotice("تم إسناد أمر العمل.");
      await loadData();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "تعذر الإسناد");
    }
  }

  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    if (!chatBody.trim() || !selectedOrder) return;
    await request("/api/chat/messages", { method: "POST", body: JSON.stringify({ workOrderId: selectedOrder, body: chatBody }) }, token);
    setChatBody("");
  }

  async function logout() {
    await request("/api/auth/logout", { method: "POST", body: JSON.stringify({}) }, token).catch(() => undefined);
    localStorage.removeItem(tokenKey);
    onLogout();
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-inline">{hotel?.logoUrl ? <img className="hotel-logo" src={hotel.logoUrl} alt="" /> : <span className="brand-mark small">TS</span>}<strong>{hotel?.name || "T-SMART"}</strong><span className="version">V7</span></div>
        {hotelOptions.length > 1 && <select className="hotel-switcher" value={user.hotelId} onChange={(event) => void switchHotel(Number(event.target.value))} aria-label="تبديل الفندق">{hotelOptions.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}</select>}
        <div className="user-actions"><span className="online-dot" />{user.name}<span className="role-pill">{roleLabels[user.role]}</span><button className="ghost-button" onClick={logout}>خروج</button></div>
      </header>
      <main className="dashboard">
        <div className="welcome-row"><div><p className="eyebrow">مساحة العمل</p><h1>{user.role === "MANAGER" ? "لوحة المدير" : user.role === "TECHNICIAN" ? "مهامي اليوم" : "طلبات الصيانة"}</h1></div><span className="date-chip">{new Date().toLocaleDateString("ar-EG", { weekday: "long", day: "numeric", month: "long" })}</span></div>
        {notice && <div className="alert info">{notice}<button onClick={() => setNotice("")}>×</button></div>}
        <section className="panel toolbar-panel">
          <form className="search-toolbar" onSubmit={(event) => { event.preventDefault(); void loadData(); }}>
            <input value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder="ابحث في العنوان أو الوصف أو الموقع..." aria-label="بحث أوامر العمل" />
            <button className="primary-button">بحث</button>
            {user.role === "MANAGER" && <button type="button" className="secondary-button" onClick={() => void downloadFile("/api/reports/work-orders.csv", "work-orders-report.csv")}>تنزيل تقرير CSV</button>}
          </form>
        </section>
        <section className="stats-grid">
          <div className="stat-card"><span>كل الأوامر</span><strong>{analytics.total}</strong><small>ضمن النظام</small></div>
          <div className="stat-card"><span>تحتاج متابعة</span><strong className={analytics.overdue ? "danger-text" : ""}>{analytics.overdue}</strong><small>تجاوزت SLA</small></div>
          <div className="stat-card"><span>الفنيون المتصلون</span><strong>{analytics.onlineTechnicians}</strong><small>حضور لحظي</small></div>
          <div className="stat-card accent"><span>الحالة الحالية</span><strong>{analytics.byStatus.find((item) => item.status === "NEW")?.count || 0}</strong><small>أوامر جديدة</small></div>
        </section>
        <div className="content-grid">
          <section className="panel orders-panel">
            <div className="panel-heading"><div><h2>أوامر العمل</h2><p className="muted">تحديثات الحالة والإسناد تظهر لحظياً.</p></div><span className="count-badge">{workOrders.length}</span></div>
            {workOrders.length === 0 ? <div className="empty-state">لا توجد أوامر عمل مطابقة.</div> : <div className="order-list">{workOrders.map((order) => <article className={`order-card ${selectedOrder === order.id ? "selected" : ""}`} key={order.id} onClick={() => setSelectedOrder(order.id)}>
              <div className="order-main"><div className="priority-line"><span className={`priority ${order.priority.toLowerCase()}`}>{order.priority}</span><span className="muted">#{order.id}</span></div><h3>{order.title}</h3><p>{order.location}{order.roomCode ? ` · ${order.roomCode}` : ""}</p></div>
              <div className="order-side"><span className={`status ${order.status.toLowerCase()}`}>{statusLabels[order.status] || order.status}</span><small>{order.assigneeName || (order.assignedTo ? `فني #${order.assignedTo}` : "بانتظار الإسناد")}</small><small className={order.slaDueAt && new Date(order.slaDueAt).getTime() < Date.now() && !["FIXED", "CLOSED"].includes(order.status) ? "danger-text" : ""}>{order.slaDueAt ? `SLA: ${new Date(order.slaDueAt).toLocaleString("ar-EG", { dateStyle: "short", timeStyle: "short" })}` : "بدون موعد SLA"}</small></div>
              {user.role === "MANAGER" && <div className="order-controls"><select value={order.assignedTo || ""} onChange={(e) => { e.stopPropagation(); void assign(order, e.target.value); }} onClick={(e) => e.stopPropagation()}><option value="">إسناد تلقائي/اختر فني</option>{technicians.map((tech) => <option key={tech.id} value={tech.id}>{tech.name} · {tech.specialty || "عام"}</option>)}</select></div>}
              {user.role === "TECHNICIAN" && order.assignedTo === user.id && <div className="order-controls"><select value="" onChange={(e) => { e.stopPropagation(); void updateStatus(order, e.target.value); }} onClick={(e) => e.stopPropagation()}><option value="">تحديث الحالة</option>{(transitions[order.status] || []).map((status) => <option key={status} value={status}>{statusLabels[status]}</option>)}</select></div>}
            </article>)}</div>}
          </section>
          <aside className="side-column">
            <section className="panel"><div className="panel-heading"><div><h2>الحضور المباشر</h2><p className="muted">الفنيون المتصلون الآن</p></div><span className="live-label">LIVE</span></div>{online.length ? <div className="presence-list">{online.map((person) => <div className="presence-row" key={person.id}><span className="avatar">{person.name.slice(0, 1)}</span><span>{person.name}<small>{person.specialty || "فني"}</small></span><i /></div>)}</div> : <div className="empty-state compact">لا يوجد فنيون متصلون</div>}</section>
            <section className="panel"><div className="panel-heading"><div><h2>التحليلات</h2><p className="muted">توزيع الحالات</p></div></div><div className="bars">{analytics.byStatus.map((item) => <div className="bar-row" key={item.status}><span>{statusLabels[item.status] || item.status}</span><div><i style={{ width: `${Math.min(100, (item.count / Math.max(analytics.total, 1)) * 100)}%` }} /></div><b>{item.count}</b></div>)}</div></section>
          </aside>
        </div>
        {canCreate && <section className="panel form-panel"><div className="panel-heading"><div><h2>إنشاء أمر عمل</h2><p className="muted">التوجيه يراعي التخصص وحجم العمل الحالي للفنيين.</p></div></div><form className="form-grid" onSubmit={createOrder}><label>العنوان<input value={orderForm.title} onChange={(e) => setOrderForm({ ...orderForm, title: e.target.value })} required /></label><label>الموقع / المنطقة<input value={orderForm.location} onChange={(e) => setOrderForm({ ...orderForm, location: e.target.value })} required /></label><label>التخصص<select value={orderForm.specialty} onChange={(e) => setOrderForm({ ...orderForm, specialty: e.target.value })}><option>HVAC</option><option>ELECTRICAL</option><option>PLUMBING</option><option>KITCHEN</option><option>REFRIGERATION</option><option>GENERAL</option></select></label><label>الأولوية<select value={orderForm.priority} onChange={(e) => setOrderForm({ ...orderForm, priority: e.target.value })}><option>LOW</option><option>MEDIUM</option><option>HIGH</option><option>CRITICAL</option></select></label><label className="wide">الوصف<textarea value={orderForm.description} onChange={(e) => setOrderForm({ ...orderForm, description: e.target.value })} required /></label><label>الغرفة<select value={orderForm.roomId} onChange={(e) => setOrderForm({ ...orderForm, roomId: e.target.value, roomCode: rooms.find((room) => room.id === Number(e.target.value))?.roomNumber || "" })}><option value="">بدون ربط غرفة</option>{rooms.map((room) => <option key={room.id} value={room.id}>{room.buildingName} · {room.roomNumber}</option>)}</select></label><div className="form-action"><button className="primary-button">إنشاء وإسناد</button></div></form></section>}
        {canCreate && <section className="panel form-panel"><div className="panel-heading"><div><h2>الأصول وQR</h2><p className="muted">رمز أصل دائم يفتح معلوماته ويربط البلاغات به.</p></div></div><form className="form-grid compact-form" onSubmit={createAsset}><label>اسم الأصل<input value={assetForm.name} onChange={(e) => setAssetForm({ ...assetForm, name: e.target.value })} required /></label><label>رمز الأصل<input value={assetForm.assetCode} onChange={(e) => setAssetForm({ ...assetForm, assetCode: e.target.value })} placeholder="يولد تلقائياً" /></label><label>التصنيف<input value={assetForm.category} onChange={(e) => setAssetForm({ ...assetForm, category: e.target.value })} /></label><label>الغرفة<select value={assetForm.roomId} onChange={(e) => setAssetForm({ ...assetForm, roomId: e.target.value, roomCode: rooms.find((room) => room.id === Number(e.target.value))?.roomNumber || "" })}><option value="">غير محددة</option>{rooms.map((room) => <option key={room.id} value={room.id}>{room.buildingName} · {room.roomNumber}</option>)}</select></label><div className="form-action"><button className="secondary-button">إضافة أصل</button></div></form>{assets.length > 0 && <div className="asset-list">{assets.slice(0, 6).map((asset) => <span key={asset.id}>{asset.assetCode} · {asset.name}</span>)}</div>}</section>}
        {user.role === "MANAGER" && <section className="panel form-panel"><div className="panel-heading"><div><h2>المباني والغرف</h2><p className="muted">هيكل الفندق مستقل لكل منشأة.</p></div></div><form className="form-grid compact-form" onSubmit={createBuilding}><label>اسم المبنى<input value={buildingForm.name} onChange={(e) => setBuildingForm({ ...buildingForm, name: e.target.value })} required /></label><label>رمز المبنى<input value={buildingForm.code} onChange={(e) => setBuildingForm({ ...buildingForm, code: e.target.value })} /></label><label>عدد الطوابق<input type="number" min="1" max="200" value={buildingForm.floors} onChange={(e) => setBuildingForm({ ...buildingForm, floors: e.target.value })} /></label><div className="form-action"><button className="secondary-button">إضافة مبنى</button></div></form>{buildings.length > 0 && <form className="form-grid compact-form" onSubmit={createRoom}><label>المبنى<select value={roomForm.buildingId} onChange={(e) => setRoomForm({ ...roomForm, buildingId: e.target.value })} required><option value="">اختر مبنى</option>{buildings.map((building) => <option key={building.id} value={building.id}>{building.name}</option>)}</select></label><label>رقم الغرفة<input value={roomForm.roomNumber} onChange={(e) => setRoomForm({ ...roomForm, roomNumber: e.target.value })} required /></label><label>الطابق<input value={roomForm.floor} onChange={(e) => setRoomForm({ ...roomForm, floor: e.target.value })} /></label><label>نوع الغرفة<input value={roomForm.roomType} onChange={(e) => setRoomForm({ ...roomForm, roomType: e.target.value })} /></label><div className="form-action"><button className="secondary-button">إضافة غرفة</button></div></form>}<div className="asset-list">{rooms.slice(0, 12).map((room) => <span key={room.id}>{room.buildingName} · {room.roomNumber}</span>)}</div></section>}
        <section className="panel form-panel"><div className="panel-heading"><div><h2>المخزون والخامات</h2><p className="muted">تسجيل دخول وخروج المواد وربط الصرف بأوامر العمل.</p></div><span className="count-badge">{inventory.filter((item) => item.quantity <= item.reorderAt).length} منخفض</span></div>{canCreate && <form className="form-grid compact-form" onSubmit={createInventoryItem}><label>اسم المادة<input value={inventoryForm.name} onChange={(e) => setInventoryForm({ ...inventoryForm, name: e.target.value })} required /></label><label>رمز SKU<input value={inventoryForm.sku} onChange={(e) => setInventoryForm({ ...inventoryForm, sku: e.target.value })} required /></label><label>الوحدة<input value={inventoryForm.unit} onChange={(e) => setInventoryForm({ ...inventoryForm, unit: e.target.value })} /></label><label>رصيد البداية<input type="number" min="0" step="0.01" value={inventoryForm.quantity} onChange={(e) => setInventoryForm({ ...inventoryForm, quantity: e.target.value })} /></label><label>حد إعادة الطلب<input type="number" min="0" step="0.01" value={inventoryForm.reorderAt} onChange={(e) => setInventoryForm({ ...inventoryForm, reorderAt: e.target.value })} /></label><label>موقع التخزين<input value={inventoryForm.location} onChange={(e) => setInventoryForm({ ...inventoryForm, location: e.target.value })} /></label><div className="form-action"><button className="secondary-button">إضافة مادة</button></div></form>}<div className="inventory-list">{inventory.map((item) => <div className="inventory-row" key={item.id}><span><strong>{item.name}</strong><small>{item.sku} · {item.location || "بدون موقع"}</small></span><b className={item.quantity <= item.reorderAt ? "danger-text" : ""}>{item.quantity} {item.unit}</b></div>)}</div>{selected && user.role === "TECHNICIAN" && inventory.length > 0 && <form className="chat-form" onSubmit={consumeMaterials}><select value={materialForm.itemId} onChange={(e) => setMaterialForm({ ...materialForm, itemId: e.target.value })} required><option value="">اختر مادة لصرفها لأمر #{selected.id}</option>{inventory.map((item) => <option key={item.id} value={item.id}>{item.name} · المتاح {item.quantity}</option>)}</select><input type="number" min="0.01" step="0.01" value={materialForm.quantity} onChange={(e) => setMaterialForm({ ...materialForm, quantity: e.target.value })} /><button className="secondary-button">صرف</button></form>}</section>
        {user.role === "MANAGER" && <section className="panel form-panel"><div className="panel-heading"><div><h2>إعدادات الفندق والفريق</h2><p className="muted">غيّر الهوية وادعُ أعضاء الفريق إلى مساحة الفندق الحالية.</p></div></div><form className="form-grid compact-form" onSubmit={saveHotel}><label>اسم الفندق<input value={hotelForm.name} onChange={(e) => setHotelForm({ ...hotelForm, name: e.target.value })} required /></label><label>رابط الشعار<input type="url" value={hotelForm.logoUrl} onChange={(e) => setHotelForm({ ...hotelForm, logoUrl: e.target.value })} placeholder="https://…" /></label><div className="form-action"><button className="secondary-button">حفظ الهوية</button></div></form><form className="form-grid compact-form" onSubmit={inviteMember}><label>اسم العضو<input value={inviteForm.name} onChange={(e) => setInviteForm({ ...inviteForm, name: e.target.value })} required /></label><label>البريد الإلكتروني<input type="email" value={inviteForm.email} onChange={(e) => setInviteForm({ ...inviteForm, email: e.target.value })} required /></label><label>الدور<select value={inviteForm.role} onChange={(e) => setInviteForm({ ...inviteForm, role: e.target.value })}><option value="TECHNICIAN">فني</option><option value="STAFF">موظف</option></select></label><label>التخصص<input value={inviteForm.specialty} onChange={(e) => setInviteForm({ ...inviteForm, specialty: e.target.value })} /></label><div className="form-action"><button className="secondary-button">إرسال دعوة</button></div></form></section>}
        {user.role === "MANAGER" && <section className="panel form-panel"><div className="panel-heading"><div><h2>النسخ الاحتياطي والتدقيق</h2><p className="muted">نزّل نسخة تشغيلية موقعة واحفظها خارج قاعدة البيانات. الاستعادة تضيف/تحدّث بيانات هذا الفندق فقط.</p></div></div><div className="button-row"><button className="secondary-button" onClick={() => void downloadFile("/api/admin/backup", `hotel-${user.hotelId}-backup.json`)}>تنزيل نسخة الفندق</button><button className="secondary-button" onClick={() => void downloadFile("/api/reports/work-orders.csv", "hotel-work-orders.csv")}>تقرير أوامر العمل CSV</button></div><form className="restore-form" onSubmit={restoreBackup}><label>استعادة نسخة موقعة<input type="file" accept="application/json,.json" onChange={(e) => setBackupFile(e.target.files?.[0] || null)} required /></label><button className="primary-button" disabled={!backupFile}>تحقق واستعادة</button></form>{auditLogs.length > 0 && <div className="audit-list"><h3>آخر تغييرات الإدارة</h3>{auditLogs.slice(0, 8).map((entry) => <div className="audit-row" key={entry.id}><span><strong>{entry.action}</strong><small>{entry.actorName || "النظام"} · {entry.entityType} #{entry.entityId || "—"}</small></span><time>{new Date(entry.createdAt).toLocaleString("ar-EG")}</time></div>)}</div>}</section>}
        <section className="panel form-panel"><div className="panel-heading"><div><h2>التنبيهات</h2><p className="muted">تحذير قبل انتهاء SLA وتصعيد عند التجاوز.</p></div><span className="count-badge">{notifications.filter((item) => !item.readAt).length} جديد</span></div>{notifications.length ? <div className="audit-list">{notifications.slice(0, 8).map((item) => <button className={`notification-row ${item.readAt ? "read" : ""}`} key={item.id} onClick={() => void markRead(item.id)}><span><strong>{item.title}</strong><small>{item.body} · {item.kind}</small></span><time>{new Date(item.createdAt).toLocaleString("ar-EG")}</time></button>)}</div> : <div className="empty-state compact">لا توجد تنبيهات حالياً.</div>}</section>
        <section className="panel chat-panel"><div className="panel-heading"><div><h2>محادثة وسجل أمر العمل</h2><p className="muted">{selected ? `أمر العمل #${selected.id}` : "اختر أمراً لعرض التفاصيل"}</p></div></div>{selected ? <><div className="order-timeline">{eventHistory.map((entry, index) => <div key={`${entry.eventType}-${index}`}><i /><span><strong>{entry.eventType}{entry.toStatus ? ` · ${statusLabels[entry.toStatus] || entry.toStatus}` : ""}</strong><small>{entry.actorName || "النظام"} · {new Date(entry.createdAt).toLocaleString("ar-EG")}</small></span></div>)}</div><div className="messages">{messages.length ? messages.map((message) => <div className={`message ${message.senderId === user.id ? "mine" : ""}`} key={message.id}><p>{message.body}</p><small>{new Date(message.createdAt).toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit" })}</small></div>) : <div className="empty-state compact">ابدأ المحادثة مع الفريق.</div>}</div><form className="chat-form" onSubmit={sendMessage}><input value={chatBody} onChange={(e) => setChatBody(e.target.value)} placeholder="اكتب رسالة..." /><button className="primary-button">إرسال</button></form></> : <div className="empty-state">اختر أمراً من القائمة لبدء محادثة فورية.</div>}</section>
      </main>
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState(localStorage.getItem(tokenKey) || "");
  const [hotelOptions, setHotelOptions] = useState<Hotel[]>([]);

  useEffect(() => {
    const refreshed = (event: Event) => {
      const nextToken = (event as CustomEvent<string>).detail;
      if (nextToken) setToken(nextToken);
    };
    const expired = () => {
      setUser(null);
      setToken("");
    };
    window.addEventListener("t-smart:token-refreshed", refreshed);
    window.addEventListener("t-smart:session-expired", expired);
    return () => {
      window.removeEventListener("t-smart:token-refreshed", refreshed);
      window.removeEventListener("t-smart:session-expired", expired);
    };
  }, []);

  useEffect(() => {
    if (!token) return;
    request<{ user: User; hotels: Hotel[] }>("/api/auth/me", {}, token).then((result) => {
      setUser(result.user);
      setHotelOptions(result.hotels);
    }).catch(() => {
      localStorage.removeItem(tokenKey);
      setToken("");
      setUser(null);
    });
  }, [token]);

  if (!user || !token) {
    return <AuthScreen onLogin={(nextUser, access, memberships = []) => {
      localStorage.setItem(tokenKey, access);
      setToken(access);
      setUser(nextUser);
      setHotelOptions(memberships);
    }} />;
  }

  return <Dashboard
    user={user}
    token={token}
    hotelOptions={hotelOptions}
    onLogout={() => { setToken(""); setUser(null); setHotelOptions([]); }}
    onHotelChange={(nextUser, nextToken) => { setUser(nextUser); setToken(nextToken); }}
  />;
}