/** DEV-ONLY preview harness — tree-shaken from prod. */
import type { BvSession } from "./bv-init";

const lbl = (c: string) => (c === "weekly" ? "week" : c === "quarterly" ? "quarter" : "month");
let PLANS: any[] = [
  { id: 1, name: "Monthly Coffee Box", blurb: "3 bags of single-origin Blue Mountain, roasted to order.", price: 4500, intro_price: 2500, cadence: "monthly", cadence_label: "month", currency: "JMD", active: true, accent: "#0a7d54", image: null, contents: ["250g roasted beans", "Brew guide", "Surprise treat"], product_ids: [], active_subs: 24, total_subs: 31, public_url: location.origin + "/plan/1" },
  { id: 2, name: "Weekly Veg Crate", blurb: "Farm-fresh produce, delivered Fridays.", price: 2800, intro_price: null, cadence: "weekly", cadence_label: "week", currency: "JMD", active: true, accent: "#2f9e44", image: null, contents: ["Seasonal veg", "Herbs"], product_ids: [], active_subs: 12, total_subs: 18, public_url: location.origin + "/plan/2" },
  { id: 3, name: "Quarterly Rum Club", blurb: null, price: 9000, intro_price: null, cadence: "quarterly", cadence_label: "quarter", currency: "JMD", active: false, accent: "#7a5901", image: null, contents: [], product_ids: [], active_subs: 0, total_subs: 5, public_url: location.origin + "/plan/3" },
];
let PID = 3;
let SUBS: any[] = [
  { id: 1, plan_id: 1, name: "Maria Brown", email: "maria@example.com", state: "active", started_at: new Date(Date.now() - 60 * 864e5).toISOString(), next_renewal: new Date(Date.now() + 6 * 864e5).toISOString().slice(0, 10), cycles: 2, skip_next: false, is_gift: false, prepaid_cycles: 0, past_due_fails: 0, portal_url: location.origin + "/sub/tok1" },
  { id: 2, plan_id: 1, name: "Devon Clarke", email: "devon@example.com", state: "paused", started_at: new Date(Date.now() - 90 * 864e5).toISOString(), next_renewal: null, cycles: 3, skip_next: false, is_gift: true, prepaid_cycles: 2, past_due_fails: 0, portal_url: location.origin + "/sub/tok2" },
  { id: 3, plan_id: 1, name: "Kemar Lewis", email: "kemar@example.com", state: "past_due", started_at: new Date(Date.now() - 120 * 864e5).toISOString(), next_renewal: new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10), cycles: 4, skip_next: false, is_gift: false, prepaid_cycles: 0, past_due_fails: 1, portal_url: location.origin + "/sub/tok3" },
  { id: 4, plan_id: 2, name: "Aaliyah Wright", email: "aaliyah@example.com", state: "active", started_at: new Date(Date.now() - 14 * 864e5).toISOString(), next_renewal: new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10), cycles: 2, skip_next: true, is_gift: false, prepaid_cycles: 0, past_due_fails: 0, portal_url: location.origin + "/sub/tok4" },
];
let SID = 4;

