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
  const out = { id: path.basename(base), type: meta.agentType || "agent", title: meta.description || meta.agentType || "agent", model: meta.model || "", finished: meta.finished === true, waiting: [...bgStarted].filter((x) => !bgDone.has(x)).length, mtime, start, count, tool: lastTool || null, text: lastText ? lastText.text : "", steps: steps.slice(-8) };
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
  s.innerHTML = '<defs><radialGradient id="lhqsun" cx="72%" cy="38%" r="55%"><stop offset="0" stop-color="#ffd27a" stop-opacity=".85"/><stop offset=".35" stop-color="#f5b83d" stop-opacity=".3"/><stop offset="1" stop-color="#f5b83d" stop-opacity="0"/></radialGradient>' +
    '<linearGradient id="lhqsky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0b2a2e"/><stop offset="1" stop-color="#1d4a48"/></linearGradient></defs>' +
    '<rect width="800" height="300" fill="url(#lhqsky)"/><rect width="800" height="300" fill="url(#lhqsun)"/>' +
    '<path d="M0 200 L90 140 L170 190 L270 110 L380 195 L470 130 L580 200 L680 120 L800 190 V300 H0Z" fill="#17413f" opacity=".75"/>' +
    '<path d="M0 235 L110 185 L210 230 L320 170 L440 235 L560 180 L690 240 L800 205 V300 H0Z" fill="#0f2f31" opacity=".9"/>' +
    '<path d="M0 270 L130 240 L260 275 L400 240 L540 280 L680 245 L800 270 V300 H0Z" fill="#0a1d20"/>';
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
  const ta = c.createEl("textarea", { cls: "lhq-fb", attr: { placeholder: "What should change?", rows: "2" } }); ta.hide();
  const send = c.createEl("button", { cls: "lhq-btn", text: "Send changes" }); send.hide();
  act("Changes", "ch", () => { ta.toggle(); send.toggle(); ta.focus(); });
  send.onclick = () => v.decide(it, "changes", ta.value);
  act("Reject", "no", () => v.decide(it, "rejected", ""));
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
];

