import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";
import { mountAppCore, inkressApi, createInkressOrder, getInkressOrder, isPaidStatus } from "@inkress/apps-core";
import { openPg } from "@inkress/apps-core/pgdb";
import { openMerchantTokens } from "@inkress/apps-core/merchant-tokens";
import { sendEmail, sesConfigured } from "@inkress/apps-core/ses";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const WEBHOOK_SECRET = process.env.INKRESS_WEBHOOK_SECRET || "";
for (const k of ["OAUTH_CLIENT_ID", "OAUTH_CLIENT_SECRET", "INKRESS_API_BASE"]) {
  if (!process.env[k]) { console.error(`[subscription-box] Missing env: ${k}`); process.exit(1); }
}

const db = await openPg("subscription_box", `
  CREATE TABLE IF NOT EXISTS plans (
    id BIGSERIAL PRIMARY KEY, merchant_id BIGINT NOT NULL,
    name TEXT NOT NULL, blurb TEXT, price NUMERIC NOT NULL, cadence TEXT NOT NULL DEFAULT 'monthly',
    currency TEXT NOT NULL DEFAULT 'JMD', active BOOLEAN NOT NULL DEFAULT true,
    merchant_name TEXT, merchant_logo TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  ALTER TABLE plans ADD COLUMN IF NOT EXISTS accent TEXT NOT NULL DEFAULT '#0a7d54';
  ALTER TABLE plans ADD COLUMN IF NOT EXISTS image TEXT;
  ALTER TABLE plans ADD COLUMN IF NOT EXISTS contents JSONB NOT NULL DEFAULT '[]';
  ALTER TABLE plans ADD COLUMN IF NOT EXISTS product_ids JSONB NOT NULL DEFAULT '[]';
  ALTER TABLE plans ADD COLUMN IF NOT EXISTS intro_price NUMERIC;
  ALTER TABLE plans ADD COLUMN IF NOT EXISTS billing_plan_id TEXT;
  CREATE TABLE IF NOT EXISTS subscribers (
    id BIGSERIAL PRIMARY KEY, merchant_id BIGINT NOT NULL, plan_id BIGINT NOT NULL,
    name TEXT, email TEXT, state TEXT NOT NULL DEFAULT 'awaiting',
    started_at TIMESTAMPTZ, next_renewal DATE, cycles INTEGER NOT NULL DEFAULT 0,
    ref TEXT, inkress_order_id TEXT, payment_url TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (plan_id, email)
  );
  ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS token TEXT;
  ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS customer_id TEXT;
  ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS skip_next BOOLEAN NOT NULL DEFAULT false;
  ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS prepaid_cycles INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS is_gift BOOLEAN NOT NULL DEFAULT false;
  ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS past_due_fails INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS renewal_sent_at TIMESTAMPTZ;
  ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_sb_token ON subscribers (token) WHERE token IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_sb_subs ON subscribers (merchant_id, plan_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS settings (merchant_id BIGINT PRIMARY KEY, data JSONB NOT NULL DEFAULT '{}', updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
  CREATE TABLE IF NOT EXISTS webhook_subs (merchant_id BIGINT PRIMARY KEY, url TEXT NOT NULL, registered_at TIMESTAMPTZ NOT NULL DEFAULT now());
  CREATE TABLE IF NOT EXISTS webhook_seen (webhook_id TEXT PRIMARY KEY, seen_at TIMESTAMPTZ NOT NULL DEFAULT now());
`);

const app = express();
app.use("/webhooks/inkress", express.raw({ type: () => true, limit: "1mb" }));
const core = mountAppCore(app, {
  clientId: process.env.OAUTH_CLIENT_ID, clientSecret: process.env.OAUTH_CLIENT_SECRET,
  apiBaseUrl: process.env.INKRESS_API_BASE, frameAncestors: process.env.FRAME_ANCESTORS,
  staticDir: path.join(__dirname, "dist"),
  onBootstrap: (entry) => { tokens.save(entry.merchantId, entry.refreshToken).catch(() => {}); },
});
const tokens = await openMerchantTokens("subscription_box", core.cfg);

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);
const token = () => crypto.randomBytes(9).toString("base64url");
const PUBLIC_BASE = (req) => process.env.PUBLIC_BASE_URL || `https://${req.get("host")}`;
const CADENCE = { weekly: { label: "week", days: 7, perYear: 52 }, monthly: { label: "month", months: 1, perYear: 12 }, quarterly: { label: "quarter", months: 3, perYear: 4 } };
function nextRenewal(cadence, from = new Date()) {
  const d = new Date(from); const c = CADENCE[cadence] || CADENCE.monthly;
  if (c.days) d.setDate(d.getDate() + c.days); else d.setMonth(d.getMonth() + (c.months || 1));
  return d.toISOString().slice(0, 10);
}
// Billing mode: manual_link today (customer pays each cycle). Flips to auto_charge once the
// upstream card-on-file billing branch lands (then renewals charge the vaulted card off-session).
const BILLING_MODE = process.env.BILLING_MODE || "manual_link";
const AUTO_CHARGE = BILLING_MODE === "auto_charge";
// commerce-api billing_plans billing_cycle: 1=day 2=week 3=month 4=year
const BILLING_CYCLE = { weekly: 2, monthly: 3, quarterly: 3 };

