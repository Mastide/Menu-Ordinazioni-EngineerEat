import { useState, useEffect, useRef } from "react";
import { supabase } from "./supabase.js";

const categories = [
  { itemsKey: "primi_items", hideKey: "primo", label: "Primi" },
  { itemsKey: "secondi_items", hideKey: "secondo", label: "Secondi" },
  { itemsKey: "contorni_items", hideKey: "contorno", label: "Contorni" },
  { itemsKey: "dessert_items", hideKey: "dessert", label: "Dessert" },
];

function formatPrice(n) {
  return `€ ${Number(n || 0).toFixed(2).replace(".", ",")}`;
}

function sendNotification(name) {
  if ("Notification" in window && Notification.permission === "granted") {
    new Notification("Nuovo ordine ricevuto", {
      body: `${name} ha appena prenotato`,
    });
  }
  fetch("https://ntfy.sh/Ordini_Mensa_Antonio_PlusFast", {
    method: "POST",
    headers: {
      "Title": "Nuovo ordine ricevuto",
      "Priority": "default",
      "Tags": "fork_and_knife",
    },
    body: `${name} ha appena prenotato`,
  }).catch(() => {});
}

export default function App() {
  const [view, setView] = useState("client");
  const [menu, setMenu] = useState([]);
  const [orders, setOrders] = useState([]);
  const [suspended, setSuspended] = useState(false);
  const [orderForm, setOrderForm] = useState({ name: "", note: "", selectedItems: [] });
  const [orderSent, setOrderSent] = useState(false);
  const [lastOrderSummary, setLastOrderSummary] = useState(null);
  const [editingDay, setEditingDay] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [activeDay, setActiveDay] = useState(0);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [adminUser, setAdminUser] = useState(null);
  const [loginForm, setLoginForm] = useState({ email: "", password: "" });
  const [loginError, setLoginError] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);
  const [showLogin, setShowLogin] = useState(false);
  const [newOrderCount, setNewOrderCount] = useState(0);
  const [newItemInputs, setNewItemInputs] = useState({});
  const [expandedDays, setExpandedDays] = useState({});
  const initialLoadDone = useRef(false);

  useEffect(() => {
    if (adminUser && "Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
  }, [adminUser]);

  useEffect(() => {
    loadMenu();
    loadSuspended();
    supabase.auth.getSession().then(({ data: { session } }) => {
      setAdminUser(session?.user ?? null);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setAdminUser(session?.user ?? null);
    });
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    supabase
      .from("orders")
      .select("*")
      .order("created_at", { ascending: false })
      .then(({ data }) => {
        if (data) {
          setOrders(data);
          setLoading(false);
          setTimeout(() => { initialLoadDone.current = true; }, 500);
        }
      });
  }, []);

  useEffect(() => {
    const channel = supabase
      .channel("orders-realtime-v2")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "orders" }, (payload) => {
        if (!payload.new) return;
        setOrders((prev) => [payload.new, ...prev]);
        if (initialLoadDone.current) {
          sendNotification(payload.new.name || "Qualcuno");
          setNewOrderCount((n) => n + 1);
        }
      })
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "orders" }, (payload) => {
        if (!payload.old) return;
        setOrders((prev) => prev.filter((o) => o.id !== payload.old.id));
      })
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, []);

  useEffect(() => {
    const channel = supabase
      .channel("settings-realtime-v2")
      .on("postgres_changes", { event: "*", schema: "public", table: "settings" }, (payload) => {
        if (payload.new?.key === "suspended") setSuspended(payload.new.value === "true");
      })
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, []);

  useEffect(() => {
    const channel = supabase
      .channel("menu-realtime")
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "menu" }, () => {
        loadMenu();
      })
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, []);

  async function loadMenu() {
    const { data } = await supabase.from("menu").select("*").order("id");
    if (data) {
      setMenu(data);
      const todayIdx = data.findIndex((d) => d.is_today);
      setActiveDay(todayIdx >= 0 ? todayIdx : 0);
    }
    setLoading(false);
  }

  async function loadSuspended() {
    const { data } = await supabase.from("settings").select("value").eq("key", "suspended").single();
    if (data) setSuspended(data.value === "true");
  }

  async function handleLogin() {
    setLoginLoading(true);
    setLoginError("");
    const { error } = await supabase.auth.signInWithPassword({
      email: loginForm.email,
      password: loginForm.password,
    });
    if (error) {
      setLoginError("Email o password non corretti.");
    } else {
      setShowLogin(false);
      setView("admin");
      if ("Notification" in window && Notification.permission === "default") {
        Notification.requestPermission();
      }
    }
    setLoginLoading(false);
  }

  async function handleLogout() {
    await supabase.auth.signOut();
    setView("client");
    setNewOrderCount(0);
  }

  function toggleSelectItem(category, nome, prezzo) {
    setOrderForm((f) => {
      const exists = f.selectedItems.some((i) => i.category === category && i.nome === nome);
      let selectedItems = exists
        ? f.selectedItems.filter((i) => !(i.category === category && i.nome === nome))
        : [...f.selectedItems, { category, nome, prezzo }];

      // Il contorno è selezionabile solo se è stato scelto almeno un secondo
      const stillHasSecondo = selectedItems.some((i) => i.category === "Secondi");
      if (!stillHasSecondo) {
        selectedItems = selectedItems.filter((i) => i.category !== "Contorni");
      }
      return { ...f, selectedItems };
    });
  }

  function isSelected(category, nome) {
    return orderForm.selectedItems.some((i) => i.category === category && i.nome === nome);
  }

  const orderTotal = orderForm.selectedItems.reduce((s, i) => s + Number(i.prezzo || 0), 0);

  function isToday(dateStr) {
    const d = new Date(dateStr);
    const now = new Date();
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  }

  const nameAlreadyOrderedToday = orderForm.name.trim().length > 1 && orders.some(
    (o) => isToday(o.created_at) && o.name.trim().toLowerCase() === orderForm.name.trim().toLowerCase()
  );

  async function handleOrder() {
    if (!orderForm.name.trim()) return;
    if (orderForm.selectedItems.length === 0) return;
    setSubmitting(true);
    const { error } = await supabase.from("orders").insert([{
      name: orderForm.name,
      selected_items: orderForm.selectedItems,
      note: orderForm.note,
    }]);
    if (!error) {
      setLastOrderSummary({ items: orderForm.selectedItems, total: orderTotal });
      setOrderSent(true);
      setOrderForm({ name: "", note: "", selectedItems: [] });
    }
    setSubmitting(false);
  }

  async function deleteOrder(id) {
    await supabase.from("orders").delete().eq("id", id);
  }

  async function toggleSuspended() {
    const newVal = (!suspended).toString();
    await supabase.from("settings").update({ value: newVal }).eq("key", "suspended");
    setSuspended(!suspended);
  }

  async function setToday(id) {
    await supabase.from("menu").update({ is_today: false }).neq("id", 0);
    await supabase.from("menu").update({ is_today: true }).eq("id", id);
    loadMenu();
  }

  function startEdit(day) {
    setEditingDay(day.id);
    setEditForm({ day: day.day, date: day.date });
  }

  async function saveEdit() {
    await supabase.from("menu").update({
      day: editForm.day,
      date: editForm.date,
    }).eq("id", editingDay);
    setEditingDay(null);
    loadMenu();
  }

  async function addItem(dayId, itemsKey, currentItems) {
    const inputKey = `${dayId}_${itemsKey}`;
    const draft = newItemInputs[inputKey] || { nome: "", prezzo: "" };
    const nome = (draft.nome || "").trim();
    if (!nome) return;
    const prezzo = parseFloat((draft.prezzo || "0").toString().replace(",", ".")) || 0;
    const newItems = [...(currentItems || []), { nome, prezzo, unavailable: false }];
    await supabase.from("menu").update({ [itemsKey]: newItems }).eq("id", dayId);
    setNewItemInputs((s) => ({ ...s, [inputKey]: { nome: "", prezzo: "" } }));
    loadMenu();
  }

  async function removeItem(dayId, itemsKey, currentItems, index) {
    const newItems = currentItems.filter((_, i) => i !== index);
    await supabase.from("menu").update({ [itemsKey]: newItems }).eq("id", dayId);
    loadMenu();
  }

  async function toggleItemUnavailable(dayId, itemsKey, currentItems, index) {
    const newItems = currentItems.map((it, i) => i === index ? { ...it, unavailable: !it.unavailable } : it);
    await supabase.from("menu").update({ [itemsKey]: newItems }).eq("id", dayId);
    loadMenu();
  }

  async function updateItemPrice(dayId, itemsKey, currentItems, index, newPrezzo) {
    const prezzo = parseFloat((newPrezzo || "0").toString().replace(",", ".")) || 0;
    const newItems = currentItems.map((it, i) => i === index ? { ...it, prezzo } : it);
    await supabase.from("menu").update({ [itemsKey]: newItems }).eq("id", dayId);
    loadMenu();
  }

  async function toggleCategoryHidden(dayId, hideKey, currentHidden) {
    let newHidden = [...(currentHidden || [])];
    if (newHidden.includes(hideKey)) newHidden = newHidden.filter((f) => f !== hideKey);
    else newHidden.push(hideKey);
    await supabase.from("menu").update({ hidden_fields: newHidden }).eq("id", dayId);
    loadMenu();
  }

  function toggleDayExpanded(dayId) {
    setExpandedDays((prev) => ({ ...prev, [dayId]: !isDayExpanded(dayId) }));
  }

  function isDayExpanded(dayId) {
    const day = menu.find((d) => d.id === dayId);
    return expandedDays[dayId] !== undefined ? expandedDays[dayId] : !!day?.is_today;
  }

  const today = menu.find((d) => d.is_today) || menu[0];

  function availableItems(day, itemsKey) {
    return (day?.[itemsKey] || []).filter((it) => !it.unavailable);
  }

  if (loading) {
    return (
      <div style={{ fontFamily: "'Poppins', sans-serif", minHeight: "100vh", background: "#1c3c5e", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ color: "#9bb8d3", fontSize: 14, letterSpacing: 1 }}>Caricamento...</div>
      </div>
    );
  }

  return (
    <div style={{ fontFamily: "'Poppins', sans-serif", minHeight: "100vh", background: "linear-gradient(180deg, #1c3c5e 0%, #16314f 100%)" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Dancing+Script:wght@500;700&family=Poppins:wght@300;400;500;600;700&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        .fade-in { animation: fadeIn 0.4s ease; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        .btn-primary { background: #ffffff; color: #1c3c5e; border: none; padding: 13px 28px; font-family: 'Poppins', sans-serif; font-size: 14px; font-weight: 600; cursor: pointer; letter-spacing: 0.5px; transition: all 0.2s; border-radius: 2px; }
        .btn-primary:hover { background: #e8eef4; }
        .btn-primary:disabled { background: #6b8aa8; color: #cdd9e4; cursor: not-allowed; }
        .btn-danger { background: rgba(180,70,70,0.25); color: #f0a0a0; border: 1px solid rgba(180,70,70,0.4); padding: 8px 18px; font-family: 'Poppins', sans-serif; font-size: 13px; cursor: pointer; transition: all 0.2s; border-radius: 2px; }
        .btn-danger:hover { background: rgba(180,70,70,0.4); }
        .btn-ghost { background: transparent; border: 1.5px solid rgba(255,255,255,0.4); color: #fff; padding: 10px 22px; font-family: 'Poppins', sans-serif; font-size: 13px; cursor: pointer; transition: all 0.2s; border-radius: 2px; }
        .btn-ghost:hover { background: rgba(255,255,255,0.1); }
        input, textarea { font-family: 'Poppins', sans-serif; border: 1.5px solid rgba(255,255,255,0.25); background: rgba(255,255,255,0.07); color: #fff; padding: 10px 14px; font-size: 14px; outline: none; transition: border 0.2s; width: 100%; border-radius: 2px; }
        input::placeholder, textarea::placeholder { color: #6b8aa8; }
        input:focus, textarea:focus { border-color: #ffffff; }
        input[type=checkbox] { width: auto; accent-color: #ffffff; transform: scale(1.2); cursor: pointer; }
        input[type=number]::-webkit-inner-spin-button, input[type=number]::-webkit-outer-spin-button { opacity: 0.6; }
        .tag { display: inline-block; padding: 3px 10px; font-size: 11px; font-weight: 500; letter-spacing: 1px; text-transform: uppercase; border-radius: 2px; }
        .divider-line { height: 1px; background: rgba(255,255,255,0.2); margin: 28px 0; }
        .day-tab { padding: 8px 16px; font-family: 'Poppins', sans-serif; font-size: 13px; cursor: pointer; border: none; background: transparent; transition: all 0.2s; border-bottom: 2px solid transparent; color: #7f9cb8; }
        .day-tab.active { color: #fff; border-bottom: 2px solid #fff; font-weight: 500; }
        .day-tab:hover:not(.active) { color: #cdd9e4; }
        .order-row { background: rgba(255,255,255,0.06); padding: 14px 18px; margin-bottom: 10px; border-left: 3px solid #fff; border-radius: 2px; }
        .suspended-banner { background: rgba(180,70,70,0.85); color: white; text-align: center; padding: 12px; font-family: 'Poppins', sans-serif; font-size: 13px; letter-spacing: 0.5px; }
        .badge { background: #fff; color: #1c3c5e; border-radius: 50%; width: 18px; height: 18px; font-size: 10px; display: inline-flex; align-items: center; justify-content: center; margin-left: 6px; font-family: 'Poppins', sans-serif; font-weight: 700; }
        .field-control-btn { border: none; padding: 4px 10px; font-family: 'Poppins', sans-serif; font-size: 10px; font-weight: 500; letter-spacing: 0.5px; cursor: pointer; transition: all 0.15s; border-radius: 2px; }
        .script-title { font-family: 'Dancing Script', cursive; font-weight: 700; color: #ffffff; }
        .card { background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12); }
        .item-row { display: flex; align-items: center; justify-content: space-between; padding: 6px 10px; margin-bottom: 4px; background: rgba(255,255,255,0.04); border-radius: 2px; gap: 8px; }
        .price-input { width: 64px !important; padding: 4px 6px !important; font-size: 12px !important; text-align: right; }

        .app-main { padding: 40px 24px; }
        .app-header-inner { padding: 0 32px; }
        .hero-title { font-size: 48px; }
        .menu-today-grid { grid-template-columns: repeat(2, 1fr); gap: 14px; }
        .menu-week-grid { grid-template-columns: repeat(4, 1fr); gap: 10px; }
        .admin-cat-grid { grid-template-columns: repeat(2, 1fr); gap: 14px; }
        .header-nav-btn-text { display: inline; }

        @media (max-width: 640px) {
          .app-main { padding: 24px 14px; }
          .app-header-inner { padding: 0 16px; height: auto !important; flex-wrap: wrap; gap: 10px; padding-top: 10px; padding-bottom: 10px; }
          .hero-title { font-size: 32px !important; }
          .menu-today-grid { grid-template-columns: 1fr; }
          .menu-week-grid { grid-template-columns: repeat(2, 1fr); }
          .admin-cat-grid { grid-template-columns: 1fr; }
          .item-row { flex-wrap: wrap; }
          .order-card-padding { padding: 20px 18px !important; }
        }
      `}</style>

      {/* Login modal */}
      {showLogin && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
          <div className="fade-in" style={{ background: "#1c3c5e", border: "1px solid rgba(255,255,255,0.15)", padding: "40px", width: 360, maxWidth: "90vw" }}>
            <h2 className="script-title" style={{ fontSize: 30, marginBottom: 4 }}>Accesso Admin</h2>
            <p style={{ fontFamily: "'Poppins', sans-serif", fontSize: 13, color: "#7f9cb8", marginBottom: 24 }}>Area riservata</p>
            <div style={{ marginBottom: 14 }}>
              <label style={{ fontFamily: "'Poppins', sans-serif", fontSize: 11, letterSpacing: 1, color: "#9bb8d3", textTransform: "uppercase", display: "block", marginBottom: 6 }}>Email</label>
              <input type="email" value={loginForm.email} onChange={(e) => setLoginForm((f) => ({ ...f, email: e.target.value }))} onKeyDown={(e) => e.key === "Enter" && handleLogin()} />
            </div>
            <div style={{ marginBottom: 20 }}>
              <label style={{ fontFamily: "'Poppins', sans-serif", fontSize: 11, letterSpacing: 1, color: "#9bb8d3", textTransform: "uppercase", display: "block", marginBottom: 6 }}>Password</label>
              <input type="password" value={loginForm.password} onChange={(e) => setLoginForm((f) => ({ ...f, password: e.target.value }))} onKeyDown={(e) => e.key === "Enter" && handleLogin()} />
            </div>
            {loginError && <div style={{ fontFamily: "'Poppins', sans-serif", fontSize: 13, color: "#f0a0a0", marginBottom: 16 }}>{loginError}</div>}
            <div style={{ display: "flex", gap: 10 }}>
              <button className="btn-primary" onClick={handleLogin} disabled={loginLoading}>{loginLoading ? "Accesso..." : "Accedi"}</button>
              <button className="btn-ghost" onClick={() => { setShowLogin(false); setLoginError(""); }}>Annulla</button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <header style={{ borderBottom: "1px solid rgba(255,255,255,0.1)" }}>
        <div className="app-header-inner" style={{ maxWidth: 900, margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "space-between", height: 64 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
            <h1 className="script-title" style={{ fontSize: 26 }}>EngineerEat</h1>
            <span style={{ color: "#7f9cb8", fontSize: 11, letterSpacing: 2 }}>ORDINAZIONI</span>
          </div>
          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
            {adminUser ? (
              <>
                <button className="day-tab" onClick={() => setView("client")} style={{ color: view === "client" ? "#fff" : "#7f9cb8", borderBottomColor: view === "client" ? "#fff" : "transparent" }}>
                  Menu & Ordini
                </button>
                <button className="day-tab" onClick={() => { setView("admin"); setNewOrderCount(0); }} style={{ color: view === "admin" ? "#fff" : "#7f9cb8", borderBottomColor: view === "admin" ? "#fff" : "transparent", display: "flex", alignItems: "center" }}>
                  Admin ⚙{newOrderCount > 0 && <span className="badge">{newOrderCount}</span>}
                </button>
                <button onClick={handleLogout} style={{ marginLeft: 8, background: "transparent", border: "1px solid rgba(255,255,255,0.2)", color: "#9bb8d3", padding: "4px 12px", fontFamily: "'Poppins', sans-serif", fontSize: 11, cursor: "pointer", letterSpacing: 0.5 }}>
                  Esci
                </button>
              </>
            ) : (
              <button onClick={() => setShowLogin(true)} style={{ background: "transparent", border: "none", color: "#5b7a9a", fontFamily: "'Poppins', sans-serif", fontSize: 12, cursor: "pointer", letterSpacing: 0.5, padding: "4px 8px" }}>
                ⚙
              </button>
            )}
          </div>
        </div>
      </header>

      {suspended && <div className="suspended-banner">ORDINAZIONI SOSPESE — La cucina non accetta nuove prenotazioni al momento</div>}

      <main className="app-main" style={{ maxWidth: 900, margin: "0 auto" }}>

        {/* CLIENT VIEW */}
        {view === "client" && today && (
          <div className="fade-in">
            <div style={{ background: "rgba(192,160,80,0.12)", border: "1px solid rgba(192,160,80,0.3)", padding: "10px 18px", marginBottom: 28, textAlign: "center", fontFamily: "'Poppins', sans-serif", fontSize: 12, color: "#d8be7a" }}>
              ⏰ Ordina entro le ore 12:00 per garantirti la disponibilità dei piatti
            </div>

            <div style={{ textAlign: "center", marginBottom: 36 }}>
              <span style={{ fontFamily: "'Poppins', sans-serif", fontSize: 11, letterSpacing: 3, color: "#7f9cb8", textTransform: "uppercase" }}>
                {today.day} · {today.date}
              </span>
              <h2 className="script-title hero-title" style={{ marginTop: 6 }}>Menù del giorno</h2>
            </div>

            <div className="menu-today-grid" style={{ display: "grid", marginBottom: 40 }}>
              {categories
                .filter((c) => !(today.hidden_fields || []).includes(c.hideKey))
                .map((c) => {
                  const avail = availableItems(today, c.itemsKey);
                  return (
                    <div key={c.itemsKey} className="card" style={{ padding: "20px 24px" }}>
                      <div style={{ fontSize: 10, fontFamily: "'Poppins', sans-serif", fontWeight: 600, letterSpacing: 2, color: "#7f9cb8", textTransform: "uppercase", marginBottom: 10 }}>{c.label}</div>
                      {avail.length === 0 ? (
                        <div style={{ fontFamily: "'Poppins', sans-serif", fontSize: 13, color: "#b08080", fontStyle: "italic" }}>Non disponibile</div>
                      ) : (
                        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                          {avail.map((it) => (
                            <div key={it.nome} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
                              <span style={{ fontFamily: "'Poppins', sans-serif", fontSize: 15, fontWeight: 500, color: "#fff" }}>{it.nome}</span>
                              <span style={{ fontFamily: "'Poppins', sans-serif", fontSize: 13, color: "#9bb8d3", whiteSpace: "nowrap" }}>{formatPrice(it.prezzo)}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
            </div>

            <div className="divider-line" />
            <h3 className="script-title" style={{ fontSize: 28, marginBottom: 18, textAlign: "center" }}>Menù della settimana</h3>

            <div style={{ borderBottom: "1px solid rgba(255,255,255,0.15)", display: "flex", marginBottom: 20, overflowX: "auto", justifyContent: "center" }}>
              {menu.map((d, i) => (
                <button key={d.id} className={`day-tab ${activeDay === i ? "active" : ""}`} onClick={() => setActiveDay(i)}>
                  {d.day}
                  {d.is_today && <span style={{ marginLeft: 4, color: "#fff" }}>•</span>}
                </button>
              ))}
            </div>

            {menu[activeDay] && (
              <div className="menu-week-grid" style={{ display: "grid", marginBottom: 40 }}>
                {categories
                  .filter((c) => !(menu[activeDay].hidden_fields || []).includes(c.hideKey))
                  .map((c) => {
                    const avail = availableItems(menu[activeDay], c.itemsKey);
                    return (
                      <div key={c.itemsKey} className="card" style={{ padding: "14px 16px" }}>
                        <div style={{ fontSize: 10, fontFamily: "'Poppins', sans-serif", letterSpacing: 1.5, color: "#7f9cb8", textTransform: "uppercase", marginBottom: 6 }}>{c.label}</div>
                        {avail.length === 0 ? (
                          <div style={{ fontFamily: "'Poppins', sans-serif", fontSize: 12, color: "#b08080", fontStyle: "italic" }}>Non disponibile</div>
                        ) : (
                          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                            {avail.map((it) => (
                              <div key={it.nome} style={{ display: "flex", justifyContent: "space-between", gap: 6 }}>
                                <span style={{ fontFamily: "'Poppins', sans-serif", fontSize: 12, fontWeight: 500, color: "#fff" }}>{it.nome}</span>
                                <span style={{ fontFamily: "'Poppins', sans-serif", fontSize: 11, color: "#9bb8d3", whiteSpace: "nowrap" }}>{formatPrice(it.prezzo)}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
              </div>
            )}

            <div className="divider-line" />
            <h3 className="script-title" style={{ fontSize: 28, marginBottom: 8, textAlign: "center" }}>
              {suspended ? "Ordinazioni chiuse" : "Prenota il tuo pasto"}
            </h3>

            {suspended ? (
              <div style={{ background: "rgba(180,70,70,0.15)", border: "1px solid rgba(180,70,70,0.3)", padding: "16px 20px", fontFamily: "'Poppins', sans-serif", fontSize: 14, color: "#f0a0a0", textAlign: "center" }}>
                Le ordinazioni sono temporaneamente sospese. Riprova più tardi.
              </div>
            ) : orderSent ? (
              <div className="fade-in" style={{ background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.2)", padding: "24px", fontFamily: "'Poppins', sans-serif", textAlign: "center" }}>
                <div style={{ fontSize: 17, fontWeight: 600, color: "#fff", marginBottom: 6 }}>Prenotazione inviata</div>
                <div style={{ fontSize: 13, color: "#9bb8d3", marginBottom: 18 }}>Il tuo ordine è stato ricevuto. Buon appetito!</div>
                {lastOrderSummary && lastOrderSummary.items.length > 0 && (
                  <div style={{ textAlign: "left", background: "rgba(0,0,0,0.15)", padding: "14px 18px", marginBottom: 4 }}>
                    {lastOrderSummary.items.map((it, idx) => (
                      <div key={idx} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "#fff", padding: "3px 0" }}>
                        <span>{it.nome} <span style={{ color: "#7f9cb8", fontSize: 11 }}>({it.category})</span></span>
                        <span style={{ color: "#9bb8d3" }}>{formatPrice(it.prezzo)}</span>
                      </div>
                    ))}
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, fontWeight: 600, color: "#fff", borderTop: "1px solid rgba(255,255,255,0.15)", marginTop: 8, paddingTop: 8 }}>
                      <span>Totale</span>
                      <span>{formatPrice(lastOrderSummary.total)}</span>
                    </div>
                  </div>
                )}
                <button className="btn-ghost" style={{ marginTop: 16, fontSize: 12 }} onClick={() => setOrderSent(false)}>Nuovo ordine</button>
              </div>
            ) : (
              <div className="card order-card-padding" style={{ padding: "28px 32px", marginTop: 16 }}>
                <div style={{ marginBottom: 16 }}>
                  <label style={{ fontFamily: "'Poppins', sans-serif", fontSize: 12, letterSpacing: 1, color: "#9bb8d3", textTransform: "uppercase", display: "block", marginBottom: 6 }}>Nome e cognome *</label>
                  <input placeholder="Es. Marco Bianchi" value={orderForm.name} onChange={(e) => setOrderForm((f) => ({ ...f, name: e.target.value }))} style={{ maxWidth: 320 }} />
                  {nameAlreadyOrderedToday && (
                    <div style={{ fontFamily: "'Poppins', sans-serif", fontSize: 12, color: "#d8be7a", marginTop: 6 }}>
                      ⚠ Risulta già un ordine oggi con questo nome. Se procedi, verrà aggiunto un secondo ordine.
                    </div>
                  )}
                </div>
                <div style={{ marginBottom: 16 }}>
                  <label style={{ fontFamily: "'Poppins', sans-serif", fontSize: 12, letterSpacing: 1, color: "#9bb8d3", textTransform: "uppercase", display: "block", marginBottom: 12 }}>Selezione *</label>
                  <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                    {categories
                      .filter((c) => !(today.hidden_fields || []).includes(c.hideKey))
                      .map((c) => {
                        const avail = availableItems(today, c.itemsKey);
                        if (avail.length === 0) return null;
                        const isContorni = c.label === "Contorni";
                        const hasSecondo = orderForm.selectedItems.some((i) => i.category === "Secondi");
                        const locked = isContorni && !hasSecondo;
                        return (
                          <div key={c.itemsKey}>
                            <div style={{ fontFamily: "'Poppins', sans-serif", fontSize: 11, letterSpacing: 1.5, color: "#7f9cb8", textTransform: "uppercase", marginBottom: 8 }}>{c.label}</div>
                            {locked && (
                              <div style={{ fontFamily: "'Poppins', sans-serif", fontSize: 12, color: "#7f9cb8", fontStyle: "italic", marginBottom: 8 }}>Seleziona un secondo per poter scegliere il contorno</div>
                            )}
                            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                              {avail.map((it) => {
                                const checked = isSelected(c.label, it.nome);
                                return (
                                  <div
                                    key={it.nome}
                                    onClick={() => !locked && toggleSelectItem(c.label, it.nome, it.prezzo)}
                                    style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: locked ? "not-allowed" : "pointer", fontFamily: "'Poppins', sans-serif", fontSize: 14, opacity: locked ? 0.4 : 1 }}
                                  >
                                    <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
                                      <span style={{
                                        width: 20, height: 20, borderRadius: 4, flexShrink: 0,
                                        border: `1.5px solid ${checked ? "#fff" : "rgba(255,255,255,0.45)"}`,
                                        background: checked ? "#fff" : "transparent",
                                        display: "flex", alignItems: "center", justifyContent: "center",
                                        transition: "all 0.15s",
                                      }}>
                                        {checked && (
                                          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                                            <path d="M2 6.2L4.8 9L10 3" stroke="#1c3c5e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                                          </svg>
                                        )}
                                      </span>
                                      <span style={{ fontWeight: 500, color: "#fff" }}>{it.nome}</span>
                                    </span>
                                    <span style={{ color: "#9bb8d3", fontSize: 13 }}>{formatPrice(it.prezzo)}</span>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}
                  </div>
                </div>
                {orderForm.selectedItems.length > 0 && (
                  <div style={{ display: "flex", justifyContent: "space-between", padding: "10px 0", borderTop: "1px solid rgba(255,255,255,0.15)", marginBottom: 16, fontFamily: "'Poppins', sans-serif" }}>
                    <span style={{ fontSize: 13, color: "#9bb8d3" }}>Totale</span>
                    <span style={{ fontSize: 16, fontWeight: 600, color: "#fff" }}>{formatPrice(orderTotal)}</span>
                  </div>
                )}
                <div style={{ marginBottom: 22 }}>
                  <label style={{ fontFamily: "'Poppins', sans-serif", fontSize: 12, letterSpacing: 1, color: "#9bb8d3", textTransform: "uppercase", display: "block", marginBottom: 6 }}>Note (facoltativo)</label>
                  <textarea placeholder="Allergie, intolleranze, preferenze..." value={orderForm.note} onChange={(e) => setOrderForm((f) => ({ ...f, note: e.target.value }))} style={{ resize: "vertical", minHeight: 70, maxWidth: 400 }} />
                </div>
                <div style={{ fontFamily: "'Poppins', sans-serif", fontSize: 11, color: "#7f9cb8", marginBottom: 14, fontStyle: "italic" }}>
                  Ricorda: ordina entro le ore 12:00 per garantirti la disponibilità.
                </div>
                <button className="btn-primary" onClick={handleOrder} disabled={submitting}>
                  {submitting ? "Invio in corso..." : "Invia prenotazione"}
                </button>
              </div>
            )}
          </div>
        )}

        {/* ADMIN VIEW */}
        {view === "admin" && adminUser && (
          <div className="fade-in">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 28 }}>
              <div>
                <h2 className="script-title" style={{ fontSize: 32 }}>Pannello Admin</h2>
                <p style={{ fontFamily: "'Poppins', sans-serif", fontSize: 13, color: "#7f9cb8", marginTop: 4 }}>{orders.length} ordini ricevuti</p>
              </div>
              <button onClick={toggleSuspended} style={{ padding: "10px 22px", fontFamily: "'Poppins', sans-serif", fontSize: 13, fontWeight: 500, cursor: "pointer", border: "none", background: suspended ? "rgba(80,150,80,0.85)" : "rgba(180,70,70,0.85)", color: "white", letterSpacing: 0.5, transition: "all 0.2s", borderRadius: 2 }}>
                {suspended ? "Riapri ordinazioni" : "Sospendi ordinazioni"}
              </button>
            </div>

            {(() => {
              const todayOrders = orders;
              const tally = {};
              todayOrders.forEach((o) => {
                (o.selected_items || []).forEach((it) => {
                  const key = `${it.category}::${it.nome}`;
                  tally[key] = (tally[key] || { category: it.category, nome: it.nome, count: 0 });
                  tally[key].count += 1;
                });
              });
              const tallyList = Object.values(tally).sort((a, b) => b.count - a.count);
              if (tallyList.length === 0) return null;
              return (
                <div className="card" style={{ padding: "18px 22px", marginBottom: 24 }}>
                  <div style={{ fontFamily: "'Poppins', sans-serif", fontSize: 11, fontWeight: 600, letterSpacing: 1.5, color: "#9bb8d3", textTransform: "uppercase", marginBottom: 12 }}>Riepilogo per la cucina — oggi</div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: "6px 18px" }}>
                    {tallyList.map((t, idx) => (
                      <div key={idx} style={{ display: "flex", justifyContent: "space-between", fontFamily: "'Poppins', sans-serif", fontSize: 13, color: "#fff", padding: "3px 0" }}>
                        <span>{t.nome} <span style={{ color: "#7f9cb8", fontSize: 11 }}>({t.category})</span></span>
                        <span style={{ fontWeight: 700, color: "#fff", marginLeft: 10 }}>× {t.count}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}

            <h3 className="script-title" style={{ fontSize: 24, marginBottom: 14 }}>Ordini ricevuti</h3>
            {orders.length === 0 ? (
              <div className="card" style={{ padding: "24px", fontFamily: "'Poppins', sans-serif", color: "#7f9cb8", fontSize: 14 }}>Nessun ordine ancora.</div>
            ) : (
              orders.map((o) => {
                const orderTot = (o.selected_items || []).reduce((s, i) => s + Number(i.prezzo || 0), 0);
                return (
                  <div key={o.id} className="order-row fade-in">
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
                          <span style={{ fontFamily: "'Poppins', sans-serif", fontWeight: 600, fontSize: 15, color: "#fff" }}>{o.name}</span>
                          <span style={{ fontFamily: "'Poppins', sans-serif", fontSize: 11, color: "#7f9cb8" }}>
                            {new Date(o.created_at).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}
                          </span>
                          {o.selected_items && o.selected_items.length > 0 && (
                            <span style={{ fontFamily: "'Poppins', sans-serif", fontSize: 12, color: "#9bb8d3", marginLeft: "auto" }}>{formatPrice(orderTot)}</span>
                          )}
                        </div>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: o.note ? 8 : 0 }}>
                          {(o.selected_items && o.selected_items.length > 0) ? (
                            o.selected_items.map((it, idx) => (
                              <span key={idx} className="tag" style={{ background: "rgba(255,255,255,0.12)", color: "#cfe0ee" }}>{it.category}: {it.nome} ({formatPrice(it.prezzo)})</span>
                            ))
                          ) : (
                            <>
                              {o.primo && <span className="tag" style={{ background: "rgba(255,255,255,0.12)", color: "#cfe0ee" }}>Primo</span>}
                              {o.secondo && <span className="tag" style={{ background: "rgba(255,255,255,0.12)", color: "#cfe0ee" }}>Secondo</span>}
                              {o.contorno && <span className="tag" style={{ background: "rgba(255,255,255,0.12)", color: "#cfe0ee" }}>Contorno</span>}
                              {o.dessert && <span className="tag" style={{ background: "rgba(255,255,255,0.12)", color: "#cfe0ee" }}>Dessert</span>}
                            </>
                          )}
                        </div>
                        {o.note && <div style={{ fontFamily: "'Poppins', sans-serif", fontSize: 12, color: "#7f9cb8", fontStyle: "italic" }}>"{o.note}"</div>}
                      </div>
                      <button className="btn-danger" onClick={() => deleteOrder(o.id)} style={{ flexShrink: 0, fontSize: 12, padding: "6px 14px" }}>Rimuovi</button>
                    </div>
                  </div>
                );
              })
            )}

            <div className="divider-line" />
            <h3 className="script-title" style={{ fontSize: 24, marginBottom: 4 }}>Gestione menù settimanale</h3>
            <p style={{ fontFamily: "'Poppins', sans-serif", fontSize: 12, color: "#7f9cb8", marginBottom: 16 }}>Aggiungi quanti piatti vuoi per ogni categoria, con prezzo, e segnali come non disponibili o eliminali.</p>

            {menu.map((day) => {
              const expanded = isDayExpanded(day.id);
              const totalItems = categories.reduce((s, c) => s + (day[c.itemsKey] || []).length, 0);
              return (
              <div key={day.id} className="card" style={{ padding: "18px 20px", marginBottom: 14, borderLeft: `3px solid ${day.is_today ? "#fff" : "rgba(255,255,255,0.2)"}` }}>
                {editingDay === day.id ? (
                  <div style={{ marginBottom: 16 }}>
                    <div style={{ fontFamily: "'Poppins', sans-serif", fontSize: 12, fontWeight: 600, marginBottom: 12, color: "#fff" }}>Modifica giorno</div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 10, marginBottom: 10 }}>
                      <div>
                        <label style={{ fontFamily: "'Poppins', sans-serif", fontSize: 11, color: "#9bb8d3", display: "block", marginBottom: 4 }}>Giorno</label>
                        <input value={editForm.day || ""} onChange={(e) => setEditForm((f) => ({ ...f, day: e.target.value }))} />
                      </div>
                      <div>
                        <label style={{ fontFamily: "'Poppins', sans-serif", fontSize: 11, color: "#9bb8d3", display: "block", marginBottom: 4 }}>Data</label>
                        <input value={editForm.date || ""} onChange={(e) => setEditForm((f) => ({ ...f, date: e.target.value }))} />
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button className="btn-primary" style={{ fontSize: 12, padding: "8px 18px" }} onClick={saveEdit}>Salva</button>
                      <button className="btn-ghost" style={{ fontSize: 12, padding: "8px 18px" }} onClick={() => setEditingDay(null)}>Annulla</button>
                    </div>
                  </div>
                ) : (
                  <div onClick={() => toggleDayExpanded(day.id)} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: expanded ? 16 : 0, cursor: "pointer" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span style={{ fontFamily: "'Poppins', sans-serif", fontSize: 12, color: "#7f9cb8", display: "inline-block", transform: expanded ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.2s" }}>▶</span>
                      <span style={{ fontFamily: "'Poppins', sans-serif", fontWeight: 600, fontSize: 16, color: "#fff" }}>{day.day} {day.date}</span>
                      {day.is_today && <span className="tag" style={{ background: "rgba(255,255,255,0.9)", color: "#1c3c5e", fontSize: 10 }}>Oggi</span>}
                      {!expanded && (
                        <span style={{ fontFamily: "'Poppins', sans-serif", fontSize: 11, color: "#5b7a9a" }}>{totalItems} {totalItems === 1 ? "piatto" : "piatti"}</span>
                      )}
                    </div>
                    <div style={{ display: "flex", gap: 8 }} onClick={(e) => e.stopPropagation()}>
                      {!day.is_today && (
                        <button className="btn-ghost" style={{ fontSize: 11, padding: "6px 14px" }} onClick={() => setToday(day.id)}>Imposta oggi</button>
                      )}
                      <button className="btn-ghost" style={{ fontSize: 11, padding: "6px 14px" }} onClick={() => startEdit(day)}>Modifica giorno</button>
                    </div>
                  </div>
                )}

                {/* Categorie con liste di piatti */}
                {expanded && (
                <div className="admin-cat-grid" style={{ display: "grid" }}>
                  {categories.map((c) => {
                    const items = day[c.itemsKey] || [];
                    const isHidden = (day.hidden_fields || []).includes(c.hideKey);
                    const inputKey = `${day.id}_${c.itemsKey}`;
                    const draft = newItemInputs[inputKey] || { nome: "", prezzo: "" };
                    return (
                      <div key={c.itemsKey} style={{ background: "rgba(255,255,255,0.03)", padding: "12px 14px", opacity: isHidden ? 0.5 : 1 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                          <span style={{ fontFamily: "'Poppins', sans-serif", fontSize: 11, fontWeight: 600, color: "#9bb8d3", textTransform: "uppercase", letterSpacing: 1 }}>{c.label}</span>
                          <button onClick={() => toggleCategoryHidden(day.id, c.hideKey, day.hidden_fields)} style={{ background: "transparent", border: "none", color: isHidden ? "#8fcf9f" : "#e09a9a", fontFamily: "'Poppins', sans-serif", fontSize: 10, cursor: "pointer", letterSpacing: 0.5 }}>
                            {isHidden ? "Mostra categoria" : "Nascondi categoria"}
                          </button>
                        </div>

                        {items.length === 0 && (
                          <div style={{ fontFamily: "'Poppins', sans-serif", fontSize: 12, color: "#5b7a9a", fontStyle: "italic", marginBottom: 8 }}>Nessun piatto inserito</div>
                        )}

                        {items.map((it, idx) => (
                          <div key={idx} className="item-row">
                            <span style={{ fontFamily: "'Poppins', sans-serif", fontSize: 13, color: it.unavailable ? "#6b7d8e" : "#fff", textDecoration: it.unavailable ? "line-through" : "none", flex: 1 }}>
                              {it.nome}
                            </span>
                            <span style={{ fontFamily: "'Poppins', sans-serif", fontSize: 12, color: "#7f9cb8" }}>€</span>
                            <input
                              type="text"
                              inputMode="decimal"
                              className="price-input"
                              defaultValue={Number(it.prezzo || 0).toFixed(2)}
                              onBlur={(e) => updateItemPrice(day.id, c.itemsKey, items, idx, e.target.value)}
                            />
                            <div style={{ display: "flex", gap: 4 }}>
                              <button className="field-control-btn" onClick={() => toggleItemUnavailable(day.id, c.itemsKey, items, idx)} style={{ background: it.unavailable ? "rgba(90,154,106,0.2)" : "rgba(192,160,80,0.2)", color: it.unavailable ? "#8fcf9f" : "#d8be7a" }}>
                                {it.unavailable ? "Disponibile" : "Esaurito"}
                              </button>
                              <button className="field-control-btn" onClick={() => removeItem(day.id, c.itemsKey, items, idx)} style={{ background: "rgba(180,70,70,0.2)", color: "#e09a9a" }}>
                                ✕
                              </button>
                            </div>
                          </div>
                        ))}

                        <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                          <input
                            placeholder="Nuovo piatto..."
                            value={draft.nome}
                            onChange={(e) => setNewItemInputs((s) => ({ ...s, [inputKey]: { ...draft, nome: e.target.value } }))}
                            style={{ fontSize: 12, padding: "7px 10px", flex: 2 }}
                          />
                          <input
                            placeholder="€"
                            inputMode="decimal"
                            value={draft.prezzo}
                            onChange={(e) => setNewItemInputs((s) => ({ ...s, [inputKey]: { ...draft, prezzo: e.target.value } }))}
                            onKeyDown={(e) => e.key === "Enter" && addItem(day.id, c.itemsKey, items)}
                            style={{ fontSize: 12, padding: "7px 10px", flex: 1, textAlign: "right" }}
                          />
                          <button className="btn-ghost" style={{ fontSize: 11, padding: "7px 12px", whiteSpace: "nowrap" }} onClick={() => addItem(day.id, c.itemsKey, items)}>
                            + Aggiungi
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
                )}
              </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