class HQView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; }
  getViewType() { return VIEW; }
  getDisplayText() { return "Project HQ"; }
  applyProject() {
    const st = this.plugin.settings; BASE = this.app.vault.adapter.basePath || "";
    const pr = st.projects.find((p) => p.id === st.last) || st.projects[0] || null;
    this.project = pr; setConfig(pr, st);
    const r = this.contentEl; r.style.removeProperty("--amber"); r.style.removeProperty("--amber2");
    if (pr && pr.accent) { r.style.setProperty("--amber", pr.accent); r.style.setProperty("--amber2", "color-mix(in srgb, " + pr.accent + " 75%, #ff5a1f)"); }
  }
  resetData() { Object.assign(this, { planOpen: new Set(), days: [], dsig: "", metricsRunning: false, review: [], rsig: "", live: [], liveSig: "", agents: [], todo: { live: "", next: [], wait: [] }, commits: {}, cAt: 0, sig: "", openSet: new Set(), page: "home" }); liveCache.clear(); }
  buildSwitcher() {
    const st = this.plugin.settings; this.sw.empty();
    st.projects.forEach((p) => this.sw.createEl("option", { value: p.id, text: p.name || "Untitled" }));
    this.sw.value = this.project ? this.project.id : ""; this.sw.toggle(st.projects.length > 0);
  }
  buildDock() {
    this.dock.empty(); this.dockBtns = {}; this.badge = null;
    SECTIONS.filter((s) => sectionOn(s.id)).forEach((s) => { const b = this.dock.createEl("button", { cls: "lhq-d" }); setIcon(b, s.icon); b.setAttr("aria-label", s.label); b.title = s.label; b.onclick = () => this.show(s.id); this.dockBtns[s.id] = b; if (s.id === "view") this.badge = b.createSpan({ cls: "lhq-badge zero", text: "0" }); });
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
    this.resetData(); Object.assign(this, { rfilter: "needs", boardOpen: false, liveAt: 0, usage: null, err: "", at: null, slide: 0, showIdle: false });
    this.applyProject();
    const root = this.contentEl; root.empty(); root.addClass("lhq");
    const touch = () => { this.touchedAt = Date.now(); };
    this.registerDomEvent(root, "pointerdown", touch, true); this.registerDomEvent(root, "keydown", touch, true); this.registerDomEvent(root, "focusin", touch, true);
    if (this.app.loadLocalStorage && this.app.loadLocalStorage("lhq-alt")) root.addClass("lhq-warm");
    landscape(root.createDiv({ cls: "lhq-bg" }));
    const bar = root.createDiv({ cls: "lhq-bar" });
    this.crumb = bar.createDiv({ cls: "lhq-crumb" });
    this.sw = bar.createEl("select", { cls: "lhq-sw" }); this.sw.onchange = () => this.reload(this.sw.value);
    this.chip = bar.createDiv({ cls: "lhq-livechip" });
    const right = bar.createDiv({ cls: "lhq-right" });
    const tm = right.createDiv({ cls: "lhq-time" }); this.clockEl = tm.createDiv({ cls: "lhq-clock" }); this.dateEl = tm.createDiv({ cls: "lhq-date" });
    const ib = (icon, label, fn) => { const b = right.createEl("button", { cls: "lhq-ib" }); setIcon(b, icon); b.setAttr("aria-label", label); b.title = label; b.onclick = fn; };
    ib("refresh-cw", "Refresh", () => this.refreshAll()); ib("palette", "Theme", () => { const w = root.toggleClass("lhq-warm", !root.hasClass("lhq-warm")); if (this.app.saveLocalStorage) this.app.saveLocalStorage("lhq-alt", root.hasClass("lhq-warm") ? "1" : null); });
    this.pageEl = root.createDiv({ cls: "lhq-page" });
    this.dock = root.createDiv({ cls: "lhq-dock" }); this.buildSwitcher(); this.buildDock();
    this.registerEvent(this.app.vault.on("modify", (f) => { if (f.path === ACT || f.path === TODO) this.loadFiles(); }));
    this.registerInterval(window.setInterval(() => this.loadFiles(), 10000));
    this.registerEvent(this.app.metadataCache.on("changed", (f) => { if (f.path.startsWith(DAILY + "/")) this.loadDays(); }));
    this.registerInterval(window.setInterval(() => this.runMetrics(false), 3600000));
    const rv = (f) => { if (f.path.startsWith(REVIEW + "/") || f.path === REVIEW) this.loadReview(); };
    ["create", "delete", "rename", "modify"].forEach((e) => this.registerEvent(this.app.vault.on(e, rv)));
    this.registerInterval(window.setInterval(() => this.loadUsage(), 5 * 60 * 1000));
    this.registerInterval(window.setInterval(() => this.loadCommits(), 10 * 60 * 1000));
    this.registerInterval(window.setInterval(() => { if (Date.now() - this.liveAt >= (this.page === "agents" ? 2900 : 29900)) this.loadLive(); }, 1000));
    this.registerInterval(window.setInterval(() => this.clock(), 1000));
    this.registerInterval(window.setInterval(() => { if (this.page === "home" && !this.hover && this.go && this.slideCount > 1) this.go(this.slide + 1); }, 8000));
    this.clock(); this.show("home");
    await this.loadAll();
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
    // The page redraws every few seconds (live agents, files). On the review page a redraw between press and release
    // swallowed Approve/Changes/Reject clicks and wiped typed feedback, so hold redraws there while the user is interacting.
    if (!force && this.page === "view" && Date.now() - (this.touchedAt || 0) < 20000) return;
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
      const agents = parseAgents(am), todo = parseTodo(tm);
      const sig = JSON.stringify([agents.map((x) => [x.name, x.state, x.task, x.last, x.updated]), todo]);
      this.agents = agents; this.todo = todo;
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
      await this.app.fileManager.processFrontMatter(sc, (fm) => { fm.status = status; fm.feedback = feedback || ""; fm.decided = new Date().toISOString(); if (!fm.title) fm.title = it.title; });
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

const DEFAULTS = { projects: [], last: "", claudeDir: "", excludeRe: "personal", person: "", chatView: "claudian-view", filesBesideHQ: true };
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
