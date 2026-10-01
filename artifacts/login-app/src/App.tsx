import { useEffect, useMemo, useState, type FormEvent } from "react";
import { io, type Socket } from "socket.io-client";
import "./app.css";

type Role = "MANAGER" | "TECHNICIAN" | "STAFF";
type User = { id: number; hotelId: number; name: string; email: string; role: Role; specialty: string | null };
type Hotel = { id: number; name: string; logoUrl: string | null; role?: Role };
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
        onLogin(result.user, result.accessToken);
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
          <label>كلمة المرور<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={12} autoComplete={mode === "login" ? "current-password" : "new-password"} placeholder="12 حرفاً على الأقل" /></label>
          {mode !== "login" && <label>رمز البريد الإلكتروني<input inputMode="numeric" pattern="[0-9]{6}" value={otp} onChange={(e) => setOtp(e.target.value)} required maxLength={6} /></label>}
          {mode === "register" && <button type="button" className="secondary-button" onClick={sendOtp} disabled={busy || !email}>إرسال رمز التحقق</button>}
          {error && <div className="alert error">{error}</div>}
          {message && <div className="alert info">{message}</div>}
          <button className="primary-button" disabled={busy}>{busy ? "جارٍ الدخول..." : "تسجيل الدخول"}</button>
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

