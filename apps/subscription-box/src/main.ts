import "./index.css";
import {
  initBv, bvApi, makeToast, type BvToastFn,
  mountShell, statRow, dataTable, card, openModal, flash,
  fmtMoney, fmtDate, pill, emptyState, h, iconEl,
} from "./bv-init";

interface Plan { id: number; name: string; blurb: string | null; price: number; intro_price: number | null; cadence: string; cadence_label: string; currency: string; active: boolean; accent: string; image: string | null; contents: string[]; product_ids: number[]; active_subs: number; total_subs: number; public_url: string; }
interface Sub { id: number; name: string | null; email: string | null; state: string; started_at: string | null; next_renewal: string | null; cycles: number; skip_next: boolean; is_gift: boolean; prepaid_cycles: number; past_due_fails: number; portal_url: string | null; }
interface ProductHit { id: number; title: string; price: number; image: string | null; }
interface Analytics { mrr: number; active: number; cancelled: number; past_due: number; churn_rate: number; avg_lifetime_cycles: number; by_plan: { name: string; active: number; mrr: number }[]; }

const root = document.getElementById("root")!;
let toast: BvToastFn;
let merchantName = "Merchant";
let currency = "JMD";
let plans: Plan[] = [];
let webhookRealtime = false;
let subFilter = "", subSearch = "", subPlanFilter = "";
let shell: ReturnType<typeof mountShell>;

(async () => {
  let session;
  if (import.meta.env.DEV && !new URLSearchParams(location.search).has("inkress_session")) {
    const m = await import("./dev-mock"); m.installMockFetch(); session = m.mockSession();
  } else {
    try { session = await initBv(); }
    catch (err: any) { root.innerHTML = ""; root.append(fatal(err?.message)); return; }
  }
  toast = makeToast(session.inkress);
  merchantName = session.merchant.name || session.merchant.username || "Merchant";
  currency = session.merchant.currency_code || "JMD";

  shell = mountShell({
    brandIcon: "package", brandLogo: "/logo.svg", title: "Subscription Boxes",
    subtitle: `${merchantName} · recurring plans your customers can join`, poweredBy: "Marketplace",
    tabs: [
      { id: "plans", label: "Plans", icon: "package", render: renderPlans },
      { id: "subscribers", label: "Subscribers", icon: "users", render: renderSubscribers },
      { id: "analytics", label: "Analytics", icon: "chart", render: renderAnalytics },
    ],
  });
})();

const sidOf = () => sessionStorage.getItem("bv_app_session_id") || localStorage.getItem("bv_app_session_id") || "";