// Ensure a commerce-api billing plan exists for this local plan and cache its id.
// Inert until BILLING_MODE=auto_charge AND the upstream `billing:write` work is
// deployed (see commerce-api docs/oauth-card-on-file-billing.md). Best-effort:
// failure just falls back to the manual payment-link path below.
async function ensureBillingPlan(accessToken, plan) {
  if (!AUTO_CHARGE) return null;
  if (plan.billing_plan_id) return plan.billing_plan_id;
  try {
    const duration = plan.cadence === "quarterly" ? 3 : 1;
    const r = await inkressApi(core.cfg, accessToken, "billing_plans", {
      method: "POST",
      body: JSON.stringify({
        name: `${plan.name} (subscription-box)`, flat_rate: round2(plan.price), currency_code: plan.currency,
        billing_cycle: BILLING_CYCLE[plan.cadence] || 3, duration, kind: 2, auto_charge: true,
        meta_data: { source: "subscription-box", plan_id: plan.id },
      }),
    });
    const id = r?.result?.id ?? r?.id;
    if (id != null) { await db.run(`UPDATE plans SET billing_plan_id=$2 WHERE id=$1`, [plan.id, String(id)]); return String(id); }
  } catch (err) { console.error(`[subscription-box] ensureBillingPlan: ${err?.message}`); }
  return null;
}

async function getSettings(mid) { const r = await db.one(`SELECT data FROM settings WHERE merchant_id=$1`, [mid]); return { auto_renew: true, ...(r?.data || {}) }; }
async function planStats(planId) {
  const r = await db.q(`SELECT state FROM subscribers WHERE plan_id=$1`, [planId]);
  return { active: r.filter((s) => s.state === "active").length, paused: r.filter((s) => s.state === "paused").length, awaiting: r.filter((s) => s.state === "awaiting").length, past_due: r.filter((s) => s.state === "past_due").length, total: r.length };
}
const serializePlan = (p, stats, req) => ({ id: p.id, name: p.name, blurb: p.blurb, price: Number(p.price), intro_price: p.intro_price != null ? Number(p.intro_price) : null, cadence: p.cadence, cadence_label: (CADENCE[p.cadence] || CADENCE.monthly).label, currency: p.currency, active: p.active, accent: p.accent, image: p.image, contents: p.contents || [], product_ids: p.product_ids || [], active_subs: stats?.active || 0, total_subs: stats?.total || 0, public_url: `${PUBLIC_BASE(req)}/plan/${p.id}` });
const serializeSub = (s, req) => ({ id: s.id, name: s.name, email: s.email, state: s.state, started_at: s.started_at, next_renewal: s.next_renewal, cycles: s.cycles, skip_next: s.skip_next, is_gift: s.is_gift, prepaid_cycles: s.prepaid_cycles, past_due_fails: s.past_due_fails, portal_url: s.token ? `${PUBLIC_BASE(req)}/sub/${s.token}` : null });