export function installMockFetch() {
  window.fetch = async (input: any, init: any = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const method = (init.method || "GET").toUpperCase();
    const u = new URL(url, location.origin);
    const body = init.body ? JSON.parse(init.body) : {};
    const json = (d: any, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json" } });
    await new Promise((r) => setTimeout(r, 80));
    const pm = u.pathname.match(/\/api\/plans\/(\d+)(\/subscribers)?$/);
    const sm = u.pathname.match(/\/api\/subscribers\/(\d+)(\/renew)?$/);

    if (u.pathname === "/api/plans" && method === "GET") return json({ plans: PLANS, connected: true, webhook_realtime: true, billing_mode: "manual_link" });
    if (u.pathname === "/api/plans" && method === "POST") { const p = { id: ++PID, ...body, cadence_label: lbl(body.cadence), currency: "JMD", active: true, contents: body.contents || [], product_ids: body.product_ids || [], active_subs: 0, total_subs: 0, public_url: location.origin + "/plan/" + PID }; PLANS.unshift(p); return json({ plan: p }, 201); }
    if (u.pathname === "/api/products") { const q = (u.searchParams.get("q") || "").toLowerCase(); const P = [{ id: 101, title: "Blue Mountain Beans 250g", price: 1800, image: null }, { id: 102, title: "Brew Guide", price: 0, image: null }, { id: 103, title: "Veg Crate", price: 2800, image: null }]; return json({ products: P.filter((x) => !q || x.title.toLowerCase().includes(q)) }); }
    if (u.pathname === "/api/subscribers" && method === "GET") { let rows = SUBS.slice(); const q = (u.searchParams.get("q") || "").toLowerCase(); const fil = u.searchParams.get("filter"); const pid = u.searchParams.get("plan_id"); if (pid) rows = rows.filter((s) => String(s.plan_id) === pid); if (q) rows = rows.filter((s) => (s.name + s.email).toLowerCase().includes(q)); if (fil) rows = rows.filter((s) => s.state === fil); return json({ subscribers: rows }); }
    if (u.pathname === "/api/subscribers.csv") return new Response("plan,name,email,state\nMonthly Coffee Box,Maria Brown,maria@example.com,active", { status: 200, headers: { "Content-Type": "text/csv" } });
    if (u.pathname === "/api/analytics") { const active = SUBS.filter((s) => s.state === "active"); const mrr = active.reduce((s, x) => { const p = PLANS.find((y) => y.id === x.plan_id); const py = p?.cadence === "weekly" ? 52 : p?.cadence === "quarterly" ? 4 : 12; return s + (p ? p.price * py / 12 : 0); }, 0); return json({ mrr: Math.round(mrr), active: active.length, cancelled: 2, past_due: SUBS.filter((s) => s.state === "past_due").length, churn_rate: 8, avg_lifetime_cycles: 2.7, by_plan: PLANS.map((p) => ({ name: p.name, active: SUBS.filter((s) => s.plan_id === p.id && s.state === "active").length, mrr: Math.round(SUBS.filter((s) => s.plan_id === p.id && s.state === "active").length * p.price * (p.cadence === "weekly" ? 52 : p.cadence === "quarterly" ? 4 : 12) / 12) })).sort((a, b) => b.mrr - a.mrr) }); }
    if (pm && pm[2] === "/subscribers") return json({ subscribers: SUBS.filter((s) => s.plan_id === Number(pm[1])) });
    if (pm && method === "PATCH") { const p = PLANS.find((x) => x.id === Number(pm[1])); Object.assign(p, body, { cadence_label: lbl(body.cadence || p.cadence) }); return json({ plan: p }); }
    if (pm && method === "DELETE") { PLANS = PLANS.filter((x) => x.id !== Number(pm[1])); SUBS = SUBS.filter((s) => s.plan_id !== Number(pm[1])); return json({ ok: true }); }
    if (sm && sm[2] === "/renew") return json({ payment_url: location.origin + "/pay/mock", sent: true });
    if (sm && method === "PATCH") { const s = SUBS.find((x) => x.id === Number(sm[1])); if (s) Object.assign(s, body); return json({ subscriber: s }); }
    return new Response("{}", { status: 404 });
  };
}

export function mockSession(): BvSession {
  return {
    inkress: { notify: ({ message }: any) => console.log("[toast]", message) } as any,
    merchant: { id: 183, username: "blue-mountain-co", name: "Blue Mountain Coffee Co.", currency_code: "JMD", email: "hello@bluemountain.co", logo: null },
    user: { id: 90, name: "Owner", email: "owner@bluemountain.co" },
    scopes: ["orders:write", "products:read", "webhooks:manage", "offline_access"],
  };
}
