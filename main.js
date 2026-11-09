// Project HQ: full-page project dashboard for Obsidian. Each page is one entry in SECTIONS: {id, label, icon, render(view, el)}.
const { Plugin, Notice, ItemView, PluginSettingTab, Setting, requestUrl, TFile, TFolder, setIcon, MarkdownRenderer, parseYaml } = require("obsidian");
const fs = require("fs"), path = require("path"), os = require("os");
const { execFile } = require("child_process");
const VIEW = "project-hq-view";
const STALL_MIN = 90;
// Active project configuration (set by setConfig from the settings). An empty string means "not configured": that tile hides.
let ACT = "", TODO = "", REVIEW = "", DAILY = "", GIT = "", MCMD = "", MCWD = "", BASE = "", NEXTH = "Next", WAITH = /^Waiting on/i, LIVE_RE = null, EXCL = null;
let PROJ = path.join(os.homedir(), ".claude", "projects");
const escRe = (x) => String(x).replace(/[.*+?^$\{}()|[\]\\]/g, "\\$&");
const mkRe = (x) => { try { return x && String(x).trim() ? new RegExp(x, "i") : null; } catch (e) { return null; } };
const absP = (p) => !p ? "" : path.isAbsolute(p) ? p : path.join(BASE, p);
const nice = (k) => String(k).replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
function setConfig(pr, g) {
  pr = pr || {}; g = g || {};
  ACT = (pr.agents || "").trim(); TODO = (pr.todo || "").trim(); REVIEW = (pr.review || "").trim().replace(/\/+$/, ""); DAILY = (pr.daily || "").trim().replace(/\/+$/, "");
  GIT = (pr.repo || "").trim(); MCMD = (pr.metricsCmd || "").trim(); MCWD = (pr.metricsCwd || "").trim();
  NEXTH = (pr.nextHead || "").trim() || "Next";
  const who = (g.person || "").trim();
  WAITH = new RegExp("^" + escRe((pr.waitHead || "").trim() || "Waiting on") + (who ? "\\s+" + escRe(who) : ""), "i");
  LIVE_RE = mkRe(pr.liveRe); EXCL = mkRe(g.excludeRe);
  PROJ = (g.claudeDir || "").trim() || path.join(os.homedir(), ".claude", "projects");
}
const SECTION_ON = { todo: () => !!TODO, needs: () => !!TODO, view: () => !!REVIEW, numbers: () => !!DAILY };
const sectionOn = (id) => !SECTION_ON[id] || SECTION_ON[id]();
const chicago = (d) => (d || new Date()).toLocaleDateString("en-CA");
const fmtN = (n) => n === null || n === undefined ? "n/a" : Number(n).toLocaleString();
const money = (n) => n === null || n === undefined ? "n/a" : "$" + Number(n).toLocaleString();
function spark(el, vals) {
  const v = vals.filter((x) => typeof x === "number");
  const svg = document.createElementNS(svgNS, "svg"); svg.setAttribute("viewBox", "0 0 100 28"); svg.classList.add("lhq-spark");
  if (v.length) {
    const lo = Math.min(...v), hi = Math.max(...v), rng = hi - lo || 1, n = vals.length;
    const pts = vals.map((x, i) => typeof x === "number" ? [n === 1 ? 50 : 4 + (i * 92) / (n - 1), 24 - ((x - lo) / rng) * 20] : null).filter(Boolean);
    if (pts.length > 1) { const p = document.createElementNS(svgNS, "polyline"); p.setAttribute("points", pts.map((q) => q.join(",")).join(" ")); svg.appendChild(p); }
    const last = pts[pts.length - 1], c = document.createElementNS(svgNS, "circle"); c.setAttribute("cx", last[0]); c.setAttribute("cy", last[1]); c.setAttribute("r", 2.6); svg.appendChild(c);
  }
  el.appendChild(svg);
}
const EXT = { video: ["mp4", "webm"], image: ["png", "jpg", "jpeg", "gif", "webp"], pdf: ["pdf"], md: ["md"] };
const mediaKind = (f) => { const e = (f.extension || "").toLowerCase(); return Object.keys(EXT).find((k) => EXT[k].includes(e)) || null; };

const when = (iso) => { const d = new Date(iso), n = new Date(); const t = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).replace(" ", "").toLowerCase(); return d.toDateString() === n.toDateString() ? t : d.toLocaleDateString([], { weekday: "short" }) + " " + t; };
const left = (iso) => { let m = Math.max(0, Math.round((new Date(iso) - Date.now()) / 60000)); const d = Math.floor(m / 1440); m -= d * 1440; const h = Math.floor(m / 60); m -= h * 60; return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`; };
const col = (p) => p >= 90 ? "var(--color-red)" : p >= 75 ? "var(--color-orange)" : p >= 50 ? "var(--color-yellow)" : "var(--color-green)";
const clean = (s) => (s || "").replace(/[\u{1F300}-\u{1FAFF}☀-➿️]/gu, "").replace(/\*\*|`/g, "").trim();
const ymd = (d) => d.toLocaleDateString("en-CA");

function ageMin(s) {
  const m = /(\d+):(\d+)\s*([AP]M)/i.exec(s || ""); if (!m) return Infinity;
  let h = +m[1] % 12; if (/p/i.test(m[3])) h += 12;
  const t = new Date(); t.setHours(h, +m[2], 0, 0);
  let d = (Date.now() - t) / 60000; if (d < 0) d += 1440; return d;
}
const agoText = (m) => !isFinite(m) ? "" : m < 1 ? "just now" : m < 60 ? Math.round(m) + "m ago" : Math.floor(m / 60) + "h " + Math.round(m % 60) + "m ago";

function parseAgents(md) {
  const out = [];
  for (const line of md.split("\n")) {
    if (!line.startsWith("|")) continue;
    const c = line.split("|").slice(1, -1).map((x) => x.trim());
    if (c.length < 5 || c[0] === "Agent" || /^-+$/.test(c[0])) continue;
    const working = /working/i.test(c[1]), age = ageMin(c[4]);
    out.push({ name: c[0], state: working ? (age > STALL_MIN ? "stalled" : "working") : "idle", task: c[2], last: c[3], updated: c[4], age });
  }
  const rank = { working: 0, stalled: 1, idle: 2 };
  return out.sort((a, b) => rank[a.state] - rank[b.state] || a.age - b.age);
}