/* --------------------------------------------------------------------- Plans */
async function renderPlans(host: HTMLElement) {
  host.append(h("div", { class: "bv-muted", style: { padding: "12px 2px" } }, "Loading…"));
  let data: { plans: Plan[]; connected: boolean; webhook_realtime: boolean; billing_mode: string };
  try { data = await bvApi("/api/plans"); plans = data.plans; webhookRealtime = data.webhook_realtime; }
  catch (err: any) { host.innerHTML = ""; host.append(emptyState({ icon: "alert", title: "Couldn't load", text: err?.message })); return; }
  host.innerHTML = "";

  host.append(statRow([
    { k: "Plans", v: String(plans.length), icon: "package" },
    { k: "Active subscribers", v: String(plans.reduce((s, p) => s + p.active_subs, 0)), tone: "ok", icon: "users" },
    { k: "Est. MRR", v: fmtMoney(plans.filter((p) => p.active).reduce((s, p) => s + p.price * p.active_subs * (p.cadence === "weekly" ? 52 / 12 : p.cadence === "quarterly" ? 1 / 3 : 1), 0), currency), tone: "accent", icon: "coins" },
  ]));

  const add = h("button", { class: "primary", onClick: () => openPlan(null) }, iconEl("plus", 15), "New plan");
  if (!plans.length) { host.append(card({ title: "Plans", action: add, body: emptyState({ icon: "package", title: "No plans yet", text: "Create a subscription plan and share its link — customers subscribe online." }) })); return; }

  const grid = h("div", { class: "sb-grid" });
  for (const p of plans) {
    grid.append(h("div", { class: "sb-card" + (p.active ? "" : " is-off"), style: { "--ac": p.accent } as any },
      p.image ? h("span", { class: "sb-hero", style: { backgroundImage: `url('${p.image}')` } }) : h("span", { class: "sb-stripe" }),
      h("div", { class: "sb-card-body" },
        h("div", { class: "sb-card-head" }, h("strong", null, p.name), p.active ? pill("live", "ok") : pill("off")),
        p.blurb ? h("div", { class: "bv-muted sb-blurb" }, p.blurb) : null,
        h("div", { class: "sb-price" }, fmtMoney(p.price, p.currency), h("span", { class: "bv-muted" }, ` / ${p.cadence_label}`), p.intro_price != null ? h("span", { class: "sb-intro" }, `intro ${fmtMoney(p.intro_price, p.currency)}`) : null),
        p.contents.length ? h("div", { class: "sb-contents bv-muted" }, p.contents.slice(0, 3).join(" · ") + (p.contents.length > 3 ? ` +${p.contents.length - 3}` : "")) : null,
        h("div", { class: "sb-subs" }, h("b", null, String(p.active_subs)), h("span", { class: "bv-muted" }, ` active · ${p.total_subs} total`)),
        h("div", { class: "sb-link" }, h("input", { class: "sb-link-input", readonly: true, value: p.public_url }), h("button", { class: "ghost sm", onClick: () => { navigator.clipboard?.writeText(p.public_url); flash("Link copied", "success"); } }, iconEl("copy", 14))),
        h("div", { class: "sb-actions" },
          h("button", { class: "ghost sm", onClick: () => { subPlanFilter = String(p.id); shell.select("subscribers"); } }, "Subscribers"),
          h("a", { class: "sb-open", href: p.public_url, target: "_blank", rel: "noopener" }, iconEl("external", 14)),
          h("button", { class: "ghost sm", onClick: () => openPlan(p) }, iconEl("edit", 14)),
          h("button", { class: "ghost sm", onClick: async () => { if (confirm(`Delete ${p.name} and its subscribers?`)) { await bvApi(`/api/plans/${p.id}`, { method: "DELETE" }); shell.select("plans"); } } }, iconEl("trash", 14))))));
  }
  host.append(card({ title: "Plans", action: add, body: grid }));
  if (webhookRealtime) host.append(h("div", { class: "sb-note bv-muted" }, iconEl("check", 14), "Real-time: subscribers activate the moment they pay. Renewals auto-email each cycle."));
  else if (!data.connected) host.append(h("div", { class: "sb-note bv-muted" }, iconEl("alert", 14), "Connecting to your Inkress account — online subscriptions activate momentarily."));
}