// ---- Plans -----------------------------------------------------------------
app.get("/api/plans", core.requireSession, async (req, res) => {
  const rows = await db.q(`SELECT * FROM plans WHERE merchant_id=$1 ORDER BY id DESC`, [req.session.merchantId]);
  const out = []; for (const p of rows) out.push(serializePlan(p, await planStats(p.id), req));
  res.json({ plans: out, connected: await tokens.hasToken(req.session.merchantId), webhook_realtime: Boolean(WEBHOOK_SECRET), billing_mode: BILLING_MODE });
});
function planFields(b, m, p) {
  const cadence = b.cadence && CADENCE[b.cadence] ? b.cadence : (p?.cadence || "monthly");
  return {
    name: String(b.name ?? p?.name ?? "").trim(), blurb: b.blurb !== undefined ? (b.blurb || null) : (p?.blurb ?? null), price: b.price != null ? round2(b.price) : Number(p?.price ?? 0),
    intro_price: b.intro_price !== undefined ? (b.intro_price ? round2(b.intro_price) : null) : (p?.intro_price ?? null), cadence,
    accent: /^#[0-9a-fA-F]{6}$/.test(b.accent) ? b.accent : (p?.accent || "#0a7d54"), image: b.image !== undefined ? (b.image || null) : (p?.image ?? null),
    contents: Array.isArray(b.contents) ? b.contents.map((c) => String(c).slice(0, 120)).filter(Boolean) : (p?.contents || []),
    product_ids: Array.isArray(b.product_ids) ? b.product_ids.map((x) => Number(x)).filter(Boolean) : (p?.product_ids || []),
  };
}
app.post("/api/plans", core.requireSession, async (req, res) => {
  const b = req.body || {}; const m = req.session.data?.merchant || {}; const f = planFields(b, m);
  if (!f.name || !(f.price > 0)) return res.status(400).json({ error: "bad_input", message: "Plan name and a price are required." });
  const row = await db.one(`INSERT INTO plans (merchant_id, name, blurb, price, intro_price, cadence, currency, accent, image, contents, product_ids, merchant_name, merchant_logo)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [req.session.merchantId, f.name, f.blurb, f.price, f.intro_price, f.cadence, m.currency_code || "JMD", f.accent, f.image, JSON.stringify(f.contents), JSON.stringify(f.product_ids), m.name || null, m.logo || m.logo_url || null]);
  res.status(201).json({ plan: serializePlan(row, { active: 0, total: 0 }, req) });
});
app.patch("/api/plans/:id", core.requireSession, async (req, res) => {
  const p = await db.one(`SELECT * FROM plans WHERE id=$1 AND merchant_id=$2`, [req.params.id, req.session.merchantId]);
  if (!p) return res.status(404).json({ error: "not_found" });
  const b = req.body || {}; const f = planFields(b, {}, p);
  const u = await db.one(`UPDATE plans SET name=$1, blurb=$2, price=$3, intro_price=$4, cadence=$5, accent=$6, image=$7, contents=$8, product_ids=$9, active=$10 WHERE id=$11 RETURNING *`,
    [f.name, f.blurb, f.price, f.intro_price, f.cadence, f.accent, f.image, JSON.stringify(f.contents), JSON.stringify(f.product_ids), b.active != null ? !!b.active : p.active, p.id]);
  res.json({ plan: serializePlan(u, await planStats(p.id), req) });
});
app.delete("/api/plans/:id", core.requireSession, async (req, res) => {
  await db.run(`DELETE FROM subscribers WHERE plan_id=$1 AND merchant_id=$2`, [req.params.id, req.session.merchantId]);
  await db.run(`DELETE FROM plans WHERE id=$1 AND merchant_id=$2`, [req.params.id, req.session.merchantId]);
  res.json({ ok: true });
});

// Catalog picker — link box contents to real Inkress products
app.get("/api/products", core.requireSession, async (req, res) => {
  const q = String(req.query.q || "").trim();
  try {
    const r = await inkressApi(core.cfg, req.session.accessToken, `products?limit=30&order=id desc${q ? `&q=${encodeURIComponent(q)}` : ""}`);
    const products = (r?.result?.entries || []).map((p) => { const cur = p.currency || {}; const raw = Number(p.price ?? 0); return { id: p.id, title: p.title || p.name || `Product ${p.id}`, price: cur.is_float === true ? raw / 100 : raw, image: p.image || p.images?.[0]?.url || null }; });
    res.json({ products });
  } catch (err) { res.status(502).json({ error: "products_failed", message: err?.message }); }
});

// ---- Subscribers -----------------------------------------------------------
app.get("/api/subscribers", core.requireSession, async (req, res) => {
  if (req.query.refresh === "1" && !WEBHOOK_SECRET) await pollAwaiting(req.session.merchantId, req.session.accessToken);
  let rows = await db.q(`SELECT * FROM subscribers WHERE merchant_id=$1 ORDER BY created_at DESC`, [req.session.merchantId]);
  const q = String(req.query.q || "").trim().toLowerCase(); const filter = String(req.query.filter || ""); const planId = req.query.plan_id;
  if (planId) rows = rows.filter((s) => String(s.plan_id) === String(planId));
  if (q) rows = rows.filter((s) => (`${s.name || ""} ${s.email || ""}`).toLowerCase().includes(q));
  if (filter && ["active", "paused", "awaiting", "past_due", "cancelled"].includes(filter)) rows = rows.filter((s) => s.state === filter);
  res.json({ subscribers: rows.map((s) => serializeSub(s, req)) });
});
app.get("/api/plans/:id/subscribers", core.requireSession, async (req, res) => {
  if (req.query.refresh === "1" && !WEBHOOK_SECRET) await pollAwaiting(req.session.merchantId, req.session.accessToken);
  const rows = await db.q(`SELECT * FROM subscribers WHERE plan_id=$1 AND merchant_id=$2 ORDER BY created_at DESC`, [req.params.id, req.session.merchantId]);
  res.json({ subscribers: rows.map((s) => serializeSub(s, req)) });
});
app.patch("/api/subscribers/:id", core.requireSession, async (req, res) => {
  const s = await db.one(`SELECT * FROM subscribers WHERE id=$1 AND merchant_id=$2`, [req.params.id, req.session.merchantId]);
  if (!s) return res.status(404).json({ error: "not_found" });
  const b = req.body || {};
  if (b.state && !["active", "paused", "cancelled"].includes(b.state)) return res.status(400).json({ error: "bad_state" });
  const u = await db.one(`UPDATE subscribers SET state=$1, skip_next=$2, is_gift=$3, prepaid_cycles=$4, cancelled_at=$5 WHERE id=$6 RETURNING *`,
    [b.state || s.state, b.skip_next != null ? !!b.skip_next : s.skip_next, b.is_gift != null ? !!b.is_gift : s.is_gift,
      b.prepaid_cycles != null ? Math.max(0, Number(b.prepaid_cycles)) : s.prepaid_cycles, b.state === "cancelled" ? new Date() : s.cancelled_at, s.id]);
  res.json({ subscriber: serializeSub(u, req) });
});
app.post("/api/subscribers/:id/renew", core.requireSession, async (req, res) => {
  const s = await db.one(`SELECT * FROM subscribers WHERE id=$1 AND merchant_id=$2`, [req.params.id, req.session.merchantId]);
  if (!s) return res.status(404).json({ error: "not_found" });
  const plan = await db.one(`SELECT * FROM plans WHERE id=$1`, [s.plan_id]);
  try { const out = await sendRenewal(s, plan); res.json({ payment_url: out.payment_url, sent: out.sent }); }
  catch (err) { res.status(502).json({ error: "order_failed", message: err?.message }); }
});

// Analytics — MRR / churn / lifetime
app.get("/api/analytics", core.requireSession, async (req, res) => {
  const plans = await db.q(`SELECT * FROM plans WHERE merchant_id=$1`, [req.session.merchantId]);
  const subs = await db.q(`SELECT * FROM subscribers WHERE merchant_id=$1`, [req.session.merchantId]);
  const planById = Object.fromEntries(plans.map((p) => [String(p.id), p]));
  let mrr = 0, active = 0, cancelled = 0, totalCycles = 0;
  for (const s of subs) {
    const p = planById[String(s.plan_id)]; if (!p) continue;
    const perYear = (CADENCE[p.cadence] || CADENCE.monthly).perYear;
    if (s.state === "active") { active++; mrr += round2(Number(p.price) * perYear / 12); }
    if (s.state === "cancelled") cancelled++;
    totalCycles += Number(s.cycles || 0);
  }
  const everActive = active + cancelled;
  res.json({ mrr: round2(mrr), active, cancelled, past_due: subs.filter((s) => s.state === "past_due").length,
    churn_rate: everActive ? Math.round((cancelled / everActive) * 100) : 0, avg_lifetime_cycles: subs.length ? round2(totalCycles / subs.length) : 0,
    by_plan: plans.map((p) => { const ps = subs.filter((s) => String(s.plan_id) === String(p.id) && s.state === "active"); return { name: p.name, active: ps.length, mrr: round2(ps.length * Number(p.price) * (CADENCE[p.cadence] || CADENCE.monthly).perYear / 12) }; }).sort((a, b) => b.mrr - a.mrr) });
});

app.get("/api/subscribers.csv", core.requireSession, async (req, res) => {
  const rows = await db.q(`SELECT s.*, p.name AS plan_name, p.price FROM subscribers s JOIN plans p ON p.id=s.plan_id WHERE s.merchant_id=$1 ORDER BY s.created_at DESC`, [req.session.merchantId]);
  const esc = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const lines = rows.map((s) => [s.plan_name, s.name, s.email, s.state, s.cycles, s.next_renewal || "", s.is_gift ? "gift" : "", s.started_at?.toISOString?.() || s.started_at || ""].map(esc).join(","));
  res.setHeader("Content-Type", "text/csv"); res.setHeader("Content-Disposition", `attachment; filename="subscribers.csv"`);
  res.send(["plan,name,email,state,cycles,next_renewal,gift,started", ...lines].join("\n"));
});

app.get("/api/status", core.requireSession, async (req, res) => {
  const mid = req.session.merchantId;
  let sub = await db.one(`SELECT * FROM webhook_subs WHERE merchant_id=$1`, [mid]);
  const canRegister = WEBHOOK_SECRET && (req.session.scope || []).includes("webhooks:manage");
  if (!sub && canRegister) {
    const url = `${PUBLIC_BASE(req)}/webhooks/inkress/${mid}`;
    try { await inkressApi(core.cfg, req.session.accessToken, `webhook_urls`, { method: "POST", body: JSON.stringify({ url, event: "orders" }) }); await db.run(`INSERT INTO webhook_subs (merchant_id, url) VALUES ($1,$2) ON CONFLICT (merchant_id) DO UPDATE SET url=$2`, [mid, url]); sub = { merchant_id: mid, url }; }
    catch (err) { if (String(err?.message || "").match(/already|unique|exist|422/i)) { await db.run(`INSERT INTO webhook_subs (merchant_id, url) VALUES ($1,$2) ON CONFLICT (merchant_id) DO NOTHING`, [mid, url]); sub = { merchant_id: mid, url }; } }
  }
  res.json({ realtime: Boolean(sub) && Boolean(WEBHOOK_SECRET), webhook_registered: Boolean(sub), can_register: Boolean(canRegister), billing_mode: BILLING_MODE });
});

// ---- Subscribe + activation ------------------------------------------------
async function activateSub(s, plan) {
  await db.run(`UPDATE subscribers SET state='active', started_at=COALESCE(started_at, now()), next_renewal=$2, cycles=cycles+1, past_due_fails=0 WHERE id=$1`, [s.id, nextRenewal(plan.cadence)]);
  emailWelcome(plan, s).catch(() => {});
}
async function pollAwaiting(mid, accessToken) {
  const awaiting = await db.q(`SELECT * FROM subscribers WHERE merchant_id=$1 AND state IN ('awaiting','past_due') AND inkress_order_id IS NOT NULL LIMIT 25`, [mid]);
  for (const s of awaiting) { try { const ink = await getInkressOrder(core.cfg, accessToken, s.inkress_order_id); if (ink && isPaidStatus(ink)) { const plan = await db.one(`SELECT * FROM plans WHERE id=$1`, [s.plan_id]); await activateSub(s, plan); } } catch { /* */ } }
}

app.get("/plan/:id", async (req, res) => {
  const p = await db.one(`SELECT * FROM plans WHERE id=$1`, [req.params.id]).catch(() => null);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (!p || !p.active) return res.status(404).send(publicShell("Unavailable", `<div class="pad"><h1>Subscription unavailable</h1></div>`));
  res.send(subscribePage(p));
});
app.post("/api/public/plan/:id", express.json(), async (req, res) => {
  const p = await db.one(`SELECT * FROM plans WHERE id=$1`, [req.params.id]).catch(() => null);
  if (!p || !p.active) return res.status(404).json({ error: "closed" });
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "bad_email", message: "Enter a valid email." });
  const existing = await db.one(`SELECT * FROM subscribers WHERE plan_id=$1 AND email=$2`, [p.id, email]).catch(() => null);
  if (existing && existing.state === "active") return res.status(400).json({ error: "already", message: "You're already subscribed with this email." });
  let accessToken;
  try { accessToken = await tokens.accessTokenFor(p.merchant_id); } catch { return res.status(503).json({ error: "not_connected", message: "This merchant hasn't finished setup." }); }
  const name = String(req.body?.name || "Subscriber").trim();
  const firstAmount = p.intro_price != null ? round2(p.intro_price) : round2(p.price);
  const ref = `sub-${p.merchant_id}-${p.id}-${Date.now().toString(36)}-${crypto.randomBytes(2).toString("hex")}`;
  const [first, ...rest] = name.split(/\s+/);
  // Auto-charge: attach a billing plan so commerce-api vaults the card and
  // creates the subscription on payment (inert until BILLING_MODE=auto_charge
  // + upstream deployed; falls back to manual link otherwise).
  const billingPlanId = await ensureBillingPlan(accessToken, p);
  let created;
  try {
    created = await createInkressOrder(core.cfg, accessToken, {
      referenceId: ref, total: firstAmount, currencyCode: p.currency, kind: "online", title: `${p.name} subscription`,
      customer: { email, first_name: first || "Subscriber", last_name: rest.join(" ") || "" },
      ...(billingPlanId ? { billingPlanId } : {}),
      metaData: { source: "subscription-box", plan_id: p.id, plan: p.name },
    });
  } catch (err) { return res.status(502).json({ error: "order_failed", message: err?.message }); }
  const tok = existing?.token || token();
  if (existing) await db.run(`UPDATE subscribers SET name=$2, state='awaiting', ref=$3, inkress_order_id=$4, payment_url=$5, token=$6 WHERE id=$1`, [existing.id, name, ref, created.id != null ? String(created.id) : null, created.payment_url || null, tok]);
  else await db.run(`INSERT INTO subscribers (merchant_id, plan_id, name, email, ref, inkress_order_id, payment_url, token, is_gift) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [p.merchant_id, p.id, name, email, ref, created.id != null ? String(created.id) : null, created.payment_url || null, tok, !!req.body?.gift]);
  res.json({ payment_url: created.payment_url });
});

