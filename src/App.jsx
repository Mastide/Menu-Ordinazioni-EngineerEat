import { useState, useEffect, useRef } from "react";
import { supabase } from "./supabase.js";

const fields = [
  { key: "primo", label: "Primo" },
  { key: "secondo", label: "Secondo" },
  { key: "contorno", label: "Contorno" },
  { key: "dessert", label: "Dessert" },
];

function sendNotification(name) {
  // Notifica browser desktop
  if ("Notification" in window && Notification.permission === "granted") {
    new Notification("Nuovo ordine ricevuto", {
      body: `${name} ha appena prenotato`,
    });
  }
  // Notifica push ntfy (telefono)
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

  // Realtime menu (per aggiornare disponibilità in tempo reale)
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
    // action: 'hide' | 'unavailable' | 'restore'
    let newHidden = [...(currentHidden || [])];
    let newUnavailable = [...(currentUnavailable || [])];

    // Prima rimuovi da entrambi
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
      <div style={{ fontFamily: "'DM Sans', sans-serif", minHeight: "100vh", background: "#f5f0e8", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ color: "#888", fontSize: 14, letterSpacing: 1 }}>Caricamento...</div>
      </div>
    );
  }

  return (
    <div style={{ fontFamily: "'Georgia', serif", minHeight: "100vh", background: "#f5f0e8" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;600;700&family=DM+Sans:wght@300;400;500&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        .fade-in { animation: fadeIn 0.4s ease; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        .btn-primary { background: #2c2c2c; color: #f5f0e8; border: none; padding: 12px 28px; font-family: 'DM Sans', sans-serif; font-size: 14px; font-weight: 500; cursor: pointer; letter-spacing: 0.5px; transition: all 0.2s; }
        .btn-primary:hover { background: #444; }
        .btn-primary:disabled { background: #aaa; cursor: not-allowed; }
        .btn-danger { background: #8b2020; color: white; border: none; padding: 8px 18px; font-family: 'DM Sans', sans-serif; font-size: 13px; cursor: pointer; transition: all 0.2s; }
        .btn-danger:hover { background: #a02828; }
        .btn-ghost { background: transparent; border: 1.5px solid #2c2c2c; color: #2c2c2c; padding: 10px 24px; font-family: 'DM Sans', sans-serif; font-size: 13px; cursor: pointer; transition: all 0.2s; }
        .btn-ghost:hover { background: #2c2c2c; color: #f5f0e8; }
        input, textarea { font-family: 'DM Sans', sans-serif; border: 1.5px solid #d4cfc4; background: white; padding: 10px 14px; font-size: 14px; outline: none; transition: border 0.2s; width: 100%; }
        input:focus, textarea:focus { border-color: #8b6914; }
        input[type=checkbox] { width: auto; accent-color: #8b6914; transform: scale(1.2); cursor: pointer; }
        .tag { display: inline-block; padding: 3px 10px; font-size: 11px; font-weight: 500; letter-spacing: 1px; text-transform: uppercase; }
        .divider { height: 1px; background: #d4cfc4; margin: 24px 0; }
        .day-tab { padding: 8px 16px; font-family: 'DM Sans', sans-serif; font-size: 13px; cursor: pointer; border: none; background: transparent; transition: all 0.2s; border-bottom: 2px solid transparent; color: #888; }
        .day-tab.active { color: #2c2c2c; border-bottom: 2px solid #8b6914; font-weight: 500; }
        .day-tab:hover:not(.active) { color: #555; }
        .order-row { background: white; padding: 14px 18px; margin-bottom: 10px; border-left: 3px solid #8b6914; }
        .suspended-banner { background: #8b2020; color: white; text-align: center; padding: 12px; font-family: 'DM Sans', sans-serif; font-size: 13px; letter-spacing: 0.5px; }
        .badge { background: #8b6914; color: white; border-radius: 50%; width: 18px; height: 18px; font-size: 10px; display: inline-flex; align-items: center; justify-content: center; margin-left: 6px; font-family: 'DM Sans', sans-serif; }
        .field-control-btn { border: none; padding: 4px 10px; font-family: 'DM Sans', sans-serif; font-size: 10px; font-weight: 500; letter-spacing: 0.5px; cursor: pointer; transition: all 0.15s; }
      `}</style>

      {/* Login modal */}
      {showLogin && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
          <div className="fade-in" style={{ background: "#f5f0e8", padding: "40px", width: 360, maxWidth: "90vw" }}>
            <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: 22, color: "#2c2c2c", marginBottom: 6 }}>Accesso Admin</h2>
            <p style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 13, color: "#888", marginBottom: 24 }}>Area riservata</p>
            <div style={{ marginBottom: 14 }}>
              <label style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 11, letterSpacing: 1, color: "#888", textTransform: "uppercase", display: "block", marginBottom: 6 }}>Email</label>
              <input type="email" value={loginForm.email} onChange={(e) => setLoginForm((f) => ({ ...f, email: e.target.value }))} onKeyDown={(e) => e.key === "Enter" && handleLogin()} />
            </div>
            <div style={{ marginBottom: 20 }}>
              <label style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 11, letterSpacing: 1, color: "#888", textTransform: "uppercase", display: "block", marginBottom: 6 }}>Password</label>
              <input type="password" value={loginForm.password} onChange={(e) => setLoginForm((f) => ({ ...f, password: e.target.value }))} onKeyDown={(e) => e.key === "Enter" && handleLogin()} />
            </div>
            {loginError && <div style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 13, color: "#8b2020", marginBottom: 16 }}>{loginError}</div>}
            <div style={{ display: "flex", gap: 10 }}>
              <button className="btn-primary" onClick={handleLogin} disabled={loginLoading}>{loginLoading ? "Accesso..." : "Accedi"}</button>
              <button className="btn-ghost" onClick={() => { setShowLogin(false); setLoginError(""); }}>Annulla</button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <header style={{ background: "#2c2c2c", padding: "0 32px" }}>
        <div style={{ maxWidth: 900, margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "space-between", height: 60 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
            <h1 style={{ fontFamily: "'Playfair Display', serif", color: "#f5f0e8", fontSize: 22, fontWeight: 600 }}>EngineerEat</h1>
<span style={{ color: "#888", fontSize: 12, letterSpacing: 1 }}>ORDINAZIONI</span>
          </div>
          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
            {adminUser ? (
              <>
                <button className="day-tab" onClick={() => setView("client")} style={{ color: view === "client" ? "#f5f0e8" : "#888", borderBottomColor: view === "client" ? "#8b6914" : "transparent" }}>
                  Menu & Ordini
                </button>
                <button className="day-tab" onClick={() => { setView("admin"); setNewOrderCount(0); }} style={{ color: view === "admin" ? "#f5f0e8" : "#888", borderBottomColor: view === "admin" ? "#8b6914" : "transparent", display: "flex", alignItems: "center" }}>
                  Admin ⚙{newOrderCount > 0 && <span className="badge">{newOrderCount}</span>}
                </button>
                <button onClick={handleLogout} style={{ marginLeft: 8, background: "transparent", border: "1px solid #555", color: "#888", padding: "4px 12px", fontFamily: "'DM Sans', sans-serif", fontSize: 11, cursor: "pointer", letterSpacing: 0.5 }}>
                  Esci
                </button>
              </>
            ) : (
              <button onClick={() => setShowLogin(true)} style={{ background: "transparent", border: "none", color: "#555", fontFamily: "'DM Sans', sans-serif", fontSize: 12, cursor: "pointer", letterSpacing: 0.5, padding: "4px 8px" }}>
                ⚙
              </button>
            )}
          </div>
        </div>
      </header>

      {suspended && <div className="suspended-banner">ORDINAZIONI SOSPESE — La cucina non accetta nuove prenotazioni al momento</div>}

      <main style={{ maxWidth: 900, margin: "0 auto", padding: "32px 24px" }}>

        {/* CLIENT VIEW */}
        {view === "client" && today && (
          <div className="fade-in">
            <div style={{ marginBottom: 20 }}>
              <span className="tag" style={{ background: "#8b6914", color: "white", marginBottom: 8, display: "block", width: "fit-content" }}>
                Oggi · {today.day} {today.date}
              </span>
              <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: 28, color: "#2c2c2c" }}>Menu del giorno</h2>
            </div>

            {/* Menu del giorno — mostra solo campi non nascosti */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12, marginBottom: 32 }}>
              {visibleFields.map(({ key, label }) => {
                const isUnavailable = todayUnavailable.includes(key);
                return (
                  <div key={key} style={{ background: "white", padding: "18px 22px", borderTop: `3px solid ${isUnavailable ? "#c0b090" : "#8b6914"}`, opacity: isUnavailable ? 0.7 : 1 }}>
                    <div style={{ fontSize: 10, fontFamily: "'DM Sans', sans-serif", fontWeight: 500, letterSpacing: 1.5, color: "#888", textTransform: "uppercase", marginBottom: 6 }}>{label}</div>
                    {isUnavailable ? (
                      <div style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 13, color: "#a08050", fontStyle: "italic" }}>Non disponibile</div>
                    ) : (
                      <div style={{ fontFamily: "'Playfair Display', serif", fontSize: 16, color: "#2c2c2c" }}>{today[key]}</div>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="divider" />
            <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: 20, color: "#2c2c2c", marginBottom: 16 }}>Menu della settimana</h3>

            <div style={{ borderBottom: "1px solid #d4cfc4", display: "flex", marginBottom: 20, overflowX: "auto" }}>
              {menu.map((d, i) => (
                <button key={d.id} className={`day-tab ${activeDay === i ? "active" : ""}`} onClick={() => setActiveDay(i)}>
                  {d.day}
                  {d.is_today && <span style={{ marginLeft: 4, color: "#8b6914" }}>•</span>}
                </button>
              ))}
            </div>

            {menu[activeDay] && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 36 }}>
                {fields
                  .filter(f => !(menu[activeDay].hidden_fields || []).includes(f.key))
                  .map(({ key, label }) => {
                    const isUnavailable = (menu[activeDay].unavailable_fields || []).includes(key);
                    return (
                      <div key={key} style={{ background: "white", padding: "14px 16px", opacity: isUnavailable ? 0.7 : 1 }}>
                        <div style={{ fontSize: 10, fontFamily: "'DM Sans', sans-serif", letterSpacing: 1.5, color: "#888", textTransform: "uppercase", marginBottom: 5 }}>{label}</div>
                        {isUnavailable ? (
                          <div style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 12, color: "#a08050", fontStyle: "italic" }}>Non disponibile</div>
                        ) : (
                          <div style={{ fontFamily: "'Playfair Display', serif", fontSize: 14, color: "#2c2c2c" }}>{menu[activeDay][key]}</div>
                        )}
                      </div>
                    );
                  })}
              </div>
            )}

            <div className="divider" />
            <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: 20, color: "#2c2c2c", marginBottom: 6 }}>
              {suspended ? "Ordinazioni chiuse" : "Prenota il tuo pasto"}
            </h3>

            {suspended ? (
              <div style={{ background: "#f9e8e8", border: "1px solid #d4a0a0", padding: "16px 20px", fontFamily: "'DM Sans', sans-serif", fontSize: 14, color: "#8b2020" }}>
                Le ordinazioni sono temporaneamente sospese. Riprova più tardi.
              </div>
            ) : orderSent ? (
              <div className="fade-in" style={{ background: "#eaf4e8", border: "1px solid #a0c89a", padding: "20px 24px", fontFamily: "'DM Sans', sans-serif" }}>
                <div style={{ fontSize: 16, fontWeight: 500, color: "#2d5a27", marginBottom: 6 }}>Prenotazione inviata</div>
                <div style={{ fontSize: 13, color: "#555" }}>Il tuo ordine è stato ricevuto. Buon appetito!</div>
                <button className="btn-ghost" style={{ marginTop: 14, fontSize: 12 }} onClick={() => setOrderSent(false)}>Nuovo ordine</button>
              </div>
            ) : (
              <div style={{ background: "white", padding: "24px 28px" }}>
                <div style={{ marginBottom: 16 }}>
                  <label style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 12, letterSpacing: 1, color: "#888", textTransform: "uppercase", display: "block", marginBottom: 6 }}>Nome e cognome *</label>
                  <input placeholder="Es. Marco Bianchi" value={orderForm.name} onChange={(e) => setOrderForm((f) => ({ ...f, name: e.target.value }))} style={{ maxWidth: 320 }} />
                </div>
                <div style={{ marginBottom: 16 }}>
                  <label style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 12, letterSpacing: 1, color: "#888", textTransform: "uppercase", display: "block", marginBottom: 12 }}>Selezione *</label>
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {visibleFields
                      .filter(f => !todayUnavailable.includes(f.key))
                      .map(({ key, label }) => (
                        <label key={key} style={{ display: "flex", alignItems: "center", gap: 12, cursor: "pointer", fontFamily: "'DM Sans', sans-serif", fontSize: 14 }}>
                          <input type="checkbox" checked={orderForm[key]} onChange={(e) => setOrderForm((f) => ({ ...f, [key]: e.target.checked }))} />
                          <span style={{ fontWeight: 400, color: "#555" }}>{label} —</span>
                          <span style={{ fontFamily: "'Playfair Display', serif", color: "#2c2c2c" }}>{today[key]}</span>
                        </label>
                      ))}
                  </div>
                </div>
                <div style={{ marginBottom: 20 }}>
                  <label style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 12, letterSpacing: 1, color: "#888", textTransform: "uppercase", display: "block", marginBottom: 6 }}>Note (facoltativo)</label>
                  <textarea placeholder="Allergie, intolleranze, preferenze..." value={orderForm.note} onChange={(e) => setOrderForm((f) => ({ ...f, note: e.target.value }))} style={{ resize: "vertical", minHeight: 70, maxWidth: 400 }} />
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
                <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: 26, color: "#2c2c2c" }}>Pannello Admin</h2>
                <p style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 13, color: "#888", marginTop: 4 }}>{orders.length} ordini ricevuti oggi</p>
              </div>
              <button onClick={toggleSuspended} style={{ padding: "10px 22px", fontFamily: "'DM Sans', sans-serif", fontSize: 13, fontWeight: 500, cursor: "pointer", border: "none", background: suspended ? "#2d5a27" : "#8b2020", color: "white", letterSpacing: 0.5, transition: "all 0.2s" }}>
                {suspended ? "Riapri ordinazioni" : "Sospendi ordinazioni"}
              </button>
            </div>

            <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: 18, marginBottom: 14, color: "#2c2c2c" }}>Ordini ricevuti</h3>
            {orders.length === 0 ? (
              <div style={{ background: "white", padding: "24px", fontFamily: "'DM Sans', sans-serif", color: "#888", fontSize: 14 }}>Nessun ordine ancora.</div>
            ) : (
              orders.map((o) => (
                <div key={o.id} className="order-row fade-in">
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
                        <span style={{ fontFamily: "'Playfair Display', serif", fontSize: 16, color: "#2c2c2c" }}>{o.name}</span>
                        <span style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 11, color: "#888" }}>
                          {new Date(o.created_at).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}
                        </span>
                      </div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: o.note ? 8 : 0 }}>
                        {o.primo && <span className="tag" style={{ background: "#f0ebe0", color: "#5a4a1e" }}>Primo</span>}
                        {o.secondo && <span className="tag" style={{ background: "#f0ebe0", color: "#5a4a1e" }}>Secondo</span>}
                        {o.contorno && <span className="tag" style={{ background: "#f0ebe0", color: "#5a4a1e" }}>Contorno</span>}
                        {o.dessert && <span className="tag" style={{ background: "#f0ebe0", color: "#5a4a1e" }}>Dessert</span>}
                      </div>
                      {o.note && <div style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 12, color: "#888", fontStyle: "italic" }}>"{o.note}"</div>}
                    </div>
                    <button className="btn-danger" onClick={() => deleteOrder(o.id)} style={{ flexShrink: 0, fontSize: 12, padding: "6px 14px" }}>Rimuovi</button>
                  </div>
                </div>
              ))
            )}

            <div className="divider" />
            <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: 18, color: "#2c2c2c", marginBottom: 4 }}>Gestione menu settimanale</h3>
            <p style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 12, color: "#888", marginBottom: 16 }}>Per ogni portata puoi impostarla come non disponibile o nasconderla completamente.</p>

            {menu.map((day) => {
              const hidden = day.hidden_fields || [];
              const unavailable = day.unavailable_fields || [];
              return (
                <div key={day.id} style={{ background: "white", padding: "16px 20px", marginBottom: 10, borderLeft: `3px solid ${day.is_today ? "#8b6914" : "#d4cfc4"}` }}>
                  {editingDay === day.id ? (
                    <div>
                      <div style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 12, fontWeight: 600, marginBottom: 12, color: "#8b6914" }}>Modifica {day.day}</div>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 10, marginBottom: 10 }}>
                        <div>
                          <label style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 11, color: "#888", display: "block", marginBottom: 4 }}>Giorno</label>
                          <input value={editForm.day || ""} onChange={(e) => setEditForm((f) => ({ ...f, day: e.target.value }))} />
                        </div>
                        <div>
                          <label style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 11, color: "#888", display: "block", marginBottom: 4 }}>Data</label>
                          <input value={editForm.date || ""} onChange={(e) => setEditForm((f) => ({ ...f, date: e.target.value }))} />
                        </div>
                        {fields.map(({ key, label }) => (
                          <div key={key}>
                            <label style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 11, color: "#888", display: "block", marginBottom: 4 }}>{label}</label>
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
                          <span style={{ fontFamily: "'Playfair Display', serif", fontSize: 15, color: "#2c2c2c" }}>{day.day} {day.date}</span>
                          {day.is_today && <span className="tag" style={{ background: "#8b6914", color: "white", fontSize: 10 }}>Oggi</span>}
                        </div>
                        <div style={{ display: "flex", gap: 8 }}>
                          {!day.is_today && (
                            <button className="btn-ghost" style={{ fontSize: 11, padding: "6px 14px" }} onClick={() => setToday(day.id)}>Imposta oggi</button>
                          )}
                          <button className="btn-ghost" style={{ fontSize: 11, padding: "6px 14px" }} onClick={() => startEdit(day)}>Modifica</button>
                        </div>
                      </div>

                      {/* Controlli visibilità portate */}
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        {fields.map(({ key, label }) => {
                          const isHidden = hidden.includes(key);
                          const isUnavailable = unavailable.includes(key);
                          const status = isHidden ? "hidden" : isUnavailable ? "unavailable" : "visible";
                          return (
                            <div key={key} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", background: isHidden ? "#f5f0f0" : isUnavailable ? "#fdf8ee" : "#f8f8f5", borderLeft: `2px solid ${isHidden ? "#c09090" : isUnavailable ? "#c0a060" : "#b0c090"}` }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                <span style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 11, fontWeight: 600, color: "#888", textTransform: "uppercase", letterSpacing: 1, width: 70 }}>{label}</span>
                                <span style={{ fontFamily: "'Playfair Display', serif", fontSize: 13, color: isHidden ? "#aaa" : isUnavailable ? "#a08050" : "#2c2c2c", textDecoration: isHidden ? "line-through" : "none", fontStyle: isUnavailable ? "italic" : "normal" }}>
                                  {isHidden ? "nascosto" : isUnavailable ? "non disponibile" : day[key]}
                                </span>
                              </div>
                              <div style={{ display: "flex", gap: 4 }}>
                                {status !== "visible" && (
                                  <button className="field-control-btn" onClick={() => toggleFieldVisibility(day.id, key, hidden, unavailable, "restore")} style={{ background: "#eaf4e8", color: "#2d5a27" }}>
                                    Ripristina
                                  </button>
                                )}
                                {status !== "unavailable" && (
                                  <button className="field-control-btn" onClick={() => toggleFieldVisibility(day.id, key, hidden, unavailable, "unavailable")} style={{ background: "#fdf0d0", color: "#8b6914" }}>
                                    Non disponibile
                                  </button>
                                )}
                                {status !== "hidden" && (
                                  <button className="field-control-btn" onClick={() => toggleFieldVisibility(day.id, key, hidden, unavailable, "hide")} style={{ background: "#f5e8e8", color: "#8b2020" }}>
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