function openPlan(p: Plan | null) {
  const name = h("input", { value: p?.name || "", placeholder: "e.g. Monthly Coffee Box" }) as HTMLInputElement;
  const blurb = h("input", { value: p?.blurb || "", placeholder: "Short description (optional)" }) as HTMLInputElement;
  const price = h("input", { type: "number", min: "0", step: "0.01", value: p ? String(p.price) : "", placeholder: "0.00" }) as HTMLInputElement;
  const introPrice = h("input", { type: "number", min: "0", step: "0.01", value: p?.intro_price != null ? String(p.intro_price) : "", placeholder: "First-cycle price (optional)" }) as HTMLInputElement;
  const cadence = h("select", null,
    h("option", { value: "weekly", selected: p?.cadence === "weekly" }, "Weekly"),
    h("option", { value: "monthly", selected: !p || p.cadence === "monthly" }, "Monthly"),
    h("option", { value: "quarterly", selected: p?.cadence === "quarterly" }, "Quarterly")) as HTMLSelectElement;
  const accent = h("input", { type: "color", value: p?.accent || "#0a7d54" }) as HTMLInputElement;
  const image = h("input", { value: p?.image || "", placeholder: "Hero image URL (optional)" }) as HTMLInputElement;
  const active = h("input", { type: "checkbox", checked: p ? p.active : true }) as HTMLInputElement;

  // Box contents (what's inside) — free text + product picker
  const contents: string[] = [...(p?.contents || [])];
  const productIds: number[] = [...(p?.product_ids || [])];
  const contentsList = h("div", { class: "sb-contents-edit" });
  const renderContents = () => { contentsList.innerHTML = ""; contents.forEach((c, i) => contentsList.append(h("div", { class: "sb-content-row" }, h("span", null, c), h("button", { class: "ghost sm", onClick: () => { contents.splice(i, 1); renderContents(); } }, iconEl("x", 12))))); };
  renderContents();
  const newContent = h("input", { placeholder: "Add an item (e.g. 250g roasted beans)" }) as HTMLInputElement;
  const addContent = () => { const v = newContent.value.trim(); if (v) { contents.push(v); newContent.value = ""; renderContents(); } };
  newContent.addEventListener("keydown", (e: any) => { if (e.key === "Enter") { e.preventDefault(); addContent(); } });

  // Product picker → adds title to contents + records product_id + sets image
  const prodSearch = h("input", { placeholder: "Link an Inkress product…", autocomplete: "off" }) as HTMLInputElement;
  const prodResults = h("div", { class: "sb-ac-results", style: { display: "none" } });
  let t: any;
  prodSearch.addEventListener("input", () => { clearTimeout(t); const q = prodSearch.value.trim(); if (q.length < 2) { prodResults.style.display = "none"; return; }
    t = setTimeout(async () => { try { const { products } = await bvApi<{ products: ProductHit[] }>(`/api/products?q=${encodeURIComponent(q)}`); prodResults.innerHTML = ""; if (!products.length) { prodResults.style.display = "none"; return; }
      for (const pr of products) prodResults.append(h("div", { class: "sb-ac-row", onClick: () => { contents.push(pr.title); productIds.push(pr.id); if (pr.image && !image.value) image.value = pr.image; prodSearch.value = ""; prodResults.style.display = "none"; renderContents(); } }, pr.image ? h("span", { class: "sb-ac-thumb", style: { backgroundImage: `url('${pr.image}')` } }) : null, h("strong", null, pr.title), h("span", { class: "bv-muted" }, fmtMoney(pr.price, currency))));
      prodResults.style.display = "block"; } catch { prodResults.style.display = "none"; } }, 220); });
  prodSearch.addEventListener("blur", () => setTimeout(() => { prodResults.style.display = "none"; }, 180));

  const body = h("div", { class: "sb-form" },
    field("Plan name", name), field("Description", blurb),
    h("div", { class: "sb-form-grid" }, field(`Price (${currency})`, price), field("Billing cadence", cadence)),
    h("div", { class: "sb-form-grid" }, field("Intro price (first cycle)", introPrice), fieldColor("Accent colour", accent)),
    field("Hero image URL", image),
    h("div", { class: "bv-label" }, "What's in the box"),
    contentsList,
    h("div", { class: "sb-content-add" }, newContent, h("button", { class: "ghost sm", onClick: addContent }, iconEl("plus", 13))),
    h("label", { class: "sb-field" }, h("span", { class: "bv-label" }, "Link a product"), h("div", { class: "sb-ac" }, prodSearch, prodResults)),
    p ? h("label", { class: "sb-check" }, active, " Active (accepting subscribers)") : null);

  const save = async () => {
    if (!name.value.trim() || !(Number(price.value) > 0)) { toast("Name and a price are required", "warning"); return; }
    const payload: any = { name: name.value, blurb: blurb.value, price: Number(price.value), intro_price: introPrice.value ? Number(introPrice.value) : null, cadence: cadence.value, accent: accent.value, image: image.value || null, contents, product_ids: productIds };
    try { if (p) { payload.active = active.checked; await bvApi(`/api/plans/${p.id}`, { method: "PATCH", body: JSON.stringify(payload) }); } else await bvApi("/api/plans", { method: "POST", body: JSON.stringify(payload) }); flash(p ? "Saved" : "Plan created", "success"); shell.select("plans"); }
    catch (err: any) { toast(err?.message || "error", "error"); }
  };
  openModal({ title: p ? "Edit plan" : "New plan", body, actions: [{ label: p ? "Save" : "Create", primary: true, onClick: () => { void save(); } }] });
}