// ---- Subscriber self-service portal (public) -------------------------------
app.get("/sub/:token", async (req, res) => {
  const s = await db.one(`SELECT * FROM subscribers WHERE token=$1`, [req.params.token]).catch(() => null);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (!s) return res.status(404).send(publicShell("Not found", `<div class="pad"><h1>Subscription not found</h1></div>`));
  const plan = await db.one(`SELECT * FROM plans WHERE id=$1`, [s.plan_id]);
  res.send(portalPage(s, plan));
});
app.post("/api/public/sub/:token/:action", express.json(), async (req, res) => {
  const s = await db.one(`SELECT * FROM subscribers WHERE token=$1`, [req.params.token]).catch(() => null);
  if (!s) return res.status(404).json({ error: "not_found" });
  const a = req.params.action;
  if (a === "pause") await db.run(`UPDATE subscribers SET state='paused' WHERE id=$1`, [s.id]);
  else if (a === "resume") await db.run(`UPDATE subscribers SET state='active' WHERE id=$1`, [s.id]);
  else if (a === "skip") await db.run(`UPDATE subscribers SET skip_next=true WHERE id=$1`, [s.id]);
  else if (a === "cancel") await db.run(`UPDATE subscribers SET state='cancelled', cancelled_at=now() WHERE id=$1`, [s.id]);
  else return res.status(400).json({ error: "bad_action" });
  res.json({ ok: true });
});