function Dashboard({ user, token, onLogout }: { user: User; token: string; onLogout: () => void }) {
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
  const [hotelOptions, setHotelOptions] = useState<Hotel[]>([]);
  const [hotelForm, setHotelForm] = useState({ name: "", logoUrl: "" });
  const [buildings, setBuildings] = useState<Building[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [notifications, setNotifications] = useState<Notice[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditEntry[]>([]);
  const [eventHistory, setEventHistory] = useState<{ eventType: string; toStatus: string | null; actorName: string | null; createdAt: string }[]>([]);
  const [searchText, setSearchText] = useState("");
  const [buildingForm, setBuildingForm] = useState({ name: "", code: "", floors: "1" });
  const [roomForm, setRoomForm] = useState({ buildingId: "", roomNumber: "", floor: "", roomType: "غرفة نزيل" });
  const [inventoryForm, setInventoryForm] = useState({ name: "", sku: "", unit: "قطعة", quantity: "0", reorderAt: "0", location: "" });
  const [materialForm, setMaterialForm] = useState({ itemId: "", quantity: "1" });
  const [inviteForm, setInviteForm] = useState({ name: "", email: "", role: "TECHNICIAN", specialty: "HVAC" });
  const [backupFile, setBackupFile] = useState<File | null>(null);
  const [orderForm, setOrderForm] = useState({ title: "", description: "", location: "", specialty: "HVAC", priority: "MEDIUM", roomCode: "" });
  const [assetForm, setAssetForm] = useState({ name: "", assetCode: "", category: "", roomCode: "" });

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
      setHotelForm({ name: hotelResult.hotel.name, logoUrl: hotelResult.hotel.logoUrl || "" });
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
          request<{ members: { id: number; role: Role }[] }>("/api/hotel/members", {}, token),
        ]);
        setAuditLogs(auditResult.auditLogs);
        setHotelOptions((memberResult.members as unknown as Hotel[]).filter((member) => member.id === user.id));
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
    const refresh = (event: Event) => {
      const nextToken = (event as CustomEvent<string>).detail;
      if (nextToken) setTokenKey(nextToken);
    };
    window.addEventListener("t-smart:token-refreshed", refresh);
    return () => window.removeEventListener("t-smart:token-refreshed", refresh);
  }, []);

  useEffect(() => {
    if (!selectedOrder || !socket) return;
    socket.emit("work-order:join", selectedOrder);
    void request<{ messages: Message[] }>(`/api/chat/messages?workOrderId=${selectedOrder}`, {}, token)
      .then((result) => setMessages(result.messages.reverse()))
      .catch(() => setMessages([]));
  }, [selectedOrder, socket, token]);

  async function createOrder(event: FormEvent) {
    event.preventDefault();
    try {
      await request("/api/work-orders", { method: "POST", body: JSON.stringify({ ...orderForm, category: orderForm.specialty }) }, token);
      setOrderForm({ title: "", description: "", location: "", specialty: "HVAC", priority: "MEDIUM", roomCode: "" });
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
    await request("/api/auth/logout", { method: "POST", body: JSON.stringify({ refreshToken: localStorage.getItem(refreshKey) }) }, token).catch(() => undefined);
    localStorage.removeItem(tokenKey);
    localStorage.removeItem(refreshKey);
    onLogout();
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-inline"><span className="brand-mark small">TS</span><strong>T-SMART</strong><span className="version">V7</span></div>
        <div className="user-actions"><span className="online-dot" />{user.name}<span className="role-pill">{roleLabels[user.role]}</span><button className="ghost-button" onClick={logout}>خروج</button></div>
      </header>
      <main className="dashboard">
        <div className="welcome-row"><div><p className="eyebrow">مساحة العمل</p><h1>{user.role === "MANAGER" ? "لوحة المدير" : user.role === "TECHNICIAN" ? "مهامي اليوم" : "طلبات الصيانة"}</h1></div><span className="date-chip">{new Date().toLocaleDateString("ar-EG", { weekday: "long", day: "numeric", month: "long" })}</span></div>
        {notice && <div className="alert info">{notice}<button onClick={() => setNotice("")}>×</button></div>}
        <section className="stats-grid">
          <div className="stat-card"><span>كل الأوامر</span><strong>{analytics.total}</strong><small>ضمن النظام</small></div>
          <div className="stat-card"><span>تحتاج متابعة</span><strong className={analytics.overdue ? "danger-text" : ""}>{analytics.overdue}</strong><small>تجاوزت SLA</small></div>
          <div className="stat-card"><span>الفنيون المتصلون</span><strong>{analytics.onlineTechnicians}</strong><small>حضور لحظي</small></div>
          <div className="stat-card accent"><span>الحالة الحالية</span><strong>{analytics.byStatus.find((item) => item.status === "NEW")?.count || 0}</strong><small>أوامر جديدة</small></div>
        </section>
        <div className="content-grid">
          <section className="panel orders-panel">
            <div className="panel-heading"><div><h2>أوامر العمل</h2><p className="muted">تحديثات الحالة والإسناد تظهر لحظياً.</p></div><span className="count-badge">{workOrders.length}</span></div>
            {workOrders.length === 0 ? <div className="empty-state">لا توجد أوامر عمل بعد.</div> : <div className="order-list">{workOrders.map((order) => <article className={`order-card ${selectedOrder === order.id ? "selected" : ""}`} key={order.id} onClick={() => setSelectedOrder(order.id)}>
              <div className="order-main"><div className="priority-line"><span className={`priority ${order.priority.toLowerCase()}`}>{order.priority}</span><span className="muted">#{order.id}</span></div><h3>{order.title}</h3><p>{order.location}{order.roomCode ? ` · ${order.roomCode}` : ""}</p></div>
              <div className="order-side"><span className={`status ${order.status.toLowerCase()}`}>{statusLabels[order.status] || order.status}</span><small>{order.assigneeName || (order.assignedTo ? `فني #${order.assignedTo}` : "بانتظار الإسناد")}</small></div>
              {user.role === "MANAGER" && <div className="order-controls"><select value={order.assignedTo || ""} onChange={(e) => { e.stopPropagation(); void assign(order, e.target.value); }} onClick={(e) => e.stopPropagation()}><option value="">إسناد تلقائي/اختر فني</option>{technicians.map((tech) => <option key={tech.id} value={tech.id}>{tech.name} · {tech.specialty || "عام"}</option>)}</select></div>}
              {user.role === "TECHNICIAN" && order.assignedTo === user.id && <div className="order-controls"><select value="" onChange={(e) => { e.stopPropagation(); void updateStatus(order, e.target.value); }} onClick={(e) => e.stopPropagation()}><option value="">تحديث الحالة</option>{(transitions[order.status] || []).map((status) => <option key={status} value={status}>{statusLabels[status]}</option>)}</select></div>}
            </article>)}</div>}
          </section>
          <aside className="side-column">
            <section className="panel"><div className="panel-heading"><div><h2>الحضور المباشر</h2><p className="muted">الفنيون المتصلون الآن</p></div><span className="live-label">LIVE</span></div>{online.length ? <div className="presence-list">{online.map((person) => <div className="presence-row" key={person.id}><span className="avatar">{person.name.slice(0, 1)}</span><span>{person.name}<small>{person.specialty || "فني"}</small></span><i /></div>)}</div> : <div className="empty-state compact">لا يوجد فنيون متصلون</div>}</section>
            <section className="panel"><div className="panel-heading"><div><h2>التحليلات</h2><p className="muted">توزيع الحالات</p></div></div><div className="bars">{analytics.byStatus.map((item) => <div className="bar-row" key={item.status}><span>{statusLabels[item.status] || item.status}</span><div><i style={{ width: `${Math.min(100, (item.count / Math.max(analytics.total, 1)) * 100)}%` }} /></div><b>{item.count}</b></div>)}</div></section>
          </aside>
        </div>
        {canCreate && <section className="panel form-panel"><div className="panel-heading"><div><h2>إنشاء أمر عمل</h2><p className="muted">سيتم اقتراح فني مطابق للتخصص تلقائياً.</p></div></div><form className="form-grid" onSubmit={createOrder}><label>العنوان<input value={orderForm.title} onChange={(e) => setOrderForm({ ...orderForm, title: e.target.value })} required /></label><label>الموقع<input value={orderForm.location} onChange={(e) => setOrderForm({ ...orderForm, location: e.target.value })} required /></label><label>التخصص<select value={orderForm.specialty} onChange={(e) => setOrderForm({ ...orderForm, specialty: e.target.value })}><option>HVAC</option><option>ELECTRICAL</option><option>PLUMBING</option><option>KITCHEN</option><option>REFRIGERATION</option></select></label><label>الأولوية<select value={orderForm.priority} onChange={(e) => setOrderForm({ ...orderForm, priority: e.target.value })}><option>LOW</option><option>MEDIUM</option><option>HIGH</option><option>CRITICAL</option></select></label><label className="wide">الوصف<textarea value={orderForm.description} onChange={(e) => setOrderForm({ ...orderForm, description: e.target.value })} required /></label><label>رقم الغرفة<input value={orderForm.roomCode} onChange={(e) => setOrderForm({ ...orderForm, roomCode: e.target.value })} /></label><div className="form-action"><button className="primary-button">إنشاء وإسناد</button></div></form></section>}
        {canCreate && <section className="panel form-panel"><div className="panel-heading"><div><h2>الأصول وQR</h2><p className="muted">كل أصل يحصل على رمز قابل للطباعة والربط بأمر العمل.</p></div></div><form className="form-grid compact-form" onSubmit={createAsset}><label>اسم الأصل<input value={assetForm.name} onChange={(e) => setAssetForm({ ...assetForm, name: e.target.value })} required /></label><label>رمز الأصل<input value={assetForm.assetCode} onChange={(e) => setAssetForm({ ...assetForm, assetCode: e.target.value })} placeholder="يولد تلقائياً" /></label><label>التصنيف<input value={assetForm.category} onChange={(e) => setAssetForm({ ...assetForm, category: e.target.value })} /></label><label>الغرفة<input value={assetForm.roomCode} onChange={(e) => setAssetForm({ ...assetForm, roomCode: e.target.value })} /></label><div className="form-action"><button className="secondary-button">إضافة أصل</button></div></form>{assets.length > 0 && <div className="asset-list">{assets.slice(0, 6).map((asset) => <span key={asset.id}>{asset.assetCode} · {asset.name}</span>)}</div>}</section>}
        <section className="panel chat-panel"><div className="panel-heading"><div><h2>المحادثة الداخلية</h2><p className="muted">{selected ? `محادثة أمر العمل #${selected.id}` : "اختر أمراً لعرض المحادثة"}</p></div></div>{selected ? <><div className="messages">{messages.length ? messages.map((message) => <div className={`message ${message.senderId === user.id ? "mine" : ""}`} key={message.id}><p>{message.body}</p><small>{new Date(message.createdAt).toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit" })}</small></div>) : <div className="empty-state compact">ابدأ المحادثة مع الفريق.</div>}</div><form className="chat-form" onSubmit={sendMessage}><input value={chatBody} onChange={(e) => setChatBody(e.target.value)} placeholder="اكتب رسالة..." /><button className="primary-button">إرسال</button></form></> : <div className="empty-state">اختر أمراً من القائمة لبدء محادثة فورية.</div>}</section>
      </main>
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState(localStorage.getItem(tokenKey) || "");

  useEffect(() => {
    if (!token) return;
    request<{ user: User }>("/api/auth/me", {}, token).then((result) => setUser(result.user)).catch(() => {
      localStorage.removeItem(tokenKey);
      localStorage.removeItem(refreshKey);
      setToken("");
    });
  }, [token]);

  if (!user || !token) {
    return <Login onLogin={(nextUser, access, refresh) => { localStorage.setItem(tokenKey, access); localStorage.setItem(refreshKey, refresh); setToken(access); setUser(nextUser); }} />;
  }

  return <Dashboard user={user} token={token} onLogout={() => { setToken(""); setUser(null); }} />;
}