/* --------------------------------------------------------------- Subscribers */
async function renderSubscribers(host: HTMLElement) {
  if (!plans.length) { try { plans = (await bvApi<{ plans: Plan[] }>("/api/plans")).plans; } catch { /* */ } }
  host.append(h("div", { class: "bv-muted", style: { padding: "12px 2px" } }, "Loading…"));
  let rows: Sub[];
  const qs = `${webhookRealtime ? "" : "refresh=1&"}q=${encodeURIComponent(subSearch)}${subFilter ? `&filter=${subFilter}` : ""}${subPlanFilter ? `&plan_id=${subPlanFilter}` : ""}`;
  try { rows = (await bvApi<{ subscribers: Sub[] }>(`/api/subscribers?${qs}`)).subscribers; }
  catch (err: any) { host.innerHTML = ""; host.append(emptyState({ icon: "alert", title: "Couldn't load", text: err?.message })); return; }
  host.innerHTML = "";

  const planSel = h("select", { onChange: (e: any) => { subPlanFilter = e.target.value; shell.select("subscribers"); } },
    h("option", { value: "", selected: !subPlanFilter }, "All plans"), ...plans.map((p) => h("option", { value: String(p.id), selected: String(p.id) === subPlanFilter }, p.name))) as HTMLSelectElement;
  const stateSel = h("select", { onChange: (e: any) => { subFilter = e.target.value; shell.select("subscribers"); } },
    ...[["", "All states"], ["active", "Active"], ["paused", "Paused"], ["awaiting", "Awaiting"], ["past_due", "Past due"], ["cancelled", "Cancelled"]].map(([v, l]) => h("option", { value: v, selected: subFilter === v }, l))) as HTMLSelectElement;
  const search = h("input", { class: "sb-search", placeholder: "Search…", value: subSearch, onKeyDown: (e: any) => { if (e.key === "Enter") { subSearch = e.target.value; shell.select("subscribers"); } } }) as HTMLInputElement;
  const csv = h("a", { class: "ghost sm", href: "/api/subscribers.csv", onClick: (e: any) => { e.preventDefault(); fetch("/api/subscribers.csv", { headers: { "X-BV-Session": sidOf() } }).then((r) => r.blob()).then((b) => { const u = URL.createObjectURL(b); const a = document.createElement("a"); a.href = u; a.download = "subscribers.csv"; a.click(); setTimeout(() => URL.revokeObjectURL(u), 10000); }).catch(() => toast("Couldn't export", "error")); } }, iconEl("download", 13), "CSV");

  host.append(card({ title: "Subscribers", action: h("div", { class: "sb-toolbar" }, planSel, stateSel, search, csv), body: rows.length ? dataTable<Sub>({
    columns: [
      { head: "Subscriber", cell: (s) => h("div", null, h("strong", null, s.name || "—"), s.email ? h("div", { class: "bv-muted" }, s.email) : null, s.is_gift ? pill("gift", "accent") : null) },
      { head: "State", cell: (s) => pill(s.state, s.state === "active" ? "ok" : s.state === "paused" ? "warn" : s.state === "awaiting" ? "accent" : s.state === "past_due" ? "bad" : "bad") },
      { head: "Renews", cell: (s) => s.next_renewal ? h("div", null, h("span", null, fmtDate(s.next_renewal)), s.skip_next ? h("div", { class: "bv-muted" }, "skips next") : s.prepaid_cycles ? h("div", { class: "bv-muted" }, `${s.prepaid_cycles} prepaid`) : null) : h("span", { class: "bv-muted" }, "—") },
      { head: "Cycles", num: true, cell: (s) => String(s.cycles) },
    ],
    rows,
    rowActions: (s) => h("div", { class: "sb-row-actions" },
      s.state === "active" ? h("button", { class: "ghost sm", onClick: () => sendRenewal(s) }, "Renewal") : null,
      s.state === "active" ? h("button", { class: "ghost sm", onClick: () => setState(s, { state: "paused" }) }, "Pause") : null,
      s.state === "active" ? h("button", { class: "ghost sm", onClick: () => setState(s, { skip_next: !s.skip_next }) }, s.skip_next ? "Unskip" : "Skip") : null,
      s.state === "paused" ? h("button", { class: "ghost sm", onClick: () => setState(s, { state: "active" }) }, "Resume") : null,
      s.portal_url ? h("button", { class: "ghost sm", onClick: () => { navigator.clipboard?.writeText(s.portal_url!); flash("Portal link copied", "success"); } }, iconEl("copy", 13)) : null,
      (s.state === "active" || s.state === "paused" || s.state === "past_due") ? h("button", { class: "ghost sm", onClick: () => { if (confirm("Cancel this subscription?")) setState(s, { state: "cancelled" }); } }, iconEl("trash", 13)) : null),
  }) : emptyState({ icon: "inbox", title: "No subscribers", text: "Share a plan link to start signing people up." }) }));
}