// ---- Webhook receiver — real-time activation -------------------------------
app.post("/webhooks/inkress/:merchantId", async (req, res) => {
  const merchantId = Number(req.params.merchantId);
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));
  if (WEBHOOK_SECRET) {
    const expected = crypto.createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("base64");
    const got = String(req.get("x-inkress-webhook-signature") || "");
    const a = Buffer.from(expected), b = Buffer.from(got);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: "bad_signature" });
  }
  res.json({ received: true });
  try {
    const evt = JSON.parse(raw.toString("utf8"));
    const o = evt?.order || evt?.data?.order;
    if (!o || !merchantId || String(o.status || "").toLowerCase() !== "paid") return;
    const wid = String(req.get("x-inkress-webhook-id") || `${o.id}.${o.status}`);
    if (await db.one(`SELECT 1 FROM webhook_seen WHERE webhook_id=$1`, [wid])) return;
    await db.run(`INSERT INTO webhook_seen (webhook_id) VALUES ($1) ON CONFLICT DO NOTHING`, [wid]);
    const s = await db.one(`SELECT * FROM subscribers WHERE merchant_id=$1 AND inkress_order_id=$2 AND state IN ('awaiting','past_due')`, [merchantId, String(o.id)]);
    if (s) { const plan = await db.one(`SELECT * FROM plans WHERE id=$1`, [s.plan_id]); await activateSub(s, plan); }
  } catch (err) { console.error(`[subscription-box] webhook failed: ${err?.message}`); }
});