// To-Do parsing: keeps line numbers so checkboxes can be written back.
function parseTodo(md) {
  const lines = md.split("\n"), sec = {}; let cur = null;
  lines.forEach((l, i) => { const h = /^## (.*)/.exec(l); if (h) { cur = h[1].trim(); sec[cur] = { start: i, end: lines.length }; } else if (cur && /^## /.test(lines[i])) { } });
  const names = Object.keys(sec); names.forEach((n, k) => { if (names[k + 1]) sec[n].end = sec[names[k + 1]].start; });
  const live = LIVE_RE ? LIVE_RE.exec(lines.slice(0, 12).join("\n")) : null;
  const next = [], wait = [];
  const nk = names.find((n) => n.toLowerCase().startsWith(NEXTH.toLowerCase())), wk = names.find((n) => WAITH.test(n));
  if (nk) for (let i = sec[nk].start + 1; i < sec[nk].end; i++) { const m = /^(\d+[a-z]?)\.\s\[( |x)\]\s(.*)/i.exec(lines[i]); if (!m) continue; const subs = []; let j = i + 1; while (j < sec[nk].end && /^\s+\S/.test(lines[j])) { subs.push(lines[j].trim().replace(/^[-*]\s+/, "")); j++; } next.push({ line: i, num: m[1], done: m[2] !== " ", text: m[3], subs }); }
  if (wk) for (let i = sec[wk].start + 1; i < sec[wk].end; i++) {
    const m = /^- \[( |x)\]\s(.*)/i.exec(lines[i]); if (!m) continue;
    const steps = []; let j = i + 1;
    while (j < sec[wk].end && /^\s+\S/.test(lines[j])) { steps.push(lines[j].trim()); j++; }
    wait.push({ line: i, done: m[1] !== " ", text: m[2], steps });
  }
  return { live: live ? clean(live[1] !== undefined ? live[1] : live[0]).replace(/\.\s*$/, "") : "", next, wait };
}

// Move done items (one, or all) out of "Next, in order" into "Done (recent)" as one-line summaries. Undo = edit the note.
async function archiveDone(app, onlyLine) {
  const f = app.vault.getAbstractFileByPath(TODO); if (!f) return 0; let moved = 0;
  await app.vault.process(f, (md) => {
    const L = md.split("\n"), hs = []; L.forEach((l, i) => { if (/^## /.test(l)) hs.push(i); });
    const nS = L.findIndex((l) => new RegExp("^## " + escRe(NEXTH), "i").test(l)); if (nS < 0) return md;
    const nE = hs.find((h) => h > nS) ?? L.length;
    const keep = [], out = [];
    for (let i = nS + 1; i < nE; ) {
      const m = /^(\d+[a-z]?)\.\s\[(x)\]\s(.*)/i.exec(L[i]);
      let j = i + 1; if (/^\d+[a-z]?\.\s\[/.test(L[i])) while (j < nE && /^\s+\S/.test(L[j])) j++;
      if (m && (onlyLine === undefined || onlyLine === i)) { out.push("- [x] " + m[1] + ". " + clean(m[3]).slice(0, 140)); moved++; }
      else for (let k = i; k < j; k++) keep.push(L[k]);
      i = j;
    }
    if (!moved) return md;
    const res = [...L.slice(0, nS + 1), ...keep, ...L.slice(nE)];
    let d = res.findIndex((l) => /^## Done/i.test(l));
    if (d < 0) { res.push("", "## Done (recent)"); d = res.length - 1; }
    res.splice(d + 1, 0, ...out);
    return res.join("\n");
  });
  return moved;
}

async function fetchUsage() {
  const cred = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude", ".credentials.json"), "utf8"));
  const tok = cred.claudeAiOauth && cred.claudeAiOauth.accessToken;
  if (!tok) throw new Error("Not signed in to Claude");
  const r = await requestUrl({ url: "https://api.anthropic.com/api/oauth/usage", headers: { Authorization: "Bearer " + tok, "anthropic-beta": "oauth-2025-04-20" }, throw: false });
  if (r.status === 401) throw new Error("Sign-in expired. Send Claude any message, then refresh.");
  if (r.status !== 200) throw new Error("Usage unavailable (" + r.status + ")");
  return r.json;
}

function fetchCommits(repo) {
  return new Promise((resolve) => {
    if (!repo) return resolve({});
    execFile("git", ["-C", absP(repo), "log", "--since=7.days", "--format=%ad", "--date=short"], { timeout: 8000, windowsHide: true }, (err, out) => {
      const m = {}; if (!err) out.split("\n").filter(Boolean).forEach((d) => { m[d] = (m[d] || 0) + 1; });
      resolve(m);
    });
  });
}


// ---- Live agent watcher: ~/.claude/projects/*/<session>/subagents/agent-*.meta.json (+ .jsonl) ----
const fsp = fs.promises;
const liveCache = new Map();
function hint(inp) {
  if (!inp) return "";
  const v = inp.description || inp.file_path || inp.path || inp.pattern || inp.command || inp.url || inp.query || inp.prompt || "";
  let t = String(v).replace(/\s+/g, " ");
  if (inp.file_path || inp.path) t = t.split(/[\\/]/).pop();
  return t.slice(0, 70);
}
async function readRange(file, from, len) {
  const fh = await fsp.open(file, "r");
  try { const b = Buffer.alloc(len); const { bytesRead } = await fh.read(b, 0, len, from); return b.toString("utf8", 0, bytesRead); } finally { await fh.close(); }
}
async function scanOne(metaFile, now) {
  const base = metaFile.replace(/\.meta\.json$/, ""), jf = base + ".jsonl";
  let ms, js = null;
  try { ms = await fsp.stat(metaFile); } catch (e) { return null; }
  try { js = await fsp.stat(jf); } catch (e) {}
  const mtime = js ? js.mtimeMs : ms.mtimeMs;
  if (now - mtime > 864e5) return null;
  const c = liveCache.get(metaFile) || {};
  if (c.mtime === mtime && c.metaM === ms.mtimeMs && c.out) return c.out;
  let meta = {}; try { meta = JSON.parse(await fsp.readFile(metaFile, "utf8")); } catch (e) {}
  let steps = c.steps || [], count = c.count || 0, off = c.off || 0, start = c.start;
  const bgStarted = new Set(c.bgStarted || []), bgDone = new Set(c.bgDone || []);
  if (js) {
    if (start === undefined) { const head = await readRange(jf, 0, 4096); const m = /"timestamp":"([^"]+)"/.exec(head); start = m ? Date.parse(m[1]) : js.birthtimeMs; }
    if (js.size < off) { off = 0; count = 0; bgStarted.clear(); bgDone.clear(); }
    if (js.size > off) { const chunk = await readRange(jf, off, js.size - off); count += (chunk.match(/"type":"tool_use"/g) || []).length; off = js.size;
      // background shells (test runs): started IDs vs completion notices, so an agent waiting on tests still counts as running
      // Background shells ("running in background with ID: x") and Monitor watchers ("Monitor started (task x") both mean the agent is still waiting on work.
      for (const m of chunk.matchAll(/(?:running in background with ID: |Monitor started \(task )([a-z0-9]+)/g)) bgStarted.add(m[1]);
      for (const m of chunk.matchAll(/task-id(?:>|\u003e)([a-z0-9]+)/g)) bgDone.add(m[1]); }
    const tailLen = Math.min(32768, js.size), tail = await readRange(jf, js.size - tailLen, tailLen);
    const lines = tail.split("\n"); if (js.size > tailLen) lines.shift();
    steps = [];
    for (const l of lines) {
      if (!l.includes('"assistant"')) continue;
      let o; try { o = JSON.parse(l); } catch (e) { continue; }
      const ct = o.message && o.message.content; if (o.type !== "assistant" || !Array.isArray(ct)) continue;
      for (const b of ct) {
        if (b.type === "tool_use") steps.push({ kind: "tool", name: b.name, hint: hint(b.input) });
        else if (b.type === "text" && b.text && b.text.trim()) steps.push({ kind: "text", text: b.text.replace(/\s+/g, " ").trim().slice(0, 120) });
      }
    }
  }
  if (start === undefined) start = ms.birthtimeMs;
  const lastTool = [...steps].reverse().find((x) => x.kind === "tool"), lastText = [...steps].reverse().find((x) => x.kind === "text");
  const out = { jf: js ? jf : "", id: path.basename(base), type: meta.agentType || "agent", title: meta.description || meta.agentType || "agent", model: meta.model || "", finished: meta.finished === true, waiting: [...bgStarted].filter((x) => !bgDone.has(x)).length, mtime, start, count, tool: lastTool || null, text: lastText ? lastText.text : "", steps: steps.slice(-8) };
  liveCache.set(metaFile, { mtime, metaM: ms.mtimeMs, steps, count, off, start, bgStarted: [...bgStarted], bgDone: [...bgDone], out });
  return out;
}
async function scanAgents() {
  const now = Date.now(), files = [];
  let dirs = []; try { dirs = await fsp.readdir(PROJ); } catch (e) { return []; }
  for (const d of dirs) {
    if (EXCL && EXCL.test(d)) continue;
    let sess = []; try { sess = await fsp.readdir(path.join(PROJ, d), { withFileTypes: true }); } catch (e) { continue; }
    for (const s of sess) {
      if (!s.isDirectory()) continue;
      const sub = path.join(PROJ, d, s.name, "subagents");
      let fl = []; try { fl = await fsp.readdir(sub); } catch (e) { continue; }
      fl.filter((f) => /^agent-.*\.meta\.json$/.test(f)).forEach((f) => files.push(path.join(sub, f)));
    }
  }
  const res = (await Promise.all(files.map((f) => scanOne(f, now).catch(() => null)))).filter(Boolean);
  res.forEach((a) => { const fresh = now - a.mtime < 3 * 3600000; if (a.waiting && fresh) { a.status = "running"; a.text = "Waiting on " + a.waiting + " background run(s) (tests/build)"; } else a.status = a.finished ? "done" : now - a.mtime < 3600000 ? "running" : "stalled"; }); // agents waiting on long test runs write nothing for many minutes; only call them stalled after an hour of silence
  return res.sort((a, b) => b.mtime - a.mtime);
}
const dur = (ms) => { const s = Math.max(0, Math.round(ms / 1000)), m = Math.floor(s / 60); return m >= 60 ? Math.floor(m / 60) + "h " + (m % 60) + "m" : m ? m + "m " + (s % 60) + "s" : s + "s"; };
const stepText = (x) => x.kind === "tool" ? x.name + (x.hint ? " · " + x.hint : "") : x.text;

const svgNS = "http://www.w3.org/2000/svg";
function landscape(el) {
  const s = document.createElementNS(svgNS, "svg"); s.setAttribute("viewBox", "0 0 800 300"); s.setAttribute("preserveAspectRatio", "xMidYMax slice"); s.classList.add("lhq-land");
  s.innerHTML = '<defs><radialGradient id="lhqsun" cx="72%" cy="38%" r="55%"><stop offset="0" style="stop-color:color-mix(in srgb,var(--amber) 60%,#fff)" stop-opacity=".85"/><stop offset=".35" style="stop-color:var(--amber)" stop-opacity=".3"/><stop offset="1" style="stop-color:var(--amber)" stop-opacity="0"/></radialGradient>' +
    '<linearGradient id="lhqsky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--sky1)"/><stop offset="1" style="stop-color:var(--sky2)"/></linearGradient></defs>' +
    '<rect width="800" height="300" fill="url(#lhqsky)"/><rect width="800" height="300" fill="url(#lhqsun)"/>' +
    '<path d="M0 200 L90 140 L170 190 L270 110 L380 195 L470 130 L580 200 L680 120 L800 190 V300 H0Z" style="fill:var(--m1)" opacity=".75"/>' +
    '<path d="M0 235 L110 185 L210 230 L320 170 L440 235 L560 180 L690 240 L800 205 V300 H0Z" style="fill:var(--m2)" opacity=".9"/>' +
    '<path d="M0 270 L130 240 L260 275 L400 240 L540 280 L680 245 L800 270 V300 H0Z" style="fill:var(--m3)"/>';
  el.appendChild(s);
}


function reviewCard(v, p, it) {
  const c = p.createDiv({ cls: "lhq-rcard st-" + it.status });
  const h = c.createDiv({ cls: "lhq-top" });
  h.createDiv({ cls: "lhq-name", text: it.title, title: it.title });
  const chips = h.createDiv({ cls: "lhq-chips" }); if (it.fm.kind) chips.createSpan({ text: String(it.fm.kind) }); chips.createSpan({ cls: "lhq-stc", text: it.status });
  const body = c.createDiv({ cls: "lhq-rbody" });
  it.files.forEach((f) => {
    const k = mediaKind(f), src = v.app.vault.getResourcePath(f);
    if (k === "video") body.createEl("video", { cls: "lhq-media", attr: { controls: "", preload: "metadata", src } });
    else if (k === "image") { const im = body.createEl("img", { cls: "lhq-media", attr: { src, alt: it.title } }); im.onclick = () => { const lb = v.contentEl.createDiv({ cls: "lhq-lb" }); lb.createEl("img", { attr: { src } }); lb.onclick = () => lb.remove(); }; }
    else if (k === "pdf") { const a = body.createEl("button", { cls: "lhq-btn", text: "Open " + f.name }); a.onclick = () => v.app.workspace.getLeaf("tab").openFile(f); }
    else if (k === "md") { const m = body.createDiv({ cls: "lhq-md" }); v.app.vault.read(f).then((t) => MarkdownRenderer.render(v.app, t.replace(/^---\n[\s\S]*?\n---\n?/, ""), m, f.path, v)); }
  });
  if (it.body.trim()) { const d = c.createDiv({ cls: "lhq-md" }); MarkdownRenderer.render(v.app, it.body, d, it.sidecar ? it.sidecar.path : "", v); }
  if (it.fm.note) c.createDiv({ cls: "lhq-muted", text: String(it.fm.note) });
  if (it.fm.feedback) c.createDiv({ cls: "lhq-line", text: "Feedback: " + it.fm.feedback });
  const bar = c.createDiv({ cls: "lhq-acts" });
  const act = (label, cls, fn) => { const b = bar.createEl("button", { cls: "lhq-btn " + cls, text: label }); b.onclick = fn; return b; };
  act("Approve", "ok", () => v.decide(it, "approved", ""));
  // The Changes box keeps its open state and typed text across redraws (v.fbOpen / v.fbText, keyed per item),
  // and keystrokes stay inside it so Obsidian hotkeys don't swallow them.
  const key = it.key || it.title; v.fbOpen = v.fbOpen || new Set(); v.fbText = v.fbText || {};
  const ta = c.createEl("textarea", { cls: "lhq-fb", attr: { placeholder: "What should change?", rows: "3" } });
  const send = c.createEl("button", { cls: "lhq-btn", text: "Send changes" });
  ta.value = v.fbText[key] || "";
  const showFb = (on) => { ta.style.display = on ? "" : "none"; send.style.display = on ? "" : "none"; };
  showFb(v.fbOpen.has(key));
  ta.addEventListener("input", () => { v.fbText[key] = ta.value; v.touchedAt = Date.now(); });
  ta.addEventListener("keydown", (e) => e.stopPropagation());
  act("Changes", "ch", () => { const on = !v.fbOpen.has(key); on ? v.fbOpen.add(key) : v.fbOpen.delete(key); showFb(on); if (on) setTimeout(() => ta.focus(), 0); });
  send.onclick = async () => { await v.decide(it, "changes", ta.value); v.fbOpen.delete(key); delete v.fbText[key]; };
  act("Reject", "no", () => v.decide(it, "rejected", ""));
}

// ===== Insights: agent progress, files, cache clock, rule cards, action items (all deterministic, no LLM, read-only on transcripts) =====
// One shared 3 s poll (HQView.insTick) that only runs while HQ is visible. Transcripts are tailed with byte offsets, never re-read.
const RULES_PATH = "Claude'sWorkspace/Rules.md", PLAYBOOK_PATH = "Claude'sWorkspace/LumenAds/Notes/Marketing Playbook.md";
const CACHE_TTL_MIN = 60, CACHE_WARN_MIN = 50, COMPACT_AT = 150000;
// ESTIMATE ONLY: API list prices in USD per million tokens (in = input, out = output, cr = cache read, c5/c1 = cache write 5 min / 1 h). Edit here.
const PRICES = { opus: { in: 5, out: 25, cr: 0.5, c5: 6.25, c1: 10 }, sonnet: { in: 3, out: 15, cr: 0.3, c5: 3.75, c1: 6 }, haiku: { in: 1, out: 5, cr: 0.1, c5: 1.25, c1: 2 } };
const family = (m) => { m = String(m || "").toLowerCase(); return m.includes("opus") ? "opus" : m.includes("haiku") ? "haiku" : m.includes("sonnet") ? "sonnet" : ""; };
const shortModel = (m) => String(m || "").replace(/^claude-/, "").replace(/-\d{8}$/, "");
function usageCost(u, model) {
  const p = PRICES[family(model)]; if (!u || !p) return 0;
  const cc = u.cache_creation || {}, c1 = cc.ephemeral_1h_input_tokens || 0, c5 = cc.ephemeral_5m_input_tokens !== undefined ? cc.ephemeral_5m_input_tokens : Math.max(0, (u.cache_creation_input_tokens || 0) - c1);
  return ((u.input_tokens || 0) * p.in + (u.output_tokens || 0) * p.out + (u.cache_read_input_tokens || 0) * p.cr + c5 * p.c5 + c1 * p.c1) / 1e6;
}
const kfmt = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1000 ? Math.round(n / 1000) + "k" : String(Math.round(n || 0));
const usd = (n) => n < 0.01 ? "<$0.01" : "$" + (n < 10 ? n.toFixed(2) : n.toFixed(1));

// Secrets never reach the screen: redact common key formats and long opaque strings from anything shown out of a transcript.
const SECRET_RES = [[/\b(?:ak|sk|pk|rk)[-_][A-Za-z0-9_-]{8,}/g, "[redacted]"], [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, "[redacted]"], [/\bAIza[\w-]{16,}/g, "[redacted]"], [/\bxox[abprs]-[\w-]{8,}/g, "[redacted]"], [/\bAKIA[0-9A-Z]{12,}/g, "[redacted]"], [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, "Bearer [redacted]"], [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{4,}/g, "[redacted]"], [/((?:key|token|secret|passw(?:or)?d|pwd|auth)\w*["']?\s*[:=]\s*["']?)[A-Za-z0-9+/_=-]{16,}/gi, "$1[redacted]"], [/\b[0-9a-f]{32,}\b/gi, "[redacted]"], [/(?<![\w/\\.])[A-Za-z0-9+/]{40,}={0,2}(?![\w/\\.])/g, "[redacted]"]];
const redact = (s) => SECRET_RES.reduce((t, [re, to]) => t.replace(re, to), String(s || ""));
const sensitivePath = (p) => /personal|PWs\.md|\.env\b|credentials/i.test(p || "");
const djb = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };

async function readBuf(file, from, len) {
  const fh = await fsp.open(file, "r");
  try { const b = Buffer.alloc(len); const { bytesRead } = await fh.read(b, 0, len, from); return b.subarray(0, bytesRead); } finally { await fh.close(); }
}
// Reads only complete new lines after st.off (advancing the offset to the last newline) and hands each to fn.
async function tailLines(file, st, fn, startAt) {
  let size; try { size = (await fsp.stat(file)).size; } catch (e) { return false; }
  if (st.off === undefined) { st.off = startAt ? Math.max(0, size - startAt) : 0; st.skipFirst = st.off > 0; }
  if (size < st.off) { st.off = 0; st.skipFirst = false; st.reset = true; }
  let moved = false;
  while (size > st.off) {
    const len = Math.min(8 * 1048576, size - st.off), buf = await readBuf(file, st.off, len), nl = buf.lastIndexOf(10);
    if (nl < 0) { if (len < 8 * 1048576) break; st.off += len; continue; } // one enormous line: skip it
    const lines = buf.subarray(0, nl).toString("utf8").split("\n");
    if (st.skipFirst) { lines.shift(); st.skipFirst = false; }
    for (const l of lines) if (l) fn(l);
    st.off += nl + 1; moved = true;
  }
  return moved;
}

// ----- per-agent stats (tokens, cost, tool calls, files) -----
const insCache = new Map();
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
function agentLine(st, l) {
  if (!l.includes('"role":"assistant"') || !l.includes('"type":"assistant"')) return;
  let o; try { o = JSON.parse(l); } catch (e) { return; }
  const m = o.message; if (!m || o.type !== "assistant") return;
  st.lastTs = Date.parse(o.timestamp) || st.lastTs;
  if (m.model && m.model !== "<synthetic>") st.model = m.model;
  if (m.usage && m.id) {
    const old = st.ids.get(m.id), cost = usageCost(m.usage, m.model);
    if (old) { st.tin -= old.i; st.tout -= old.o; st.tcr -= old.r; st.tcc -= old.c; st.cost -= old.cost; }
    const e = { i: m.usage.input_tokens || 0, o: m.usage.output_tokens || 0, r: m.usage.cache_read_input_tokens || 0, c: m.usage.cache_creation_input_tokens || 0, cost };
    st.ids.set(m.id, e); st.tin += e.i; st.tout += e.o; st.tcr += e.r; st.tcc += e.c; st.cost += cost;
  }
  for (const b of (Array.isArray(m.content) ? m.content : [])) {
    if (b.type === "text" && b.text && b.text.trim()) st.lastText = b.text.slice(0, 6000);
    if (b.type !== "tool_use") continue;
    st.tools++; const inp = b.input || {}, t = Date.parse(o.timestamp) || Date.now();
    const touch = (p, op) => { if (!p || typeof p !== "string") return; const k = p.replace(/\\/g, "/"), f = st.files.get(k); if (f && f.committed && op === "read") return; st.files.delete(k); st.files.set(k, { p, op: f && f.op === "edit" && op === "read" ? "edit" : op, t, committed: f && op === "read" ? f.committed : false }); if (st.files.size > 150) st.files.delete(st.files.keys().next().value); };
    if (EDIT_TOOLS.has(b.name)) touch(inp.file_path || inp.notebook_path, "edit");
    else if (b.name === "Read") touch(inp.file_path, "read");
    else if (b.name === "Grep") touch(inp.path, "read");
    else if ((b.name === "Bash" || b.name === "PowerShell") && /\bgit\s+(-C\s+\S+\s+)?commit\b/.test(inp.command || "")) st.files.forEach((f) => { if (f.op === "edit") f.committed = true; });
  }
}
async function agentStats(jf) {
  let size; try { size = (await fsp.stat(jf)).size; } catch (e) { return null; }
  let st = insCache.get(jf);
  if (!st || size < st.off) { st = { ids: new Map(), tin: 0, tout: 0, tcr: 0, tcc: 0, cost: 0, tools: 0, files: new Map(), model: "", lastText: "", lastTs: 0 }; insCache.set(jf, st); }
  await tailLines(jf, st, (l) => agentLine(st, l));
  return st;
}

// ----- main chat: cache clock, context size and Hayden's typed messages -----
const mainState = { file: "", findAt: 0, st: {}, asst: [], typed: [], ts: 0, usage: null, model: "" };
async function findMainFile() {
  if (Date.now() - mainState.findAt < 20000 && mainState.file) return mainState.file;
  mainState.findAt = Date.now(); let best = null, bt = 0, dirs = []; try { dirs = await fsp.readdir(PROJ); } catch (e) { return mainState.file; }
  for (const d of dirs) {
    if (EXCL && EXCL.test(d)) continue;
    let fl = []; try { fl = await fsp.readdir(path.join(PROJ, d)); } catch (e) { continue; }
    for (const f of fl) if (f.endsWith(".jsonl")) { try { const s = await fsp.stat(path.join(PROJ, d, f)); if (s.mtimeMs > bt) { bt = s.mtimeMs; best = path.join(PROJ, d, f); } } catch (e) {} }
  }
  return best || mainState.file;
}
const NOTE_TAG = /\n\s*<(?:current_note|editor_selection|context_files|browser_selection|canvas_selection|selected_text|system-reminder|ide_|!\[CDATA)/;
function typedText(o) {
  const m = o.message; if (!m || o.isMeta || o.isSidechain || o.promptSource === "system" || o.turnOrigin === "system") return "";
  let t = m.content; if (Array.isArray(t)) { if (t.some((b) => b.type === "tool_result")) return ""; t = t.filter((b) => b.type === "text").map((b) => b.text).join("\n"); }
  if (typeof t !== "string") return ""; t = t.split(NOTE_TAG)[0].trim();
  if (!t || /^</.test(t) || /^\[Request interrupted/.test(t) || /^Caveat:/.test(t) || t.length > 700) return "";
  return t;
}
// Corrections and standing rules: strong phrases anywhere, "no" only as an opening word.
const RULE_RE = /\b(never|always|from now on|don'?t|do not|dont|stop|i wish|make sure|lets? not|let'?s not|shouldn'?t|should not|no more|instead of)\b|^\s*no\b[\s,.!]/i;
function mainLine(l) {
  if (l.includes('"role":"assistant"') && l.includes('"type":"assistant"') && !l.includes('"tool_result"')) { mainState.asst.push(l); if (mainState.asst.length > 4) mainState.asst.shift(); return; }
  if (!l.includes('"type":"user"') || l.includes('"tool_result"') || l.length > 300000) return;
  let o; try { o = JSON.parse(l); } catch (e) { return; }
  if (o.type !== "user") return;
  const t = typedText(o); if (!t || t.length < 10 || !RULE_RE.test(t)) return;
  mainState.typed.push({ id: String(o.uuid || djb(t)), ts: Date.parse(o.timestamp) || 0, text: redact(t) });
  if (mainState.typed.length > 120) mainState.typed.shift();
}
async function mainTick() {
  const f = await findMainFile(); if (!f) return false;
  if (f !== mainState.file) Object.assign(mainState, { file: f, st: {}, asst: [], typed: [], usage: null, ts: 0 });
  const moved = await tailLines(f, mainState.st, mainLine, 6 * 1048576);
  if (moved || !mainState.usage) for (let i = mainState.asst.length - 1; i >= 0; i--) {
    try { const o = JSON.parse(mainState.asst[i]), m = o.message; if (m && m.usage && m.model !== "<synthetic>") { mainState.usage = m.usage; mainState.model = m.model || ""; mainState.ts = Date.parse(o.timestamp) || mainState.ts; break; } } catch (e) {}
  }
  return moved;
}
function cacheInfo() {
  const u = mainState.usage; if (!u || !mainState.ts) return null;
  const age = (Date.now() - mainState.ts) / 60000, ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  const state = age >= CACHE_TTL_MIN ? "cold" : age >= CACHE_WARN_MIN ? "warn" : "warm";
  const left = Math.max(0, Math.ceil(CACHE_TTL_MIN - age));
  const msg = state === "cold" ? "Cache cold: your next message re-reads the whole chat (~" + kfmt(ctx) + " tokens)" : state === "warn" ? "Cache going cold in " + left + " min" : "Cache warm · " + left + " min left";
  return { age, ctx, state, msg, compact: ctx > COMPACT_AT, cost: usageCost({ input_tokens: ctx }, mainState.model) };
}

// ----- action items from agents' final reports -----
const ACTION_CATS = [
  ["need", "Needs you", /\b(hayden|you need to|needs your|need your|waiting on|please check|your call|your approval|your decision)\b/i],
  ["money", "Money", /\$\s?\d|\b(paid|credits?|billing|invoice)\b/i],
  ["sec", "Security", /\b(security|secrets?|keys?|passwords?|vulnerab\w*)\b/i],
  ["fail", "Problem", /\b(failed|failing|fail|blocked|errors?|failures?)\b/i],
];
const ACTION_SKIP = /\b0 (failed|fail|failures?|errors?|vulnerabilities)\b|\bno (errors?|failures?|vulnerabilit\w+|issues)\b|\bwithout errors?\b|\b0 high\b|^\|?[-: |]+$/i;
function actionItems(text, src) {
  const out = [];
  for (const raw of String(text || "").split(/\n+/)) {
    const line = redact(raw.replace(/^[\s>*\-#]+/, "").replace(/^\d+[.)]\s+/, "").replace(/[*`_]/g, "").replace(/\s+/g, " ").trim());
    if (line.length < 14 || ACTION_SKIP.test(line)) continue;
    const c = ACTION_CATS.find((x) => x[2].test(line)); if (!c) continue;
    out.push({ id: "a:" + djb(line.toLowerCase().replace(/[^a-z0-9]+/g, " ")), cat: c[0], label: c[1], text: line.length > 220 ? line.slice(0, 217) + "…" : line, src });
    if (out.length >= 4) break;
  }
  return out;
}
let outCache = { at: 0, files: [] };
async function taskOutputs() { // Temp\claude\<id>\<session>\tasks\*.output (JSONL for agents)
  if (Date.now() - outCache.at < 30000) return outCache.files;
  const res = [], root = path.join(os.tmpdir(), "claude"); outCache.at = Date.now();
  try {
    for (const a of await fsp.readdir(root)) for (const s of await fsp.readdir(path.join(root, a)).catch(() => [])) {
      const td = path.join(root, a, s, "tasks"); for (const f of await fsp.readdir(td).catch(() => [])) if (f.endsWith(".output")) { const fp = path.join(td, f), st = await fsp.stat(fp).catch(() => null); if (st && Date.now() - st.mtimeMs < 864e5) res.push({ fp, size: st.size, m: st.mtimeMs }); }
    }
  } catch (e) {}
  outCache.files = res.sort((a, b) => b.m - a.m).slice(0, 40); return outCache.files;
}
const outText = new Map();
async function lastReportOf(o) {
  let c = outText.get(o.fp); if (c && c.size === o.size) return c.text;
  let text = ""; try {
    const len = Math.min(96 * 1024, o.size), tail = (await readBuf(o.fp, o.size - len, len)).toString("utf8").split("\n");
    if (!/^\s*\{/.test(tail[tail.length > 1 ? 1 : 0] || "")) text = ""; // plain shell output: skipped (test logs are noise)
    else for (let i = tail.length - 1; i >= 0 && !text; i--) { if (!tail[i].includes('"role":"assistant"')) continue; try { const m = JSON.parse(tail[i]).message; text = (m.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n"); } catch (e) {} }
  } catch (e) {}
  outText.set(o.fp, { size: o.size, text }); return text;
}

// ----- saving rules (append only) -----
const todayStr = () => new Date().toLocaleDateString("en-CA");
function ruleSection(t) {
  const hits = [[/\b(browser|chrome|brave)\b/i, "Browser Rules"], [/\b(vault|personal|outside the workspace)\b/i, "Vault Boundaries"], [/\b(token|tokens|usage|compact|context window)\b/i, "Token Efficiency"], [/\b(agents?|subagents?|deploys?|deployment)\b/i, "Agent Team"]].filter(([re]) => re.test(t));
  return hits.length === 1 ? hits[0][1] : "Inbox (to sort)";
}
function insertInSection(data, heading, bullet, beforeChangelog) {
  const nl = data.includes("\r\n") ? "\r\n" : "\n", lines = data.split(/\r?\n/), h = heading.toLowerCase();
  const hi = lines.findIndex((l) => /^##\s/.test(l) && l.replace(/^##\s+/, "").trim().toLowerCase().startsWith(h));
  if (hi < 0) {
    const at = beforeChangelog ? lines.findIndex((l) => /^##\s+Changelog/i.test(l)) : -1;
    if (at >= 0) lines.splice(at, 0, "## " + heading, "", bullet, "");
    else { while (lines.length && !lines[lines.length - 1].trim()) lines.pop(); lines.push("", "## " + heading, "", bullet, ""); }
  } else {
    let e = hi + 1; while (e < lines.length && !/^##\s/.test(lines[e])) e++;
    while (e > hi + 1 && !lines[e - 1].trim()) e--;
    lines.splice(e, 0, bullet);
  }
  return lines.join(nl);
}
async function appendTo(app, rel, section, text, isRules) {
  const bullet = "- " + text.replace(/\s+/g, " ").trim() + " (Added " + todayStr() + ")";
  let f = app.vault.getAbstractFileByPath(rel);
  if (!(f instanceof TFile)) { if (isRules) throw new Error(rel + " not found"); f = await app.vault.create(rel, "# Marketing Playbook\n"); }
  await app.vault.process(f, (d) => insertInSection(d, section, bullet, isRules && /^inbox/i.test(section)));
}

// ----- the Insights page -----
const catCls = { need: "need", money: "money", sec: "sec", fail: "fail" };
function insPanel(v, el, id, title, count) {
  const d = el.createEl("details", { cls: "lhq-ins" }); d.open = !v.insClosed.has(id); d.ontoggle = () => { d.open ? v.insClosed.delete(id) : v.insClosed.add(id); };
  const s = d.createEl("summary"); s.createSpan({ text: title }); if (count !== undefined && count !== "") s.createSpan({ cls: "lhq-cnt", text: String(count) });
  return d.createDiv({ cls: "lhq-insb" });
}
function openPath(v, p) {
  const base = (BASE || "").replace(/\\/g, "/").toLowerCase(), q = p.replace(/\\/g, "/");
  if (sensitivePath(q)) return;
  if (q.toLowerCase().startsWith(base + "/")) { const f = v.app.vault.getAbstractFileByPath(q.slice(base.length + 1)); if (f instanceof TFile) { v.app.workspace.getLeaf("tab").openFile(f); return; } } // keepFilesBesideHQ moves it next to HQ
  try { require("electron").shell.showItemInFolder(p.replace(/\//g, path.sep)); } catch (e) { new Notice("Not in the vault: " + p); }
}
function renderInsights(v, el, only) {
  const W = (k) => !only || only.includes(k);
  const now = Date.now(), run = v.live.filter((a) => a.status === "running"), recent = v.live.filter((a) => a.status === "done" && now - a.mtime < 30 * 60000);
  // action strip
  const acts = v.insActions();
  if (W("actions")) { const b = insPanel(v, el, "actions", "Action items", acts.length);
    if (!acts.length) b.createDiv({ cls: "lhq-muted", text: "Nothing flagged in agent reports." });
    const strip = b.createDiv({ cls: "lhq-astrip" });
    acts.slice(0, 12).forEach((a) => { const c = strip.createDiv({ cls: "lhq-achip " + catCls[a.cat] }); c.createSpan({ cls: "lhq-ak", text: a.label }); const t = c.createSpan({ cls: "lhq-at2", text: a.text }); t.title = a.text; c.createSpan({ cls: "lhq-asrc", text: a.src }); const x = c.createSpan({ cls: "lhq-x", text: "×" }); x.title = "Dismiss"; x.onclick = () => v.insHandle(a.id, "dismissed"); }); }
  // cache
  if (W("cache")) { const ci = cacheInfo(), b = insPanel(v, el, "cache", "Chat cache", ci ? ci.state : "");
    if (!ci) b.createDiv({ cls: "lhq-muted", text: "No main chat found yet." });
    else {
      const m = b.createDiv({ cls: "lhq-cache " + ci.state }); m.createDiv({ cls: "lhq-cmsg", text: ci.msg });
      b.createDiv({ cls: "lhq-muted", text: "Last reply " + agoText(ci.age) + " · context ~" + kfmt(ci.ctx) + " tokens · cache lasts " + CACHE_TTL_MIN + " min" });
      if (ci.compact) b.createDiv({ cls: "lhq-line", text: "The chat is large (" + kfmt(ci.ctx) + "). Consider running /compact." });
    } }
  // agent progress
  if (W("progress")) { const b = insPanel(v, el, "progress", "Agent progress", run.length + " running");
    const list = run.concat(recent).slice(0, 10); let tot = 0;
    if (!list.length) b.createDiv({ cls: "lhq-muted", text: "No agents running." });
    list.forEach((a) => {
      const st = a.st, done = a.status !== "running", c = b.createDiv({ cls: "lhq-pcard" + (done ? " done" : "") });
      const h = c.createDiv({ cls: "lhq-top" }); h.createDiv({ cls: "lhq-name", text: a.title, title: a.title });
      const ch = h.createDiv({ cls: "lhq-chips" }); ch.createSpan({ text: a.type }); const mm = shortModel(st && st.model || a.model); if (mm) ch.createSpan({ text: mm }); if (done) ch.createSpan({ text: "Done" });
      const bar = c.createDiv({ cls: "lhq-pbar" + (done ? " done" : " run") }); bar.createEl("i");
      const row = run.filter((x) => x.type === a.type).length === 1 ? v.agents.find((x) => x.name === a.type && x.state !== "idle") : null; // board rows are per agent type, so only trust them when one agent of that type runs
      c.createDiv({ cls: "lhq-psub", text: redact(row && row.task ? clean(row.task) : a.tool ? stepText(a.tool) : "starting…").slice(0, 140) });
      const m = c.createDiv({ cls: "lhq-meta" });
      const el1 = m.createSpan({ cls: done ? "" : "lhq-el", text: dur((done ? a.mtime : now) - a.start) }); if (!done) el1.dataset.start = a.start;
      m.createSpan({ text: (st ? st.tools : a.count) + " tool calls" });
      if (st) { tot += st.cost; m.createSpan({ text: "in " + kfmt(st.tin) + " · out " + kfmt(st.tout) + " · cache " + kfmt(st.tcr + st.tcc) }); const e = m.createSpan({ cls: "lhq-est", text: "~" + usd(st.cost) + " est." }); e.title = "Estimate from API list prices, not your plan's billing"; }
    });
    if (list.length) b.createDiv({ cls: "lhq-muted", text: "Costs are rough estimates from API list prices (subscription use is not billed per token)." }); }
  // files
  if (W("files")) { const withFiles = run.filter((a) => a.st && a.st.files.size).slice(0, 5), b = insPanel(v, el, "files", "Files in play", withFiles.reduce((n, a) => n + Math.min(6, a.st.files.size), 0));
    if (!withFiles.length) b.createDiv({ cls: "lhq-muted", text: "No running agent has touched files yet." });
    withFiles.forEach((a) => {
      b.createDiv({ cls: "lhq-fg", text: a.title });
      [...a.st.files.values()].filter((f) => !sensitivePath(f.p)).reverse().slice(0, 6).forEach((f) => {
        const live = now - f.t < 90000, kind = f.committed ? "committed" : f.op === "edit" ? (live ? "editing" : "edited") : (now - f.t < 120000 ? "reading" : "read");
        const r = b.createDiv({ cls: "lhq-frow " + kind }); r.createSpan({ cls: "lhq-fdot" });
        const nm = r.createSpan({ cls: "lhq-fn", text: f.p.split(/[\\/]/).pop() }); nm.title = f.p;
        r.createSpan({ cls: "lhq-fd", text: f.p.split(/[\\/]/).slice(-3, -1).join("/") }); r.createSpan({ cls: "lhq-fk", text: kind });
        r.onclick = () => openPath(v, f.p);
      });
    }); }
  // rule cards
  if (W("rules")) { const cards = v.insRules(), b = insPanel(v, el, "rules", "Save as rule", cards.length);
    if (!cards.length) b.createDiv({ cls: "lhq-muted", text: "No new corrections or standing rules spotted in your messages." });
    v.insText = v.insText || {};
    cards.slice(0, 6).forEach((c) => {
      const card = b.createDiv({ cls: "lhq-rule" }); card.createDiv({ cls: "lhq-muted", text: when(new Date(c.ts).toISOString()) });
      const ta = card.createEl("textarea", { cls: "lhq-fb", attr: { rows: "3", "aria-label": "Rule text" } }); ta.style.display = "";
      ta.value = v.insText[c.id] !== undefined ? v.insText[c.id] : c.text;
      ta.addEventListener("input", () => { v.insText[c.id] = ta.value; v.touchedAt = Date.now(); }); ta.addEventListener("keydown", (e) => e.stopPropagation());
      const bar = card.createDiv({ cls: "lhq-acts" }), sec = ruleSection(ta.value);
      const btn = (label, cls, fn, tip) => { const x = bar.createEl("button", { cls: "lhq-btn " + cls, text: label }); if (tip) x.title = tip; x.onclick = fn; };
      btn("Save to Rules.md", "ok", () => v.insSave(c, ta.value, "rules"), "Appends under: " + sec);
      btn("Save to Marketing Playbook", "ch", () => v.insSave(c, ta.value, "playbook"), "Appends under: Inbox (to sort)");
      btn("Dismiss", "no", () => v.insHandle(c.id, "dismissed"));
    });
    if (cards.length > 6) b.createDiv({ cls: "lhq-muted", text: "+" + (cards.length - 6) + " more" });
    if (cards.length) { const all = b.createEl("button", { cls: "lhq-btn", text: "Dismiss all" }); all.onclick = () => v.insHandleMany(cards.map((c) => c.id), "dismissed"); } }
}

const col2 = (p) => p >= 90 ? "var(--color-red)" : p >= 75 ? "var(--color-orange)" : p >= 50 ? "var(--color-yellow)" : "var(--color-green)";
const SECTIONS = [
  {
    id: "home", label: "Home", icon: "layout-dashboard",
    render(v, el) {
      // week strip
      const strip = el.createDiv({ cls: "lhq-week" });
      const days = el.createDiv(); days.addClass("lhq-days"); strip.appendChild(days);
      for (let i = 6; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate() - i);
        const n = v.commits[ymd(d)] || 0, p = days.createDiv({ cls: "lhq-day" + (i === 0 ? " today" : "") });
        p.createDiv({ cls: "lhq-dn", text: d.toLocaleDateString([], { weekday: "short" }) });
        p.createDiv({ cls: "lhq-dd", text: String(d.getDate()) });
        const dots = p.createDiv({ cls: "lhq-dots" }); for (let k = 0; k < Math.min(n, 4); k++) dots.createSpan();
        p.title = n + (n === 1 ? " commit" : " commits");
      }
      const stats = strip.createDiv({ cls: "lhq-stats" });
      const st = (a, b) => { const x = stats.createDiv({ cls: "lhq-stat" }); x.createDiv({ cls: "lhq-sk", text: a }); x.createDiv({ cls: "lhq-sv", text: b }); };
      if (TODO) st("Needs you", v.needsCount() + " items"); st("Agents", v.workingCount() + " working");
      // dense 3-column dashboard
      const dash = el.createDiv({ cls: "lhq-dash" });
      const col = (cls) => dash.createDiv({ cls: "lhq-col " + cls });
      const pane = (p, cls, title, page) => {
        const t = p.createDiv({ cls: "lhq-tile " + cls }); const h = t.createDiv({ cls: "lhq-th" });
        const a = h.createSpan({ text: title }); if (page) { a.addClass("lnk"); a.onclick = () => v.show(page); }
        return { t, h, body: t.createDiv({ cls: "lhq-tb" }) };
      };
      const openAt = (line) => { const f = v.app.vault.getAbstractFileByPath(TODO); if (f) v.app.workspace.getLeaf("tab").openFile(f, { eState: { line } }); };
      const c1 = col("c1"), c2 = col("c2"), c3 = col("c3");
      v.fixCols = () => { const cs = [c1, c2, c3]; cs.filter((c) => !c.children.length).forEach((c) => c.remove()); const n = cs.filter((c) => c.parentElement).length; if (!c1.parentElement) dash.addClass("noplan"); if (n < 3) dash.style.setProperty("--cols", "repeat(" + Math.max(n, 1) + ", 1fr)"); };
      // PLAN
      if (TODO) {
        const P = pane(c1, "plan", "Plan", "todo"), items = v.todo.next, now = items.find((n) => !n.done);
        const nDone = items.filter((i) => i.done).length;
        if (nDone) { const cb = P.h.createEl("button", { cls: "lhq-clr", text: "Clear done (" + nDone + ")" }); cb.title = "Move finished items to Done (recent) in the To-Do note"; cb.onclick = async (e) => { e.stopPropagation(); await archiveDone(v.app); v.loadFiles(); }; }
        const title = (it, p) => {
          const txt = it.text, m = /^\*\*(.+?)\*\*(.*)$/.exec(txt), head = m ? m[1] : txt, rest = m ? m[2] : "";
          const tt = p.createSpan({ cls: "lhq-pt", text: clean(head) }); tt.title = "Open in note"; tt.onclick = (e) => { e.stopPropagation(); openAt(it.line); };
          if (rest.trim()) p.createSpan({ cls: "lhq-pr", text: " " + clean(rest) });
        };
        const subs = (it, p, big) => {
          if (!it.subs.length) return; const w = p.createDiv({ cls: "lhq-subs" });
          const open = v.planOpen.has(it.line); const shown = open ? it.subs : it.subs.slice(0, 3);
          shown.forEach((x) => w.createDiv({ cls: "lhq-sb" + (open ? " open" : ""), text: clean(x) }));
          if (!open && it.subs.length > 3) w.createDiv({ cls: "lhq-sb more", text: "+" + (it.subs.length - 3) + " more" });
        };
        if (now) {
          const n = P.body.createDiv({ cls: "lhq-now" + (v.planOpen.has(now.line) ? " open" : "") });
          n.createDiv({ cls: "lhq-nk", text: "NOW · " + now.num });
          const tl = n.createDiv({ cls: "lhq-ptxt" }); title(now, tl); subs(now, n);
          n.onclick = () => { v.planOpen.has(now.line) ? v.planOpen.delete(now.line) : v.planOpen.add(now.line); v.renderPage(); };
        }
        const list = P.body.createDiv({ cls: "lhq-plist" });
        items.filter((i) => i !== now).forEach((it) => {
          const r = list.createDiv({ cls: "lhq-pi" + (it.done ? " done" : "") + (v.planOpen.has(it.line) ? " open" : "") });
          r.createSpan({ cls: "lhq-pn", text: it.num });
          const b = r.createDiv({ cls: "lhq-pb" }); const tl = b.createDiv({ cls: "lhq-ptxt" }); title(it, tl);
          if (!it.done) subs(it, b);
          else { const x = r.createSpan({ cls: "lhq-x", text: "×" }); x.title = "Remove from plan (moves to Done)"; x.onclick = async (e) => { e.stopPropagation(); await archiveDone(v.app, it.line); v.loadFiles(); }; }
          r.onclick = () => { v.planOpen.has(it.line) ? v.planOpen.delete(it.line) : v.planOpen.add(it.line); v.renderPage(); };
        });
        if (!items.length) P.body.createDiv({ cls: "lhq-muted", text: "No items found." });
      }
      // AGENTS
      {
        const A = pane(c2, "agt", "Agents", "agents"), run = v.live.filter((a) => a.status === "running"), rec = v.live.filter((a) => a.status !== "running").slice(0, 3);
        A.h.createSpan({ cls: "lhq-cnt", text: run.length + " running" });
        if (!run.length) A.body.createDiv({ cls: "lhq-muted", text: "No agents running" });
        run.forEach((a) => {
          const r = A.body.createDiv({ cls: "lhq-arow" }); r.createSpan({ cls: "lhq-pring sm" });
          const b = r.createDiv({ cls: "lhq-ab" }); b.createDiv({ cls: "lhq-at", text: a.title, title: a.title });
          b.createDiv({ cls: "lhq-as", text: a.tool ? stepText(a.tool) : "starting…" });
          const e = r.createSpan({ cls: "lhq-el lhq-ae", text: dur(Date.now() - a.start) }); e.dataset.start = a.start;
        });
        if (rec.length) A.body.createDiv({ cls: "lhq-sep" });
        rec.forEach((a) => { const r = A.body.createDiv({ cls: "lhq-rrow" }); r.createSpan({ cls: "lhq-rs " + a.status, text: a.status === "done" ? "done" : "stalled" }); r.createSpan({ cls: "lhq-rt", text: a.title, title: a.title }); r.createSpan({ cls: "lhq-rg", text: agoText((Date.now() - a.mtime) / 60000) }); });
      }
      // NEEDS YOU
      if (TODO) {
        const open = v.todo.wait.filter((w) => !w.done), N = pane(c2, "need", "Needs you", "needs");
        N.h.createSpan({ cls: "lhq-cnt", text: String(open.length) });
        if (!open.length) N.body.createDiv({ cls: "lhq-muted", text: "Nothing waiting" });
        open.forEach((w) => {
          const r = N.body.createDiv({ cls: "lhq-nrow" }), cb = r.createEl("input", { type: "checkbox" });
          cb.onchange = () => v.tick(w.line, w.text, cb.checked);
          const t = r.createSpan({ cls: "lhq-nt", text: clean(w.text) }); t.title = w.steps.length ? w.steps.map((x) => clean(x)).join("\n") : clean(w.text);
        });
      }
      // USAGE
      {
        const U = pane(c3, "use", "Usage", "usage"), rings = U.body.createDiv({ cls: "lhq-rings" });
        [["Session 5h", v.usage && v.usage.five_hour], ["Week", v.usage && v.usage.seven_day]].forEach(([l, x]) => {
          const p = Math.round((x && x.utilization) || 0), b = rings.createDiv({ cls: "lhq-g sm" });
          const r = b.createDiv({ cls: "lhq-ring sm" }); r.style.background = "conic-gradient(" + col2(p) + " " + Math.min(100, p) * 3.6 + "deg, rgba(255,255,255,.1) 0)";
          const n = r.createSpan({ text: p + "%" }); n.style.color = col2(p); b.createDiv({ cls: "lhq-gs", text: l });
          b.createDiv({ cls: "lhq-gs dim", text: x && x.resets_at ? "in " + left(x.resets_at) : "" });
        });
      }
      // NUMBERS
      if (DAILY) {
        const M = pane(c3, "num", "Numbers", "numbers"), d = v.days, cur = d.length ? d[d.length - 1].fm : {}, ser = (k) => d.map((x) => x.fm[k]);
        const row = (label, val, key, extra) => { const r = M.body.createDiv({ cls: "lhq-mrow" }); r.createSpan({ cls: "lhq-ml", text: label }); const vv = r.createSpan({ cls: "lhq-mv", text: val }); if (extra) { vv.empty(); extra(vv); } const sp = r.createSpan({ cls: "lhq-msp" }); if (key) spark(sp, ser(key)); };
        const keys = Object.keys(cur).filter((k) => k !== "updated" && (typeof cur[k] === "number" || typeof cur[k] === "boolean")).slice(0, 12);
        keys.forEach((k) => {
          if (typeof cur[k] === "boolean") row(nice(k), "", null, (e) => { e.addClass("lhq-pcl"); if (cur[k]) e.addClass("on"); e.createSpan({ cls: "lhq-light" }); e.createSpan({ text: cur[k] ? "yes" : "no" }); });
          else row(nice(k), fmtN(cur[k]), k);
        });
        if (!keys.length) M.body.createDiv({ cls: "lhq-muted", text: "No metrics yet" });
      }
      // TO REVIEW
      if (REVIEW) {
        const rv = v.review.filter((i) => i.status === "needs-review"), R = pane(c3, "rev", "To review", "view");
        R.h.createSpan({ cls: "lhq-cnt", text: String(rv.length) });
        const th = R.body.createDiv({ cls: "lhq-thumbs" });
        if (!rv.length) th.createSpan({ cls: "lhq-muted", text: "Nothing to review" });
        rv.slice(0, 4).forEach((i) => { const f = i.files[0]; if (f && mediaKind(f) === "image") th.createEl("img", { attr: { src: v.app.vault.getResourcePath(f), alt: i.title } }); else th.createSpan({ cls: "lhq-thumb", text: f ? (mediaKind(f) || "file") : "md" }); });
      }
      v.fixCols();
    },
  },
  {
    id: "agents", label: "Agents", icon: "bot",
    render(v, el) {
      const run = v.live.filter((a) => a.status === "running"), rec = v.live.filter((a) => a.status !== "running");
      const now = Date.now();
      const hd = (t, n) => { const h = el.createDiv({ cls: "lhq-sec-h" }); h.createSpan({ text: t }); h.createSpan({ text: String(n) }); };
      hd("Live", run.length);
      const lg = el.createDiv({ cls: "lhq-live" });
      if (!run.length) lg.createDiv({ cls: "lhq-muted", text: "No agents running right now." });
      run.forEach((a) => {
        const open = v.openSet.has(a.id), c = lg.createDiv({ cls: "lhq-lcard" + (open ? " open" : "") });
        c.onclick = () => { open ? v.openSet.delete(a.id) : v.openSet.add(a.id); v.renderPage(); };
        const hr = c.createDiv({ cls: "lhq-lhead" }); hr.createDiv({ cls: "lhq-pring" });
        const tt = hr.createDiv({ cls: "lhq-ltt" }); tt.createDiv({ cls: "lhq-ltitle", text: a.title });
        const chips = tt.createDiv({ cls: "lhq-chips" }); chips.createSpan({ text: a.type }); if (a.model) chips.createSpan({ text: a.model });
        const m = c.createDiv({ cls: "lhq-meta" });
        const el1 = m.createSpan({ cls: "lhq-el", text: dur(now - a.start) }); el1.dataset.start = a.start;
        m.createSpan({ text: a.count + " tool uses" });
        const st = c.createDiv({ cls: "lhq-step" });
        st.createSpan({ cls: "lhq-sx", text: a.tool ? stepText(a.tool) : "starting…" });
        const td = st.createSpan({ cls: "lhq-typing" }); td.createSpan(); td.createSpan(); td.createSpan();
        if (a.text) c.createDiv({ cls: "lhq-line", text: a.text });
        if (open) { const tl = c.createDiv({ cls: "lhq-tl" }); a.steps.forEach((x) => { const r = tl.createDiv({ cls: "lhq-tls " + x.kind }); r.createSpan({ cls: "lhq-tlk", text: x.kind === "tool" ? "›" : "“" }); r.createSpan({ text: stepText(x) }); }); }
      });
      hd("Recent (24h)", rec.length);
      const rg = el.createDiv({ cls: "lhq-grid" });
      rec.forEach((a) => {
        const c = rg.createDiv({ cls: "lhq-card " + (a.status === "done" ? "idle" : "stalled") });
        c.createDiv({ cls: "lhq-av", text: (a.type || "?").charAt(0).toUpperCase() });
        const b = c.createDiv(); const top = b.createDiv({ cls: "lhq-top" });
        top.createDiv({ cls: "lhq-name", text: a.title, title: a.title });
        const s2 = top.createDiv({ cls: "lhq-st" }); s2.createSpan({ cls: "lhq-dot" }); s2.createSpan({ text: a.status === "done" ? "Done" : "Stalled" });
        b.createDiv({ cls: "lhq-last", text: a.type + (a.model ? " · " + a.model : "") + " · " + a.count + " tools · " + dur(a.mtime - a.start) });
        b.createDiv({ cls: "lhq-ago", text: agoText((now - a.mtime) / 60000) });
      });
      if (!rec.length) rg.createDiv({ cls: "lhq-muted", text: "Nothing in the last 24h." });
      if (ACT) {
      const d = el.createEl("details", { cls: "lhq-board" }); d.open = v.boardOpen; d.ontoggle = () => { v.boardOpen = d.open; };
      d.createEl("summary", { text: "Team board (" + v.agents.length + ")" });
      const g3 = d.createDiv({ cls: "lhq-list" });
      v.agents.forEach((a) => g3.createDiv({ cls: "lhq-item" + (a.state === "idle" ? " done" : "") }).createSpan({ cls: "lhq-it", text: a.name + " · " + a.state + " · " + clean(a.task).slice(0, 90) + " · " + a.updated }));
      }
    },
  },
  {
    id: "needs", label: "Needs you", icon: "bell",
    render(v, el) {
      const grid = el.createDiv({ cls: "lhq-grid" });
      if (!v.todo.wait.length) grid.createDiv({ cls: "lhq-muted", text: "Nothing waiting on you." });
      v.todo.wait.forEach((w) => {
        const c = grid.createDiv({ cls: "lhq-card lhq-need" + (w.done ? " done" : "") });
        const cb = c.createEl("input", { type: "checkbox" }); cb.checked = w.done; cb.setAttr("aria-label", "Mark done");
        cb.onchange = () => v.tick(w.line, w.text, cb.checked);
        const b = c.createDiv(); b.createDiv({ cls: "lhq-needt", text: clean(w.text) });
        if (w.steps.length) { const d = b.createEl("details"); d.createEl("summary", { text: w.steps.length + " steps" }); const ol = d.createDiv({ cls: "lhq-steps" }); w.steps.forEach((s) => ol.createDiv({ text: clean(s) })); }
      });
    },
  },
  {
    id: "usage", label: "Usage", icon: "gauge",
    render(v, el) {
      const h = el.createDiv({ cls: "lhq-row" });
      h.createDiv({ cls: "lhq-muted", text: v.at ? "Updated " + v.at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "Loading…" });
      const b = h.createEl("button", { cls: "lhq-btn", text: "Refresh" }); b.onclick = () => v.loadUsage();
      const wrap = el.createDiv({ cls: "lhq-gauges" });
      [["Session (5h)", v.usage && v.usage.five_hour], ["Week", v.usage && v.usage.seven_day]].forEach(([label, x]) => {
        const p = Math.round((x && x.utilization) || 0), g = wrap.createDiv({ cls: "lhq-g" });
        const ring = g.createDiv({ cls: "lhq-ring" });
        ring.style.background = `conic-gradient(${col(p)} ${Math.min(100, p) * 3.6}deg, rgba(255,255,255,.1) 0)`;
        const n = ring.createSpan({ text: p + "%" }); n.style.color = col(p);
        g.createDiv({ cls: "lhq-gl", text: label });
        g.createDiv({ cls: "lhq-gs", text: x && x.resets_at ? `resets ${when(x.resets_at)} (in ${left(x.resets_at)})` : "" });
      });
      if (v.err) el.createDiv({ cls: "lhq-err", text: v.err });
    },
  },
  {
    id: "todo", label: "To-Do", icon: "list-checks",
    render(v, el) {
      const list = el.createDiv({ cls: "lhq-list" });
      if (!v.todo.next.length) list.createDiv({ cls: "lhq-muted", text: "No items found." });
      v.todo.next.forEach((n) => {
        const r = list.createDiv({ cls: "lhq-item" + (n.done ? " done" : "") });
        r.createSpan({ cls: "lhq-chk", text: n.done ? "✓" : "○" });
        const t = clean(n.text); r.createSpan({ cls: "lhq-it", text: t.length > 160 ? t.slice(0, 160) + "…" : t }); r.title = t;
        r.onclick = () => { const f = v.app.vault.getAbstractFileByPath(TODO); if (f) v.app.workspace.getLeaf("tab").openFile(f); };
      });
    },
  },
  {
    id: "view", label: "View", icon: "eye",
    render(v, el) {
      const tabs = el.createDiv({ cls: "lhq-tabs" });
      [["needs", "Needs review"], ["approved", "Approved"], ["all", "All"]].forEach(([k, l]) => {
        const b = tabs.createEl("button", { cls: "lhq-btn" + (v.rfilter === k ? " on" : ""), text: l }); b.onclick = () => { v.rfilter = k; v.renderPage(false, true); };
      });
      const items = v.review.filter((i) => v.rfilter === "all" || (v.rfilter === "approved" ? i.status === "approved" : i.status === "needs-review"));
      const g = el.createDiv({ cls: "lhq-rgrid" });
      if (!items.length) g.createDiv({ cls: "lhq-muted", text: "Nothing here. Claude drops items in Notes/Review." });
      items.forEach((it) => reviewCard(v, g, it));
    },
  },
  {
    id: "numbers", label: "Numbers", icon: "trending-up",
    render(v, el) {
      const days = v.days, cur = days.length ? days[days.length - 1].fm : {}, ser = (k) => days.map((d) => d.fm[k]);
      const row = el.createDiv({ cls: "lhq-row" });
      const upd = cur.updated ? Math.max(0, Math.round((Date.now() - Date.parse(cur.updated)) / 60000)) : null;
      row.createDiv({ cls: "lhq-muted", text: v.metricsRunning ? "Updating…" : upd === null ? "No data yet" : "Updated " + (upd < 1 ? "just now" : upd + "m ago") });
      if (MCMD) { const rb = row.createEl("button", { cls: "lhq-btn", text: "Refresh" }); rb.onclick = () => v.runMetrics(true); }
      const g = el.createDiv({ cls: "lhq-stiles" });
      const tile = (label, big, sub, key) => { const t = g.createDiv({ cls: "lhq-stile" }); t.createDiv({ cls: "lhq-sk", text: label }); t.createDiv({ cls: "lhq-sbig", text: big }); if (sub) t.createDiv({ cls: "lhq-sub", text: sub }); if (key) spark(t, ser(key)); return t; };
      const keys = Object.keys(cur).filter((k) => k !== "updated" && (typeof cur[k] === "number" || typeof cur[k] === "boolean"));
      keys.forEach((k) => {
        if (typeof cur[k] === "boolean") { const t = g.createDiv({ cls: "lhq-stile" }); t.createDiv({ cls: "lhq-sk", text: nice(k) }); const b = t.createDiv({ cls: "lhq-sbig lhq-pcl" + (cur[k] ? " on" : "") }); b.createSpan({ cls: "lhq-light" }); b.createSpan({ text: cur[k] ? "Yes" : "No" }); }
        else tile(nice(k), fmtN(cur[k]), "", k);
      });
      if (!keys.length) g.createDiv({ cls: "lhq-muted", text: "No numeric metrics in the latest daily note yet." });
    },
  },
  { id: "insights", label: "Insights", icon: "activity", render: renderInsights },
];

// Whole-dashboard colour themes: page gradient (bg), panels (teal), muted text (tx2), landscape sky + 3 mountain layers (m), matching accent.
const THEMES = [
  { id: "teal", name: "Teal", bg: ["#0a1f22", "#102e30", "#0c2124"], teal: ["#0d2a2d", "#14393b"], tx2: "#9db5b1", sky: ["#0b2a2e", "#1d4a48"], m: ["#17413f", "#0f2f31", "#0a1d20"], accent: "#f5b83d" },
  { id: "ember", name: "Ember", bg: ["#1c1510", "#2b1f14", "#1a130d"], teal: ["#24190d", "#3a2812"], tx2: "#c4b49a", sky: ["#2a1a0e", "#4a2e16"], m: ["#3d2814", "#2a1b0d", "#1a1008"], accent: "#ff8a3d" },
  { id: "midnight", name: "Midnight", bg: ["#0b1022", "#141c3a", "#0a0f1f"], teal: ["#111833", "#1b2550"], tx2: "#9fa8cc", sky: ["#0d1430", "#25305e"], m: ["#1e2850", "#141c3a", "#0a0f20"], accent: "#748ffc" },
  { id: "ocean", name: "Ocean", bg: ["#071a2a", "#0c2a42", "#061624"], teal: ["#0a2236", "#12324e"], tx2: "#9cb8cc", sky: ["#082238", "#1a4a6e"], m: ["#144060", "#0c2c44", "#061826"], accent: "#3bc9db" },
  { id: "forest", name: "Forest", bg: ["#0d1a12", "#15291c", "#0b160f"], teal: ["#102016", "#183222"], tx2: "#a3bfa9", sky: ["#102418", "#244a32"], m: ["#1d3d28", "#13291b", "#0a1810"], accent: "#69db7c" },
  { id: "plum", name: "Plum", bg: ["#1a0f1f", "#2a1733", "#160c1a"], teal: ["#22132a", "#33203f"], tx2: "#c0a8c8", sky: ["#22112c", "#4a2a58"], m: ["#3a2246", "#27162f", "#160c1b"], accent: "#e599f7" },
  { id: "wine", name: "Wine", bg: ["#1f0d10", "#331419", "#1a0b0d"], teal: ["#281114", "#3d1a20"], tx2: "#c9a6aa", sky: ["#2a0f14", "#55242c"], m: ["#45202a", "#2e141a", "#1a0a0d"], accent: "#ff6b6b" },
  { id: "graphite", name: "Graphite", bg: ["#121314", "#1d1f21", "#101112"], teal: ["#1a1c1e", "#26292c"], tx2: "#a8adb2", sky: ["#16181a", "#33373b"], m: ["#2c3034", "#1f2225", "#111314"], accent: "#4dabf7" },
  { id: "dusk", name: "Dusk", bg: ["#1e1020", "#3a1a2e", "#160d1a"], teal: ["#2a1426", "#3e1e36"], tx2: "#d0aec0", sky: ["#2a1230", "#7a3a4a"], m: ["#4a2236", "#2e1524", "#170b14"], accent: "#ffa94d" },
];
const ACCENTS = [["Amber", "#f5b83d"], ["Orange", "#ff8a3d"], ["Coral", "#ff6b6b"], ["Rose", "#f06595"], ["Orchid", "#e599f7"], ["Violet", "#9775fa"], ["Indigo", "#748ffc"], ["Sky", "#4dabf7"], ["Cyan", "#3bc9db"], ["Mint", "#38d9a9"], ["Green", "#69db7c"], ["Lime", "#c0eb75"]];
class HQView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; }
  getViewType() { return VIEW; }
  getDisplayText() { return "Project HQ"; }
  applyProject() {
    const st = this.plugin.settings; BASE = this.app.vault.adapter.basePath || "";
    const pr = st.projects.find((p) => p.id === st.last) || st.projects[0] || null;
    this.project = pr; setConfig(pr, st); this.osMode();
    if (this.os) { this.osVars(); return; }
    this.setTheme(this.themeId()); this.setAccent(pr && pr.accent);
  }
  themeId() { const pr = this.project; return (pr && pr.theme) || (this.app.loadLocalStorage && this.app.loadLocalStorage("lhq-alt") ? "ember" : "teal"); }
  setTheme(id) {
    const t = THEMES.find((x) => x.id === id) || THEMES[0], r = this.contentEl;
    const v = { "--bg1": t.bg[0], "--bg2": t.bg[1], "--bg3": t.bg[2], "--teal": t.teal[0], "--teal2": t.teal[1], "--tx2": t.tx2, "--sky1": t.sky[0], "--sky2": t.sky[1], "--m1": t.m[0], "--m2": t.m[1], "--m3": t.m[2] };
    Object.entries(v).forEach(([k, c]) => r.style.setProperty(k, c));
  }
  setAccent(c) {
    const r = this.contentEl; r.style.removeProperty("--amber"); r.style.removeProperty("--amber2");
    if (c) { r.style.setProperty("--amber", c); r.style.setProperty("--amber2", "color-mix(in srgb, " + c + " 75%, #ff5a1f)"); }
  }
  // Colours button: a popover of whole-dashboard themes (background, panels, landscape + matching accent),
  // then accent swatches and a custom colour to fine-tune. Both save on the current project (theme, accent).
  openPicker(anchor) {
    if (this.pick && this.pick.isConnected) return this.closePicker();
    const root = this.contentEl, pr = this.project, pop = root.createDiv({ cls: "lhq-pick" }); this.pick = pop;
    const a = anchor.getBoundingClientRect(), rr = root.getBoundingClientRect();
    pop.style.top = (a.bottom - rr.top + 8) + "px"; pop.style.right = Math.max(8, rr.right - a.right) + "px";
    const save = () => { if (pr) this.plugin.saveSettings(); };
    const mark = (sel, attr, val) => pop.querySelectorAll(sel).forEach((el) => el.toggleClass("on", el.dataset[attr] === val));
    let ci = null;
    const accent = (c, keep) => {
      c = c.toLowerCase(); const def = c === ACCENTS[0][1];
      this.setAccent(def ? null : c); mark(".lhq-sw8", "c", c); if (ci) ci.value = c;
      if (pr) { if (def) delete pr.accent; else pr.accent = c; if (keep) save(); }
    };
    pop.createDiv({ cls: "lhq-pk", text: pr ? "Theme · " + (pr.name || "this project") : "Theme" });
    const tg = pop.createDiv({ cls: "lhq-tgrid" });
    THEMES.forEach((t) => {
      const b = tg.createEl("button", { cls: "lhq-tile", attr: { "aria-label": t.name + " theme", "data-t": t.id } });
      b.createDiv({ cls: "lhq-tprev" }).style.background = "radial-gradient(60% 70% at 75% 30%, " + t.accent + "55, transparent 70%), linear-gradient(180deg, " + t.sky[1] + ", " + t.bg[1] + " 60%, " + t.m[2] + ")";
      b.createSpan({ text: t.name });
      b.onclick = () => { this.setTheme(t.id); mark(".lhq-tile", "t", t.id); if (pr) pr.theme = t.id; accent(t.accent, true); };
    });
    mark(".lhq-tile", "t", this.themeId());
    pop.createDiv({ cls: "lhq-pk", text: "Accent" });
    const g = pop.createDiv({ cls: "lhq-pgrid" });
    ACCENTS.forEach(([name, c]) => { const b = g.createEl("button", { cls: "lhq-sw8", attr: { "aria-label": name, title: name, "data-c": c } }); b.style.background = c; b.onclick = () => accent(c, true); });
    const lab = g.createEl("label", { cls: "lhq-swc", attr: { title: "Custom colour", "aria-label": "Custom colour" } });
    ci = lab.createEl("input", { type: "color" });
    ci.oninput = () => accent(ci.value, false); ci.onchange = () => accent(ci.value, true);
    const cur = ((pr && pr.accent) || ACCENTS[0][1]).toLowerCase(); ci.value = cur; mark(".lhq-sw8", "c", cur);
    const out = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) this.closePicker(); };
    const esc = (e) => { if (e.key === "Escape") { e.stopPropagation(); this.closePicker(); } };
    document.addEventListener("pointerdown", out, true); pop.addEventListener("keydown", esc);
    this.pickOff = () => document.removeEventListener("pointerdown", out, true);
  }
  async onClose() { this.closePicker(); this.osStop(); }
  closePicker() { if (this.pickOff) this.pickOff(); this.pickOff = null; if (this.pick) this.pick.remove(); this.pick = null; }
  resetData() { Object.assign(this, { planOpen: new Set(), days: [], dsig: "", metricsRunning: false, review: [], rsig: "", live: [], liveSig: "", agents: [], todo: { live: "", next: [], wait: [] }, commits: {}, cAt: 0, sig: "", openSet: new Set(), page: "home" }); liveCache.clear(); }
  buildSwitcher() {
    const st = this.plugin.settings; this.sw.empty();
    st.projects.forEach((p) => this.sw.createEl("option", { value: p.id, text: p.name || "Untitled" }));
    this.sw.value = this.project ? this.project.id : ""; this.sw.toggle(st.projects.length > 0);
  }
  buildDock() {
    this.dock.empty(); this.dockBtns = {}; this.badge = null; this.insBadge = null;
    SECTIONS.filter((s) => sectionOn(s.id)).forEach((s) => { const b = this.dock.createEl("button", { cls: "lhq-d" }); setIcon(b, s.icon); b.setAttr("aria-label", s.label); b.title = s.label; b.onclick = () => this.show(s.id); this.dockBtns[s.id] = b; if (s.id === "view") this.badge = b.createSpan({ cls: "lhq-badge zero", text: "0" }); if (s.id === "insights") this.insBadge = b.createSpan({ cls: "lhq-badge zero", text: "0" }); });
  }
  async reload(id) {
    if (id) { this.plugin.settings.last = id; await this.plugin.saveSettings(); }
    this.applyProject(); this.resetData(); this.buildSwitcher(); this.buildDock(); this.show("home"); await this.loadAll();
  }
  async loadAll() { await this.loadFiles(); await this.loadReview(); this.loadDays(); this.runMetrics(false); this.loadLive(); this.loadCommits(true); await this.loadUsage(); }
  getIcon() { return "layout-dashboard"; }
  workingCount() { return this.live.filter((a) => a.status === "running").length; }
  needsCount() { return this.todo.wait.filter((w) => !w.done).length; }
  slides() {
    const out = [], nx = this.todo.next.find((n) => !n.done);
    out.push({ kick: "Now", big: nx ? clean(nx.text).slice(0, 110) : "All clear", sub: "" });
    if (this.todo.live) out.push({ kick: "Last live", big: this.todo.live, sub: "" });
    this.live.filter((a) => a.status === "running").forEach((a) => out.push({ kick: "Agent working", big: a.title.slice(0, 80), sub: a.type + (a.tool ? " · " + stepText(a.tool) : "") }));
    out.push({ kick: "Needs you", big: this.needsCount() + (this.needsCount() === 1 ? " item" : " items"), sub: "Waiting on you" });
    const u = this.usage && this.usage.five_hour;
    out.push({ kick: "Session usage", big: u ? Math.round(u.utilization || 0) + "%" : "—", sub: u && u.resets_at ? `resets ${when(u.resets_at)} (in ${left(u.resets_at)})` : this.err });
    return out;
  }
  async onOpen() {
    this.resetData(); Object.assign(this, { insClosed: new Set(), insActs: [], insSig: "", insActAt: 0, insText: {}, rfilter: "needs", boardOpen: false, liveAt: 0, usage: null, err: "", at: null, slide: 0, showIdle: false });
    this.applyProject();
    const root = this.contentEl; root.empty(); root.addClass("lhq"); root.style.zoom = String((this.plugin.settings.textScale || 125) / 100); // text size setting (Hayden: text was too small)
    const touch = () => { this.touchedAt = Date.now(); };
    this.registerDomEvent(root, "pointerdown", touch, true); this.registerDomEvent(root, "keydown", touch, true); this.registerDomEvent(root, "focusin", touch, true);
    landscape(root.createDiv({ cls: "lhq-bg" }));
    const bar = root.createDiv({ cls: "lhq-bar" });
    this.crumb = bar.createDiv({ cls: "lhq-crumb" });
    this.sw = bar.createEl("select", { cls: "lhq-sw" }); this.sw.onchange = () => this.reload(this.sw.value);
    this.chip = bar.createDiv({ cls: "lhq-livechip" });
    this.cacheChip = bar.createDiv({ cls: "lhq-livechip lhq-cachechip" }); this.cacheChip.hide(); this.cacheChip.onclick = () => this.show("insights");
    const right = bar.createDiv({ cls: "lhq-right" });
    const tm = right.createDiv({ cls: "lhq-time" }); this.clockEl = tm.createDiv({ cls: "lhq-clock" }); this.dateEl = tm.createDiv({ cls: "lhq-date" });
    const ib = (icon, label, fn) => { const b = right.createEl("button", { cls: "lhq-ib" }); setIcon(b, icon); b.setAttr("aria-label", label); b.title = label; b.onclick = () => fn(b); return b; };
    ib("refresh-cw", "Refresh", () => this.refreshAll()); ib("palette", "Colours", (b) => this.openPicker(b));
    this.pageEl = root.createDiv({ cls: "lhq-page" });
    this.dock = root.createDiv({ cls: "lhq-dock" }); this.buildSwitcher(); this.buildDock();
    this.registerEvent(this.app.vault.on("modify", (f) => { if (f.path === ACT || f.path === TODO || (this.project && f.path === this.project.queue)) this.loadFiles(); }));
    this.registerInterval(window.setInterval(() => this.loadFiles(), 10000));
    this.registerEvent(this.app.metadataCache.on("changed", (f) => { if (f.path.startsWith(DAILY + "/")) this.loadDays(); }));
    this.registerInterval(window.setInterval(() => this.runMetrics(false), 3600000));
    const rv = (f) => { if (f.path.startsWith(REVIEW + "/") || f.path === REVIEW) this.loadReview(); };
    ["create", "delete", "rename", "modify"].forEach((e) => this.registerEvent(this.app.vault.on(e, rv)));
    this.registerInterval(window.setInterval(() => this.loadUsage(), 5 * 60 * 1000));
    this.registerInterval(window.setInterval(() => this.loadCommits(), 10 * 60 * 1000));
    // Agents show up instantly: watch the Claude projects folder (recursive; Windows and macOS) and rescan as soon as any
    // subagent file appears or changes. The interval stays as a fallback (5 s on Home, 3 s on the Agents page).
    this.registerInterval(window.setInterval(() => { if (Date.now() - this.liveAt >= (this.page === "agents" ? 2900 : 4900)) this.loadLive(); }, 1000));
    try {
      const w = fs.watch(PROJ, { recursive: true }, (_e, f) => {
        if (!f || !/subagents[\\/]agent-.*\.(meta\.json|jsonl)$/.test(String(f)) || /personal/i.test(String(f))) return;
        clearTimeout(this.watchT); this.watchT = setTimeout(() => { this.liveAt = 0; this.loadLive(); }, 400);
      });
      this.register(() => { try { w.close(); } catch (e) {} clearTimeout(this.watchT); });
    } catch (e) { /* no recursive watch on this platform: the interval still covers it */ }
    this.registerInterval(window.setInterval(() => this.clock(), 1000));
    this.registerInterval(window.setInterval(() => this.osTick(), 1000)); // HQ_OS: the one shared timer (clock, countdown, vitals, sessions)
    this.registerDomEvent(document, "visibilitychange", () => this.osGate());
    this.registerInterval(window.setInterval(() => this.insTick(), 3000)); // one shared throttled poll for the Insights panels; skips work while HQ is hidden
    this.registerInterval(window.setInterval(() => { if (this.page === "home" && !this.hover && this.go && this.slideCount > 1) this.go(this.slide + 1); }, 8000));
    this.clock(); this.show("home");
    this.insTick(true);
    await this.loadAll();
  }
  insHandled() { const s = this.plugin.settings; s.insights = s.insights || {}; s.insights.handled = s.insights.handled || []; return s.insights.handled; }
  async insHandleMany(ids, why) { const h = this.insHandled(); ids.forEach((id) => { if (!h.includes(id)) h.push(id); }); if (h.length > 800) h.splice(0, h.length - 800); await this.plugin.saveSettings(); this.touchedAt = 0; this.insActAt = 0; await this.insTick(true); this.renderPage(false, true); }
  insHandle(id, why) { return this.insHandleMany([id], why); }
  insRules() { const h = new Set(this.insHandled()), cut = Date.now() - 7 * 864e5; return mainState.typed.filter((c) => !h.has(c.id) && c.ts > cut).slice().reverse(); }
  insActions() { return this.insActs; }
  async insSave(c, text, where) {
    text = String(text || "").trim(); if (!text) return;
    try {
      if (where === "rules") await appendTo(this.app, RULES_PATH, ruleSection(text), text, true); else await appendTo(this.app, PLAYBOOK_PATH, "Inbox (to sort)", text, false);
      new Notice("Saved to " + (where === "rules" ? "Rules.md" : "Marketing Playbook")); delete this.insText[c.id]; await this.insHandle(c.id, "saved");
    } catch (e) { console.error("Project HQ save rule", e); new Notice("Could not save: " + (e && e.message || e)); }
  }
  async insActionsUpdate(force) {
    if (!force && Date.now() - this.insActAt < 30000) return; this.insActAt = Date.now();
    const done = new Set(this.insHandled()), seen = new Set(), out = [];
    const add = (text, src) => actionItems(text, src).forEach((a) => { if (!seen.has(a.id) && !done.has(a.id)) { seen.add(a.id); out.push(a); } });
    for (const a of this.live.filter((x) => x.status !== "running" && Date.now() - x.mtime < 864e5 && x.jf).slice(0, 25)) {
      const s = await fsp.stat(a.jf).catch(() => null); if (s) add(await lastReportOf({ fp: a.jf, size: s.size, m: s.mtimeMs }), a.title.slice(0, 40));
    }
    for (const o of (await taskOutputs()).slice(0, 25)) add(await lastReportOf(o), "task " + path.basename(o.fp, ".output"));
    this.insActs = out.slice(0, 30);
  }
  async insTick(force) {
    if (this.insBusy) return;
    if (!force && ((this.contentEl.isShown && !this.contentEl.isShown()) || document.hidden)) return;
    this.insBusy = true;
    try {
      await mainTick();
      const now = Date.now();
      for (const a of this.live) { if (a.jf && (a.status === "running" || (a.status === "done" && now - a.mtime < 30 * 60000))) a.st = await agentStats(a.jf); }
      const fin = this.live.filter((a) => a.status !== "running").length; if (fin !== this.insFin) { this.insFin = fin; this.insActAt = 0; } // a new finished agent: rescan reports now
      await this.insActionsUpdate(force);
      const ci = cacheInfo(), cards = this.insRules();
      if (this.cacheChip) { const show = ci && (ci.state !== "warm" || ci.compact); this.cacheChip.toggle(!!show); if (show) { this.cacheChip.setText(ci.state !== "warm" ? ci.msg : "Context ~" + kfmt(ci.ctx) + ": consider /compact"); this.cacheChip.toggleClass("cold", ci.state === "cold"); this.cacheChip.title = ci.compact ? "Large chat (" + kfmt(ci.ctx) + " tokens): consider /compact" : ci.msg; } }
      if (this.insBadge) { const n = cards.length + this.insActs.length; this.insBadge.setText(String(n)); this.insBadge.toggleClass("zero", !n); }
      const sig = JSON.stringify([ci && [ci.state, ci.msg], cards.map((c) => c.id), this.insActs.map((a) => a.id), this.live.map((a) => [a.id, a.status, a.st && [a.st.tools, a.st.tin + a.st.tout + a.st.tcr, a.st.files.size, [...a.st.files.values()].slice(-3).map((f) => f.op + f.committed + (now - f.t < 90000))]])]);
      if (sig !== this.insSig) { this.insSig = sig; if (this.page === "insights" || this.os) this.renderPage(); }
    } catch (e) { console.error("Project HQ insights", e); } finally { this.insBusy = false; }
  }
  async loadLive() {
    if (this.scanning) return; this.scanning = true; this.liveAt = Date.now();
    try {
      const live = await scanAgents();
      const sig = JSON.stringify(live.map((a) => [a.id, a.status, a.count, a.tool && stepText(a.tool), a.text]));
      this.live = live;
      if (sig !== this.liveSig) { this.liveSig = sig; if (this.page === "agents" || this.page === "home") this.renderPage(); }
    } catch (e) { console.error("Project HQ live", e); } finally { this.scanning = false; }
  }
  clock() {
    const n = new Date();
    this.contentEl.querySelectorAll(".lhq-el").forEach((e) => { e.setText(dur(Date.now() - +e.dataset.start)); });
    this.clockEl.setText(n.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).replace(/\s?[AP]M/i, ""));
    this.dateEl.setText(n.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: "numeric" }));
  }
  show(id) {
    if (!sectionOn(id)) id = "home";
    this.page = id; const s = SECTIONS.find((x) => x.id === id);
    this.contentEl.toggleClass("lhq-onhome", id === "home"); this.pageEl.toggleClass("fit", id === "home");
    Object.entries(this.dockBtns).forEach(([k, b]) => b.toggleClass("on", k === id));
    this.crumb.empty(); this.crumb.createSpan({ cls: "lhq-c1", text: this.project ? this.project.name : "Project HQ" }); this.crumb.createSpan({ cls: "lhq-c2", text: " / " + s.label });
    this.renderPage(true, true);
  }
  renderPage(anim, force) {
    if (this.os && this.project) { try { this.osRender(force); } catch (e) { console.error("Project HQ OS render", e); } return; }
    // The page redraws every few seconds (live agents, files). On the review page a redraw between press and release
    // swallowed Approve/Changes/Reject clicks and wiped typed feedback, so hold redraws there while the user is interacting.
    if (!force && (this.page === "view" || this.page === "insights") && (Date.now() - (this.touchedAt || 0) < 20000 || (document.activeElement && document.activeElement.tagName === "TEXTAREA" && this.contentEl.contains(document.activeElement)))) return;
    { const lv = (this.todo && this.todo.live) || "", b = /batch (\d+)/i.exec(lv), c = /[0-9a-f]{7,}/.exec(lv); this.chip.setText(lv ? "Live: " + (b ? "batch " + b[1] : "") + (b && c ? " · " : "") + (c ? c[0] : "") : ""); this.chip.toggle(!!lv); }
    if (!this.project) { this.pageEl.empty(); const e = this.pageEl.createDiv({ cls: "lhq-empty" }); e.createDiv({ cls: "lhq-big", text: "Welcome to Project HQ" }); e.createDiv({ cls: "lhq-sub", text: "Add your first project in Settings → Project HQ" }); const b = e.createEl("button", { cls: "lhq-btn", text: "Open settings" }); b.onclick = () => { this.app.setting.open(); this.app.setting.openTabById("project-hq"); }; return; }
    const s = SECTIONS.find((x) => x.id === this.page), keep = this.pageEl.scrollTop;
    this.pageEl.empty(); this.pageEl.toggleClass("enter", false);
    s.render(this, this.pageEl.createDiv({ cls: "lhq-pg lhq-pg-" + s.id }));
    if (anim) { void this.pageEl.offsetWidth; this.pageEl.addClass("enter"); } else this.pageEl.scrollTop = keep;
  }
  async loadFiles() {
    try {
      const vt = this.app.vault, a = ACT ? vt.getAbstractFileByPath(ACT) : null, t = TODO ? vt.getAbstractFileByPath(TODO) : null;
      const am = a instanceof TFile ? await vt.read(a) : "", tm = t instanceof TFile ? await vt.read(t) : "";
      const agents = parseAgents(am), todo = parseTodo(tm), secs = parseSecs(tm), qp = this.project && this.project.queue, qf = qp ? vt.getAbstractFileByPath(qp) : null, queue = qf instanceof TFile ? parseQueue(await vt.read(qf)) : null;
      const sig = JSON.stringify([agents.map((x) => [x.name, x.state, x.task, x.last, x.updated]), todo, secs.map((x) => x.items.map((i) => [i.line, i.st, i.text])), queue]);
      this.agents = agents; this.todo = todo; this.secs = secs; this.queue = queue;
      if (sig !== this.sig) { this.sig = sig; this.renderPage(); }
    } catch (e) { console.error("Project HQ files", e); }
  }
  loadDays() {
    const root = DAILY ? this.app.vault.getAbstractFileByPath(DAILY) : null, out = [];
    if (root instanceof TFolder) root.children.filter((f) => f instanceof TFile && /^\d{4}-\d{2}-\d{2}\.md$/.test(f.name)).sort((x, y) => x.name.localeCompare(y.name)).slice(-14).forEach((f) => { const c = this.app.metadataCache.getFileCache(f); out.push({ date: f.basename, fm: (c && c.frontmatter) || {} }); });
    const sig = JSON.stringify(out);
    this.days = out;
    if (sig !== this.dsig) { this.dsig = sig; if (this.page === "numbers" || this.page === "home") this.renderPage(); }
  }
  runMetrics(force) {
    if (this.metricsRunning) return;
    const last = this.days[this.days.length - 1], fresh = last && last.date === chicago() && last.fm.updated && Date.now() - Date.parse(last.fm.updated) < 3600000;
    if (!MCMD) return;
    if (fresh && !force) return;
    if (!MCMD) return;
    const parts = (MCMD.match(/"[^"]*"|\S+/g) || []).map((x) => x.replace(/^"|"$/g, "")), cwd = absP(MCWD) || BASE;
    this.metricsRunning = true; if (this.page === "numbers") this.renderPage();
    execFile(parts[0], parts.slice(1), { cwd, timeout: 120000, windowsHide: true }, (err) => {
      this.metricsRunning = false; if (err) console.error("Project HQ metrics", String(err.message).slice(0, 200));
      setTimeout(() => this.loadDays(), 800);
    });
  }
  async loadReview() {
    const vt = this.app.vault, root = REVIEW ? vt.getAbstractFileByPath(REVIEW) : null, items = [];
    const read = async (f) => { if (!f) return { fm: {}, body: "" }; const t = (await vt.read(f)).replace(/\r\n/g, "\n"), m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(t); let fm = {}; if (m) { try { fm = parseYaml(m[1]) || {}; } catch (e) {} } return { fm, body: m ? m[2] : t }; };
    const push = async (key, title, files, sidecar, sidecarPath, standalone) => {
      const r = await read(sidecar), fm = r.fm;
      items.push({ key, title: fm.title || title, files, sidecar, sidecarPath, fm, body: r.body, status: fm.status || "needs-review", created: fm.created || (sidecar || files[0] || {}).stat?.ctime || 0 });
    };
    if (root instanceof TFolder) {
      const kids = root.children.filter((c) => c instanceof TFile), media = kids.filter((f) => mediaKind(f) && f.extension !== "md");
      for (const f of media) { const sc = kids.find((k) => k.extension === "md" && k.basename === f.basename); await push(f.path, f.basename, [f], sc || null, root.path + "/" + f.basename + ".md"); }
      for (const f of kids.filter((k) => k.extension === "md" && k.name !== "README.md" && !media.some((m) => m.basename === k.basename))) await push(f.path, f.basename, [], f, f.path, true);
      for (const d of root.children.filter((c) => c instanceof TFolder)) {
        const fl = d.children.filter((c) => c instanceof TFile), sc = fl.find((k) => k.name === "item.md");
        await push(d.path, d.name, fl.filter((k) => mediaKind(k) && k !== sc), sc || null, d.path + "/item.md");
      }
    }
    items.sort((a, b) => String(b.created).localeCompare(String(a.created)));
    const sig = JSON.stringify(items.map((i) => [i.key, i.title, i.status, i.fm.feedback, i.body]));
    this.review = items;
    if (this.dockBtns && this.dockBtns.view) { const n = items.filter((i) => i.status === "needs-review").length; this.badge.setText(String(n)); this.badge.toggleClass("zero", !n); }
    if (sig !== this.rsig) { this.rsig = sig; if (this.page === "home" || this.page === "view") this.renderPage(); }
  }
  async decide(it, status, feedback) {
    const vt = this.app.vault; let sc = it.sidecar;
    try {
      if (!sc) sc = vt.getAbstractFileByPath(it.sidecarPath) || await vt.create(it.sidecarPath, "---\n---\n");
      const setFm = () => this.app.fileManager.processFrontMatter(sc, (fm) => { fm.status = status; fm.feedback = feedback || ""; fm.decided = new Date().toISOString(); if (!fm.title) fm.title = it.title; });
      try { await setFm(); }
      catch (e1) {
        // Agent-written frontmatter sometimes has an unquoted colon or quotes inside quotes, which breaks YAML.
        // Repair every top-level value into a safe JSON-quoted string, then try once more.
        await this.app.vault.process(sc, (t) => t.replace(/^---\r?\n([\s\S]*?)\r?\n---/, (all, body) => "---\n" + body.split(/\r?\n/).map((l) => {
          const k = /^([A-Za-z_]+):\s+(.*)$/.exec(l); if (!k) return l;
          let v = k[2].trim(); if (/^[|>[{]/.test(v) || v === "") return l;
          if (v.length > 1 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1); else if (v.length > 1 && v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1);
          return k[1] + ": " + JSON.stringify(v.replace(/\\"/g, "'").replace(/"/g, "'"));
        }).join("\n") + "\n---"));
        await setFm();
      }
      new Notice((status === "approved" ? "Approved" : status === "rejected" ? "Rejected" : "Changes sent") + ": " + it.title);
    } catch (e) { console.error("Project HQ review", e); new Notice("Could not save the review: " + (e && e.message || e)); }
    this.touchedAt = 0;
    await this.loadReview();
    this.renderPage(false, true);
  }
  async loadUsage() {
    // Cache the last good reading so a reload or a rate limit (429) never blanks the gauges; retry quietly.
    if (!this.usage) { try { const c = JSON.parse(localStorage.getItem("project-hq-usage") || "null"); if (c) { this.usage = c.u; this.at = new Date(c.at); } } catch (e) {} }
    if (this.at && Date.now() - this.at < 60000 && this.usage) { this.renderPage(); return; } // never poll faster than 1/min
    try {
      this.usage = await fetchUsage(); this.err = ""; this.at = new Date();
      localStorage.setItem("project-hq-usage", JSON.stringify({ u: this.usage, at: this.at.getTime() }));
    } catch (e) {
      const m = e.message || "Usage error";
      if (/429|unavailable/i.test(m) && this.usage) this.err = ""; else this.err = m;
      if (/429/.test(m)) { clearTimeout(this.retryT); this.retryT = setTimeout(() => this.loadUsage(), 120000); }
    }
    this.renderPage();
  }
  async loadCommits(force) {
    if (!force && this.cAt && Date.now() - this.cAt < 600000) return;
    this.commits = await fetchCommits(GIT); this.cAt = Date.now();
    if (this.page === "home") this.renderPage();
  }
  refreshAll() { this.cAt = 0; this.runMetrics(true); this.loadFiles(); this.loadCommits(true); this.loadUsage(); }
  async tick(line, text, on) {
    const f = this.app.vault.getAbstractFileByPath(TODO); if (!(f instanceof TFile)) return;
    await this.app.vault.process(f, (d) => {
      const ls = d.split("\n"); if (ls[line] && ls[line].includes(text.slice(0, 40))) ls[line] = ls[line].replace(/\[( |x)\]/i, on ? "[x]" : "[ ]");
      return ls.join("\n");
    });
  }
}

// ===== HQ_OS: sci-fi mission-control layout. Replaces the classic home unless settings.classicLayout is on. =====
// Presentation only: every data function above (usage, agents, review, insights, todo) is reused. One shared 1 s timer (HQView.osTick) plus the orb's own rAF loop (paused when hidden).
const OS_PERSONAL = /💀|(^|[\/])personal[\/]/i;
const claudianOf = (app) => { const pl = app.plugins && app.plugins.plugins; return pl && (pl.realclaudian || pl.claudian) || null; };
const osMono = (n) => String(n).padStart(2, "0");
const shortName = (s) => clean(String(s)).replace(/\s*[(,:].*$/, "").slice(0, 16) || "Section";
const vit = { cpu: 0, mem: 0, up: 0, hist: [], last: null };
function sampleVitals() {
  const cur = os.cpus().map((c) => Object.assign({}, c.times)); let idle = 0, tot = 0;
  if (vit.last) cur.forEach((t, i) => { const p = vit.last[i] || t; let s = 0; for (const k in t) s += t[k] - p[k]; tot += s; idle += t.idle - p.idle; });
  vit.last = cur; vit.cpu = tot > 0 ? Math.max(0, Math.min(100, Math.round(100 * (1 - idle / tot)))) : vit.cpu;
  vit.mem = Math.round(100 * (1 - os.freemem() / os.totalmem())); vit.up = os.uptime();
  vit.hist.push(vit.cpu); if (vit.hist.length > 30) vit.hist.shift();
}
const upText = (s) => { const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); return d ? d + "d " + h + "h" : h + "h " + m + "m"; };
// ----- To-Do sections: every top-level checkbox line with its line number -----
function parseSecs(md) {
  const out = []; let cur = null;
  md.split("\n").forEach((l, i) => {
    const h = /^## (.*)/.exec(l); if (h) { cur = { name: h[1].trim(), items: [] }; out.push(cur); return; }
    const m = cur && /^(?:- |\d+[a-z]?\.\s)\[( |x|~|-)\]\s(.*)/i.exec(l); if (m) cur.items.push({ line: i, st: m[1].toLowerCase(), raw: m[2], text: clean(m[2]) });
  });
  return out;
}
function parseQueue(md) {
  const open = [], today = ymd(new Date()); let posted = 0;
  md.split("\n").forEach((l, i) => {
    const m = /^- \[( |x)\]\s+(.*)/i.exec(l); if (!m) return;
    if (m[1].toLowerCase() === "x") { const d = /posted[^)]*?(\d{4}-\d{2}-\d{2})/i.exec(m[2]); if (d && d[1] === today) posted++; return; }
    if (/\bHOLD\b/.test(m[2])) return;
    const parts = m[2].split("|").map((x) => x.trim()), file = (parts[1] || "").split(/[\\/]/).pop().replace(/\.\w+(\s|$).*/, "").replace(/_9x16.*/, "");
    open.push({ line: i, text: (parts[0] || "") + " · " + (file || parts[1] || "").slice(0, 60) });
  });
  return { open, posted };
}
function nextSlot(slots, now) {
  const list = String(slots || "").split(",").map((s) => /^(\d{1,2}):(\d{2})$/.exec(s.trim())).filter(Boolean).map((m) => [+m[1], +m[2]]).sort((a, b) => a[0] * 60 + a[1] - b[0] * 60 - b[1]);
  if (!list.length) return null;
  for (const dayOff of [0, 1]) for (const [h, m] of list) { const d = new Date(now); d.setDate(d.getDate() + dayOff); d.setHours(h, m, 0, 0); if (d > now) return d; }
  return null;
}
function osPanel(parent, title, cls) {
  const p = parent.createDiv({ cls: "os-p " + (cls || "") }), h = p.createDiv({ cls: "os-ph" });
  h.createSpan({ cls: "os-pt", text: title }); const meta = h.createSpan({ cls: "os-pm" });
  return { p, h, meta, body: p.createDiv({ cls: "os-pb" }) };
}
// ----- the particle orb (2D canvas, projected sphere; ~30 fps; paused when HQ is not visible) -----
class Orb {
  constructor(cv) {
    this.cv = cv; this.ctx = cv.getContext("2d"); const N = this.N = 900;
    this.X = new Float32Array(N); this.Y = new Float32Array(N); this.Z = new Float32Array(N);
    for (let i = 0; i < N; i++) { const y = 1 - (i + 0.5) * 2 / N, r = Math.sqrt(1 - y * y), th = i * 2.399963, k = 0.96 + Math.random() * 0.08; this.X[i] = Math.cos(th) * r * k; this.Y[i] = y * k; this.Z[i] = Math.sin(th) * r * k; }
    this.bx = [0, 1, 2, 3].map(() => new Float32Array(N * 2)); this.bn = [0, 0, 0, 0];
    Object.assign(this, { rot: 0, int: 0.25, target: 0.25, tint: 0, tintT: 0, arcs: [], nextArc: 0, last: 0, on: false, raf: 0, w: 0, h: 0, cost: 0, frames: 0, dpr: 1, still: matchMedia("(prefers-reduced-motion: reduce)").matches });
    this.loop = (t) => this.frame(t);
  }
  resize() {
    const cv = this.cv, w = cv.clientWidth, h = cv.clientHeight; if (!w || !h) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5); cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    this.w = cv.width; this.h = cv.height; this.s = Math.min(this.w, this.h) * 0.42; this.dpr = dpr;
    const gs = this.gs = Math.round(this.s * 2.8), mk = (rgb) => { const g = document.createElement("canvas"); g.width = g.height = gs; const x = g.getContext("2d"), rg = x.createRadialGradient(gs / 2, gs / 2, this.s * 0.1, gs / 2, gs / 2, gs / 2); rg.addColorStop(0, "rgba(" + rgb + ",.34)"); rg.addColorStop(0.45, "rgba(" + rgb + ",.1)"); rg.addColorStop(1, "rgba(" + rgb + ",0)"); x.fillStyle = rg; x.fillRect(0, 0, gs, gs); return g; };
    this.glow = mk("25,227,208"); this.glowA = mk("255,176,46");
  }
  mode(intensity, warn) { this.target = intensity; this.tintT = warn ? 1 : 0; }
  run(on) { if (on === this.on) return; this.on = on; cancelAnimationFrame(this.raf); if (on) { this.last = 0; this.raf = requestAnimationFrame(this.loop); } }
  pt(i, cx, cy, R, cs) { // rotated + projected point i -> [sx, sy]
    const x = this.X[i], y = this.Y[i], z = this.Z[i], c = Math.cos(this.rot), s = Math.sin(this.rot);
    const x1 = x * c + z * s, z1 = -x * s + z * c, y2 = y * cs[0] - z1 * cs[1], z2 = y * cs[1] + z1 * cs[0], p = 1 + z2 * 0.22;
    return [cx + x1 * R * p, cy + y2 * R * p];
  }
  frame(t) {
    if (!this.on) return; this.raf = requestAnimationFrame(this.loop);
    const gap = this.still ? 120 : 31; if (t - this.last < gap) return;
    const dt = Math.min(0.1, (t - (this.last || t - gap)) / 1000); this.last = t; const t0 = performance.now();
    if (!this.w) { this.resize(); if (!this.w) return; }
    const ctx = this.ctx, W = this.w, H = this.h, cx = W / 2, cy = H / 2, dpr = this.dpr;
    this.int += (this.target - this.int) * Math.min(1, dt * 1.5); this.tint += (this.tintT - this.tint) * Math.min(1, dt * 2);
    const I = this.int; this.rot += dt * (this.still ? 0.02 : 0.1 + 0.3 * I);
    ctx.clearRect(0, 0, W, H);
    const gs = this.gs, br = 1 + 0.03 * Math.sin(t / 700) + 0.04 * I * Math.sin(t / 530); // breathing stays well under 3 Hz
    ctx.globalAlpha = Math.min(1, 0.45 + 0.6 * I); ctx.drawImage(this.glow, cx - gs / 2, cy - gs / 2);
    if (this.tint > 0.02) { ctx.globalAlpha = this.tint * 0.9; ctx.drawImage(this.glowA, cx - gs / 2, cy - gs / 2); } ctx.globalAlpha = 1;
    const R = this.s * br, tilt = 0.38, cs = [Math.cos(tilt), Math.sin(tilt)], cr = Math.cos(this.rot), sr = Math.sin(this.rot);
    this.bn[0] = this.bn[1] = this.bn[2] = this.bn[3] = 0;
    for (let i = 0; i < this.N; i++) {
      const x = this.X[i], y = this.Y[i], z = this.Z[i], x1 = x * cr + z * sr, z1 = -x * sr + z * cr, y2 = y * cs[0] - z1 * cs[1], z2 = y * cs[1] + z1 * cs[0], p = 1 + z2 * 0.22;
      const b = z2 < -0.4 ? 0 : z2 < 0 ? 1 : z2 < 0.5 ? 2 : 3, a = this.bx[b], n = this.bn[b]; a[n] = cx + x1 * R * p; a[n + 1] = cy + y2 * R * p; this.bn[b] = n + 2;
    }
    const base = [0.22, 0.4, 0.7, 1], sz = [1.1, 1.5, 2, 2.5].map((s) => s * dpr), mix = this.tint;
    const col = (a) => "rgba(" + Math.round(25 + 230 * mix) + "," + Math.round(227 - 51 * mix) + "," + Math.round(208 - 162 * mix) + "," + a.toFixed(3) + ")";
    for (let b = 0; b < 4; b++) { ctx.fillStyle = col(base[b] * (0.55 + 0.45 * I)); const a = this.bx[b], n = this.bn[b], s = sz[b]; for (let j = 0; j < n; j += 2) ctx.fillRect(a[j], a[j + 1], s, s); }
    // lightning arcs: only while agents are working, at most 2 at once, each lives ~0.5 s and they spawn >= 0.55 s apart (never > 3 Hz)
    if (!this.still && I > 0.6 && t > this.nextArc && this.arcs.length < 2) {
      this.nextArc = t + 550 + Math.random() * 900; const a = (Math.random() * this.N) | 0; let b = (Math.random() * this.N) | 0, g = 0;
      while (g++ < 40 && Math.abs(this.X[a] * this.X[b] + this.Y[a] * this.Y[b] + this.Z[a] * this.Z[b]) > 0.5) b = (Math.random() * this.N) | 0;
      this.arcs.push({ a, b, born: t });
    }
    this.arcs = this.arcs.filter((r) => t - r.born < 520);
    for (const r of this.arcs) {
      const A = this.pt(r.a, cx, cy, R, cs), B = this.pt(r.b, cx, cy, R, cs), f = 1 - (t - r.born) / 520, mx = (A[0] + B[0]) / 2, my = (A[1] + B[1]) / 2, ox = mx - cx, oy = my - cy, ol = Math.hypot(ox, oy) || 1, bulge = R * 0.35;
      const qx = mx + ox / ol * bulge, qy = my + oy / ol * bulge; ctx.beginPath(); ctx.moveTo(A[0], A[1]);
      for (let s = 1; s <= 9; s++) { const u = s / 9, ax = (1 - u) * (1 - u) * A[0] + 2 * u * (1 - u) * qx + u * u * B[0], ay = (1 - u) * (1 - u) * A[1] + 2 * u * (1 - u) * qy + u * u * B[1], j = s < 9 ? (Math.random() - 0.5) * R * 0.06 : 0; ctx.lineTo(ax + j, ay + j); }
      ctx.strokeStyle = "rgba(25,227,208," + (0.18 * f).toFixed(3) + ")"; ctx.lineWidth = 5 * dpr; ctx.stroke(); ctx.strokeStyle = "rgba(210,255,250," + (0.9 * f).toFixed(3) + ")"; ctx.lineWidth = 1.3 * dpr; ctx.stroke();
    }
    this.cost += (performance.now() - t0 - this.cost) * 0.05; this.frames++;
  }
}
Object.assign(HQView.prototype, {
  claudian() { return claudianOf(this.app); },
  osVars() {
    const r = this.contentEl, v = { "--amber": "#19e3d0", "--amber2": "#2dd4bf", "--bg1": "#05090c", "--bg2": "#071014", "--bg3": "#04070a", "--tx": "#d8f3f1", "--tx2": "#8fb3b6", "--glass": "rgba(25,227,208,.05)", "--glass-b": "rgba(25,227,208,.28)", "--teal": "#0a1c20", "--teal2": "#0f2a2e" };
    Object.entries(v).forEach(([k, c]) => r.style.setProperty(k, c));
  },
  osMode() {
    const on = !this.plugin.settings.classicLayout; if (this.os === on) return; this.os = on;
    this.contentEl.toggleClass("hqos", on); this.osStop(); if (this.pageEl) { this.pageEl.empty(); this.pageEl.toggleClass("os", on); }
    if (!on) ["--tx", "--glass", "--glass-b"].forEach((k) => this.contentEl.style.removeProperty(k));
  },
  osStop() { if (this.orb) this.orb.run(false); if (this.osIO) this.osIO.disconnect(); if (this.osRO) this.osRO.disconnect(); this.orb = null; this.osIO = this.osRO = null; this.osUI = null; },
  osBuild() {
    const page = this.pageEl; page.empty(); page.addClass("os"); const ui = this.osUI = { sig: {}, inView: true }, wrap = page.createDiv({ cls: "os-wrap" });
    wrap.createDiv({ cls: "os-sweep" }); ui.top = wrap.createDiv({ cls: "os-top" });
    const grid = wrap.createDiv({ cls: "os-grid" }), L = grid.createDiv({ cls: "os-col os-left" }), M = grid.createDiv({ cls: "os-col os-mid" }), Rt = grid.createDiv({ cls: "os-col os-right" });
    ui.vit = osPanel(L, "SYSTEM VITALS", "os-vit"); ui.sess = osPanel(L, "ACTIVE AI SESSIONS", "os-sess"); ui.prog = osPanel(L, "PROJECT PROGRESS", "os-prog"); ui.next = osPanel(L, "NEXT UP", "os-next");
    ui.tasks = osPanel(Rt, "TOP TASKS", "os-tasks"); ui.rev = osPanel(Rt, "REVIEW QUEUE", "os-rev"); ui.acts = osPanel(Rt, "ACTION ITEMS", "os-acts"); ui.rules = osPanel(Rt, "SAVE AS RULE", "os-rules"); ui.ap = osPanel(Rt, "AGENT PROGRESS", "os-ap"); ui.files = osPanel(Rt, "FILES IN PLAY", "os-files");
    this.osColl = this.osColl || new Set(["files"]);
    [["ap", ui.ap], ["files", ui.files]].forEach(([k, p]) => { p.p.addClass("os-coll"); p.p.toggleClass("collapsed", this.osColl.has(k)); p.h.setAttr("role", "button"); p.h.setAttr("tabindex", "0"); p.h.setAttr("aria-expanded", String(!this.osColl.has(k)));
      const tg = () => { this.osColl.has(k) ? this.osColl.delete(k) : this.osColl.add(k); p.p.toggleClass("collapsed", this.osColl.has(k)); p.h.setAttr("aria-expanded", String(!this.osColl.has(k))); }; p.h.onclick = tg; p.h.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); tg(); } }); });
    const orbw = M.createDiv({ cls: "os-orbw" }); ui.cv = orbw.createEl("canvas", { cls: "os-cv", attr: { "aria-hidden": "true" } });
    orbw.insertAdjacentHTML("beforeend", '<svg class="os-ring" viewBox="0 0 200 200" aria-hidden="true"><circle cx="100" cy="100" r="96" class="r1"/><circle cx="100" cy="100" r="88" class="r2"/><path class="r3" d="M100 2v10M100 188v10M2 100h10M188 100h10"/></svg>');
    ui.status = M.createDiv({ cls: "os-status", attr: { role: "status", "aria-live": "polite" } });
    const cmd = M.createDiv({ cls: "os-cmd" }); ui.target = cmd.createEl("select", { cls: "os-sel", attr: { "aria-label": "Send to which Claudian session" } });
    ui.cmdIn = cmd.createEl("input", { cls: "os-in", attr: { type: "text", placeholder: "Type a command for HQ…", "aria-label": "Command for Claudian", autocomplete: "off", spellcheck: "false" } });
    const sendB = cmd.createEl("button", { cls: "os-go", text: "SEND", attr: { "aria-label": "Send command" } }); ui.cmdMsg = M.createDiv({ cls: "os-cmdmsg" });
    const go = () => this.osSend(ui.cmdIn.value, ui.target.value); sendB.onclick = go; ui.cmdIn.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter" && !e.isComposing) go(); });
    ui.tick = M.createDiv({ cls: "os-ticker" });
    this.orb = new Orb(ui.cv); this.osRO = new ResizeObserver(() => { if (this.orb) this.orb.resize(); }); this.osRO.observe(orbw);
    this.osIO = new IntersectionObserver((es) => { ui.inView = es[es.length - 1].isIntersecting; this.osGate(); }); this.osIO.observe(orbw);
    if (!this.usage) { try { const c = JSON.parse(localStorage.getItem("project-hq-usage") || "null"); if (c) { this.usage = c.u; this.at = new Date(c.at); } } catch (e) {} }
    sampleVitals(); setTimeout(() => { if (this.osUI === ui) { sampleVitals(); this.osVitalsRender(); } }, 1500);
    this.osSessData(true); this.osElevenCheck(true); setTimeout(() => this.osGate(), 300);
  },
  osGate() { const ui = this.osUI; if (!ui || !this.orb) return; this.orb.run(!document.hidden && ui.inView && (!this.contentEl.isShown || this.contentEl.isShown())); },
  // ---- render everything (cheap; each region redraws only when its signature changed) ----
  osRender(force) {
    if (!this.osUI) this.osBuild();
    const ae = document.activeElement, held = !force && (Date.now() - (this.touchedAt || 0) < 20000 || (ae && /TEXTAREA|INPUT/.test(ae.tagName) && this.contentEl.contains(ae)));
    this.osTopRender(); this.osVitalsRender(); this.osSessRender(); this.osProgRender(); this.osNextRender(); this.osMidRender();
    if (!held) { this.osTasksRender(); this.osReviewRender(); this.osInsRender(); }
  },
  osReg(name, sig, fn) { const u = this.osUI; if (u.sig[name] === sig) return; u.sig[name] = sig; fn(); },
  osPlanName() { if (this.osPlan === undefined) { this.osPlan = ""; try { const c = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude", ".credentials.json"), "utf8")); this.osPlan = String((c.claudeAiOauth && c.claudeAiOauth.subscriptionType) || "").slice(0, 12); } catch (e) {} } return this.osPlan; },
  osTopRender() {
    const u = this.osUI, ci = cacheInfo(), us = this.usage, wk = us && us.seven_day, se = us && us.five_hour, model = shortModel(mainState.model);
    const pc = (x) => x && x.utilization !== undefined && x.utilization !== null ? Math.round(x.utilization) : null, wv = pc(wk), sv = pc(se), cl = (p) => p === null ? "" : p >= 90 ? "bad" : p >= 75 ? "warn" : "";
    const sig = JSON.stringify([this.project && this.project.name, model, this.osPlanName(), wv, sv, ci && ci.state, ci && Math.floor(ci.age / 3), this.err, vit.cpu > 85, wk && wk.resets_at, se && se.resets_at]);
    this.osReg("top", sig, () => {
      const t = u.top; t.empty(); const brand = t.createDiv({ cls: "os-brand" }); brand.createSpan({ cls: "os-logo", text: "HQ_OS" });
      brand.createSpan({ cls: "os-proj", text: "// " + String(this.project ? this.project.name : "HQ").toUpperCase() });
      const on = brand.createSpan({ cls: "os-online" }); on.createSpan({ cls: "os-dot" }); on.createSpan({ text: "ONLINE" });
      const chips = t.createDiv({ cls: "os-chips" }), chip = (k, v, c, tip) => { const e = chips.createSpan({ cls: "os-chip " + (c || "") }); e.createSpan({ cls: "k", text: k }); e.createSpan({ cls: "v", text: v }); if (tip) e.title = tip; return e; };
      if (model) chip("MODEL", model.toUpperCase()); if (this.osPlanName()) chip("PLAN", this.osPlanName().toUpperCase());
      chip("WEEK", wv === null ? "N/A" : wv + "%", cl(wv), wk && wk.resets_at ? "Resets " + when(wk.resets_at) + " (in " + left(wk.resets_at) + ")" : this.err || "");
      chip("SESSION", sv === null ? "N/A" : sv + "%", cl(sv), se && se.resets_at ? "Resets " + when(se.resets_at) + " (in " + left(se.resets_at) + ")" : this.err || "");
      if (ci) { const e = chip("CACHE", ci.state === "cold" ? "COLD" : ci.state === "warn" ? "COOLING" : "WARM", ci.state === "cold" ? "bad" : ci.state === "warn" ? "warn" : "", ci.msg); e.addClass("click"); e.onclick = () => this.osFocusInsights(); }
      if (vit.cpu > 85) chip("LOAD", vit.cpu + "%", "bad", "System load is high");
      const r = t.createDiv({ cls: "os-r" }); this.osClock = r.createDiv({ cls: "os-clock" });
      const ib = (icon, label, fn) => { const b = r.createEl("button", { cls: "os-ib", attr: { "aria-label": label, title: label } }); setIcon(b, icon); b.onclick = fn; };
      ib("refresh-cw", "Refresh", () => this.refreshAll()); ib("settings", "Settings", () => { try { this.app.setting.open(); this.app.setting.openTabById("project-hq"); } catch (e) { new Notice("Open Settings, then Project HQ"); } });
      this.osClockTick();
    });
  },
  osFocusInsights() { const u = this.osUI; if (u && u.acts) u.acts.p.scrollIntoView({ behavior: "smooth", block: "nearest" }); },
  osClockTick() { if (!this.osClock) return; const n = new Date(); this.osClock.setText(osMono(n.getHours()) + ":" + osMono(n.getMinutes()) + ":" + osMono(n.getSeconds()) + "  ·  " + n.toLocaleDateString([], { weekday: "short", day: "2-digit", month: "short", year: "numeric" }).toUpperCase().replace(/,/g, "")); },
  osVitalsRender() {
    const u = this.osUI, b = u.vit.body, warn = vit.cpu > 85 || vit.mem > 85;
    this.osReg("vit", JSON.stringify([vit.cpu, vit.mem, Math.floor(vit.up / 60)]), () => {
      b.empty(); const row = (k, v, p) => { const r = b.createDiv({ cls: "os-vrow" + (p > 85 ? " bad" : p > 70 ? " warn" : "") }); r.createSpan({ cls: "k", text: k }); r.createSpan({ cls: "v", text: v }); const bar = r.createDiv({ cls: "os-bar" }); bar.createEl("i").style.width = Math.max(2, p) + "%"; };
      row("CPU", vit.cpu + "%", vit.cpu); row("MEMORY", vit.mem + "%", vit.mem);
      const sp = b.createDiv({ cls: "os-spark" }); spark(sp, vit.hist);
      const up = b.createDiv({ cls: "os-vrow flat" }); up.createSpan({ cls: "k", text: "UPTIME" }); up.createSpan({ cls: "v", text: upText(vit.up) });
      if (warn) b.createDiv({ cls: "os-warn", text: "HIGH LOAD: " + (vit.cpu > 85 ? "CPU " + vit.cpu + "%" : "memory " + vit.mem + "%") + ". Close heavy apps." });
      u.vit.meta.setText(warn ? "WARNING" : "NOMINAL"); u.vit.meta.toggleClass("bad", warn);
    });
  },
  // ---- sessions: Claudian conversations + agents ----
  async osSessData(force) {
    if (this.osSessBusy) return; if (!force && Date.now() - (this.osSessAt || 0) < 4500) return; this.osSessBusy = true; this.osSessAt = Date.now();
    try {
      const cp = this.claudian(), rows = [], reads = []; this.osSnip = this.osSnip || {};
      if (cp && cp.chatHost && cp.sessionMessaging) {
        const list = cp.chatHost.getConversationList().filter((c) => !c.isArchived && !OS_PERSONAL.test((c.linkedContentPath || "") + " " + (c.title || ""))).sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0)).slice(0, 7);
        for (const c of list) {
          const st = cp.sessionMessaging.status(c.id), key = [c.lastActivityAt, c.messageCount, st].join("|"), sn = this.osSnip[c.id];
          if (rows.length < 4 && cp.api && (!sn || (sn.key !== key && Date.now() - sn.at > 8000))) reads.push([c.id, key, sn]);
          rows.push({ kind: "chat", id: c.id, title: clean(c.title || "Untitled"), st: st === "running" ? "thinking" : st === "awaiting-user" ? "needs you" : "idle", ts: c.lastActivityAt || 0, snip: (this.osSnip[c.id] || {}).text || "" });
        }
        this.osConvs = list.map((c) => [c.id, clean(c.title || "Untitled"), !!(cp.api && cp.api.getActiveSessionId && cp.api.getActiveSessionId() === c.id)]);
      } else this.osConvs = [];
      const now = Date.now();
      this.live.filter((a) => a.status === "running" || (a.status === "done" && now - a.mtime < 3600000)).slice(0, 8).forEach((a) => rows.push({ kind: "agent", id: a.id, title: clean(a.title), st: a.status === "running" ? "running in background" : "done", ts: a.mtime, snip: redact(a.tool ? stepText(a.tool) : a.text || "").replace(/\s+/g, " ").slice(0, 180), type: a.type }));
      this.osRows = rows; this.osFillTarget(); this.osSessRender();
      for (const [id, key, sn] of reads) { let t = ""; try { t = String(await cp.api.read(id) || ""); } catch (e) {} this.osSnip[id] = { key, at: Date.now(), text: /^.no reply.$/.test(t) ? (sn && sn.text || "") : clean(redact(t)).replace(/\s+/g, " ").trim().slice(0, 180) }; const r = rows.find((x) => x.id === id); if (r) r.snip = this.osSnip[id].text; }
      if (reads.length) this.osSessRender();
    } catch (e) { console.error("Project HQ OS sessions", e); } finally { this.osSessBusy = false; }
  },
  osSessRender() {
    const u = this.osUI; if (!u) return; const rows = this.osRows || [];
    this.osReg("sess", JSON.stringify(rows.map((r) => [r.id, r.st, r.snip, r.title])), () => {
      const b = u.sess.body; b.empty(); u.sess.meta.setText(rows.filter((r) => r.st === "thinking" || r.st === "running in background").length + " ACTIVE");
      if (!rows.length) b.createDiv({ cls: "os-muted", text: "No sessions yet." });
      rows.forEach((r) => {
        const c = b.createDiv({ cls: "os-srow " + r.kind + " s-" + r.st.replace(/\s+/g, "-"), attr: r.kind === "chat" ? { role: "button", tabindex: "0", "aria-label": "Open session " + r.title } : {} });
        const h = c.createDiv({ cls: "os-sh" }); h.createSpan({ cls: "os-sd" }); h.createSpan({ cls: "os-sn", text: r.title }).title = r.title; h.createSpan({ cls: "os-ss", text: r.st.toUpperCase() });
        c.createDiv({ cls: "os-sm", text: (r.kind === "agent" ? r.type + " · " : "") + (r.snip || "(no messages yet)") });
        if (r.kind === "chat") { const open = () => this.osOpenSession(r.id); c.onclick = open; c.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } }); }
      });
    });
  },
  osOpenSession(id) {
    const cp = this.claudian(), ws = this.app.workspace, type = (this.plugin.settings.chatView || "claudian-view").trim();
    try { const p = cp && cp.chatHost && cp.chatHost.switchConversation ? cp.chatHost.switchConversation(id) : null; if (p && p.catch) p.catch((e) => console.error("Project HQ switch session", e)); } catch (e) { console.error("Project HQ switch session", e); }
    const leaf = ws.getLeavesOfType(type)[0]; if (leaf) ws.revealLeaf(leaf);
  },
  osFillTarget() {
    const u = this.osUI; if (!u || !u.target) return; const prev = u.target.value, convs = this.osConvs || [], sig = JSON.stringify(convs); if (u.tsig === sig) return; u.tsig = sig; u.target.empty();
    u.target.createEl("option", { value: "new", text: "+ NEW SESSION" }); convs.forEach(([id, t, act]) => u.target.createEl("option", { value: id, text: (act ? "* " : "") + t.slice(0, 34) }));
    u.target.value = convs.some((c) => c[0] === prev) || prev === "new" ? prev : "new";
  },
  // ---- command bar -> Claudian (api.send queues the text as a user message; new session via chatHost.createConversation) ----
  async osSend(text, target) {
    const u = this.osUI; text = String(text || "").trim(); if (!text) return; const say = (m, bad) => { u.cmdMsg.setText(m); u.cmdMsg.toggleClass("bad", !!bad); };
    const cp = this.claudian(), ws = this.app.workspace, type = (this.plugin.settings.chatView || "claudian-view").trim();
    if (!(cp && cp.api && cp.api.send && cp.chatHost)) { // no safe API: copy and focus the chat input
      try { await navigator.clipboard.writeText(text); } catch (e) {}
      const leaf = ws.getLeavesOfType(type)[0]; if (leaf) { ws.revealLeaf(leaf); setTimeout(() => { const ta = leaf.view.contentEl.querySelector("textarea"); if (ta) ta.focus(); }, 150); }
      say("Claudian API not found: copied to clipboard, paste it into the chat."); return;
    }
    u.cmdIn.disabled = true; say("Sending…");
    try {
      let id = target, title = "";
      if (!id || id === "new") {
        const s = cp.chatHost.getCommittedSettings ? cp.chatHost.getCommittedSettings() : {}, ms = cp.chatHost.getActiveModelSelection ? cp.chatHost.getActiveModelSelection() : null;
        const conv = await cp.chatHost.createConversation(Object.assign({ providerId: (ms && ms.providerId) || s.settingsProvider || "claude" }, ms && ms.model ? { selectedModel: ms.model } : {})); id = conv.id; title = "a new session";
      } else title = ((this.osConvs || []).find((c) => c[0] === id) || [])[1] || "session";
      await cp.api.send(id, { text });
      u.cmdIn.value = ""; say("Sent to " + title + ".");
      if (!target || target === "new") { this.osSessAt = 0; this.osOpenSession(id); }
      this.osSessData(true);
    } catch (e) { console.error("Project HQ command", e); say("Could not send: " + redact(e && e.message || e), true); }
    finally { u.cmdIn.disabled = false; u.cmdIn.focus(); }
  },
  // ---- project progress rings ----
  osProgRender() {
    const u = this.osUI, secs = (this.secs || []).filter((s) => !/^done/i.test(s.name)).map((s) => { const it = s.items.filter((i) => i.st !== "-"); return { n: shortName(s.name), done: it.filter((i) => i.st === "x").length, tot: it.length }; }).filter((s) => s.tot > 0);
    this.osReg("prog", JSON.stringify(secs), () => {
      const b = u.prog.body; b.empty(); u.prog.meta.setText(secs.reduce((n, s) => n + s.done, 0) + "/" + secs.reduce((n, s) => n + s.tot, 0));
      if (!secs.length) { b.createDiv({ cls: "os-muted", text: "No To-Do sections found." }); return; }
      const g = b.createDiv({ cls: "os-rings" });
      secs.slice(0, 6).forEach((s) => {
        const pct = Math.round(100 * s.done / s.tot), c = g.createDiv({ cls: "os-rg", attr: { title: s.n + ": " + s.done + " of " + s.tot + " done" } }), C = 2 * Math.PI * 22;
        c.insertAdjacentHTML("beforeend", '<svg viewBox="0 0 56 56" aria-hidden="true"><circle cx="28" cy="28" r="22" class="bg"/><circle cx="28" cy="28" r="22" class="fg" stroke-dasharray="' + (C * pct / 100).toFixed(1) + " " + C.toFixed(1) + '" transform="rotate(-90 28 28)"/></svg>');
        c.createDiv({ cls: "os-rp", text: pct + "%" }); c.createDiv({ cls: "os-rl", text: s.n }); c.createDiv({ cls: "os-rc", text: s.done + "/" + s.tot });
      });
    });
  },
  // ---- next posting slot ----
  osNextRender() {
    const u = this.osUI, pr = this.project || {}, nx = nextSlot(pr.slots, new Date()), wait = this.needsCount(), q = this.queue || { open: [] };
    this.osReg("next", JSON.stringify([nx && nx.getTime(), wait, q.open[0] && q.open[0].text]), () => {
      const b = u.next.body; b.empty(); u.next.meta.setText(wait ? wait + " WAITING" : "CLEAR");
      if (nx) { const r = b.createDiv({ cls: "os-nrow" }); r.createSpan({ cls: "k", text: "NEXT POST" }); r.createSpan({ cls: "v", text: osMono(nx.getHours()) + ":" + osMono(nx.getMinutes()) }); this.osCount = b.createDiv({ cls: "os-count" }); this.osCountAt = nx.getTime(); this.osCountTick(); }
      else { this.osCount = null; b.createDiv({ cls: "os-muted", text: "No posting slots set (Settings: Posting slots)." }); }
      if (q.open[0]) b.createDiv({ cls: "os-muted os-qn", text: "Queue: " + q.open[0].text });
      const w = b.createDiv({ cls: "os-nrow" + (wait ? " warn" : "") }); w.createSpan({ cls: "k", text: "WAITING ON " + String(this.plugin.settings.person || "YOU").toUpperCase() }); w.createSpan({ cls: "v", text: String(wait) });
    });
  },
  osCountTick() { if (this.osCount && this.osCountAt) { const ms = this.osCountAt - Date.now(), s = Math.max(0, Math.floor(ms / 1000)); this.osCount.setText("T-" + osMono(Math.floor(s / 3600)) + ":" + osMono(Math.floor(s % 3600 / 60)) + ":" + osMono(s % 60)); if (ms < 0 && this.osUI) { this.osUI.sig.next = ""; this.osNextRender(); } } },
  // ---- centre: status line + ticker; orb mood ----
  osMidRender() {
    const u = this.osUI, run = this.live.filter((a) => a.status === "running").length, ci = cacheInfo(), cold = ci && ci.state === "cold", hot = vit.cpu > 85;
    const el = this.osEleven && this.osEleven.ok ? this.osEleven : null, posts = this.queue ? this.queue.posted : null, lv = this.todo && this.todo.live;
    if (this.orb) this.orb.mode(run ? 1 : cold ? 0.15 : 0.28, !!cold);
    const msg = run ? run + (run === 1 ? " agent" : " agents") + " running" : cold ? "Cache cold: next message re-reads the chat" : hot ? "High system load" : "All systems operational", cls = run ? "run" : (cold || hot) ? "warn" : "ok";
    this.osReg("mid", JSON.stringify([msg, cls, run, posts, el && el.left, this.osEleven && this.osEleven.err, lv]), () => {
      u.status.empty(); u.status.className = "os-status " + cls; u.status.createSpan({ cls: "os-dot" }); u.status.createSpan({ text: msg.toUpperCase() });
      const t = u.tick; t.empty(); const it = (k, v, c, tip) => { const e = t.createSpan({ cls: "os-ti " + (c || "") }); e.createSpan({ cls: "k", text: k }); e.createSpan({ cls: "v", text: v }); if (tip) e.title = tip; };
      it("AGENTS", run + " running", run ? "run" : ""); if (posts !== null) it("POSTS TODAY", String(posts));
      if (this.osEleven) it("ELEVENLABS", el ? fmtN(el.left) + " chars left" : (this.osEleven.err ? "n/a" : "checking…"), el && el.left < 20000 ? "warn" : "", this.osEleven.err);
      it("SITE", lv ? "LIVE · " + lv.slice(0, 40) : "n/a", lv ? "ok" : "");
    });
  },
  // ---- ElevenLabs credits: via the existing eleven.mjs, at most once per hour, cached in localStorage ----
  osElevenCheck() {
    const pr = this.project || {}, script = absP(pr.creditsScript || ""); if (!script) return;
    if (this.osEleven === undefined) { try { this.osEleven = JSON.parse(localStorage.getItem("hqos-eleven") || "null"); } catch (e) { this.osEleven = null; } }
    if (this.osElevenBusy || (this.osEleven && Date.now() - this.osEleven.t < 3600000)) return; this.osElevenBusy = true;
    execFile("node", [script, "subscription"], { cwd: path.dirname(script), timeout: 25000, windowsHide: true }, (err, out) => {
      this.osElevenBusy = false; let r = { t: Date.now(), ok: false, err: "" };
      try { const line = String(out || "").split("\n").reverse().find((l) => l.trim().startsWith("{")), j = JSON.parse(line); if (typeof j.left === "number") r = { t: Date.now(), ok: true, left: j.left, limit: j.limit, tier: j.tier }; else r.err = "no data"; } catch (e) { r.err = redact(err ? String(err.message).split("\n")[0] : "no data").slice(0, 100); }
      this.osEleven = r; try { localStorage.setItem("hqos-eleven", JSON.stringify(r)); } catch (e) {} if (this.osUI) { this.osUI.sig.mid = ""; this.osMidRender(); }
    });
  },
  // ---- tasks (right) ----
  osTasksRender() {
    const u = this.osUI, secs = this.secs || [], wait = this.todo.wait.filter((w) => !w.done), q = this.queue || { open: [] };
    const open = []; secs.forEach((s) => { if (/^done/i.test(s.name) || WAITH.test(s.name)) return; s.items.forEach((i) => { if (i.st === " " || i.st === "~") open.push({ s, i }); }); });
    this.osReg("tasks", JSON.stringify([open.slice(0, 60).map((o) => [o.i.line, o.i.text, o.i.st]), wait.map((w) => [w.line, w.text]), q.open.slice(0, 5).map((o) => o.text), this.osTaskAdd, this.osTaskAll]), () => {
      const b = u.tasks.body; b.empty(); u.tasks.meta.setText(open.length + wait.length + " OPEN");
      const group = (title, count, addTo, build) => {
        const g = b.createDiv({ cls: "os-tg" }), h = g.createDiv({ cls: "os-tgh" }); h.createSpan({ cls: "os-tgt", text: title }); h.createSpan({ cls: "os-cnt", text: String(count) });
        const add = h.createEl("button", { cls: "os-add", text: "+ Add", attr: { "aria-label": "Add task to " + title } }); const list = g.createDiv({ cls: "os-tl" }); build(list);
        if (this.osTaskAdd === addTo) {
          const f = g.createDiv({ cls: "os-addf" }), inp = f.createEl("input", { cls: "os-in", attr: { type: "text", placeholder: "New task, Enter to add (Esc cancels)", "aria-label": "New task text" } });
          inp.addEventListener("keydown", async (e) => { e.stopPropagation(); if (e.key === "Escape") { this.osTaskAdd = null; this.osUI.sig.tasks = ""; this.osTasksRender(); } if (e.key === "Enter" && !e.isComposing && inp.value.trim()) { const t = inp.value.trim(); this.osTaskAdd = null; await this.osAddTask(addTo, t); } });
          setTimeout(() => inp.focus(), 0);
        }
        add.onclick = () => { this.osTaskAdd = this.osTaskAdd === addTo ? null : addTo; this.osUI.sig.tasks = ""; this.osTasksRender(); };
      };
      const pn = String(this.project ? this.project.name : "Project").toUpperCase();
      group(pn + " TO-DO", open.length, "todo", (l) => {
        if (!open.length) l.createDiv({ cls: "os-muted", text: "Nothing open." });
        (this.osTaskAll ? open : open.slice(0, 8)).forEach(({ s, i }) => this.osTaskRow(l, i.text, false, () => this.osTickLine(i.line, i.raw), i.st === "~" ? "in progress" : "", s.name));
        if (open.length > 8) { const m = l.createEl("button", { cls: "os-more", text: this.osTaskAll ? "Show fewer" : "+" + (open.length - 8) + " more" }); m.onclick = () => { this.osTaskAll = !this.osTaskAll; this.osUI.sig.tasks = ""; this.osTasksRender(); }; }
      });
      group("WAITING ON " + String(this.plugin.settings.person || "YOU").toUpperCase(), wait.length, "wait", (l) => { if (!wait.length) l.createDiv({ cls: "os-muted", text: "Nothing waiting." }); wait.forEach((w) => this.osTaskRow(l, clean(w.text), false, () => this.tick(w.line, w.text, true), "")); });
      if (this.project && this.project.queue) group("POST QUEUE · NEXT 5", q.open.length, "queue", (l) => { if (!q.open.length) l.createDiv({ cls: "os-muted", text: "Queue empty." }); q.open.slice(0, 5).forEach((o) => this.osTaskRow(l, o.text, true)); });
    });
  },
  osTaskRow(list, text, ro, onTick, tag, tip) {
    const r = list.createDiv({ cls: "os-task" }), id = "os" + Math.random().toString(36).slice(2, 8);
    const cb = r.createEl("input", { attr: { type: "checkbox", id, "aria-label": ro ? "Queued post" : "Mark done: " + text } }); if (ro) { cb.disabled = true; cb.addClass("ro"); } else cb.onchange = () => { cb.disabled = true; onTick(); };
    const lb = r.createEl("label", { attr: { for: id }, text: text.slice(0, 130) }); lb.title = (tip ? tip + ": " : "") + text; if (tag) r.createSpan({ cls: "os-tag", text: tag });
  },
  async osTickLine(line, raw) {
    const f = this.app.vault.getAbstractFileByPath(TODO); if (!(f instanceof TFile)) return;
    await this.app.vault.process(f, (d) => { const ls = d.split("\n"), L = ls[line]; if (L !== undefined && L.includes(String(raw).slice(0, 40))) ls[line] = L.replace(/\[[ ~]\]/, "[x]"); return ls.join("\n"); }); // only that one line
  },
  async osAddTask(where, text) {
    const rel = where === "queue" ? (this.project || {}).queue : TODO, head = where === "wait" ? "Waiting on" : where === "queue" ? "TikTok" : NEXTH;
    try {
      const f = this.app.vault.getAbstractFileByPath(rel); if (!(f instanceof TFile)) throw new Error("note not found");
      const line = "- [ ] " + text.replace(/\s+/g, " ").trim() + (where === "queue" ? "" : " (Added " + todayStr() + ")");
      await this.app.vault.process(f, (d) => insertInSection(d, head, line, false)); new Notice("Task added");
    } catch (e) { console.error("Project HQ add task", e); new Notice("Could not add: " + (e && e.message || e)); }
    this.osUI.sig.tasks = ""; await this.loadFiles(); this.osTasksRender();
  },
  osReviewRender() {
    const u = this.osUI, need = this.review.filter((i) => i.status === "needs-review"), shown = this.osRevAll ? need : need.slice(0, 3);
    this.osReg("rev", this.rsig + "|" + need.length + "|" + this.osRevAll, () => {
      const b = u.rev.body; b.empty(); u.rev.meta.setText(need.length ? need.length + " PENDING" : "CLEAR"); u.rev.meta.toggleClass("warn", need.length > 0);
      if (!need.length) b.createDiv({ cls: "os-muted", text: "Nothing to review." });
      shown.forEach((it) => reviewCard(this, b, it));
      if (need.length > 3) { const m = b.createEl("button", { cls: "os-more", text: this.osRevAll ? "Show fewer" : "+" + (need.length - 3) + " more" }); m.onclick = () => { this.osRevAll = !this.osRevAll; this.osUI.sig.rev = ""; this.osReviewRender(); }; }
    });
  },
  osInsRender() {
    const u = this.osUI;
    this.osReg("ins", this.insSig + "|" + this.liveSig, () => {
      [["acts", "actions"], ["rules", "rules"], ["ap", "progress"], ["files", "files"]].forEach(([k, w]) => {
        const p = u[k], b = p.body; b.empty(); renderInsights(this, b, [w]); const d = b.querySelector("details"); if (!d) return;
        const s = d.querySelector("summary"), cnt = s && s.querySelector(".lhq-cnt"); p.meta.setText(cnt ? cnt.textContent.toUpperCase() : ""); d.open = true; if (s) s.hide();
      });
    });
  },
  osTick() {
    if (!this.os) return; this.osClockTick(); this.osCountTick(); this.osGate();
    if (document.hidden || (this.contentEl.isShown && !this.contentEl.isShown())) return;
    const now = Date.now();
    if (now - (this.osVitAt || 0) >= 4000) { this.osVitAt = now; sampleVitals(); if (this.osUI) { this.osVitalsRender(); this.osTopRender(); this.osMidRender(); } }
    this.osSessData(); this.osElevenCheck();
  },
});

const DEFAULTS = { projects: [], last: "", claudeDir: "", excludeRe: "personal", person: "", chatView: "claudian-view", filesBesideHQ: true, textScale: 125 };
const PFIELDS = [
  ["todo", "To-Do note path", "Vault path to a note with a numbered list under the Next heading, and checkboxes under Waiting on.", "Notes/To-Do.md"],
  ["nextHead", "Next heading", "Heading text (prefix match) of the numbered plan list. Default: Next", "Next"],
  ["waitHead", "Waiting-on heading", "Heading text (prefix match) of the items waiting on you. Default: Waiting on", "Waiting on"],
  ["liveRe", "Live line regex (optional)", "Matched against the To-Do note's first 12 lines; group 1 (or the whole match) becomes the Live chip.", "Live = ([^\\n]*)"],
  ["agents", "Agent board note (optional)", "Vault path to a note with a table: Agent | Status | Current task | Last finished | Updated.", "Notes/Agent Activity.md"],
  ["review", "Review folder (optional)", "Vault folder holding items for you to review (media plus optional sidecar notes).", "Notes/Review"],
  ["daily", "Daily notes folder for metrics (optional)", "Vault folder with YYYY-MM-DD.md notes whose frontmatter holds numeric metrics.", "Notes/Daily"],
  ["metricsCmd", "Metrics command (optional)", "Runs hourly if today's note is missing or over 60 minutes old. Example: node tools/metrics.mjs", "node tools/metrics.mjs"],
  ["metricsCwd", "Metrics working directory (optional)", "Absolute path (or vault-relative). Defaults to the vault folder.", ""],
  ["queue", "Post queue note (optional)", "Vault path to a note whose unchecked lines are the next posts (HQ_OS shows the next 5 and counts today's posted lines).", "Notes/Post Queue.md"],
  ["slots", "Posting slots (optional)", "Daily times, 24 h, comma separated. HQ_OS counts down to the next one.", "8:43,13:13,19:13"],
  ["creditsScript", "Credits script (optional)", "Vault-relative or absolute path to a Node script; HQ_OS runs `node <script> subscription` at most once an hour and shows the credits left (JSON with a numeric `left`).", "LumenAds/tools/eleven.mjs"],
  ["repo", "Git repo path (optional)", "Absolute path (or vault-relative); commits of the last 7 days show as dots in the week strip.", ""],
];

class ProjectHQSettings extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const el = this.containerEl, p = this.plugin, st = p.settings; el.empty();
    el.createEl("h2", { text: "Project HQ" });
    el.createEl("h3", { text: "Projects" });
    st.projects.forEach((pr) => {
      const d = el.createEl("details", { cls: "lhq-set" }); d.createEl("summary", { text: pr.name || "Untitled project" });
      new Setting(d).setName("Name").addText((t) => t.setValue(pr.name || "").onChange((v) => { pr.name = v; p.changed(); }));
      new Setting(d).setName("Accent colour").addColorPicker((c) => c.setValue(pr.accent || "#f5b83d").onChange((v) => { pr.accent = v; p.changed(); }));
      PFIELDS.forEach(([k, name, desc, ph]) => new Setting(d).setName(name).setDesc(desc).addText((t) => t.setPlaceholder(ph).setValue(pr[k] || "").onChange((v) => { pr[k] = v; p.changed(); })));
      new Setting(d).addButton((b) => b.setButtonText("Remove project").setWarning().onClick(async () => { st.projects = st.projects.filter((x) => x !== pr); if (st.last === pr.id) st.last = ""; await p.saveSettings(); p.changed(true); this.display(); }));
    });
    new Setting(el).addButton((b) => b.setButtonText("Add project").setCta().onClick(async () => {
      const id = "p" + Date.now().toString(36); st.projects.push({ id, name: "New project", accent: "#f5b83d", nextHead: "Next", waitHead: "Waiting on" }); if (!st.last) st.last = id;
      await p.saveSettings(); p.changed(true); this.display();
    }));
    el.createEl("h3", { text: "Global" });
    const g = (key, name, desc, ph) => new Setting(el).setName(name).setDesc(desc).addText((t) => t.setPlaceholder(ph).setValue(st[key] || "").onChange((v) => { st[key] = v; p.changed(); }));
    g("claudeDir", "Claude projects folder", "Where Claude Code stores sessions, scanned for live agents. Empty = ~/.claude/projects", "~/.claude/projects");
    g("excludeRe", "Exclude folders (regex)", "Session folders whose name matches are skipped when scanning agents.", "personal");
    g("person", "Your name", "Used in 'Waiting on <name>'. Empty matches any 'Waiting on' heading.", "");
    g("chatView", "Chat view type", "Used by the Command center layout. Default: claudian-view", "claudian-view");
    new Setting(el).setName("Text size").setDesc("Scales all of Project HQ. 100% = original size.")
      .addSlider((s) => s.setLimits(90, 175, 5).setValue(st.textScale || 125).setDynamicTooltip().onChange((v) => { st.textScale = v; p.changed(); p.app.workspace.getLeavesOfType(VIEW).forEach((l) => { l.view.contentEl.style.zoom = String(v / 100); }); }));
    new Setting(el).setName("Classic layout").setDesc("Safety fallback: turn on to use the original Project HQ pages instead of HQ_OS.")
      .addToggle((t) => t.setValue(!!st.classicLayout).onChange((v) => { st.classicLayout = v; p.changed(true); }));
    new Setting(el).setName("Open files beside Project HQ").setDesc("Notes and files never open in the chat pane; they move to Project HQ's side.")
      .addToggle((t) => t.setValue(st.filesBesideHQ !== false).onChange((v) => { st.filesBesideHQ = v; p.changed(); }));
  }
}

module.exports = class ProjectHQ extends Plugin {
  async onload() {
    const d = (await this.loadData()) || {}; this.settings = Object.assign({}, DEFAULTS, d); if (!Array.isArray(this.settings.projects)) this.settings.projects = [];
    this.registerView(VIEW, (leaf) => new HQView(leaf, this));
    this.addSettingTab(new ProjectHQSettings(this.app, this));
    this.addRibbonIcon("layout-dashboard", "Project HQ", () => this.open());
    this.addCommand({ id: "open", name: "Open Project HQ", callback: () => this.open() });
    this.addRibbonIcon("monitor", "Project HQ command center (HQ + chat)", () => this.commandCenter());
    this.addCommand({ id: "command-center", name: "Command center layout (HQ + chat)", callback: () => this.commandCenter() });
    // Keep the chat pane for chat only: any note or file that opens in the chat's tab group moves to Project HQ's tab group.
    this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => this.keepFilesBesideHQ(leaf)));
  }
  keepFilesBesideHQ(leaf) {
    if (!this.settings.filesBesideHQ || !leaf || this._moving) return;
    const ws = this.app.workspace, type = (this.settings.chatView || "claudian-view").trim();
    const vt = leaf.view && leaf.view.getViewType && leaf.view.getViewType();
    if (!vt || vt === type || vt === VIEW || vt === "empty") return;
    const chat = ws.getLeavesOfType(type).find((l) => l.parent === leaf.parent);
    const hq = ws.getLeavesOfType(VIEW)[0];
    if (!chat || !hq || hq.parent === leaf.parent || leaf.getRoot() !== ws.rootSplit) return;
    this._moving = true;
    setTimeout(async () => {
      try {
        const state = leaf.getViewState(), eState = leaf.getEphemeralState ? leaf.getEphemeralState() : undefined;
        const target = ws.createLeafInParent(hq.parent, hq.parent.children.length);
        await target.setViewState({ ...state, active: true }, eState);
        leaf.detach();
        ws.setActiveLeaf(target, { focus: true });
      } catch (e) { console.error("Project HQ: could not move the file tab", e); }
      finally { this._moving = false; }
    }, 0);
  }
  async saveSettings() { await this.saveData(this.settings); }
  // Debounced: save and refresh every open HQ view after a settings change.
  changed(now) {
    clearTimeout(this._t);
    this._t = setTimeout(async () => { await this.saveSettings(); this.app.workspace.getLeavesOfType(VIEW).forEach((l) => l.view.reload && l.view.reload()); }, now ? 0 : 600);
  }
  // HQ on the left, the chat view on the right. If the chat view is not installed, it just opens HQ.
  async commandCenter() {
    const ws = this.app.workspace, type = (this.settings.chatView || "claudian-view").trim();
    if (!this.app.viewRegistry.viewByType[type]) { await this.open(); return; }
    let chat = ws.getLeavesOfType(type)[0];
    if (!chat) { chat = ws.getLeaf("tab"); await chat.setViewState({ type }); }
    if (chat.getRoot() !== ws.rootSplit) { const m = ws.getLeaf("tab"); await m.setViewState(chat.getViewState()); chat.detach(); chat = m; }
    ws.getLeavesOfType(VIEW).forEach((l) => l.detach());
    const hq = ws.createLeafBySplit(chat, "vertical", true);
    await hq.setViewState({ type: VIEW, active: true });
    ws.setActiveLeaf(chat, { focus: true });
  }
  async open() {
    const ws = this.app.workspace;
    let leaf = ws.getLeavesOfType(VIEW)[0];
    if (!leaf) { leaf = ws.getLeaf("tab"); await leaf.setViewState({ type: VIEW, active: true }); }
    ws.revealLeaf(leaf);
  }
  onunload() { this.app.workspace.detachLeavesOfType(VIEW); }
};