async function setState(s: Sub, patch: any) {
  try { await bvApi(`/api/subscribers/${s.id}`, { method: "PATCH", body: JSON.stringify(patch) }); shell.select("subscribers"); }
  catch (err: any) { toast(err?.message || "error", "error"); }
}
async function sendRenewal(s: Sub) {
  try { const r = await bvApi<{ payment_url: string; sent: boolean }>(`/api/subscribers/${s.id}/renew`, { method: "POST" }); flash(r.sent ? "Renewal link emailed" : "Renewal link created", "success"); if (!r.sent && r.payment_url) navigator.clipboard?.writeText(r.payment_url); shell.select("subscribers"); }
  catch (err: any) { toast(err?.message || "error", "error"); }
}

/* ---------------------------------------------------------------- Analytics */
async function renderAnalytics(host: HTMLElement) {
  host.append(h("div", { class: "bv-muted", style: { padding: "12px 2px" } }, "Loading…"));
  let a: Analytics;
  try { a = await bvApi("/api/analytics"); }
  catch (err: any) { host.innerHTML = ""; host.append(emptyState({ icon: "alert", title: "Couldn't load", text: err?.message })); return; }
  host.innerHTML = "";
  host.append(statRow([
    { k: "MRR", v: fmtMoney(a.mrr, currency), tone: "accent", icon: "coins" },
    { k: "Active", v: String(a.active), tone: "ok", icon: "users" },
    { k: "Churn rate", v: `${a.churn_rate}%`, tone: a.churn_rate > 10 ? "bad" : undefined, icon: "chart" },
    { k: "Avg lifetime", v: `${a.avg_lifetime_cycles} cycles`, icon: "clock" },
  ]));
  if (a.past_due) host.append(h("div", { class: "sb-note bv-muted" }, iconEl("alert", 14), `${a.past_due} subscriber${a.past_due === 1 ? "" : "s"} past due — dunning auto-retries, then cancels after 3 fails.`));
  host.append(card({ title: "MRR by plan", body: a.by_plan.length ? dataTable<any>({
    columns: [
      { head: "Plan", cell: (p) => h("strong", null, p.name) },
      { head: "Active subs", num: true, cell: (p) => String(p.active) },
      { head: "MRR", num: true, cell: (p) => fmtMoney(p.mrr, currency) },
    ], rows: a.by_plan,
  }) : emptyState({ icon: "chart", title: "No data yet", text: "MRR appears once you have active subscribers." }) }));
}

function field(label: string, el: HTMLElement) { return h("label", { class: "sb-field" }, h("span", { class: "bv-label" }, label), el); }
function fieldColor(label: string, el: HTMLElement) { return h("label", { class: "sb-field sb-field-color" }, h("span", { class: "bv-label" }, label), el); }
function fatal(msg?: string) { return h("div", { class: "bv-empty", style: { margin: "40px auto" } }, h("h3", null, "Subscription Boxes couldn't load"), h("p", null, msg || "Open this app from the Inkress dashboard.")); }