// ---- Scheduler: renewals (auto-charge when billing lands; else auto-email link) + dunning
async function sendRenewal(s, plan) {
  const accessToken = await tokens.accessTokenFor(s.merchant_id);
  const ref = `subrenew-${s.merchant_id}-${s.id}-${Date.now().toString(36)}`;
  const [first, ...rest] = String(s.name || "Subscriber").split(/\s+/);
  // BILLING_MODE === 'auto_charge' path (card-on-file) wires in here once the upstream branch lands.
  const created = await createInkressOrder(core.cfg, accessToken, {
    referenceId: ref, total: round2(plan.price), currencyCode: plan.currency, kind: "online", title: `${plan.name} — renewal`,
    customer: { email: s.email, first_name: first || "Subscriber", last_name: rest.join(" ") || "" },
    metaData: { source: "subscription-box", plan_id: plan.id, plan: plan.name, renewal: true },
  });
  await db.run(`UPDATE subscribers SET inkress_order_id=$2, payment_url=$3, renewal_sent_at=now() WHERE id=$1`, [s.id, created.id != null ? String(created.id) : null, created.payment_url || null]);
  let sent = false;
  if (sesConfigured() && s.email) { try { await sendEmail({ to: s.email, subject: `Renew your ${plan.name} subscription`, html: renewEmail(plan, created.payment_url, s) }); sent = true; } catch { /* */ } }
  return { payment_url: created.payment_url, sent };
}
async function runRenewals() {
  try {
    const mids = await db.q(`SELECT DISTINCT merchant_id FROM subscribers WHERE state='active'`);
    for (const { merchant_id: mid } of mids) {
      const s = await getSettings(mid); if (!s.auto_renew) continue;
      const due = await db.q(`SELECT * FROM subscribers WHERE merchant_id=$1 AND state='active' AND next_renewal IS NOT NULL AND next_renewal <= $2`, [mid, today()]);
      for (const sub of due) {
        const plan = await db.one(`SELECT * FROM plans WHERE id=$1`, [sub.plan_id]); if (!plan) continue;
        if (sub.skip_next) { await db.run(`UPDATE subscribers SET skip_next=false, next_renewal=$2 WHERE id=$1`, [sub.id, nextRenewal(plan.cadence)]); continue; }
        if (sub.prepaid_cycles > 0) { await db.run(`UPDATE subscribers SET prepaid_cycles=prepaid_cycles-1, cycles=cycles+1, next_renewal=$2 WHERE id=$1`, [sub.id, nextRenewal(plan.cadence)]); continue; }
        // Auto-charge: commerce-api charges the vaulted card off-session on its
        // own renewal schedule — the app sends no manual link. Just advance the
        // local next_renewal marker for display.
        if (AUTO_CHARGE && plan.billing_plan_id) { await db.run(`UPDATE subscribers SET cycles=cycles+1, next_renewal=$2 WHERE id=$1`, [sub.id, nextRenewal(plan.cadence)]); continue; }
        try { await sendRenewal(sub, plan); await db.run(`UPDATE subscribers SET next_renewal=$2 WHERE id=$1`, [sub.id, nextRenewal(plan.cadence)]); } catch { /* */ }
      }
      // Dunning: renewal links sent but unpaid > 5 days → past_due; > 3 fails → cancel.
      const stale = await db.q(`SELECT * FROM subscribers WHERE merchant_id=$1 AND state='active' AND renewal_sent_at IS NOT NULL AND renewal_sent_at < now() - interval '5 days' AND inkress_order_id IS NOT NULL`, [mid]);
      for (const sub of stale) {
        try { const ink = await getInkressOrder(core.cfg, await tokens.accessTokenFor(mid), sub.inkress_order_id); if (ink && isPaidStatus(ink)) continue; } catch { /* */ }
        const fails = Number(sub.past_due_fails) + 1;
        if (fails >= 3) await db.run(`UPDATE subscribers SET state='cancelled', cancelled_at=now() WHERE id=$1`, [sub.id]);
        else await db.run(`UPDATE subscribers SET state='past_due', past_due_fails=$2, renewal_sent_at=NULL WHERE id=$1`, [sub.id, fails]);
      }
    }
  } catch (err) { console.error(`[subscription-box] runRenewals: ${err?.message}`); }
}
setInterval(runRenewals, 6 * 3600 * 1000); setTimeout(runRenewals, 45000);

