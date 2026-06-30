import { useState, useEffect, useRef } from "react";
import { supabase } from "./supabase.js";

const fields = [
  { key: "primo", label: "Primo" },
  { key: "secondo", label: "Secondo" },
  { key: "contorno", label: "Contorno" },
  { key: "dessert", label: "Dessert" },
];

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
  const [orderForm, setOrderForm] = useState({ name: "", primo: false, secondo: false, contorno: false, dessert: false, note: "" });
  const [orderSent, setOrderSent] = useState(false);
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

  async function handleOrder() {
    if (!orderForm.name.trim()) return;
    const hasItem = orderForm.primo || orderForm.secondo || orderForm.contorno || orderForm.dessert;
    if (!hasItem) return;
    setSubmitting(true);
    const { error } = await supabase.from("orders").insert([{
      name: orderForm.name,
      primo: orderForm.primo,
      secondo: orderForm.secondo,
      contorno: orderForm.contorno,
      dessert: orderForm.dessert,
      note: orderForm.note,
    }]);
    if (!error) {
      setOrderSent(true);
      setOrderForm({ name: "", primo: false, secondo: false, contorno: false, dessert: false, note: "" });
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
    setEditForm({ ...day });
  }

  async function saveEdit() {
    await supabase.from("menu").update({
      day: editForm.day,
      date: editForm.date,
      primo: editForm.primo,
      secondo: editForm.secondo,
      contorno: editForm.contorno,
      dessert: editForm.dessert,
    }).eq("id", editingDay);
    setEditingDay(null);
    loadMenu();
  }

  async function toggleFieldVisibility(dayId, fieldKey, currentHidden, currentUnavailable, action) {
    let newHidden = [...(currentHidden || [])];
    let newUnavailable = [...(currentUnavailable || [])];
    newHidden = newHidden.filter(f => f !== fieldKey);
    newUnavailable = newUnavailable.filter(f => f !== fieldKey);
    if (action === "hide") newHidden.push(fieldKey);
    if (action === "unavailable") newUnavailable.push(fieldKey);
    await supabase.from("menu").update({
      hidden_fields: newHidden,
      unavailable_fields: newUnavailable,
    }).eq("id", dayId);
    loadMenu();
  }

  const today = menu.find((d) => d.is_today) || menu[0];
  const todayHidden = today?.hidden_fields || [];
  const todayUnavailable = today?.unavailable_fields || [];
  const visibleFields = fields.filter(f => !todayHidden.includes(f.key));

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
      <header style={{ padding: "0 32px", borderBottom: "1px solid rgba(255,255,255,0.1)" }}>
        <div style={{ maxWidth: 900, margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "space-between", height: 64 }}>
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

      <main style={{ maxWidth: 900, margin: "0 auto", padding: "40px 24px" }}>

        {/* CLIENT VIEW */}
        {view === "client" && today && (
          <div className="fade-in">
            <div style={{ textAlign: "center", marginBottom: 36 }}>
              <span style={{ fontFamily: "'Poppins', sans-serif", fontSize: 11, letterSpacing: 3, color: "#7f9cb8", textTransform: "uppercase" }}>
                {today.day} · {today.date}
              </span>
              <h2 className="script-title" style={{ fontSize: 48, marginTop: 6 }}>Menù del giorno</h2>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 14, marginBottom: 40 }}>
              {visibleFields.map(({ key, label }) => {
                const isUnavailable = todayUnavailable.includes(key);
                return (
                  <div key={key} className="card" style={{ padding: "20px 24px", opacity: isUnavailable ? 0.55 : 1 }}>
                    <div style={{ fontSize: 10, fontFamily: "'Poppins', sans-serif", fontWeight: 600, letterSpacing: 2, color: "#7f9cb8", textTransform: "uppercase", marginBottom: 8 }}>{label}</div>
                    {isUnavailable ? (
                      <div style={{ fontFamily: "'Poppins', sans-serif", fontSize: 13, color: "#b08080", fontStyle: "italic" }}>Non disponibile</div>
                    ) : (
                      <div style={{ fontFamily: "'Poppins', sans-serif", fontSize: 16, fontWeight: 500, color: "#fff" }}>{today[key]}</div>
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
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 40 }}>
                {fields
                  .filter(f => !(menu[activeDay].hidden_fields || []).includes(f.key))
                  .map(({ key, label }) => {
                    const isUnavailable = (menu[activeDay].unavailable_fields || []).includes(key);
                    return (
                      <div key={key} className="card" style={{ padding: "14px 16px", opacity: isUnavailable ? 0.55 : 1 }}>
                        <div style={{ fontSize: 10, fontFamily: "'Poppins', sans-serif", letterSpacing: 1.5, color: "#7f9cb8", textTransform: "uppercase", marginBottom: 5 }}>{label}</div>
                        {isUnavailable ? (
                          <div style={{ fontFamily: "'Poppins', sans-serif", fontSize: 12, color: "#b08080", fontStyle: "italic" }}>Non disponibile</div>
                        ) : (
                          <div style={{ fontFamily: "'Poppins', sans-serif", fontSize: 13, fontWeight: 500, color: "#fff" }}>{menu[activeDay][key]}</div>
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
                <div style={{ fontSize: 13, color: "#9bb8d3" }}>Il tuo ordine è stato ricevuto. Buon appetito!</div>
                <button className="btn-ghost" style={{ marginTop: 16, fontSize: 12 }} onClick={() => setOrderSent(false)}>Nuovo ordine</button>
              </div>
            ) : (
              <div className="card" style={{ padding: "28px 32px", marginTop: 16 }}>
                <div style={{ marginBottom: 16 }}>
                  <label style={{ fontFamily: "'Poppins', sans-serif", fontSize: 12, letterSpacing: 1, color: "#9bb8d3", textTransform: "uppercase", display: "block", marginBottom: 6 }}>Nome e cognome *</label>
                  <input placeholder="Es. Marco Bianchi" value={orderForm.name} onChange={(e) => setOrderForm((f) => ({ ...f, name: e.target.value }))} style={{ maxWidth: 320 }} />
                </div>
                <div style={{ marginBottom: 16 }}>
                  <label style={{ fontFamily: "'Poppins', sans-serif", fontSize: 12, letterSpacing: 1, color: "#9bb8d3", textTransform: "uppercase", display: "block", marginBottom: 12 }}>Selezione *</label>
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {visibleFields
                      .filter(f => !todayUnavailable.includes(f.key))
                      .map(({ key, label }) => (
                        <label key={key} style={{ display: "flex", alignItems: "center", gap: 12, cursor: "pointer", fontFamily: "'Poppins', sans-serif", fontSize: 14 }}>
                          <input type="checkbox" checked={orderForm[key]} onChange={(e) => setOrderForm((f) => ({ ...f, [key]: e.target.checked }))} />
                          <span style={{ fontWeight: 400, color: "#9bb8d3" }}>{label} —</span>
                          <span style={{ fontWeight: 500, color: "#fff" }}>{today[key]}</span>
                        </label>
                      ))}
                  </div>
                </div>
                <div style={{ marginBottom: 22 }}>
                  <label style={{ fontFamily: "'Poppins', sans-serif", fontSize: 12, letterSpacing: 1, color: "#9bb8d3", textTransform: "uppercase", display: "block", marginBottom: 6 }}>Note (facoltativo)</label>
                  <textarea placeholder="Allergie, intolleranze, preferenze..." value={orderForm.note} onChange={(e) => setOrderForm((f) => ({ ...f, note: e.target.value }))} style={{ resize: "vertical", minHeight: 70, maxWidth: 400 }} />
                </div>
                <button className="btn-primary" onClick={handleOrder} disabled={submitting}>
                  {submitting ? "Invio in corso..." : "Invia prenotazione"}
                </button>
              </div>
            )}

            {/* Decorazione line-art: piatto con cuore di vapore, forchetta e coltello */}
            <div style={{ display: "flex", justifyContent: "center", marginTop: 60, opacity: 0.9 }}>
              <svg width="320" height="210" viewBox="0 0 320 210" fill="none" xmlns="http://www.w3.org/2000/svg">
                {/* Cuore di vapore che sale dal piatto, un unico tratto fluido */}
                <path
                  d="M160 18
                     C 148 26, 146 38, 156 46
                     C 164 52, 158 60, 160 70
                     C 162 60, 156 52, 164 46
                     C 174 38, 172 26, 160 18 Z"
                  stroke="white" strokeWidth="2" fill="none" strokeLinejoin="round" strokeLinecap="round"
                />
                <path d="M160 70 C 160 80, 160 86, 160 92" stroke="white" strokeWidth="2" fill="none" strokeLinecap="round"/>

                {/* Piatto ellittico a doppio bordo */}
                <ellipse cx="160" cy="128" rx="92" ry="28" stroke="white" strokeWidth="2" fill="none"/>
                <ellipse cx="160" cy="125" rx="54" ry="15" stroke="white" strokeWidth="1.4" fill="none" opacity="0.65"/>

                {/* Forchetta — linea continua, rebbi arrotondati */}
                <path
                  d="M56 70
                     L56 100
                     C 56 108, 64 112, 70 108
                     L 70 160
                     M48 70 L48 92
                     M64 70 L64 92
                     M56 70 L56 92"
                  stroke="white" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"
                />
                <path d="M48 70 C 48 60, 56 60, 56 70 M64 70 C 64 60, 56 60, 56 70" stroke="white" strokeWidth="2" fill="none" strokeLinecap="round"/>

                {/* Coltello — lama affusolata e manico */}
                <path
                  d="M258 64
                     C 246 68, 240 80, 246 96
                     L 252 112
                     C 254 118, 254 124, 254 130
                     L 254 168"
                  stroke="white" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"
                />

                {/* Filo decorativo che collega gli elementi, come nel menù fisico */}
                <path d="M70 160 C 110 178, 210 178, 254 168" stroke="white" strokeWidth="1.2" fill="none" strokeLinecap="round" opacity="0.5"/>
              </svg>
            </div>
          </div>
        )}

        {/* ADMIN VIEW */}
        {view === "admin" && adminUser && (
          <div className="fade-in">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 28 }}>
              <div>
                <h2 className="script-title" style={{ fontSize: 32 }}>Pannello Admin</h2>
                <p style={{ fontFamily: "'Poppins', sans-serif", fontSize: 13, color: "#7f9cb8", marginTop: 4 }}>{orders.length} ordini ricevuti oggi</p>
              </div>
              <button onClick={toggleSuspended} style={{ padding: "10px 22px", fontFamily: "'Poppins', sans-serif", fontSize: 13, fontWeight: 500, cursor: "pointer", border: "none", background: suspended ? "rgba(80,150,80,0.85)" : "rgba(180,70,70,0.85)", color: "white", letterSpacing: 0.5, transition: "all 0.2s", borderRadius: 2 }}>
                {suspended ? "Riapri ordinazioni" : "Sospendi ordinazioni"}
              </button>
            </div>

            <h3 className="script-title" style={{ fontSize: 24, marginBottom: 14 }}>Ordini ricevuti</h3>
            {orders.length === 0 ? (
              <div className="card" style={{ padding: "24px", fontFamily: "'Poppins', sans-serif", color: "#7f9cb8", fontSize: 14 }}>Nessun ordine ancora.</div>
            ) : (
              orders.map((o) => (
                <div key={o.id} className="order-row fade-in">
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
                        <span style={{ fontFamily: "'Poppins', sans-serif", fontWeight: 600, fontSize: 15, color: "#fff" }}>{o.name}</span>
                        <span style={{ fontFamily: "'Poppins', sans-serif", fontSize: 11, color: "#7f9cb8" }}>
                          {new Date(o.created_at).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}
                        </span>
                      </div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: o.note ? 8 : 0 }}>
                        {o.primo && <span className="tag" style={{ background: "rgba(255,255,255,0.12)", color: "#cfe0ee" }}>Primo</span>}
                        {o.secondo && <span className="tag" style={{ background: "rgba(255,255,255,0.12)", color: "#cfe0ee" }}>Secondo</span>}
                        {o.contorno && <span className="tag" style={{ background: "rgba(255,255,255,0.12)", color: "#cfe0ee" }}>Contorno</span>}
                        {o.dessert && <span className="tag" style={{ background: "rgba(255,255,255,0.12)", color: "#cfe0ee" }}>Dessert</span>}
                      </div>
                      {o.note && <div style={{ fontFamily: "'Poppins', sans-serif", fontSize: 12, color: "#7f9cb8", fontStyle: "italic" }}>"{o.note}"</div>}
                    </div>
                    <button className="btn-danger" onClick={() => deleteOrder(o.id)} style={{ flexShrink: 0, fontSize: 12, padding: "6px 14px" }}>Rimuovi</button>
                  </div>
                </div>
              ))
            )}

            <div className="divider-line" />
            <h3 className="script-title" style={{ fontSize: 24, marginBottom: 4 }}>Gestione menù settimanale</h3>
            <p style={{ fontFamily: "'Poppins', sans-serif", fontSize: 12, color: "#7f9cb8", marginBottom: 16 }}>Per ogni portata puoi impostarla come non disponibile o nasconderla completamente.</p>

            {menu.map((day) => {
              const hidden = day.hidden_fields || [];
              const unavailable = day.unavailable_fields || [];
              return (
                <div key={day.id} className="card" style={{ padding: "16px 20px", marginBottom: 10, borderLeft: `3px solid ${day.is_today ? "#fff" : "rgba(255,255,255,0.2)"}` }}>
                  {editingDay === day.id ? (
                    <div>
                      <div style={{ fontFamily: "'Poppins', sans-serif", fontSize: 12, fontWeight: 600, marginBottom: 12, color: "#fff" }}>Modifica {day.day}</div>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 10, marginBottom: 10 }}>
                        <div>
                          <label style={{ fontFamily: "'Poppins', sans-serif", fontSize: 11, color: "#9bb8d3", display: "block", marginBottom: 4 }}>Giorno</label>
                          <input value={editForm.day || ""} onChange={(e) => setEditForm((f) => ({ ...f, day: e.target.value }))} />
                        </div>
                        <div>
                          <label style={{ fontFamily: "'Poppins', sans-serif", fontSize: 11, color: "#9bb8d3", display: "block", marginBottom: 4 }}>Data</label>
                          <input value={editForm.date || ""} onChange={(e) => setEditForm((f) => ({ ...f, date: e.target.value }))} />
                        </div>
                        {fields.map(({ key, label }) => (
                          <div key={key}>
                            <label style={{ fontFamily: "'Poppins', sans-serif", fontSize: 11, color: "#9bb8d3", display: "block", marginBottom: 4 }}>{label}</label>
                            <input value={editForm[key] || ""} onChange={(e) => setEditForm((f) => ({ ...f, [key]: e.target.value }))} />
                          </div>
                        ))}
                      </div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button className="btn-primary" style={{ fontSize: 12, padding: "8px 18px" }} onClick={saveEdit}>Salva</button>
                        <button className="btn-ghost" style={{ fontSize: 12, padding: "8px 18px" }} onClick={() => setEditingDay(null)}>Annulla</button>
                      </div>
                    </div>
                  ) : (
                    <div>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <span style={{ fontFamily: "'Poppins', sans-serif", fontWeight: 600, fontSize: 15, color: "#fff" }}>{day.day} {day.date}</span>
                          {day.is_today && <span className="tag" style={{ background: "rgba(255,255,255,0.9)", color: "#1c3c5e", fontSize: 10 }}>Oggi</span>}
                        </div>
                        <div style={{ display: "flex", gap: 8 }}>
                          {!day.is_today && (
                            <button className="btn-ghost" style={{ fontSize: 11, padding: "6px 14px" }} onClick={() => setToday(day.id)}>Imposta oggi</button>
                          )}
                          <button className="btn-ghost" style={{ fontSize: 11, padding: "6px 14px" }} onClick={() => startEdit(day)}>Modifica</button>
                        </div>
                      </div>

                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        {fields.map(({ key, label }) => {
                          const isHidden = hidden.includes(key);
                          const isUnavailable = unavailable.includes(key);
                          const status = isHidden ? "hidden" : isUnavailable ? "unavailable" : "visible";
                          return (
                            <div key={key} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", background: isHidden ? "rgba(180,70,70,0.1)" : isUnavailable ? "rgba(200,160,60,0.1)" : "rgba(255,255,255,0.04)", borderLeft: `2px solid ${isHidden ? "#b04545" : isUnavailable ? "#c0a050" : "#5a9a6a"}` }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                <span style={{ fontFamily: "'Poppins', sans-serif", fontSize: 11, fontWeight: 600, color: "#7f9cb8", textTransform: "uppercase", letterSpacing: 1, width: 70 }}>{label}</span>
                                <span style={{ fontFamily: "'Poppins', sans-serif", fontSize: 13, fontWeight: 500, color: isHidden ? "#6b7d8e" : isUnavailable ? "#c0a050" : "#fff", textDecoration: isHidden ? "line-through" : "none", fontStyle: isUnavailable ? "italic" : "normal" }}>
                                  {isHidden ? "nascosto" : isUnavailable ? "non disponibile" : day[key]}
                                </span>
                              </div>
                              <div style={{ display: "flex", gap: 4 }}>
                                {status !== "visible" && (
                                  <button className="field-control-btn" onClick={() => toggleFieldVisibility(day.id, key, hidden, unavailable, "restore")} style={{ background: "rgba(90,154,106,0.2)", color: "#8fcf9f" }}>
                                    Ripristina
                                  </button>
                                )}
                                {status !== "unavailable" && (
                                  <button className="field-control-btn" onClick={() => toggleFieldVisibility(day.id, key, hidden, unavailable, "unavailable")} style={{ background: "rgba(192,160,80,0.2)", color: "#d8be7a" }}>
                                    Non disponibile
                                  </button>
                                )}
                                {status !== "hidden" && (
                                  <button className="field-control-btn" onClick={() => toggleFieldVisibility(day.id, key, hidden, unavailable, "hide")} style={{ background: "rgba(180,70,70,0.2)", color: "#e09a9a" }}>
                                    Nascondi
                                  </button>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
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