async function emailWelcome(plan, sub) { if (!sesConfigured() || !sub.email) return; await sendEmail({ to: sub.email, subject: `Welcome to ${plan.name} 🎁`, html: welcomeEmail(plan, sub) }); }

core.mountSpaFallback();
app.listen(PORT, HOST, () => console.log(`[subscription-box] listening on ${HOST}:${PORT}`));

// ---- html ------------------------------------------------------------------
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function money(n, c) { try { return new Intl.NumberFormat("en-JM", { style: "currency", currency: c, minimumFractionDigits: 0 }).format(n); } catch { return `${c} ${n}`; } }
function welcomeEmail(plan, sub) {
  return `<div style="font-family:system-ui,sans-serif;max-width:460px;margin:0 auto;text-align:center;color:#1a1a1a;">
    <div style="font-size:40px;">🎁</div><h2 style="margin:4px 0;">You're subscribed!</h2>
    <p style="color:#555;">${esc(plan.name)} — ${money(Number(plan.price), plan.currency)} / ${(CADENCE[plan.cadence] || CADENCE.monthly).label}</p>
    ${(plan.contents || []).length ? `<p style="color:#666;font-size:13px;">Inside: ${(plan.contents || []).map(esc).join(" · ")}</p>` : ""}
    <p style="color:#888;font-size:13px;">Next renewal: ${esc(sub.next_renewal || "")}</p>
    ${sub.token ? `<p style="font-size:12px;"><a href="${esc(process.env.PUBLIC_BASE_URL || "")}/sub/${esc(sub.token)}" style="color:${esc(plan.accent || "#0a7d54")}">Manage your subscription</a></p>` : ""}
    <p style="color:#aaa;font-size:12px;">via Marketplace</p></div>`;
}
function renewEmail(plan, url, sub) {
  return `<div style="font-family:system-ui,sans-serif;max-width:460px;margin:0 auto;text-align:center;color:#1a1a1a;">
    <h2 style="margin:4px 0;">Time to renew ${esc(plan.name)}</h2>
    <p style="color:#555;">${money(Number(plan.price), plan.currency)} / ${(CADENCE[plan.cadence] || CADENCE.monthly).label}</p>
    <a href="${esc(url)}" style="display:inline-block;margin:14px 0;padding:13px 28px;background:${esc(plan.accent || "#0a7d54")};color:#fff;border-radius:10px;text-decoration:none;font-weight:700;">Renew now</a>
    ${sub?.token ? `<p style="font-size:12px;"><a href="${esc(process.env.PUBLIC_BASE_URL || "")}/sub/${esc(sub.token)}" style="color:#888">Manage / pause / cancel</a></p>` : ""}
    <p style="color:#aaa;font-size:12px;">via Marketplace</p></div>`;
}
function publicShell(title, inner, accent = "#0a7d54") {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
  <style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#f6f7f9;color:#1f2430;display:grid;place-items:center;min-height:100vh;padding:20px}
  .card{background:#fff;border:1px solid #e9ebef;border-radius:18px;box-shadow:0 14px 44px rgba(20,25,40,.12);max-width:430px;width:100%;overflow:hidden}
  .accent{height:4px;background:${accent}} .pad{padding:26px}
  .logo{width:60px;height:60px;border-radius:16px;object-fit:cover;margin:0 auto 12px;display:block;border:1px solid #eee}
  .hero{width:100%;height:150px;object-fit:cover;display:block}
  h1{font-size:1.5rem;margin:0 0 6px;text-align:center} .blurb{color:#6b7280;text-align:center;margin:0 0 14px}
  .price{text-align:center;font-size:2rem;font-weight:800;margin:8px 0 2px}.per{text-align:center;color:#8a93a3;margin:0 0 16px;font-size:.92rem}
  .contents{list-style:none;padding:0;margin:0 0 16px}.contents li{padding:7px 0;border-bottom:1px solid #eef1f5;font-size:.92rem;display:flex;gap:8px}.contents li:before{content:"✓";color:${accent};font-weight:700}
  input{width:100%;box-sizing:border-box;padding:12px 14px;border:1px solid #d4d8df;border-radius:10px;font-size:15px;margin-bottom:10px}
  button.buy{width:100%;padding:14px;border:0;border-radius:10px;background:${accent};color:#fff;font-size:15px;font-weight:700;cursor:pointer}
  .row{display:flex;gap:8px}.row button{flex:1;padding:12px;border:1px solid #d4d8df;background:#fff;border-radius:10px;font-weight:600;cursor:pointer}
  .state{text-align:center;font-weight:700;margin:6px 0 14px}.foot{text-align:center;color:#aab;font-size:12px;padding:14px}</style></head>
  <body><div class="card"><div class="accent"></div>${inner}<div class="foot">powered by Marketplace</div></div></body></html>`;
}
function subscribePage(p) {
  const accent = (p.accent && /^#[0-9a-fA-F]{6}$/.test(p.accent)) ? p.accent : "#0a7d54";
  const logo = p.merchant_logo ? `<img class="logo" src="${esc(p.merchant_logo)}" alt="">` : "";
  const per = (CADENCE[p.cadence] || CADENCE.monthly).label;
  const contents = (p.contents || []).length ? `<ul class="contents">${(p.contents || []).map((c) => `<li>${esc(c)}</li>`).join("")}</ul>` : "";
  const intro = p.intro_price != null ? `<p class="per">first ${esc(per)} ${money(Number(p.intro_price), p.currency)}, then ${money(Number(p.price), p.currency)}/${esc(per)}</p>` : `<p class="per">billed every ${esc(per)}</p>`;
  return publicShell(p.name, `${p.image ? `<img class="hero" src="${esc(p.image)}" alt="">` : ""}<div class="pad">${p.image ? "" : logo}
    <h1>${esc(p.name)}</h1>${p.merchant_name ? `<p class="blurb">by ${esc(p.merchant_name)}</p>` : ""}${p.blurb ? `<p class="blurb">${esc(p.blurb)}</p>` : ""}
    <div class="price">${money(Number(p.intro_price != null ? p.intro_price : p.price), p.currency)}</div>${intro}
    ${contents}
    <input id="n" required placeholder="Your name" autocomplete="name">
    <input id="em" type="email" required placeholder="you@email.com" autocomplete="email">
    <button class="buy" id="buy">Subscribe</button>
    <div id="msg" style="display:none;color:#6b7280;text-align:center;margin-top:10px"></div>
    <script>document.getElementById('buy').addEventListener('click',async()=>{const n=document.getElementById('n').value,em=document.getElementById('em').value;if(!n||!em){show('Enter your name and email.');return;}const b=document.getElementById('buy');b.disabled=true;b.textContent='Creating your link…';const r=await fetch('/api/public/plan/${p.id}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:n,email:em})});const j=await r.json();if(j.payment_url){window.location.href=j.payment_url;}else{b.disabled=false;b.textContent='Subscribe';show(j.message||'Something went wrong.');}});
    function show(t){const m=document.getElementById('msg');m.style.display='block';m.textContent=t;}</script></div>`, accent);
}
function portalPage(s, plan) {
  const accent = (plan?.accent && /^#[0-9a-fA-F]{6}$/.test(plan.accent)) ? plan.accent : "#0a7d54";
  const per = (CADENCE[plan?.cadence] || CADENCE.monthly).label;
  const paused = s.state === "paused"; const cancelled = s.state === "cancelled";
  return publicShell(`Manage ${plan?.name || "subscription"}`, `<div class="pad">
    <h1>${esc(plan?.name || "Your subscription")}</h1>
    <p class="blurb">${esc(s.name || s.email || "")}</p>
    <div class="price">${money(Number(plan?.price || 0), plan?.currency || "JMD")}</div><p class="per">per ${esc(per)} · ${s.cycles} cycle${s.cycles === 1 ? "" : "s"}</p>
    <p class="state" style="color:${cancelled ? "#c92a2a" : paused ? "#b8860b" : accent}">${cancelled ? "Cancelled" : paused ? "Paused" : "Active"}${s.next_renewal && !cancelled ? ` · next ${esc(s.next_renewal)}` : ""}</p>
    ${cancelled ? "" : `<div class="row">
      ${paused ? `<button onclick="act('resume')">Resume</button>` : `<button onclick="act('pause')">Pause</button><button onclick="act('skip')">Skip next</button>`}
      <button onclick="if(confirm('Cancel your subscription?'))act('cancel')" style="color:#c92a2a">Cancel</button></div>`}
    <div id="ok" style="display:none;text-align:center;color:${accent};font-weight:600;margin-top:14px">✓ Updated</div>
    <script>async function act(a){const r=await fetch('/api/public/sub/${esc(s.token)}/'+a,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});if(r.ok){document.getElementById('ok').style.display='block';setTimeout(()=>location.reload(),900);}}</script></div>`, accent);
}
