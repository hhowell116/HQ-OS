// Project HQ: full-page project dashboard for Obsidian. Each page is one entry in SECTIONS: {id, label, icon, render(view, el)}.
const { Plugin, Notice, Menu, ItemView, PluginSettingTab, Setting, requestUrl, TFile, TFolder, setIcon, MarkdownRenderer, parseYaml } = require("obsidian");
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
// ---- project discovery: top-level folders of the workspace, each with Notes/ by convention ----
const WS = "Claude'sWorkspace", NOT_PROJECTS = new Set(["agent team", "token tools", "node_modules", "lumenads"]);
const slug = (x) => String(x).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } };
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } };
function discoverFolders(base) { try { return fs.readdirSync(path.join(base, WS), { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".") && !NOT_PROJECTS.has(d.name.toLowerCase())).map((d) => d.name); } catch (e) { return []; } }
const folderOf = (pr) => pr.folder || ((String(pr.todo || pr.agents || pr.review || "").match(/^([^/]+[/][^/]+)[/]/) || [])[1]) || "";
// Fill every blank path field from <folder>/Notes (a *To-Do* or *Board* note, Review, Agent Activity.md, Daily, Post Queue, Marketing Playbook).
function resolveProject(pr, base) {
  const r = Object.assign({}, pr), f = folderOf(pr); r.folder = f; r.auto = {}; if (!f) return r;
  const notes = f + "/Notes", abs = (p) => path.join(base, p), has = (p) => isFile(abs(p)), hasDir = (p) => isDir(abs(p));
  let md = []; try { md = fs.readdirSync(abs(notes)).filter((n) => /[.]md$/i.test(n)); } catch (e) {}
  const pick = (k, v) => { if (!(pr[k] || "").trim() && v) { r[k] = v; r.auto[k] = true; } };
  pick("todo", (md.find((n) => /to-?do/i.test(n)) && notes + "/" + md.find((n) => /to-?do/i.test(n))) || (md.find((n) => /board/i.test(n)) && notes + "/" + md.find((n) => /board/i.test(n))) || "");
  pick("agents", has(notes + "/Agent Activity.md") ? notes + "/Agent Activity.md" : "");
  pick("review", hasDir(notes + "/Review") ? notes + "/Review" : "");
  pick("daily", hasDir(notes + "/Daily") ? notes + "/Daily" : "");
  pick("queue", has(notes + "/Post Queue.md") ? notes + "/Post Queue.md" : "");
  pick("playbook", has(notes + "/Marketing Playbook.md") ? notes + "/Marketing Playbook.md" : "");
  pick("repo", hasDir(f + "/.git") ? f : "");
  // extra folders (comma separated, e.g. LumenAds under Lumen): fill what the main folder lacks from their Notes/tools
  r.extras = String(pr.extra || "").split(",").map((x) => x.trim().replace(/[/]+$/, "")).filter(Boolean).map((x) => (x.includes("/") ? x : WS + "/" + x));
  for (const x of r.extras) {
    pick("queue", has(x + "/Notes/Post Queue.md") ? x + "/Notes/Post Queue.md" : ""); pick("playbook", has(x + "/Notes/Marketing Playbook.md") ? x + "/Notes/Marketing Playbook.md" : "");
    pick("creditsScript", has(x + "/tools/eleven.mjs") ? x + "/tools/eleven.mjs" : "");
  }
  return r;
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
  res.forEach((a) => { const fresh = now - a.mtime < 45 * 60000; if (a.waiting && fresh) { a.status = "running"; a.text = "Waiting on " + a.waiting + " background run(s) (tests/build)"; } else a.status = a.finished ? "done" : now - a.mtime < 15 * 60000 ? "running" : "stalled"; }); // agents waiting on test runs are caught by a.waiting above; any other agent silent for 15 min has almost always died with its chat
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
// ESTIMATE ONLY: API list prices in USD per million tokens (in = input, out = output, cr = cache read, c5/c1 = cache write 5 min / 1 h). Edit here.
const PRICES = { opus: { in: 5, out: 25, cr: 0.5, c5: 6.25, c1: 10 }, sonnet: { in: 3, out: 15, cr: 0.3, c5: 3.75, c1: 6 }, haiku: { in: 1, out: 5, cr: 0.1, c5: 1.25, c1: 2 } };
const family = (m) => { m = String(m || "").toLowerCase(); return m.includes("opus") ? "opus" : m.includes("haiku") ? "haiku" : m.includes("sonnet") ? "sonnet" : ""; };
const shortModel = (m) => String(m || "").replace(/^claude-/, "").replace(/-\d{8}$/, "");
function usageCost(u, model) {
  const p = (MODS.progress.prices || PRICES)[family(model)]; if (!u || !p) return 0;
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
  const t = typedText(o); if (!t || t.length < 10 || !(MODS.rules.on && ruleRe().test(t))) return;
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
  if (!MODS.cache.on) return null;
  const u = mainState.usage; if (!u || !mainState.ts) return null;
  const age = (Date.now() - mainState.ts) / 60000, ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  const state = age >= MODS.cache.cold ? "cold" : age >= MODS.cache.warn ? "warn" : "warm";
  const left = Math.max(0, Math.ceil(MODS.cache.cold - age));
  const msg = state === "cold" ? "Cache cold: your next message re-reads the whole chat (~" + kfmt(ctx) + " tokens)" : state === "warn" ? "Cache going cold in " + left + " min" : "Cache warm · " + left + " min left";
  return { age, ctx, state, msg, compact: ctx > MODS.cache.compact * 1000, cost: usageCost({ input_tokens: ctx }, mainState.model) };
}

// ----- action items from agents' final reports -----
const ACTION_CATS = [
  ["need", "Needs you", /\b(hayden|you need to|needs your|need your|waiting on|please check|your call|your approval|your decision)\b/i],
  ["money", "Money", /\$\s?\d|\b(paid|credits?|billing|invoice)\b/i],
  ["sec", "Security", /\b(security|secrets?|keys?|passwords?|vulnerab\w*)\b/i],
  ["fail", "Problem", /\b(failed|failing|fail|blocked|errors?|failures?)\b/i],
];
const ACTION_SKIP = /\b0 (failed|fail|failures?|errors?|vulnerabilities)\b|\bno (errors?|failures?|vulnerabilit\w+|issues)\b|\bwithout errors?\b|\b0 high\b|^\|?[-: |]+$/i;
function actionCats() {
  const a = MODS.actions, l = ACTION_CATS.filter((c) => a[c[0]] !== false), kw = String(a.keywords || "").split(",").map((x) => x.trim()).filter(Boolean);
  if (kw.length) l.push(["need", "Keyword", new RegExp("\\b(" + kw.map(escRe).join("|") + ")\\b", "i")]);
  return l;
}
function actionItems(text, src) {
  const out = []; if (!MODS.actions.on) return out;
  for (const raw of String(text || "").split(/\n+/)) {
    const line = redact(raw.replace(/^[\s>*\-#]+/, "").replace(/^\d+[.)]\s+/, "").replace(/[*`_]/g, "").replace(/\s+/g, " ").trim());
    if (line.length < 14 || ACTION_SKIP.test(line)) continue;
    const c = actionCats().find((x) => x[2].test(line)); if (!c) continue;
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
      b.createDiv({ cls: "lhq-muted", text: "Last reply " + agoText(ci.age) + " · context ~" + kfmt(ci.ctx) + " tokens · cache lasts " + MODS.cache.cold + " min" });
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
      if (st) { tot += st.cost; m.createSpan({ text: "in " + kfmt(st.tin) + " · out " + kfmt(st.tout) + " · cache " + kfmt(st.tcr + st.tcc) }); if (MODS.progress.cost) { const e = m.createSpan({ cls: "lhq-est", text: "~" + usd(st.cost) + " est." }); e.title = "Estimate from API list prices, not your plan's billing"; } }
    });
    const hqT = v.plugin.hq && v.plugin.hq.todayTotals(); if (hqT && hqT.n) { const c = b.createDiv({ cls: "lhq-pcard done" }), h = c.createDiv({ cls: "lhq-top" }); h.createDiv({ cls: "lhq-name", text: "HQ chat (today)" }); h.createDiv({ cls: "lhq-chips" }).createSpan({ text: hqT.n + " turns" }); const m = c.createDiv({ cls: "lhq-meta" }); m.createSpan({ text: "in " + kfmt(hqT.tin) + " · out " + kfmt(hqT.tout) + " · cache " + kfmt(hqT.cache) }); if (MODS.progress.cost) m.createSpan({ cls: "lhq-est", text: "~" + usd(hqT.cost) + " est." }); }
    if (list.length && MODS.progress.cost) b.createDiv({ cls: "lhq-muted", text: "Costs are rough estimates from API list prices (subscription use is not billed per token)." }); }
  // files
  if (W("files")) { const withFiles = run.filter((a) => a.st && a.st.files.size).slice(0, 5), b = insPanel(v, el, "files", "Files in play", withFiles.reduce((n, a) => n + Math.min(MODS.files.max, a.st.files.size), 0));
    if (!withFiles.length) b.createDiv({ cls: "lhq-muted", text: "No running agent has touched files yet." });
    withFiles.forEach((a) => {
      b.createDiv({ cls: "lhq-fg", text: a.title });
      [...a.st.files.values()].filter((f) => !sensitivePath(f.p)).reverse().slice(0, MODS.files.max).forEach((f) => {
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
      MODS.rules.targets.forEach((t, i) => btn("Save to " + t.label, i ? "ch" : "ok", () => v.insSave(c, ta.value, t), t.kind === "rules" ? "Appends under: " + sec : "Appends under: Inbox (to sort)"));
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
// ===== MODS: one switch + settings per feature, persisted in plugin data (settings.mods) and read live through MODS =====
const GUARD_FOLDERS = ["node_modules", ".claude/worktrees", "dist", "build", ".cache", "tmp", ".tmp", "LumenAds/out"];
const RULE_TRIGGERS = ["never", "always", "from now on", "don't", "do not", "dont", "stop", "i wish", "make sure", "let's not", "lets not", "shouldn't", "should not", "no more", "instead of"];
const MOD_LIST = [
  ["progress", "AGENT PROGRESS", "Per-agent tool calls, tokens and an estimated cost."],
  ["files", "FILES IN PLAY", "Files the running agents are reading and editing."],
  ["cache", "CACHE WARNING", "Warns before the prompt cache goes cold and nudges /compact on a big chat."],
  ["rules", "SAVE AS RULE", "Spots corrections in your messages and saves them as rules."],
  ["orb", "PARTICLE ORB", "The animated sphere in the middle."],
  ["chat", "HQ CHAT", "The built-in Claude Code chat."],
  ["guard", "DELETE GUARD", "Blocks recursive deletes outside throwaway folders (hook for Claude Code)."],
];
const MOD_DEFAULTS = {
  progress: { on: true, cost: true, refresh: 3, prices: JSON.parse(JSON.stringify(PRICES)) },
  files: { on: true, max: 6, collapsed: false },
  cache: { on: true, warn: 50, cold: 60, compact: 150 },
  rules: { on: true, triggers: RULE_TRIGGERS.slice(), days: 7, targets: [{ label: "Rules.md", path: "Claude'sWorkspace/Rules.md", kind: "rules" }, { label: "Marketing Playbook", path: "", kind: "playbook" }] },
  actions: { on: true, need: true, money: true, sec: true, fail: true, keywords: "" },
  orb: { on: true, particles: 900, fps: 32, arcs: true, audio: true, audioK: 100, nowPlaying: true },
  chat: { on: false, model: "", effort: "", tools: false, cost: true }, // HQ's own chat is off by default (2026-11-08): the box talks to Claudian chats
  guard: { on: true, folders: GUARD_FOLDERS.slice() },
};
const cloneJ = (o) => JSON.parse(JSON.stringify(o));
function buildMods(saved) {
  const m = cloneJ(MOD_DEFAULTS);
  for (const k of Object.keys(m)) { const s = saved && saved[k]; if (s && typeof s === "object") for (const f of Object.keys(m[k])) if (s[f] !== undefined && typeof s[f] === typeof m[k][f] && Array.isArray(s[f]) === Array.isArray(m[k][f])) m[k][f] = s[f]; }
  return m;
}
let MODS = cloneJ(MOD_DEFAULTS);
const MODSTAT = {};
const modErr = (k, e) => { const m = String((e && e.message) || e).slice(0, 220); MODSTAT[k] = { err: m, last: m, at: Date.now() }; };
const modOk = (k) => { const s = MODSTAT[k]; if (s && s.err) MODSTAT[k] = { err: "", last: s.last, at: s.at }; };
const modState = (k) => (!MODS[k].on ? "off" : MODSTAT[k] && MODSTAT[k].err ? "error" : "running");
const ruleReCache = { key: "", re: null };
function ruleRe() { // built from the editable trigger list; "no" as an opening word always counts
  const list = MODS.rules.triggers.map((x) => String(x).trim()).filter(Boolean), key = list.join("\n");
  if (ruleReCache.key !== key || !ruleReCache.re) {
    const body = list.map((x) => escRe(x).replace(/'/g, "'?").replace(/\s+/g, "\\s+")).join("|");
    let re = null; try { re = new RegExp((body ? "\\b(" + body + ")\\b|" : "") + "^\\s*no\\b[\\s,.!]", "i"); } catch (e) { re = /^\s*no\b[\s,.!]/i; }
    ruleReCache.key = key; ruleReCache.re = re;
  }
  return ruleReCache.re;
}

// ===== THEMES: CSS variables on the HQ root only =====
const hex2rgb = (h) => { h = String(h || "").replace("#", ""); if (h.length === 3) h = h.split("").map((c) => c + c).join(""); const n = parseInt(h, 16); return h.length !== 6 || isNaN(n) ? [0, 0, 0] : [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const rgb2hex = (c) => "#" + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
const mixC = (a, b, t) => { const x = hex2rgb(a), y = hex2rgb(b); return rgb2hex(x.map((v, i) => v + (y[i] - v) * t)); };
const relLum = (c) => { const [r, g, b] = hex2rgb(c).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrastOf = (a, b) => { const l1 = relLum(a), l2 = relLum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
const HQ_PRESETS = [
  { id: "cyan", name: "Cyan", accent: "#19e3d0", accent2: "#14b8a6", warn: "#ffb02e", danger: "#ff5d6c", bg: "#04080b", panel: "#071217" },
  { id: "amber", name: "Amber", accent: "#ffb02e", accent2: "#f59e0b", warn: "#ff7a2e", danger: "#ff5d6c", bg: "#0a0804", panel: "#16100a" },
  { id: "matrix", name: "Matrix Green", accent: "#3dff6e", accent2: "#19c24a", warn: "#d6ff3d", danger: "#ff5d6c", bg: "#020a04", panel: "#06140a" },
  { id: "crimson", name: "Crimson", accent: "#ff3b5c", accent2: "#d9304f", warn: "#ffb02e", danger: "#ff8a3d", bg: "#0b0406", panel: "#170709" },
  { id: "violet", name: "Violet", accent: "#a78bfa", accent2: "#7c5cf0", warn: "#ffb02e", danger: "#ff5d6c", bg: "#07050d", panel: "#100c1c" },
  { id: "mono", name: "Mono", accent: "#e5e7eb", accent2: "#9ca3af", warn: "#fbbf24", danger: "#f87171", bg: "#08090a", panel: "#131416" },
  { id: "ice", name: "Ice", accent: "#7dd3fc", accent2: "#38bdf8", warn: "#fcd34d", danger: "#fb7185", bg: "#040a10", panel: "#091621" },
].map((t) => Object.assign({ glow: 1, grid: 1, scan: 1, scanOn: true }, t));
// Accent changer (Hayden 2026-11-08): one accent colour laid over any theme. "" = use the theme's own accent.
const HQ_ACCENTS = [["Cyan", "#19e3d0"], ["Teal", "#14b8a6"], ["Ice", "#7dd3fc"], ["Blue", "#60a5fa"], ["Violet", "#a78bfa"], ["Pink", "#f472b6"], ["Red", "#ff3b5c"], ["Orange", "#fb923c"], ["Amber", "#ffb02e"], ["Green", "#3dff6e"], ["White", "#e5e7eb"]];
const shadeHex = (h, f) => { const n = parseInt(h.slice(1), 16); return "#" + [n >> 16, (n >> 8) & 255, n & 255].map((v) => Math.max(0, Math.min(255, Math.round(v * f))).toString(16).padStart(2, "0")).join(""); };
const THEME_KEYS = ["accent", "accent2", "warn", "danger", "bg", "panel"];
const hexOk = (x) => /^#[0-9a-f]{6}$/i.test(String(x || ""));
function cleanTheme(o, base) { // import/saved themes are validated field by field
  const t = Object.assign({}, base || HQ_PRESETS[0]); o = o || {};
  for (const k of THEME_KEYS) if (hexOk(o[k])) t[k] = String(o[k]).toLowerCase();
  const n = (v, lo, hi, d) => (typeof v === "number" && isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);
  t.glow = n(o.glow, 0, 1.5, t.glow); t.grid = n(o.grid, 0, 1, t.grid); t.scan = n(o.scan, 0, 1, t.scan); t.scanOn = o.scanOn === undefined ? t.scanOn : !!o.scanOn;
  return t;
}
function themeDerive(t) { // readable text colours for this panel, auto-corrected to AA
  const panel = mixC(t.bg, t.panel, 0.82), light = relLum(panel) > 0.35, end = light ? "#000000" : "#ffffff";
  const fix = (c) => { let x = c, i = 0; while (contrastOf(x, panel) < 4.6 && i++ < 20) x = mixC(x, end, 0.1); return x; };
  return { panel, tx: fix(mixC(t.accent, end, 0.85)), dim: fix(mixC(mixC(t.accent, "#b4bcc0", 0.55), panel, light ? 0.2 : 0.15)) };
}
function themeChecks(t) {
  const d = themeDerive(t), rows = [["Body text", d.tx, d.panel], ["Dim text", d.dim, d.panel], ["Accent text", t.accent, d.panel], ["Secondary accent", t.accent2, d.panel], ["Warning text", t.warn, d.panel], ["Danger text", t.danger, d.panel], ["Accent on background", t.accent, t.bg]];
  return rows.map(([label, fg, bg]) => { const r = contrastOf(fg, bg); return { label, fg, bg, ratio: r, pass: r >= 4.5 }; });
}
function themeVars(t) {
  const d = themeDerive(t), rg = (c) => hex2rgb(c).join(",");
  return {
    "--os-cy": t.accent, "--os-teal": t.accent2, "--os-ac": t.orb || t.accent, "--os-acrgb": rg(t.orb || t.accent), "--os-am": t.warn, "--os-red": t.danger, "--os-dim": d.dim, "--os-bg0": t.bg, "--os-solid": mixC(t.bg, t.panel, 0.9),
    "--os-cyrgb": rg(t.accent), "--os-amrgb": rg(t.warn), "--os-redrgb": rg(t.danger), "--os-bgrgb": rg(mixC(t.bg, "#000000", 0.2)), "--os-panelrgb": rg(t.panel),
    "--os-glowk": String(t.glow), "--os-gridk": String(t.grid), "--os-scank": String(t.scanOn ? t.scan : 0),
    "--tx": d.tx, "--tx2": d.dim, "--amber": t.accent, "--amber2": t.accent2, "--bg1": t.bg, "--bg2": t.panel, "--bg3": t.bg, "--teal": t.panel, "--teal2": mixC(t.panel, t.accent, 0.1),
    "--glass": "rgba(" + rg(t.accent) + ",.05)", "--glass-b": "rgba(" + rg(t.accent) + ",.28)",
  };
}
const THEME_RGB = { a: [25, 227, 208], w: [255, 176, 46], glow: 1, key: "" };
class HQView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; }
  getViewType() { return VIEW; }
  getDisplayText() { return "Project HQ"; }
  applyProject() {
    const st = this.plugin.settings; BASE = this.app.vault.adapter.basePath || "";
    const vis = this.plugin.visibleProjects(), pr0 = vis.find((p) => p.id === st.last) || vis[0] || null, pr = pr0 ? resolveProject(pr0, BASE) : null;
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
    const vis = this.plugin.visibleProjects(); vis.forEach((p) => this.sw.createEl("option", { value: p.id, text: p.name || "Untitled" }));
    this.sw.value = this.project ? this.project.id : ""; this.sw.toggle(vis.length > 0);
  }
  buildDock() {
    this.dock.empty(); this.dockBtns = {}; this.badge = null; this.insBadge = null;
    SECTIONS.filter((s) => sectionOn(s.id)).forEach((s) => { const b = this.dock.createEl("button", { cls: "lhq-d" }); setIcon(b, s.icon); b.setAttr("aria-label", s.label); b.title = s.label; b.onclick = () => this.show(s.id); this.dockBtns[s.id] = b; if (s.id === "view") this.badge = b.createSpan({ cls: "lhq-badge zero", text: "0" }); if (s.id === "insights") this.insBadge = b.createSpan({ cls: "lhq-badge zero", text: "0" }); });
  }
  async reload(id) {
    if (id) { this.plugin.settings.last = id; await this.plugin.saveSettings(); }
    this.applyProject(); this.resetData(); this.buildSwitcher(); this.buildDock();
    if (this.os && this.osUI) { this.osUI.sig = {}; this.osTaskAdd = null; this.osTaskAll = false; this.osRevAll = false; this.osEleven = undefined; this.osProjSwitch(); }
    this.touchedAt = 0; this.show("home"); await this.loadAll(); this.touchedAt = 0; this.renderPage(false, true);
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
    this.registerInterval(window.setInterval(() => this.insTick(), 1000)); // one shared throttled poll for the Insights panels; skips work while HQ is hidden
    this.registerInterval(window.setInterval(() => { if (this.page === "home" && !this.hover && this.go && this.slideCount > 1) this.go(this.slide + 1); }, 8000));
    this.clock(); this.show("home");
    this.insTick(true);
    await this.loadAll();
  }
  insHandled() { const s = this.plugin.settings; s.insights = s.insights || {}; s.insights.handled = s.insights.handled || []; return s.insights.handled; }
  async insHandleMany(ids, why) { const h = this.insHandled(); ids.forEach((id) => { if (!h.includes(id)) h.push(id); }); if (h.length > 800) h.splice(0, h.length - 800); await this.plugin.saveSettings(); this.touchedAt = 0; this.insActAt = 0; await this.insTick(true); this.renderPage(false, true); }
  insHandle(id, why) { return this.insHandleMany([id], why); }
  insRules() { if (!MODS.rules.on) return []; const h = new Set(this.insHandled()), cut = Date.now() - MODS.rules.days * 864e5; return mainState.typed.filter((c) => !h.has(c.id) && c.ts > cut).slice().reverse(); }
  insActions() { return this.insActs; }
  async insSave(c, text, where) {
    text = String(text || "").trim(); if (!text) return;
    try {
      const t = where && where.kind ? where : MODS.rules.targets[0], p = t.path || (t.kind === "playbook" ? (this.project && this.project.playbook) || PLAYBOOK_PATH : RULES_PATH);
      if (sensitivePath(p)) throw new Error("That path is off limits.");
      if (t.kind === "rules") await appendTo(this.app, p, ruleSection(text), text, true); else await appendTo(this.app, p, "Inbox (to sort)", text, false);
      new Notice("Saved to " + t.label); delete this.insText[c.id]; await this.insHandle(c.id, "saved");
    } catch (e) { console.error("Project HQ save rule", e); new Notice("Could not save: " + (e && e.message || e)); }
  }
  async insActionsUpdate(force) {
    { this.insActs = []; return; } // action items panel removed (Hayden 2026-11-09)
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
    if (!force && Date.now() - (this.insAt || 0) < MODS.progress.refresh * 1000 - 300) return; this.insAt = Date.now();
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
      if (sig !== this.liveSig) { this.liveSig = sig; if (this.page === "agents" || this.page === "home" || this.os) this.renderPage(); }
    } catch (e) { console.error("Project HQ live", e); } finally { this.scanning = false; }
  }
  clock() {
    const n = new Date();
    this.contentEl.querySelectorAll(".lhq-el").forEach((e) => { e.setText(dur(Date.now() - +e.dataset.start)); });
    this.clockEl.setText(n.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
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
    const plat = { TT: "TikTok", YT: "YouTube", FB: "Facebook", IG: "Instagram", X: "X", PIN: "Pinterest" }[(parts[0] || "").toUpperCase()] || parts[0] || "";
    open.push({ line: i, text: plat + " · " + (file || parts[1] || "").replace(/-v\d+$/, "").replace(/-/g, " ").slice(0, 60) });
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
  // expand: the panel fills the dashboard so everything in it is readable at once; Esc, the button or a click outside closes it
  const x = h.createEl("button", { cls: "os-pmax", text: "⤢", attr: { "aria-label": "Expand " + title, title: "Expand", "aria-pressed": "false" } });
  const close = () => { p.removeClass("os-max"); x.setText("⤢"); x.setAttr("aria-pressed", "false"); x.setAttr("aria-label", "Expand " + title); document.removeEventListener("keydown", esc, true); document.removeEventListener("pointerdown", out, true); const g = p.closest(".os-grid"); if (g && !g.querySelector(".os-max")) g.removeClass("has-max"); };
  const esc = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } }, out = (e) => { if (!p.contains(e.target)) close(); };
  x.onclick = (e) => { e.stopPropagation(); if (p.hasClass("os-max")) return close(); const g = p.closest(".os-grid"); if (g) { g.querySelectorAll(".os-max .os-pmax").forEach((b) => b !== x && b.click()); g.addClass("has-max"); }
    p.addClass("os-max"); x.setText("✕"); x.setAttr("aria-pressed", "true"); x.setAttr("aria-label", "Close expanded " + title); setTimeout(() => { document.addEventListener("keydown", esc, true); document.addEventListener("pointerdown", out, true); }, 0); };
  return { p, h, meta, body: p.createDiv({ cls: "os-pb" }) };
}
// ----- the particle orb (2D canvas, projected sphere; ~30 fps; paused when HQ is not visible) -----
const HQAudio = window.__hqAudio = {
  on: false, busy: false, err: "", bands: new Float32Array(24), level: 0, bass: 0,
  async start() {
    if (this.on || this.busy || Date.now() - (this.failAt || 0) < 60000) return; this.busy = true; this.err = "";
    try {
      const st = await navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: "desktop" } }, video: { mandatory: { chromeMediaSource: "desktop", maxWidth: 1, maxHeight: 1, maxFrameRate: 1 } } });
      this.stream = st; const at = st.getAudioTracks(); if (!at.length) throw new Error("no desktop audio track");
      this.ctx = new AudioContext(); this.an = this.ctx.createAnalyser(); this.an.fftSize = 512; this.an.smoothingTimeConstant = 0.78;
      this.ctx.createMediaStreamSource(new MediaStream(at)).connect(this.an); this.buf = new Uint8Array(this.an.frequencyBinCount); this.on = true;
    } catch (e) { this.err = String(e && e.message || e); this.failAt = Date.now(); console.warn("Project HQ orb audio", e); this.stop(); }
    this.busy = false;
  },
  stop() { this.on = false; try { if (this.stream) this.stream.getTracks().forEach((t) => t.stop()); } catch (e) {} try { if (this.ctx) this.ctx.close(); } catch (e) {} this.stream = this.ctx = this.an = null; this.level = this.bass = 0; this.bands.fill(0); },
  read() { // 24 log-spaced bands, 0..1
    if (!this.on || !this.an) { this.level *= 0.9; this.bass *= 0.9; for (let i = 0; i < 24; i++) this.bands[i] *= 0.9; return; }
    const d = this.buf; this.an.getByteFrequencyData(d); const n = d.length; let tot = 0;
    for (let i = 0; i < 24; i++) { const a = Math.floor(Math.pow(n * 0.7, i / 24)), b = Math.max(a + 1, Math.floor(Math.pow(n * 0.7, (i + 1) / 24))); let m = 0; for (let j = a; j < b; j++) m = Math.max(m, d[j]); this.bands[i] = m / 255; tot += m / 255; }
    this.level = tot / 24; this.bass = (this.bands[2] + this.bands[3] + this.bands[4] + this.bands[5]) / 4;
  },
};
const HQNow = {
  proc: null, data: null, subs: new Set(), failAt: 0,
  start(script) {
    if (this.proc || Date.now() - this.failAt < 60000 || !fs.existsSync(script)) return;
    try {
      const p = this.proc = require("child_process").spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
      let buf = ""; p.stdout.on("data", (d) => { buf += d.toString("utf8"); let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l.startsWith("{")) { try { this.data = JSON.parse(l); this.subs.forEach((f) => f(this.data)); } catch (e) {} } } });
      p.on("exit", () => { if (this.proc === p) { this.proc = null; this.failAt = Date.now(); } }); p.on("error", () => { if (this.proc === p) { this.proc = null; this.failAt = Date.now(); } });
    } catch (e) { this.proc = null; this.failAt = Date.now(); }
  },
  stop() { const p = this.proc; this.proc = null; if (p) { try { require("child_process").execFile("taskkill", ["/PID", String(p.pid), "/T", "/F"], { windowsHide: true }, () => {}); } catch (e) { try { p.kill(); } catch (e2) {} } } this.data = null; this.subs.forEach((f) => f(null)); },
  pick(d) { // the playing session Windows calls current, else any playing one
    const ss = (d && d.sessions) || []; const pl = ss.filter((x) => x.status === "Playing" && x.title); return pl.find((x) => x.app === d.current) || pl[0] || null;
  },
  appName(id) { const a = String(id || "").split("!").pop().replace(/\.exe$/i, ""); return /spotify/i.test(a) ? "Spotify" : /msedge/i.test(a) ? "Edge" : /chrome/i.test(a) ? "Chrome" : /brave/i.test(a) ? "Browser" : /firefox/i.test(a) ? "Firefox" : /zune|music/i.test(a) ? "Media Player" : a.charAt(0).toUpperCase() + a.slice(1); },
};
window.addEventListener("beforeunload", () => HQNow.stop());
function hueShift(rgb, deg) { // rotate a colour's hue (for the equalizer's edge colour)
  let [r, g, b] = rgb.map((x) => x / 255); const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn; let h = 0, s2 = 0;
  if (d) { s2 = d / (1 - Math.abs(2 * l - 1)); h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60; }
  h = (h + deg + 360) % 360; s2 = Math.max(s2, 0.75); const c = (1 - Math.abs(2 * l - 1)) * s2, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
  const [a, b2, c2] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [a, b2, c2].map((v) => Math.round((v + m) * 255));
}
class Orb {
  constructor(cv) {
    this.cv = cv; this.ctx = cv.getContext("2d"); this.seed(MODS.orb.particles);
    Object.assign(this, { rot: 0, int: 0.25, target: 0.25, tint: 0, tintT: 0, arcs: [], nextArc: 0, last: 0, on: false, raf: 0, w: 0, h: 0, cost: 0, frames: 0, dpr: 1, still: matchMedia("(prefers-reduced-motion: reduce)").matches });
    this.loop = (t) => { try { this.frame(t); if (MODSTAT.orb && MODSTAT.orb.err) modOk("orb"); } catch (e) { modErr("orb", e); this.on = false; cancelAnimationFrame(this.raf); } };
  }
  seed(n) { const N = this.N = n;
    this.X = new Float32Array(N); this.Y = new Float32Array(N); this.Z = new Float32Array(N);
    for (let i = 0; i < N; i++) { const y = 1 - (i + 0.5) * 2 / N, r = Math.sqrt(1 - y * y), th = i * 2.399963, k = 0.96 + Math.random() * 0.08; this.X[i] = Math.cos(th) * r * k; this.Y[i] = y * k; this.Z[i] = Math.sin(th) * r * k; }
    this.bx = [0, 1, 2, 3].map(() => new Float32Array(N * 2)); this.bn = [0, 0, 0, 0]; }
  resize() {
    const cv = this.cv, w = cv.clientWidth, h = cv.clientHeight; if (!w || !h) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5); cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    this.w = cv.width; this.h = cv.height; this.s = Math.min(this.w, this.h) * 0.42; this.dpr = dpr;
    const gk = Math.min(1.5, THEME_RGB.glow), gs = this.gs = Math.round(this.s * 2.8), mk = (rgb) => { const g = document.createElement("canvas"); g.width = g.height = gs; const x = g.getContext("2d"), rg = x.createRadialGradient(gs / 2, gs / 2, this.s * 0.1, gs / 2, gs / 2, gs / 2); rg.addColorStop(0, "rgba(" + rgb + "," + (0.34 * gk).toFixed(3) + ")"); rg.addColorStop(0.45, "rgba(" + rgb + "," + (0.1 * gk).toFixed(3) + ")"); rg.addColorStop(1, "rgba(" + rgb + ",0)"); x.fillStyle = rg; x.fillRect(0, 0, gs, gs); return g; };
    this.glow = mk(THEME_RGB.a.join(",")); this.glowA = mk(THEME_RGB.w.join(","));
  }
  eq(ctx, cx, cy, R, AF, ak, dpr) {
    // mirrored pixel equalizer: auto-gain so loud audio never turns into a solid slab, tapered ends that fizzle out, soft flickering tips
    const cols = 69, half = (cols - 1) / 2, span = R * 2.1, cw = span / cols, cell = Math.max(2, cw * 0.72), maxN = 15, A = THEME_RGB.a, B = THEME_RGB.e || THEME_RGB.w;
    this.eqH = this.eqH && this.eqH.length === cols ? this.eqH : new Float32Array(cols);
    let pk = 0; for (let i = 0; i < 24; i++) pk = Math.max(pk, AF[i]); this.eqPk = Math.max(pk, (this.eqPk || 0.3) * 0.996); const gain = 0.82 / Math.max(0.22, this.eqPk);
    // silence: fade the whole equalizer out instead of leaving a flat line; fade back in when sound returns
    this.eqA = (this.eqA || 0) + ((pk * ak > 0.012 ? 1 : 0) - (this.eqA || 0)) * (pk * ak > 0.012 ? 0.25 : 0.05); if (this.eqA < 0.02) return; ctx.globalAlpha *= this.eqA;
    // each band also keeps its own slow peak, so quiet highs still move (half global level, half per-band level)
    const bp = this.eqBP = this.eqBP || new Float32Array(24).fill(0.2), N = this.eqN = this.eqN || new Float32Array(24);
    for (let i = 0; i < 24; i++) { bp[i] = Math.max(AF[i], bp[i] * 0.997, 0.06); N[i] = 0.5 * Math.min(1, AF[i] * gain) + 0.5 * Math.min(1, 0.85 * AF[i] / bp[i]) * Math.min(1, pk * 4); }
    const sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
    for (let c = 0; c < cols; c++) {
      const d = Math.abs(c - half) / half, f = Math.max(0, 1 - d / 0.85) * 23, i0 = Math.floor(f), i1 = Math.min(23, i0 + 1), v = N[i0] + (N[i1] - N[i0]) * (f - i0);
      const env = (0.45 + 0.55 * sm(0, 0.22, d)) * (1 - sm(0.6, 1, d)); // dip in the centre, taper to nothing at the ends
      const tgt = Math.min(1, Math.pow(v * ak, 1.25) * env); this.eqH[c] += (tgt - this.eqH[c]) * (tgt > this.eqH[c] ? 0.55 : 0.16);
      const h = this.eqH[c] * maxN, n = Math.max(1, Math.ceil(h)), x = cx - span / 2 + c * cw + (cw - cell) / 2, m = Math.pow(d, 0.8);
      const r = Math.round(A[0] + (B[0] - A[0]) * m), g = Math.round(A[1] + (B[1] - A[1]) * m), b = Math.round(A[2] + (B[2] - A[2]) * m);
      for (let k = 0; k < n; k++) { // crisp pixels: no random dropout or flicker
        const a = 0.95 - 0.45 * Math.pow(k / maxN, 1.4); ctx.fillStyle = "rgba(" + r + "," + g + "," + b + "," + a.toFixed(3) + ")";
        const yUp = cy - cell / 2 - k * cw, yDn = cy - cell / 2 + k * cw; ctx.fillRect(x, yUp, cell, cell); if (k) ctx.fillRect(x, yDn, cell, cell);
      }
    }
    const tail = 7; ctx.fillStyle = "rgba(" + B.join(",") + ",0.85)";
    for (let j = 1; j <= tail; j++) { const xl = cx - span / 2 - j * cw + (cw - cell) / 2, xr = cx + span / 2 + (j - 1) * cw + (cw - cell) / 2; ctx.fillRect(xl, cy - cell / 2, cell, cell); ctx.fillRect(xr, cy - cell / 2, cell, cell); }
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
    const gap = this.still ? 120 : Math.max(8, 1000 / Math.max(5, MODS.orb.fps) - 2); if (t - this.last < gap) return;
    if (this.N !== MODS.orb.particles) this.seed(MODS.orb.particles); if (this.tk !== THEME_RGB.key) { this.tk = THEME_RGB.key; this.resize(); }
    const dt = Math.min(0.1, (t - (this.last || t - gap)) / 1000); this.last = t; const t0 = performance.now();
    if (!this.w) { this.resize(); if (!this.w) return; }
    const ctx = this.ctx, W = this.w, H = this.h, cx = W / 2, cy = H / 2, dpr = this.dpr;
    this.int += (this.target - this.int) * Math.min(1, dt * 1.5); this.tint += (this.tintT - this.tint) * Math.min(1, dt * 2);
    const I = this.int; HQAudio.read(); const ak = MODS.orb.audio ? (MODS.orb.audioK || 100) / 100 : 0, AL = HQAudio.level * ak, AB = HQAudio.bass * ak, AF = HQAudio.bands;
    this.rot += dt * (this.still ? 0.02 : 0.1 + 0.3 * I);
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
    const col = (a) => "rgba(" + Math.round(THEME_RGB.a[0] + (THEME_RGB.w[0] - THEME_RGB.a[0]) * mix) + "," + Math.round(THEME_RGB.a[1] + (THEME_RGB.w[1] - THEME_RGB.a[1]) * mix) + "," + Math.round(THEME_RGB.a[2] + (THEME_RGB.w[2] - THEME_RGB.a[2]) * mix) + "," + a.toFixed(3) + ")";
    for (let b = 0; b < 4; b++) { ctx.fillStyle = col(base[b] * (0.55 + 0.45 * I)); const a = this.bx[b], n = this.bn[b], s = sz[b]; for (let j = 0; j < n; j += 2) ctx.fillRect(a[j], a[j + 1], s, s); }
    if (ak && (HQAudio.on || AL > 0.002)) { const dim = ctx.canvas.closest(".os-mid.chatting") ? 0.9 : 1; ctx.save(); ctx.globalAlpha *= dim; this.eq(ctx, cx, cy, R, AF, ak, dpr); ctx.restore(); }
    // lightning arcs: only while agents are working, at most 2 at once, each lives ~0.5 s and they spawn >= 0.55 s apart (never > 3 Hz)
    if (MODS.orb.arcs && !this.still && I > 0.6 && t > this.nextArc && this.arcs.length < 2) {
      this.nextArc = t + 550 + Math.random() * 900; const a = (Math.random() * this.N) | 0; let b = (Math.random() * this.N) | 0, g = 0;
      while (g++ < 40 && Math.abs(this.X[a] * this.X[b] + this.Y[a] * this.Y[b] + this.Z[a] * this.Z[b]) > 0.5) b = (Math.random() * this.N) | 0;
      this.arcs.push({ a, b, born: t });
    }
    this.arcs = this.arcs.filter((r) => t - r.born < 520);
    for (const r of this.arcs) {
      const A = this.pt(r.a, cx, cy, R, cs), B = this.pt(r.b, cx, cy, R, cs), f = 1 - (t - r.born) / 520, mx = (A[0] + B[0]) / 2, my = (A[1] + B[1]) / 2, ox = mx - cx, oy = my - cy, ol = Math.hypot(ox, oy) || 1, bulge = R * 0.35;
      const qx = mx + ox / ol * bulge, qy = my + oy / ol * bulge; ctx.beginPath(); ctx.moveTo(A[0], A[1]);
      for (let s = 1; s <= 9; s++) { const u = s / 9, ax = (1 - u) * (1 - u) * A[0] + 2 * u * (1 - u) * qx + u * u * B[0], ay = (1 - u) * (1 - u) * A[1] + 2 * u * (1 - u) * qy + u * u * B[1], j = s < 9 ? (Math.random() - 0.5) * R * 0.06 : 0; ctx.lineTo(ax + j, ay + j); }
      ctx.strokeStyle = "rgba(" + THEME_RGB.a.join(",") + "," + (0.18 * f).toFixed(3) + ")"; ctx.lineWidth = 5 * dpr; ctx.stroke(); ctx.strokeStyle = "rgba(210,255,250," + (0.9 * f).toFixed(3) + ")"; ctx.lineWidth = 1.3 * dpr; ctx.stroke();
    }
    this.cost += (performance.now() - t0 - this.cost) * 0.05; this.frames++;
  }
}
Object.assign(HQView.prototype, {
  claudian() { return claudianOf(this.app); },
  osVars() {
    if (true) { this.applyTheme(); return; }
    const r = this.contentEl, v = { "--amber": "#19e3d0", "--amber2": "#2dd4bf", "--bg1": "#05090c", "--bg2": "#071014", "--bg3": "#04070a", "--tx": "#d8f3f1", "--tx2": "#8fb3b6", "--glass": "rgba(25,227,208,.05)", "--glass-b": "rgba(25,227,208,.28)", "--teal": "#0a1c20", "--teal2": "#0f2a2e" };
    Object.entries(v).forEach(([k, c]) => r.style.setProperty(k, c));
  },
  osMode() {
    const on = !this.plugin.settings.classicLayout; if (this.os === on) return; this.os = on;
    this.contentEl.toggleClass("hqos", on); this.osStop(); if (this.pageEl) { this.pageEl.empty(); this.pageEl.toggleClass("os", on); }
    if (!on) ["--tx", "--glass", "--glass-b"].forEach((k) => this.contentEl.style.removeProperty(k));
  },
  osStop() { HQAudio.stop(); HQNow.stop(); if (this.osNpUnsub) { this.osNpUnsub(); this.osNpUnsub = null; } if (this.osTipMO) { this.osTipMO.disconnect(); this.osTipMO = null; } if (this.osUnsub) { this.osUnsub(); this.osUnsub = null; } clearTimeout(this.osStreamT); this.osStreamT = 0; if (this.orb) this.orb.run(false); if (this.osIO) this.osIO.disconnect(); if (this.osRO) this.osRO.disconnect(); this.orb = null; this.osIO = this.osRO = null; this.osUI = null; },
  osBuild() {
    const page = this.pageEl; page.empty(); page.addClass("os"); const ui = this.osUI = { sig: {}, inView: true }, wrap = page.createDiv({ cls: "os-wrap" });
    wrap.createDiv({ cls: "os-sweep" }); ui.top = wrap.createDiv({ cls: "os-top" }); ui.run = wrap.createDiv({ cls: "os-run os-hide", attr: { role: "status", "aria-live": "polite", "aria-label": "Running agents" } });
    const grid = ui.grid = wrap.createDiv({ cls: "os-grid" }), modsEl = ui.modsEl = wrap.createDiv({ cls: "os-mods os-hide" }), L = grid.createDiv({ cls: "os-col os-left" }), M = grid.createDiv({ cls: "os-col os-mid" }), Rt = grid.createDiv({ cls: "os-col os-right" });
    ui.vit = osPanel(L, "SYSTEM VITALS", "os-vit"); ui.sess = osPanel(L, "AGENTS & CHATS", "os-sess"); ui.next = osPanel(L, "NEXT UP", "os-next"); ui.files = osPanel(L, "FILES IN PLAY", "os-files");
    ui.tasks = osPanel(Rt, "TOP TASKS", "os-tasks"); ui.rev = osPanel(Rt, "REVIEW QUEUE", "os-rev");
    { const f = L.createDiv({ cls: "os-fill" }); hqDuel(f); const g = Rt.createDiv({ cls: "os-fill" }); hqDuel(g, "hq-fill-scene-r", 5); }
    this.osColl = this.osColl || new Set(MODS.files.collapsed ? ["files"] : []);
    [["files", ui.files]].forEach(([k, p]) => { p.p.addClass("os-coll"); p.p.toggleClass("collapsed", this.osColl.has(k)); p.h.setAttr("role", "button"); p.h.setAttr("tabindex", "0"); p.h.setAttr("aria-expanded", String(!this.osColl.has(k)));
      const tg = () => { this.osColl.has(k) ? this.osColl.delete(k) : this.osColl.add(k); p.p.toggleClass("collapsed", this.osColl.has(k)); p.h.setAttr("aria-expanded", String(!this.osColl.has(k))); }; p.h.onclick = tg; p.h.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); tg(); } }); });
    const orbw = M.createDiv({ cls: "os-orbw" }); ui.cv = orbw.createEl("canvas", { cls: "os-cv", attr: { "aria-hidden": "true" } });
    orbw.insertAdjacentHTML("beforeend", '<svg class="os-ring" viewBox="0 0 200 200" aria-hidden="true"><circle cx="100" cy="100" r="96" class="r1"/><circle cx="100" cy="100" r="88" class="r2"/><path class="r3" d="M100 2v10M100 188v10M2 100h10M188 100h10"/></svg>');
    ui.np = orbw.createDiv({ cls: "os-np os-hide", attr: { "aria-live": "polite" } }); ui.npT = ui.np.createDiv({ cls: "os-npt" }); ui.npS = ui.np.createDiv({ cls: "os-nps" });
    const npShow = (d) => { if (this.osUI !== ui) return; const x = HQNow.pick(d); ui.np.toggleClass("os-hide", !x); if (!x) return; const t = String(x.title).slice(0, 120), a = [x.artist, HQNow.appName(x.app)].filter(Boolean).join("  ·  ").slice(0, 100); if (ui.npT.textContent !== "\u266A " + t) ui.npT.setText("\u266A " + t); if (ui.npS.textContent !== a) ui.npS.setText(a); };
    HQNow.subs.add(npShow); this.osNpUnsub = () => HQNow.subs.delete(npShow); npShow(HQNow.data);
    ui.status = M.createDiv({ cls: "os-status", attr: { role: "status", "aria-live": "polite" } });
    ui.mid = M; ui.chatBox = M.createDiv({ cls: "os-chat os-hide" }); ui.showChat = M.createEl("button", { cls: "os-showchat os-hide", text: "SHOW CHAT", attr: { title: "Show chat" } }); ui.showChat.onclick = () => { ui.chatHidden = false; this.osChatLayout(); ui.claudKey = ""; setTimeout(() => this.osClaudRender(true), 0); }; this.osChatHeader(ui.chatBox); ui.chatList = ui.chatBox.createDiv({ cls: "os-clist os-hide" }); ui.chatBody = ui.chatBox.createDiv({ cls: "os-cbody", attr: { role: "log", "aria-live": "polite" } }); ui.chatBody.addEventListener("scroll", () => { const b = ui.chatBody; ui.stick = b.scrollHeight - b.scrollTop - b.clientHeight < 40; }, { passive: true }); ui.queue = ui.chatBox.createDiv({ cls: "os-queue os-hide", attr: { "aria-label": "Queued messages" } });
    { const tip = ui.tip = wrap.createDiv({ cls: "os-tip os-hide", attr: { "aria-hidden": "true" } });
      // follows the cursor; screen px are divided by the HQ text-scale zoom so it lands right under the pointer
      const place = (e) => { const w = wrap.getBoundingClientRect(), z = (w.width / wrap.offsetWidth) || 1, W = wrap.offsetWidth, H = wrap.offsetHeight, tw = tip.offsetWidth, th = tip.offsetHeight;
        let x = (e.clientX - w.left) / z + 12, y = (e.clientY - w.top) / z + 18; if (x + tw > W - 4) x = Math.max(4, (e.clientX - w.left) / z - tw - 12); if (y + th > H - 4) y = (e.clientY - w.top) / z - th - 10; tip.style.left = x + "px"; tip.style.top = y + "px"; };
      let cur = null;
      // turn every native title into data-tip as soon as it appears, so Windows' delayed tooltip never shows (rows re-render often)
      const strip = () => wrap.querySelectorAll("[title]").forEach((el) => { el.setAttribute("data-tip", el.getAttribute("title")); el.removeAttribute("title"); });
      let sq = 0; this.osTipMO = new MutationObserver(() => { if (!sq) sq = requestAnimationFrame(() => { sq = 0; strip(); }); }); this.osTipMO.observe(wrap, { subtree: true, childList: true, attributes: true, attributeFilter: ["title"] }); strip();
      ["mouseover", "mouseenter", "pointerover", "mousemove", "pointermove"].forEach((ev) => wrap.addEventListener(ev, (e) => e.stopPropagation())); // keeps Obsidian's own delayed aria-label tooltip out of HQ (ours shows instantly)
      wrap.addEventListener("mouseover", (e) => { const el = e.target.closest && e.target.closest("[title],[data-tip]"); if (!el || !wrap.contains(el)) { cur = null; tip.addClass("os-hide"); return; } if (el.hasAttribute("title")) { el.setAttribute("data-tip", el.getAttribute("title")); el.removeAttribute("title"); } const t = el.getAttribute("data-tip"); if (!t) return; cur = el; tip.setText(t); tip.removeClass("os-hide"); place(e); });
      wrap.addEventListener("mousemove", (e) => { if (cur) place(e); });
      wrap.addEventListener("mouseleave", () => tip.addClass("os-hide")); wrap.addEventListener("pointerdown", () => tip.addClass("os-hide"), true); wrap.addEventListener("scroll", () => tip.addClass("os-hide"), true); }
    ui.chatBody.addEventListener("click", (e) => { const a = e.target.closest && e.target.closest("a.os-lk"); if (a) { e.preventDefault(); this.osChatLink(a.getAttribute("data-u")); } });
    this.osBuildInput(M, ui);
    ui.tick = createDiv(); // bottom ticker removed (2026-11-08): it repeated the top bar and had project-specific stats
    this.orb = new Orb(ui.cv); this.osRO = new ResizeObserver(() => { if (this.orb) this.orb.resize(); }); this.osRO.observe(orbw);
    this.osIO = new IntersectionObserver((es) => { ui.inView = es[es.length - 1].isIntersecting; this.osGate(); }); this.osIO.observe(orbw);
    if (!this.usage) { try { const c = JSON.parse(localStorage.getItem("project-hq-usage") || "null"); if (c) { this.usage = c.u; this.at = new Date(c.at); } } catch (e) {} }
    sampleVitals(); setTimeout(() => { if (this.osUI === ui) { sampleVitals(); this.osVitalsRender(); } }, 1500);
    this.osSessData(true); this.osChatInit(); setTimeout(() => this.osGate(), 300);
  },
  // ---- the Claude input: toolbar (target, model, effort, hint, counter, expand), drag grip, auto-growing textarea, attachments ----
  osBuildInput(M, ui) {
    const lsGet = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k) || "null"); return v === null ? d : v; } catch (e) { return d; } }, lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
    ui.userH = 0; lsSet("hqos-in-h", 0); ui.imgs = []; ui.hi = -1; ui.histVal = ""; this.osHist = lsGet("hqos-hist", []);
    const cmd = ui.cmd = M.createDiv({ cls: "os-cmd" }), tb = cmd.createDiv({ cls: "os-ctool" });
    ui.tbtn = tb.createEl("button", { cls: "os-sel os-tbtn", attr: { "aria-haspopup": "listbox", "aria-label": "Choose which chat to send to" } }); ui.tbtn.onclick = (e) => { e.stopPropagation(); this.osTargetMenu(); };
    ui.target = tb.createEl("select", { cls: "os-sel os-hide", attr: { "aria-label": "Send to HQ chat or a Claudian session", "aria-hidden": "true", tabindex: "-1" } });
    ui.tpop = cmd.createDiv({ cls: "os-tpop os-hide", attr: { role: "listbox", "aria-label": "Chats" } });
    ui.model = tb.createEl("select", { cls: "os-sel os-sm", attr: { "aria-label": "Model" } }); HQ_MODELS.forEach((m) => ui.model.createEl("option", { value: m, text: m ? m.toUpperCase() : "MODEL: DEFAULT" }));
    ui.effort = tb.createEl("select", { cls: "os-sel os-sm", attr: { "aria-label": "Effort" } }); HQ_EFFORTS.forEach((m) => ui.effort.createEl("option", { value: m, text: m ? m.toUpperCase() : "EFFORT: DEFAULT" }));
    tb.createSpan({ cls: "os-sp" });
    ui.hint = tb.createSpan({ cls: "os-hint", text: "ENTER sends · SHIFT+ENTER new line" }); ui.cnt = tb.createSpan({ cls: "os-cnt2", attr: { "aria-live": "off" } });
    ui.compact = tb.createEl("button", { cls: "os-chb os-compact", text: "COMPACT", attr: { "aria-label": "Compact this chat (shrinks its history so each message costs less)", title: "Shrink this chat's history so each message costs less" } });
    ui.handoff = tb.createEl("button", { cls: "os-chb os-handoff", text: "HANDOFF", attr: { "aria-label": HANDOFF_TIP, title: HANDOFF_TIP } });
    ui.handoff.onclick = () => this.osHandoff();
    ui.compact.onclick = () => { if (ui.target.value === "hq") { const hq = this.hq(), c = hq && hq.get(hq.activeId); if (!c || !c.sessionId) { ui.cmdMsg.setText("Open a chat with some history first."); return; } if (c.busy) { ui.cmdMsg.setText("Wait for Claude to finish, then compact."); return; } this.osChatSend("/compact"); } else this.osSend("/compact", ui.target.value); };
    ui.exp = tb.createEl("button", { cls: "os-pmax os-expb", text: "⤢", attr: { "aria-label": "Expand the message box to compose a long message", "aria-pressed": "false" } });
    ui.grip = cmd.createDiv({ cls: "os-grip", attr: { role: "separator", "aria-orientation": "horizontal", "aria-label": "Resize message box (drag, or Up and Down arrows). Double-click resets.", tabindex: "0", title: "Drag to resize the message box" } });
    const box = cmd.createDiv({ cls: "os-cbox" }), left = box.createDiv({ cls: "os-cleft" });
    ui.chips = left.createDiv({ cls: "os-atts os-hide" });
    ui.cmdIn = left.createEl("textarea", { cls: "os-in", attr: { rows: "1", placeholder: "Message Claude Code… (type / for commands)", autocomplete: "off", spellcheck: "false" } });
    ui.slash = cmd.createDiv({ cls: "os-slash os-hide", attr: { role: "listbox", "aria-label": "Commands" } });
    ui.go = box.createEl("button", { cls: "os-go", text: "SEND", attr: { "aria-label": "Send message" } }); ui.cmdMsg = M.createDiv({ cls: "os-cmdmsg" });
    const t = ui.cmdIn, zoom = () => (this.plugin.settings.textScale || 125) / 100;
    const go = () => { if (ui.target.value === "hq" && /^\/\S/.test(t.value.trim()) && !ui.imgs.length) return this.osChatSend(t.value); const c = this.hq().get(this.hq().activeId); if (ui.target.value === "hq" && c && c.busy) return (t.value.trim() || ui.imgs.length) ? this.osChatQueue(t.value) : this.hq().stop(c); if (ui.target.value === "hq") return this.osChatSend(t.value); this.osSend(t.value, ui.target.value); };
    ui.go.onclick = go; ui.target.onchange = () => this.osChatLayout();
    t.addEventListener("input", () => { if (t.value !== ui.histVal) ui.hi = -1; this.osAutoGrow(); this.osGoLabel(); this.osSlashMenu(); });
    t.addEventListener("blur", () => setTimeout(() => { if (ui.slash) ui.slash.addClass("os-hide"); }, 150));
    const setVal = (v) => { t.value = v; ui.histVal = v; this.osAutoGrow(); t.setSelectionRange(v.length, v.length); };
    t.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (ui.slashItems && !ui.slash.hasClass("os-hide")) {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); this.osSlashMenu(e.key === "ArrowDown" ? 1 : -1); return; }
        if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) { e.preventDefault(); this.osSlashPick(); return; }
        if (e.key === "Escape") { e.preventDefault(); ui.slash.addClass("os-hide"); ui.slashItems = null; return; }
      }
      if (e.key === "Escape" && ui.full) { e.preventDefault(); this.osSetFull(false); return; }
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); const c = this.hq().get(this.hq().activeId); if (c && c.busy && ui.target.value === "hq" && !t.value.trim() && !ui.imgs.length) return; go(); return; }
      const H = this.osHist || [], mine = ui.hi >= 0 && t.value === ui.histVal;
      if (e.key === "ArrowUp" && !e.shiftKey && !e.altKey && H.length && (!t.value || mine)) { e.preventDefault(); ui.hi = Math.min(ui.hi + 1, H.length - 1); setVal(H[H.length - 1 - ui.hi]); }
      else if (e.key === "ArrowDown" && !e.shiftKey && !e.altKey && mine) { e.preventDefault(); ui.hi--; setVal(ui.hi < 0 ? "" : H[H.length - 1 - ui.hi]); }
    });
    // paste: multi-line text pastes as typed; images become attachments; files paste as paths
    const fpath = (f) => { try { const w = require("electron").webUtils; if (w && w.getPathForFile) return w.getPathForFile(f); } catch (e) {} return f.path || ""; };
    const insert = (txt) => { const a = t.selectionStart, z = t.selectionEnd; t.setRangeText(txt, a, z, "end"); t.focus(); this.osAutoGrow(); };
    const paths = (files) => files.map(fpath).filter(Boolean).map((p) => (/\s/.test(p) ? '"' + p + '"' : p)).join(" ");
    t.addEventListener("paste", (e) => {
      const cd = e.clipboardData; if (!cd) return; const files = [...(cd.files || [])]; if (!files.length) return;
      const imgs = files.filter((f) => /^image[/](png|jpeg|gif|webp)$/.test(f.type)), others = files.filter((f) => !imgs.includes(f));
      const pp = paths(others); e.preventDefault(); imgs.forEach((f) => this.osAddImage(f)); if (pp) insert(pp + " ");
    });
    t.addEventListener("dragover", (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes("Files")) { e.preventDefault(); cmd.addClass("drop"); } });
    t.addEventListener("dragleave", () => cmd.removeClass("drop"));
    t.addEventListener("drop", (e) => { cmd.removeClass("drop"); const fs2 = e.dataTransfer && [...e.dataTransfer.files]; if (!fs2 || !fs2.length) return; e.preventDefault(); const pp = paths(fs2); if (pp) insert(pp + " "); });
    // resize grip (remembered), expand button
    ui.grip.addEventListener("pointerdown", (e) => {
      e.preventDefault(); ui.grip.setPointerCapture(e.pointerId); const y0 = e.clientY, h0 = t.offsetHeight;
      const mv = (ev) => { ui.userH = Math.min(Math.max(0, Math.round(h0 + (y0 - ev.clientY) / zoom())), Math.round((ui.mid.clientHeight || 600) * 0.5)); this.osAutoGrow(true); }, up = () => { ui.grip.removeEventListener("pointermove", mv); ui.grip.removeEventListener("pointerup", up); lsSet("hqos-in-h", ui.userH); };
      ui.grip.addEventListener("pointermove", mv); ui.grip.addEventListener("pointerup", up);
    });
    ui.grip.addEventListener("keydown", (e) => { if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); ui.userH = Math.max(0, t.offsetHeight + (e.key === "ArrowUp" ? 24 : -24)); this.osAutoGrow(true); lsSet("hqos-in-h", ui.userH); } });
    ui.grip.addEventListener("dblclick", () => { ui.userH = 0; lsSet("hqos-in-h", 0); this.osAutoGrow(true); });
    ui.exp.onclick = () => this.osSetFull(!ui.full);
    ui.fx = cmd.createEl("button", { cls: "os-fx", text: "✕", attr: { "aria-label": "Close the big message box", title: "Close (Esc)" } }); ui.fx.onclick = () => this.osSetFull(false);
    ui.model.onchange = ui.effort.onchange = () => { const c = this.hq().get(this.hq().activeId); if (c && !c.busy) { c.model = ui.model.value; c.effort = ui.effort.value; this.hq().save(c); } };
    ui.model.value = MODS.chat.model || ""; ui.effort.value = MODS.chat.effort || ""; this.osAutoGrow();
  },
  osSetFull(on) { const u = this.osUI; if (!u) return; u.full = !!on; u.grid.toggleClass("cmd-full", u.full);
    if (u.fullOut) { document.removeEventListener("pointerdown", u.fullOut, true); u.fullOut = null; }
    if (u.full) { u.fullOut = (e) => { if (!u.cmd.contains(e.target)) { e.preventDefault(); e.stopPropagation(); this.osSetFull(false); } }; setTimeout(() => { if (u.full && u.fullOut) document.addEventListener("pointerdown", u.fullOut, true); }, 0); } u.cmd.toggleClass("full", u.full); u.exp.setText(u.full ? "✕" : "⤢"); u.exp.setAttr("aria-pressed", String(u.full)); this.osAutoGrow(true); u.cmdIn.focus(); },
  osAddImage(f) {
    const u = this.osUI; if (!u) return; const say = (m) => { u.cmdMsg.setText(m); u.cmdMsg.addClass("bad"); setTimeout(() => { u.cmdMsg.removeClass("bad"); this.osCtxHint(); }, 4000); };
    if (u.imgs.length >= 5) return say("At most 5 images per message."); if (f.size > 5 * 1024 * 1024) return say("Image is over 5 MB.");
    const rd = new FileReader(); rd.onload = () => { const url = String(rd.result), m = /^data:([^;]+);base64,(.*)$/.exec(url); if (!m || !this.osUI) return; u.imgs.push({ name: f.name || "pasted image", media: m[1], data: m[2], url }); this.osRenderAtts(); }; rd.readAsDataURL(f);
  },
  osRenderAtts() {
    const u = this.osUI; if (!u) return; u.chips.empty(); u.chips.toggleClass("os-hide", !u.imgs.length);
    u.imgs.forEach((im, i) => { const c = u.chips.createDiv({ cls: "os-att" }); c.createEl("img", { attr: { src: im.url, alt: "Attached image " + (i + 1) } }); const x = c.createEl("button", { cls: "os-attx", text: "×", attr: { "aria-label": "Remove attached image " + (i + 1) } }); x.onclick = () => { u.imgs.splice(i, 1); this.osRenderAtts(); u.cmdIn.focus(); }; });
    this.osAutoGrow();
  },
  osRemember(text) { const H = (this.osHist || []).filter((x) => x !== text); H.push(text); this.osHist = H.slice(-30); try { localStorage.setItem("hqos-hist", JSON.stringify(this.osHist)); } catch (e) {} if (this.osUI) this.osUI.hi = -1; },
  osGate() { const ui = this.osUI; if (!ui || !this.orb) return; ui.cv.toggleClass("os-hide", !MODS.orb.on); const go = MODS.orb.on && !document.hidden && ui.inView && !(this.osPage === "mods") && (!this.contentEl.isShown || this.contentEl.isShown()); this.orb.run(go);
    if (go && MODS.orb.audio) HQAudio.start(); else HQAudio.stop();
    if (go && MODS.orb.nowPlaying) HQNow.start(path.join(this.plugin.hq.dir, "nowplaying.ps1")); else HQNow.stop(); },
  // ---- render everything (cheap; each region redraws only when its signature changed) ----
  osRender(force) {
    if (!this.osUI) this.osBuild();
    const ae = document.activeElement, held = !force && (Date.now() - (this.touchedAt || 0) < 20000 || (ae && /TEXTAREA|INPUT/.test(ae.tagName) && this.contentEl.contains(ae)));
    this.osTopRender(); this.osRunRender(); this.osVitalsRender(); this.osSessRender(); this.osNextRender(); this.osMidRender();
    if (!held) { this.osTasksRender(); this.osReviewRender(); this.osInsRender(); }
  },
  // ---- running agents strip (top of page, hidden when none): name, type/model, current step, elapsed time ----
  osRunRender() {
    const u = this.osUI; if (!u || !u.run) return;
    u.run.addClass("os-hide"); return; // agents now show in one place only: the AGENTS & CHATS panel (plus a RUNNING chip in the top bar)
    const live = this.live || [], run = live.filter((a) => a.status === "running");
    const items = run.map((a) => { const row = run.filter((x) => x.type === a.type).length === 1 ? (this.agents || []).find((x) => x.name === a.type && x.state !== "idle") : null;
      return { a, step: redact(a.waiting ? a.text : row && row.task ? clean(row.task) : a.tool ? stepText(a.tool) : "starting…").replace(/\s+/g, " ").slice(0, 120) }; });
    this.osReg("run", JSON.stringify(items.map((i) => [i.a.id, i.step])), () => {
      const b = u.run; b.empty(); b.toggleClass("os-hide", !items.length); if (!items.length) return;
      const h = b.createDiv({ cls: "os-run-h" }); h.createSpan({ cls: "os-dot" }); h.createSpan({ text: items.length + " AGENT" + (items.length > 1 ? "S" : "") + " RUNNING" });
      const g = b.createDiv({ cls: "os-run-g" });
      items.forEach((i) => {
        const c = g.createDiv({ cls: "os-run-c" }), t = c.createDiv({ cls: "os-run-t" });
        t.createSpan({ cls: "os-run-n", text: clean(i.a.title), attr: { title: i.a.title } });
        const mm = shortModel((i.a.st && i.a.st.model) || i.a.model); t.createSpan({ cls: "os-run-k", text: (i.a.type + (mm ? " · " + mm : "")).toUpperCase() });
        const m = c.createDiv({ cls: "os-run-m" }); m.createSpan({ cls: "os-run-s", text: i.step, attr: { title: i.step } });
        const r = m.createSpan({ cls: "os-run-r" }); const e = r.createSpan({ cls: "lhq-el", text: dur(Date.now() - i.a.start) }); e.dataset.start = i.a.start;
      });
    });
  },
  osReg(name, sig, fn) { const u = this.osUI; if (u.sig[name] === sig) return; u.sig[name] = sig; fn(); },
  osPlanName() { if (this.osPlan === undefined) { this.osPlan = ""; try { const c = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude", ".credentials.json"), "utf8")); this.osPlan = String((c.claudeAiOauth && c.claudeAiOauth.subscriptionType) || "").slice(0, 12); } catch (e) {} } return this.osPlan; },
  osAccount() { // the Claude account Claude Code is logged in as (re-read every 5 min in case of a /login switch)
    if (!this.osAcct || Date.now() - this.osAcct.at > 300000) { let a = {}; try { a = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude.json"), "utf8")).oauthAccount || {}; } catch (e) {} this.osAcct = { at: Date.now(), email: String(a.emailAddress || ""), org: String(a.organizationName || ""), name: String(a.displayName || "") }; }
    return this.osAcct;
  },
  osRunCount() { return (this.live || []).filter((a) => a.status === "running").length + (this.hq() && this.hq().isBusy() ? 1 : 0); },
  osTopRender() {
    const u = this.osUI, ci = cacheInfo(), us = this.usage, wk = us && us.seven_day, se = us && us.five_hour, model = shortModel(mainState.model);
    const pc = (x) => x && x.utilization !== undefined && x.utilization !== null ? Math.round(x.utilization) : null, wv = pc(wk), sv = pc(se), cl = (p) => p === null ? "" : p >= 90 ? "bad" : p >= 75 ? "warn" : "";
    const vis = this.plugin.visibleProjects(), sig = JSON.stringify([this.project && this.project.id, vis.map((p) => [p.id, p.name, !!p.pinned]), this.osMenuOpen, model, this.osAccount().email, this.osRunCount(), wv, sv, ci && ci.state, ci && Math.floor(ci.age / 3), this.err, vit.cpu > 85, wk && wk.resets_at, se && se.resets_at, this.plugin.settings.theme.id, Object.keys(this.plugin.settings.theme.saved).join(), MODS.guard.on, this.osPage]);
    this.osReg("top", sig, () => {
      const t = u.top; t.empty(); const brand = t.createDiv({ cls: "os-brand" }); brand.createSpan({ cls: "os-logo", text: "HQ_OS" });
      const pw = brand.createDiv({ cls: "os-pw" }), pb = pw.createEl("button", { cls: "os-proj os-pbtn", attr: { "aria-haspopup": "menu", "aria-expanded": String(!!this.osMenuOpen), "aria-label": "Switch project (current: " + (this.project ? this.project.name : "none") + ")" } });
      pb.createSpan({ text: "// " + String(this.project ? this.project.name : "HQ").toUpperCase() }); pb.createSpan({ cls: "os-caret", text: " \u25BE", attr: { "aria-hidden": "true" } });
      const closeM = () => { this.osMenuOpen = false; u.sig.top = ""; this.osTopRender(); };
      pb.onclick = () => { this.osMenuOpen = !this.osMenuOpen; u.sig.top = ""; this.osTopRender(); };
      if (this.osMenuOpen) {
        const menu = pw.createDiv({ cls: "os-menu", attr: { role: "menu", "aria-label": "Projects" } });
        vis.forEach((p) => { const it = menu.createEl("button", { cls: "os-mi" + (this.project && p.id === this.project.id ? " cur" : ""), attr: { role: "menuitemradio", "aria-checked": String(!!(this.project && p.id === this.project.id)) } }); it.createSpan({ text: (p.pinned ? "\u2605 " : "") + (p.name || "Untitled") }); it.onclick = () => { this.osMenuOpen = false; if (!this.project || p.id !== this.project.id) this.reload(p.id); else closeM(); }; });
        if (!vis.length) menu.createDiv({ cls: "os-muted", text: "No projects yet." });
        { const nb = menu.createEl("button", { cls: "os-mi os-minew", text: "+ NEW PROJECT", attr: { role: "menuitem" } }); nb.onclick = (e) => { e.stopPropagation(); const inp = createEl("input", { cls: "os-ren", attr: { type: "text", placeholder: "Project name, Enter to create", "aria-label": "New project name" } }); nb.replaceWith(inp); inp.focus();
            inp.addEventListener("keydown", async (ev) => { ev.stopPropagation(); if (ev.key === "Escape") { closeM(); return; } if (ev.key !== "Enter") return; const nm = inp.value.replace(/[\\/:*?"<>|#^[\]]/g, "").replace(/\s+/g, " ").trim().slice(0, 40); if (!nm) return; inp.disabled = true; try { const id = await this.osNewProject(nm); this.osMenuOpen = false; await this.reload(id); } catch (x) { new Notice("Could not create the project: " + (x && x.message || x)); inp.disabled = false; } }); }; }
        menu.addEventListener("keydown", (e) => { const its = [...menu.querySelectorAll(".os-mi")], i = its.indexOf(document.activeElement); if (e.key === "Escape") { e.stopPropagation(); closeM(); } else if (e.key === "ArrowDown") { e.preventDefault(); (its[i + 1] || its[0]).focus(); } else if (e.key === "ArrowUp") { e.preventDefault(); (its[i - 1] || its[its.length - 1]).focus(); } });
        setTimeout(() => { const c = menu.querySelector(".cur") || menu.querySelector(".os-mi"); if (c) c.focus(); }, 0);
        const off = (e) => { if (!pw.contains(e.target)) { document.removeEventListener("pointerdown", off, true); if (this.osMenuOpen) closeM(); } }; setTimeout(() => document.addEventListener("pointerdown", off, true), 0);
      }
      const on = brand.createSpan({ cls: "os-online", attr: { title: "Online" } }); on.createSpan({ cls: "os-dot" });
      const chips = t.createDiv({ cls: "os-chips" }), chip = (k, v, c, tip) => { const e = chips.createSpan({ cls: "os-chip " + (c || "") }); e.createSpan({ cls: "k", text: k }); e.createSpan({ cls: "v", text: v }); if (tip) e.title = tip; return e; };
      const acct = this.osAccount(); if (acct.email) chip("ACCT", acct.email.split("@")[0], "os-acct", [acct.name, acct.email, acct.org, this.osPlanName() ? "plan: " + this.osPlanName() : ""].filter(Boolean).join("  ·  "));
      if (model) chip("MODEL", model.toUpperCase());
      { const n = this.osRunCount(); if (n) { const e = chip("RUNNING", String(n), "run click", "Agents and chats working now. Click to see them."); e.onclick = () => { const s = u.sess && u.sess.p; if (s) s.scrollIntoView({ behavior: "smooth", block: "nearest" }); }; } }
      { const e = chip("USAGE", "", cl(wv) || cl(sv), [wk && wk.resets_at ? "Week " + (wv === null ? "n/a" : wv + "%") + ": resets " + when(wk.resets_at) + " (in " + left(wk.resets_at) + ")" : "", se && se.resets_at ? "Session " + (sv === null ? "n/a" : sv + "%") + ": resets " + when(se.resets_at) + " (in " + left(se.resets_at) + ")" : ""].filter(Boolean).join("\n") || this.err || "");
        const v = e.querySelector(".v"); v.empty(); v.createSpan({ cls: cl(wv), text: "W " + (wv === null ? "N/A" : wv + "%") }); v.appendText(" · "); v.createSpan({ cls: cl(sv), text: "S " + (sv === null ? "N/A" : sv + "%") }); }
      if (ci) { const e = chip("CACHE", ci.state === "cold" ? "COLD" : ci.state === "warn" ? "COOLING" : "WARM", ci.state === "cold" ? "bad" : ci.state === "warn" ? "warn" : "", (ci.msg ? ci.msg + "\n\n" : "") + "What this means: every message makes Claude re-read the whole chat. After each reply Anthropic keeps a saved copy (the cache) for about 1 hour on your plan.\nWARM: the copy exists, so re-reading costs about a tenth of the normal price.\nCOOLING: the hour is nearly up.\nCOLD: the copy expired, so the next message re-reads the whole chat at full price (a long chat can cost 10-20x more).\nFix for long chats: send your next message soon, or use HANDOFF to start fresh with a summary."); e.addClass("click"); e.onclick = () => this.osFocusInsights(); }
      if (vit.cpu > 85) chip("LOAD", vit.cpu + "%", "bad", "System load is high");
      if (!MODS.guard.on) { const e = chip("GUARD", "OFF", "bad os-offchip", "Delete guard is OFF: recursive deletes are not checked. Click to open MODS."); e.setAttr("role", "button"); e.setAttr("tabindex", "0"); e.addClass("click"); e.onclick = () => { if (this.osPage !== "mods") this.osModsToggle(); }; }
      const r = t.createDiv({ cls: "os-r" }); this.osClock = r.createDiv({ cls: "os-clock" });
      { const ts = r.createEl("select", { cls: "os-sel os-modsw", attr: { "aria-label": "Colour theme" } }), th = this.plugin.settings.theme;
        HQ_PRESETS.forEach((p) => ts.createEl("option", { value: p.id, text: p.name.toUpperCase() })); Object.keys(th.saved).forEach((n) => ts.createEl("option", { value: "saved:" + n, text: n.toUpperCase() })); if (th.id === "custom") ts.createEl("option", { value: "custom", text: "CUSTOM" });
        ts.value = th.id; const fit = () => { const o = ts.options[ts.selectedIndex], m = ts.ownerDocument.body.createSpan({ text: o ? o.text : "" }), cs = getComputedStyle(ts); m.style.cssText = "position:absolute;visibility:hidden;white-space:pre;font:" + cs.font + ";letter-spacing:" + cs.letterSpacing; const w = m.getBoundingClientRect().width; m.remove(); ts.style.width = Math.ceil(w + 22) + "px"; }; fit(); ts.onchange = () => { fit(); this.plugin.setThemeId(ts.value); };
        this.osAccentPicker(r);
        const mb = r.createEl("button", { cls: "os-chb", text: this.osPage === "mods" ? "BACK" : "MODS", attr: { "aria-label": this.osPage === "mods" ? "Back to HQ" : "Open the MODS page (switches, settings, theme)" } }); mb.onclick = () => this.osModsToggle(); }
      const ib = (icon, label, fn) => { const b = r.createEl("button", { cls: "os-ib", attr: { "aria-label": label, title: label } }); setIcon(b, icon); b.onclick = fn; };
      ib("refresh-cw", "Refresh", () => this.refreshAll()); ib("settings", "Settings", () => { try { this.app.setting.open(); this.app.setting.openTabById("project-hq"); } catch (e) { new Notice("Open Settings, then Project HQ"); } });
      this.osClockTick();
    });
  },
  // Called after a project switch: close a chat that belongs to another project, refresh the title bits.
  osProjSwitch() {
    const u = this.osUI, hq = this.hq(); if (!u) return;
    const c = hq && hq.get(hq.activeId); if (c && hq.projOf(c) !== (this.project && this.project.id)) { hq.activeId = ""; u.chatOpen = false; this.osChatWas = false; }
    if (u.chatList) u.chatList.addClass("os-hide"); u.tsig = ""; this.osSessData(true); this.osChatLayout(); this.osChatRender(true); this.osTopRender(); this.osCtxHint();
  },
  osCtxHint() { const u = this.osUI; if (u && u.cmdMsg && !u.cmdMsg.hasClass("bad")) u.cmdMsg.setText(this.project ? "Project: " + this.project.name + (this.project.folder ? "  ·  " + this.project.folder : "") : ""); },
  osFocusInsights() { const u = this.osUI; if (u && u.acts) u.acts.p.scrollIntoView({ behavior: "smooth", block: "nearest" }); },
  osClockTick() { if (!this.osClock) return; const n = new Date(); this.osClock.setText(((n.getHours() % 12) || 12) + ":" + osMono(n.getMinutes()) + (n.getHours() < 12 ? " AM" : " PM")); const dt = n.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long", year: "numeric" }); if (this.osClock.getAttribute("data-tip") !== dt) this.osClock.setAttribute("data-tip", dt); },
  osVitalsRender() {
    const u = this.osUI, b = u.vit.body, warn = vit.cpu > 85 || vit.mem > 85;
    this.osReg("vit", JSON.stringify([vit.cpu, vit.mem, Math.floor(vit.up / 60)]), () => {
      b.empty(); const row = (k, v, p) => { const r = b.createDiv({ cls: "os-vrow" + (p > 85 ? " bad" : p > 70 ? " warn" : "") }); r.createSpan({ cls: "k", text: k }); r.createSpan({ cls: "v", text: v }); const bar = r.createDiv({ cls: "os-bar" }); bar.createEl("i").style.width = Math.max(2, p) + "%"; };
      row("CPU", vit.cpu + "%", vit.cpu); row("MEMORY", vit.mem + "%", vit.mem);
      
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
        const cpid = this.claudProjId();
        const list = cp.chatHost.getConversationList().filter((c) => !c.isArchived && c.projectId === cpid && cpid && !OS_PERSONAL.test((c.linkedContentPath || "") + " " + (c.title || ""))).sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0)).slice(0, 15);
        for (const c of list) {
          const st = cp.sessionMessaging.status(c.id), key = [c.lastActivityAt, c.messageCount, st].join("|"), sn = this.osSnip[c.id];
          if (rows.length < 4 && cp.api && (!sn || (sn.key !== key && Date.now() - sn.at > 8000))) reads.push([c.id, key, sn]);
          const us = (() => { try { const f = cp.chatHost.getConversationSync ? cp.chatHost.getConversationSync(c.id) : cp.chatHost.getCachedConversation && cp.chatHost.getCachedConversation(c.id); return f && f.usage; } catch (e) { return null; } })();
          rows.push({ kind: "chat", id: c.id, tok: us && us.contextTokens ? { ctx: us.contextTokens, win: us.contextWindow || 0, pct: us.percentage } : null, title: clean(c.title || "Untitled"), st: st === "running" && this.claudBusy(c.id) ? "thinking" : st === "awaiting-user" ? "needs you" : "idle", ts: c.lastActivityAt || 0, snip: (this.osSnip[c.id] || {}).text || "" });
        }
        this.osConvs = list.map((c) => [c.id, clean(c.title || "Untitled"), !!(cp.api && cp.api.getActiveSessionId && cp.api.getActiveSessionId() === c.id)]);
      } else this.osConvs = [];
      const now = Date.now();
      this.live.filter((a) => a.status === "running").slice(0, 8).forEach((a) => rows.push({ kind: "agent", id: a.id, title: clean(a.title), st: "running in background", tok: a.st ? { i: (a.st.tin || 0) + (a.st.tcr || 0) + (a.st.tcc || 0), o: a.st.tout || 0, cost: a.st.cost || 0 } : null, ts: a.mtime, snip: redact(a.tool ? stepText(a.tool) : a.text || "").replace(/\s+/g, " ").slice(0, 180), type: a.type }));
      if (this.hq() && MODS.chat.on) this.hq().list(this.project && this.project.id).slice(0, 3).reverse().forEach((c) => rows.unshift({ kind: "hq", id: c.id, tok: (() => { const ts = c.turns || []; return ts.length ? { i: ts.reduce((n, t) => n + (t.in || 0) + (t.cache || 0), 0), o: ts.reduce((n, t) => n + (t.out || 0), 0), cost: ts.reduce((n, t) => n + (t.cost || 0), 0) } : null; })(), title: (c.pinned ? "★ " : "") + clean(c.title), st: c.busy ? "thinking" : "idle", ts: c.updated, snip: (() => { const m = c.msgs.filter((x) => x.r === "asst").pop(); const t = m && m.blocks.filter((b) => b.k === "text").map((b) => b.text).join(" "); return clean(redact(t || "")).replace(/\s+/g, " ").slice(0, 180); })() }));
      { let n = 0; const keep = []; rows.forEach((r) => { if (r.kind !== "chat" || r.st !== "idle" || n++ < 3) keep.push(r); }); rows.length = 0; keep.forEach((r) => rows.push(r)); }
      this.osRows = rows; this.osFillTarget(); this.osSessRender();
      for (const [id, key, sn] of reads) { let t = ""; try { t = String(await cp.api.read(id) || ""); } catch (e) {} this.osSnip[id] = { key, at: Date.now(), text: /^.no reply.$/.test(t) ? (sn && sn.text || "") : clean(redact(t)).replace(/\s+/g, " ").trim().slice(0, 180) }; const r = rows.find((x) => x.id === id); if (r) r.snip = this.osSnip[id].text; }
      if (reads.length) this.osSessRender();
    } catch (e) { console.error("Project HQ OS sessions", e); } finally { this.osSessBusy = false; }
  },
  osSessRender() {
    const u = this.osUI; if (!u) return; const rows = (this.osRows || []).filter((r) => r.st !== "idle" && r.st !== "done");
    this.osReg("sess", JSON.stringify(rows.map((r) => [r.id, r.st, r.snip, r.title, r.tok && [r.tok.i, r.tok.o, r.tok.ctx]])), () => {
      const b = u.sess.body; b.empty(); u.sess.meta.setText(rows.filter((r) => r.st === "thinking" || r.st === "running in background").length + " RUNNING");
      if (!rows.length) b.createDiv({ cls: "os-muted", text: "Nothing running right now." });
      rows.forEach((r) => {
        const c = b.createDiv({ cls: "os-srow " + r.kind + " s-" + r.st.replace(/\s+/g, "-"), attr: r.kind !== "agent" ? { role: "button", tabindex: "0", "aria-label": "Open session " + r.title } : {} });
        const h = c.createDiv({ cls: "os-sh" }); h.createSpan({ cls: "os-sd" }); h.createSpan({ cls: "os-sn", text: r.title }).title = r.title; if (r.tok && r.tok.ctx) { const tk = h.createSpan({ cls: "os-stok", text: kfmt(r.tok.ctx) + " ctx" }); tk.title = "Context in use: " + kfmt(r.tok.ctx) + (r.tok.win ? " of " + kfmt(r.tok.win) : "") + (r.tok.pct != null ? " (" + r.tok.pct + "%)" : "") + ". Each message re-reads about this much."; }
        else if (r.tok) { const tk = h.createSpan({ cls: "os-stok", text: kfmt(r.tok.i + r.tok.o) }); tk.title = kfmt(r.tok.i) + " in (incl. cache) · " + kfmt(r.tok.o) + " out" + (r.tok.cost ? " · ~" + usd(r.tok.cost) + " est." : ""); }
        h.createSpan({ cls: "os-ss", text: r.st === "running in background" ? "RUNNING" : r.st.toUpperCase() });
        c.title = r.title + " — " + (r.kind === "agent" ? r.type + " · " : "") + (r.snip || "(no messages yet)"); c.addClass("one");
        h.insertBefore(createSpan({ cls: "os-sk", text: r.kind === "agent" ? "AGENT" : r.kind === "hq" ? "HQ" : "CLAUDIAN" }), h.children[1]);
        if (r.kind !== "agent") { const menu = (e) => this.osChatMenu(r, e); c.onclick = menu; c.addEventListener("contextmenu", (e) => { e.preventDefault(); menu(e); }); c.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); const b = c.getBoundingClientRect(); menu({ clientX: b.left + 20, clientY: b.bottom }); } }); }
      });
    });
  },
  // click a chat row: open it, start a new one, or delete it (asks once more before deleting)
  osChatMenu(r, e) {
    const m = new Menu(), hq = r.kind === "hq", cp = this.claudian(), busy = r.st === "thinking";
    m.addItem((i) => i.setTitle("Open chat").setIcon("message-square").onClick(() => hq ? this.osChatOpenConv(r.id) : this.osOpenSession(r.id)));
    m.addItem((i) => i.setTitle(hq ? "Start new HQ chat" : "Start new Claudian chat").setIcon("plus").onClick(() => { if (hq) { this.osChatNew(); return; } try { this.app.commands.executeCommandById("realclaudian:new-session") || this.app.commands.executeCommandById("claudian:new-session"); } catch (x) {} const ws = this.app.workspace, leaf = ws.getLeavesOfType((this.plugin.settings.chatView || "claudian-view").trim())[0]; if (leaf) ws.revealLeaf(leaf); }));
    m.addSeparator();
    m.addItem((i) => { i.setTitle(busy ? "Delete chat (stop it first)" : "Delete chat…").setIcon("trash-2").setDisabled(busy); if (!busy) i.onClick(() => {
      const ok = new Menu(); ok.addItem((j) => j.setTitle("Yes, delete “" + String(r.title).slice(0, 40) + "”").setIcon("trash-2").onClick(async () => {
        try { if (hq) { const c = this.hq().get(r.id); if (c) this.hq().remove(c); if (this.osUI) { this.osUI.chatOpen = this.osUI.chatOpen && this.hq().activeId !== ""; this.osChatLayout(); this.osChatRender(true); } } else if (cp && cp.chatHost && cp.chatHost.deleteConversation) await cp.chatHost.deleteConversation(r.id); new Notice("Chat deleted"); } catch (x) { new Notice("Could not delete: " + (x && x.message || x)); }
        this.osSessData(true); }));
      ok.addItem((j) => j.setTitle("Cancel").setIcon("x")); ok.showAtPosition({ x: e.clientX, y: e.clientY }); }); });
    m.showAtPosition({ x: e.clientX, y: e.clientY });
  },
  // ---- handoff: ask the chat for a handoff note, then start a new chat (same kind, same project) seeded with it ----
  async osHandoff() {
    const u = this.osUI; if (!u) return; if (this.osHandoffBusy) { new Notice("A handoff is already running."); return; }
    const say = (m, bad) => { u.cmdMsg.setText(m); u.cmdMsg.toggleClass("bad", !!bad); }, tgt = u.target.value;
    const seed = (title, note) => "Handoff from the previous chat \u201C" + title + "\u201D. Read this, then continue from \u2018Next steps\u2019. Don't redo finished work.\n\n" + note;
    this.osHandoffBusy = true; u.handoff.addClass("busy"); u.handoff.setText("HANDING OFF\u2026");
    try {
      if (tgt === "hq") {
        const hq = this.hq(), c = hq.get(hq.activeId); if (!c || !c.sessionId) throw new Error("Open a chat with some history first.");
        if (c.busy) throw new Error("Wait for Claude to finish, then hand off.");
        say("Writing the handoff note\u2026");
        const note = await new Promise((res, rej) => { const off = hq.on((cc, what) => { if (cc !== c || what !== "done") return; off(); const m = c.msgs.filter((x) => x.r === "asst").pop(); const t = m && m.blocks.filter((b) => b.k === "text").map((b) => b.text).join("\n").trim(); t ? res(t) : rej(new Error("No handoff note came back.")); }); hq.send(c, HANDOFF_PROMPT); });
        const n = hq.create(c.model, c.effort, this.project); n.title = "Handoff: " + String(c.title).slice(0, 40); hq.save(n);
        u.chatOpen = true; this.osChatWas = true; hq.send(n, seed(c.title, note)); this.osChatLayout(); this.osChatRender(true);
        say("Handoff done: new chat \u201C" + n.title + "\u201D started with the summary.");
      } else {
        const cp = this.claudian(); if (!(cp && cp.api && cp.chatHost && cp.sessionMessaging)) throw new Error("Claudian is not available.");
        const src = cp.chatHost.getConversationList().find((x) => x.id === tgt); if (!src) throw new Error("That Claudian chat was not found.");
        const before = String(await cp.api.read(tgt) || ""); say(this.claudBusy(tgt) ? "Handoff queued: it starts as soon as Claude finishes the current turn, then a new chat opens. You can keep working." : "Writing the handoff note in \u201C" + src.title + "\u201D\u2026"); new Notice(this.claudBusy(tgt) ? "Handoff queued behind the current turn" : "Handoff started");
        await cp.api.send(tgt, { text: HANDOFF_PROMPT });
        const t0 = Date.now(); let note = "";
        while (Date.now() - t0 < 15 * 60000) { await new Promise((r) => setTimeout(r, 3000)); if (cp.sessionMessaging.status(tgt) !== "idle") continue; const t = String(await cp.api.read(tgt) || "").trim(); if (t && t !== before.trim() && /##s*Goal/i.test(t) && /##s*Next steps/i.test(t)) { note = t; break; } }
        if (!note) throw new Error("Timed out waiting for the handoff note.");
        const nc = await cp.chatHost.createConversation(Object.assign({ providerId: src.providerId, selectedModel: src.selectedModel }, src.projectId ? { projectId: src.projectId } : {}));
        try { if (cp.chatHost.renameConversation) await cp.chatHost.renameConversation(nc.id, "Handoff: " + String(src.title).slice(0, 40)); } catch (x) {}
        await cp.api.send(nc.id, { text: seed(src.title, note) }); this.osOpenSession(nc.id); this.osSessData(true);
        say("Handoff done: new Claudian chat started with the summary. The old chat is untouched.");
      }
    } catch (e) { say("Handoff: " + (e && e.message || e), true); }
    finally { this.osHandoffBusy = false; if (u.handoff) { u.handoff.removeClass("busy"); u.handoff.setText("HANDOFF"); } }
  },
  // HANDOFF lights up when the target chat is past 250k tokens of context or its cache went cold
  osHandoffHint() {
    const u = this.osUI; if (!u || !u.handoff) return; let ctx = 0, cold = false; const tgt = u.target.value;
    if (tgt === "hq") { const hq = this.hq(), c = hq && hq.get(hq.activeId), t = c && (c.turns || []).slice(-1)[0]; if (t) { ctx = (t.in || 0) + (t.cache || 0); cold = Date.now() - t.at > 3600000; } }
    else { const cp = this.claudian(); try { const f = cp && cp.chatHost && (cp.chatHost.getConversationSync ? cp.chatHost.getConversationSync(tgt) : null); ctx = (f && f.usage && f.usage.contextTokens) || 0; } catch (x) {} const ci = cacheInfo(); cold = !!(ci && ci.state === "cold"); }
    const hot = ctx > 250000 || (cold && ctx > 60000); u.handoff.toggleClass("hot", hot);
    const tip = HANDOFF_TIP + (ctx ? "\n\nThis chat: about " + kfmt(ctx) + " tokens re-read per message" + (cold ? ", cache is cold" : "") + "." : ""); if (u.handoff.getAttribute("data-tip") !== tip) u.handoff.setAttribute("data-tip", tip);
  },
  // read-only view of the picked Claudian chat (last 40 messages), refreshed when it changes
  async osClaudRender(force) {
    const u = this.osUI, cp = this.claudian(); if (!u || u.target.value === "hq" || !cp || !cp.chatHost || !cp.sessionMessaging || this.osClaudBusy) return;
    const id = u.target.value, meta = cp.chatHost.getConversationList().find((x) => x.id === id);
    if (!meta) { if (u.claudKey !== "none:" + id) { u.claudKey = "none:" + id; u.chatBody.empty(); u.chatBody.createDiv({ cls: "os-muted os-chint", text: "No chats in " + (this.project ? this.project.name : "this project") + " yet. Type below to start one." }); u.chatTitle.setText(this.project ? this.project.name.toUpperCase() : "NEW CHAT"); u.chatCost.setText("NEW"); u.queue.addClass("os-hide"); } return; }
    const st = cp.sessionMessaging.status(id), key = [id, meta.lastActivityAt, meta.messageCount, st].join("|"); if (!force && key === u.claudKey) return;
    this.osClaudBusy = true;
    try {
      const t = await cp.sessionMessaging.loadTranscript(id); if (u.target.value !== id) return; u.claudKey = key;
      const all = (t && t.conversation && t.conversation.messages) || [], msgs = [];
      for (const m of all.slice(-40)) {
        if (m.role === "user") { const tx = String(m.displayContent || m.content || "").split(NOTE_TAG)[0].trim(); if (tx) msgs.push({ r: "user", text: tx }); continue; }
        if (m.role !== "assistant") continue; const tc = m.toolCalls || [], blocks = [];
        (m.contentBlocks && m.contentBlocks.length ? m.contentBlocks : [{ type: "text", content: m.content }]).forEach((b) => {
          if (b.type === "text" && b.content) blocks.push({ k: "text", text: String(b.content) });
          else if (b.type === "tool_use") { const x = tc.find((y) => y.id === b.toolId) || {}; const res = x.result; blocks.push({ k: "tool", name: x.name || "tool", input: x.input || {}, target: toolTarget(x.name, x.input), result: typeof res === "string" ? res.slice(0, 1500) : res ? JSON.stringify(res).slice(0, 1500) : "", isErr: x.status === "error" || !!x.isError }); }
        });
        msgs.push({ r: "asst", blocks });
      }
      const b = u.chatBody, near = u.stick !== false || force; b.empty(); u.liveEl = null;
      if (all.length > 40) b.createDiv({ cls: "os-muted os-chint", text: "Showing the last 40 messages. Open it in Claudian for the full chat." });
      msgs.forEach((m) => this.osChatMsg(b, m, false));
      const P = this.osPend || {}, seen = msgs.filter((m) => m.r === "user").slice(-8).map((m) => m.text); P[id] = (P[id] || []).filter((p) => Date.now() - p.t < 900000 && !seen.some((x) => x.includes(p.text.slice(0, 60)))); P[id].forEach((p) => this.osChatMsg(b, { r: "user", text: p.text }, false));
      { const Q = this.osQ && this.osQ[id]; if (Q) for (let i = Q.length - 1; i >= 0; i--) if (Q[i].sent && (Date.now() - Q[i].sent > 900000 || seen.some((x) => x.includes(Q[i].text.slice(0, 60))))) Q.splice(i, 1); }
      if (P[id].length && !(st === "running" && this.claudBusy(id))) b.createDiv({ cls: "os-think os-working", text: "Sent. Waiting for Claude…" });
      if (st === "running" && this.claudBusy(id)) { const since = meta.lastActivityAt ? Math.max(0, Math.round((Date.now() - meta.lastActivityAt) / 60000)) : 0;
        const w = b.createDiv({ cls: "os-think os-working" }); w.createDiv({ text: "Claude is replying…" + (since ? " (last update " + since + " min ago)" : "") }); }
      if (near) b.scrollTop = b.scrollHeight;
      this.osCQRender(); u.chatTitle.setText("CLAUDIAN \u00B7 " + (meta.title || "Untitled")); const act = st === "running" && this.claudBusy(id); u.chatCost.setText(act ? "WORKING" : st === "awaiting-user" ? "NEEDS YOU" : "READY"); u.chatCost.toggleClass("run", act);
    } catch (e) { console.error("Project HQ claudian view", e); } finally { this.osClaudBusy = false; }
  },
  osPendAdd(id, text) { this.osPend = this.osPend || {}; (this.osPend[id] = this.osPend[id] || []).push({ text, t: Date.now() }); if (this.osUI) this.osUI.claudKey = ""; },
  async osClaudStop(id) { const cp = this.claudian(); try { await cp.api.send(id, { mode: "interrupt" }); } catch (e) { new Notice("Could not stop: " + (e && e.message || e)); } },
  // queued messages for the picked Claudian chat: SEND NOW interrupts Claude and sends it immediately
  osCQRender() {
    const u = this.osUI; if (!u || !u.queue) return; const id = u.target.value, q = (this.osQ && this.osQ[id]) || [];
    if (id === "hq") return; u.queue.empty(); u.queue.toggleClass("os-hide", !q.length); if (!q.length) return;
    u.queue.createDiv({ cls: "os-q-h", text: "QUEUED (" + q.length + ") \u00B7 sends when Claude finishes" });
    q.forEach((m, i) => { const r = u.queue.createDiv({ cls: "os-q-i" }); r.createSpan({ cls: "os-q-n", text: String(i + 1) }); r.createSpan({ cls: "os-q-t", text: m.text.replace(/\s+/g, " ").slice(0, 200), attr: { title: m.text } });
      if (m.sent) { r.createSpan({ cls: "os-q-sent", text: "NEXT UP", attr: { title: "Handed to Claude. It shows in the chat once Claude picks it up." } }); return; }
      const now = r.createEl("button", { cls: "os-chb os-qnow", text: "SEND NOW", attr: { title: "Stop what Claude is doing and send this right away" } });
      now.onclick = async () => { q.splice(i, 1); this.osCQRender(); const cp = this.claudian(); try { await cp.api.send(id, { text: m.text, mode: "interrupt" }); this.osPendAdd(id, m.text); this.osUI.cmdMsg.setText("Interrupted and sent."); } catch (e) { new Notice("Could not send: " + (e && e.message || e)); } setTimeout(() => this.osClaudRender(true), 800); };
      const ed = r.createEl("button", { cls: "os-chb", text: "EDIT" }); ed.onclick = () => { q.splice(i, 1); u.cmdIn.value = m.text; this.osAutoGrow(); this.osGoLabel(); this.osCQRender(); u.cmdIn.focus(); };
      const x = r.createEl("button", { cls: "os-chb", text: "\u00D7", attr: { "aria-label": "Remove queued message" } }); x.onclick = () => { q.splice(i, 1); this.osCQRender(); }; });
  },
  async osCQPump() { // send the next queued message once a chat goes idle
    if (this.osCQBusy || !this.osQ) return; const cp = this.claudian(); if (!cp || !cp.api) return;
    for (const id of Object.keys(this.osQ)) { const q = this.osQ[id], m = q.find((x) => !x.sent); if (!m || q.some((x) => x.sent) || this.claudBusy(id)) continue;
      this.osCQBusy = true; try { await cp.api.send(id, { text: m.text }); m.sent = Date.now(); } catch (e) {} this.osCQBusy = false; this.osCQRender(); setTimeout(() => this.osClaudRender(true), 800); break; }
  },
  claudProjId() { const cp = this.claudian(), nm = String(this.project ? this.project.name : "").toLowerCase(); try { const p = cp.chatHost.domains.projects.list().find((x) => !x.isArchived && String(x.name).toLowerCase() === nm); return p ? p.id : ""; } catch (e) { return ""; } },
  async claudEnsureProject() { // the Claudian project for this HQ project, created on first use
    let id = this.claudProjId(); if (id || !this.project) return id; const cp = this.claudian(), nm = this.project.name, sl = String(nm).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
    try { const p = await cp.chatHost.domains.projects.create({ name: nm, instructions: "", memoryPath: ".claudian/projects/" + sl + "/MEMORY.md" }); id = p && p.id || this.claudProjId(); } catch (e) { console.error("Project HQ claudian project", e); }
    return id;
  },
  async osNewClaudChat(firstText) { // new Claudian chat inside this project; optionally sends the first message
    const cp = this.claudian(), u = this.osUI; if (!cp || !cp.chatHost) throw new Error("Claudian is not available.");
    const pid = await this.claudEnsureProject(), any = cp.chatHost.getConversationList()[0] || {};
    const nc = await cp.chatHost.createConversation(Object.assign({ providerId: any.providerId || "claude" }, any.selectedModel ? { selectedModel: any.selectedModel } : {}, pid ? { projectId: pid } : {}));
    u.pendTarget = nc.id; if (firstText) await cp.api.send(nc.id, { text: firstText }); await this.osSessData(true); this.osTargetPick(nc.id); return nc.id;
  },
  async osNewProject(nm) { // folder + Notes/To-Do note in Claude'sWorkspace, an HQ project, and a matching Claudian project
    const P = this.plugin, folder = WS + "/" + nm, todo = folder + "/Notes/" + nm + " To-Do.md", V = this.app.vault;
    if (V.getAbstractFileByPath(folder)) throw new Error("A folder named " + nm + " already exists.");
    await V.createFolder(folder); await V.createFolder(folder + "/Notes");
    await V.create(todo, "# " + nm + " To-Do\n\n## Now\n\n## Next\n1. \n\n## Waiting on " + (P.settings.person || "me") + "\n\n## Done\n");
    P.syncProjects(); const p = P.settings.projects.find((x) => x.folder === folder); if (!p) throw new Error("project not registered"); p.todo = todo; await P.saveSettings();
    const cp = this.claudian(), sl = nm.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
    try { if (cp && cp.chatHost && !cp.chatHost.domains.projects.list().some((x) => String(x.name).toLowerCase() === nm.toLowerCase())) await cp.chatHost.domains.projects.create({ name: nm, instructions: "", memoryPath: ".claudian/projects/" + sl + "/MEMORY.md" }); } catch (e) { console.error("Project HQ claudian project", e); }
    new Notice("Project " + nm + " created"); return p.id;
  },
  osTargetLabel() { const u = this.osUI; if (!u || !u.tbtn) return; const o = u.target.options[u.target.selectedIndex]; u.tbtn.setText((o ? o.text : "HQ CHAT") + "  \u25BE"); },
  osTargetPick(v) { const u = this.osUI; u.target.value = v; this.osChatLayout(); this.osTargetLabel(); this.osTargetClose(); u.cmdIn.focus(); },
  osTargetClose() { const u = this.osUI; if (!u || !u.tpop) return; u.tpop.addClass("os-hide"); if (u.tpopOff) { document.removeEventListener("pointerdown", u.tpopOff, true); document.removeEventListener("keydown", u.tpopKey, true); u.tpopOff = null; } },
  // chat picker: pick where messages go; rename or delete any Claudian chat right here (delete asks once more)
  osTargetMenu(keep) {
    const u = this.osUI, P = u.tpop, cp = this.claudian(); if (!keep && !P.hasClass("os-hide")) { this.osTargetClose(); return; }
    P.empty(); P.removeClass("os-hide"); const cur = u.target.value, convs = this.osConvs || [];
    const row = (val, label, sub) => { const r = P.createDiv({ cls: "os-tro" + (val === cur ? " cur" : ""), attr: { role: "option", "aria-selected": String(val === cur) } }); const n = r.createDiv({ cls: "os-trn" }); n.createSpan({ cls: "os-trt", text: label }); if (sub) n.createSpan({ cls: "os-trs", text: sub }); n.onclick = () => this.osTargetPick(val); return r; };
    if (MODS.chat.on) { const hr = row("hq", "HQ CHAT", "built-in"); const lb = hr.createEl("button", { cls: "os-chb", text: "CHATS", attr: { title: "HQ chat list: open, pin, rename, delete" } }); lb.onclick = (e) => { e.stopPropagation(); this.osTargetClose(); this.osChatList(); }; }
    { const nr = P.createDiv({ cls: "os-tro os-trnew" }), nb = nr.createDiv({ cls: "os-trn" }); nb.createSpan({ cls: "os-trt", text: "+ NEW CHAT" }); nb.createSpan({ cls: "os-trs", text: "in " + (this.project ? this.project.name : "this project") }); nb.onclick = async () => { this.osTargetClose(); try { await this.osNewClaudChat(); } catch (x) { new Notice(String(x && x.message || x)); } }; }
    if (!convs.length) P.createDiv({ cls: "os-muted", text: "No chats in " + (this.project ? this.project.name : "this project") + " yet." });
    if (convs.length && MODS.chat.on) P.createDiv({ cls: "os-trh", text: "CLAUDIAN" });
    convs.forEach(([id, title, act]) => {
      const r = row(id, title, act ? "open now" : "");
      const ren = r.createEl("button", { cls: "os-chb", text: "RENAME", attr: { "aria-label": "Rename " + title } });
      ren.onclick = (e) => { e.stopPropagation(); const n = r.querySelector(".os-trn"), inp = createEl("input", { cls: "os-ren", attr: { type: "text", "aria-label": "New name" } }); inp.value = title; n.replaceWith(inp); inp.focus(); inp.select(); let done = false;
        const fin = async (ok) => { if (done) return; done = true; const v = inp.value.replace(/\s+/g, " ").trim().slice(0, 80); if (ok && v && v !== title) { try { await cp.chatHost.renameConversation(id, v); } catch (x) { new Notice("Could not rename: " + (x && x.message || x)); } } await this.osSessData(true); this.osTargetMenu(true); };
        inp.onclick = (ev) => ev.stopPropagation(); inp.addEventListener("keydown", (ev) => { ev.stopPropagation(); if (ev.key === "Enter") { ev.preventDefault(); fin(true); } else if (ev.key === "Escape") { ev.preventDefault(); fin(false); } }); inp.addEventListener("blur", () => fin(true)); };
      const busy = cp && cp.sessionMessaging && cp.sessionMessaging.status(id) === "running";
      const del = r.createEl("button", { cls: "os-chb", text: "DELETE", attr: { "aria-label": "Delete " + title, title: busy ? "Working right now; stop it first" : "Delete this chat" } }); if (busy) del.disabled = true;
      del.onclick = async (e) => { e.stopPropagation(); if (!del.hasClass("sure")) { del.addClass("sure"); del.setText("SURE?"); setTimeout(() => { if (del.isConnected) { del.removeClass("sure"); del.setText("DELETE"); } }, 3000); return; }
        try { await cp.chatHost.deleteConversation(id); new Notice("Chat deleted"); } catch (x) { new Notice("Could not delete: " + (x && x.message || x)); } if (u.target.value === id) u.target.value = "hq"; await this.osSessData(true); this.osTargetMenu(true); };
    });
    if (!u.tpopOff) { u.tpopOff = (e) => { if (!P.contains(e.target) && e.target !== u.tbtn) this.osTargetClose(); }; u.tpopKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); this.osTargetClose(); } }; setTimeout(() => { document.addEventListener("pointerdown", u.tpopOff, true); document.addEventListener("keydown", u.tpopKey, true); }, 0); }
  },
  osOpenSession(id) {
    const cp = this.claudian(), ws = this.app.workspace, type = (this.plugin.settings.chatView || "claudian-view").trim();
    try { const p = cp && cp.chatHost && cp.chatHost.switchConversation ? cp.chatHost.switchConversation(id) : null; if (p && p.catch) p.catch((e) => console.error("Project HQ switch session", e)); } catch (e) { console.error("Project HQ switch session", e); }
    const leaf = ws.getLeavesOfType(type)[0]; if (leaf) ws.revealLeaf(leaf);
  },
  osFillTarget() {
    const u = this.osUI; if (!u || !u.target) return; const prev = u.target.value || "hq", convs = this.osConvs || [], sig = JSON.stringify(convs); if (u.tsig === sig) return; u.tsig = sig; u.target.empty();
    const hqOn = MODS.chat.on; if (!convs.length && !hqOn) u.target.createEl("option", { value: "new", text: "NEW CHAT" }); if (hqOn) u.target.createEl("option", { value: "hq", text: "HQ CHAT" }); convs.forEach(([id, t, act]) => u.target.createEl("option", { value: id, text: (MODS.chat.on ? "CLAUDIAN: " : "") + t.slice(0, 40) }));
    const act = (convs.find((c) => c[2]) || convs[0] || [])[0];
    const pend = u.pendTarget && convs.some((c) => c[0] === u.pendTarget) ? u.pendTarget : ""; if (pend) u.pendTarget = "";
    u.target.value = pend || (convs.some((c) => c[0] === prev) || (prev === "hq" && hqOn) ? prev : (act || (hqOn ? "hq" : "new"))); this.osChatLayout(); this.osTargetLabel(); if (!u.tpop.hasClass("os-hide")) this.osTargetMenu(true);
  },
  // ---- Claudian path (only when a Claudian session is picked in the target list; HQ chat is the default) ----
  claudBusy(id) { const cp = this.claudian(); try { if (!(cp && cp.sessionMessaging && cp.sessionMessaging.status(id) === "running")) return false; const m = cp.chatHost.getConversationList().find((x) => x.id === id); return !m || !m.lastActivityAt || Date.now() - m.lastActivityAt < 180000; } catch (e) { return false; } },
  async osSend(text, target) {
    const u = this.osUI; if (u) u.stick = true; text = String(text || "").trim(); if (!target || target === "hq") return;
    if (u.imgs && u.imgs.length) { try { const dir = require("path").join(require("os").tmpdir(), "hq-images"); require("fs").mkdirSync(dir, { recursive: true }); const ps = u.imgs.map((im, i) => { const p = require("path").join(dir, Date.now() + "-" + i + "." + ((im.media || "image/png").split("/")[1] || "png").replace("jpeg", "jpg")); require("fs").writeFileSync(p, Buffer.from(im.data, "base64")); return p; }); text = (text || "See the attached image" + (ps.length > 1 ? "s" : "") + ".") + "\n\n" + ps.map((p) => "[Attached image: " + p + "]").join("\n"); u.imgs = []; this.osRenderAtts(); } catch (e) { new Notice("Could not attach image: " + (e && e.message || e)); return; } }
    if (!text) return;
    if (target === "new") { u.cmdIn.value = ""; this.osAutoGrow(); try { u.cmdMsg.setText("Starting a new chat in " + (this.project ? this.project.name : "this project") + "\u2026"); await this.osNewClaudChat(text); this.osRemember(text); u.cmdMsg.setText("Sent."); } catch (e) { u.cmdIn.value = text; u.cmdMsg.setText("Could not start a chat: " + (e && e.message || e)); } return; }
    this.osQ = this.osQ || {}; const q = this.osQ[target] = this.osQ[target] || [];
    if (this.claudBusy(target) || q.length) { q.push({ text }); this.osRemember(text); u.cmdIn.value = ""; this.osAutoGrow(); this.osGoLabel(); this.osCQRender(); return; } const say = (m, bad) => { u.cmdMsg.setText(m); u.cmdMsg.toggleClass("bad", !!bad); };
    const cp = this.claudian(); if (!(cp && cp.api && cp.api.send)) { say("Claudian is not available.", true); return; }
    u.cmdIn.disabled = true; say("Sending…");
    try { const title = ((this.osConvs || []).find((c) => c[0] === target) || [])[1] || "session"; await cp.api.send(target, { text }); this.osPendAdd(target, text); this.osRemember(text); u.cmdIn.value = ""; this.osAutoGrow(); say(""); this.osSessData(true); setTimeout(() => this.osClaudRender(true), 800); }
    catch (e) { console.error("Project HQ command", e); say("Could not send: " + redact(e && e.message || e), true); }
    finally { u.cmdIn.disabled = false; u.cmdIn.focus(); }
  },
  // ---- project progress rings ----
  // ---- next posting slot ----
  osNextRender() {
    const u = this.osUI, pr = this.project || {}, nx = nextSlot(pr.slots, new Date()), wait = this.needsCount(), q = this.queue || { open: [] };
    this.osReg("next", JSON.stringify([nx && nx.getTime(), wait, q.open[0] && q.open[0].text]), () => {
      const b = u.next.body; b.empty(); u.next.meta.setText(wait ? wait + " WAITING" : "CLEAR");
      u.next.p.toggleClass("os-hide", !(nx || (pr.queue && q.open.length))); // only for projects that post on a schedule
      if (nx) { const r = b.createDiv({ cls: "os-nrow" }); r.createSpan({ cls: "k", text: "NEXT POST" }); r.createSpan({ cls: "v", text: ((nx.getHours() % 12) || 12) + ":" + osMono(nx.getMinutes()) + (nx.getHours() < 12 ? " AM" : " PM") }); this.osCount = b.createDiv({ cls: "os-count" }); this.osCountAt = nx.getTime(); this.osCountTick(); }
      else { this.osCount = null; b.createDiv({ cls: "os-muted", text: "No posting slots set (Settings: Posting slots)." }); }
      if (q.open[0]) b.createDiv({ cls: "os-muted os-qn", text: "Queue: " + q.open[0].text });
      const w = b.createDiv({ cls: "os-nrow" + (wait ? " warn" : "") }); w.createSpan({ cls: "k", text: "WAITING ON " + String(this.plugin.settings.person || "YOU").toUpperCase() }); w.createSpan({ cls: "v", text: String(wait) });
    });
  },
  osCountTick() { if (this.osCount && this.osCountAt) { const ms = this.osCountAt - Date.now(), s = Math.max(0, Math.floor(ms / 1000)); this.osCount.setText("T-" + osMono(Math.floor(s / 3600)) + ":" + osMono(Math.floor(s % 3600 / 60)) + ":" + osMono(s % 60)); if (ms < 0 && this.osUI) { this.osUI.sig.next = ""; this.osNextRender(); } } },
  // ---- centre: status line + ticker; orb mood ----
  osMidRender() {
    const u = this.osUI, hqBusy = this.hq() && this.hq().isBusy() ? 1 : 0, run = this.live.filter((a) => a.status === "running").length + hqBusy, ci = cacheInfo(), cold = ci && ci.state === "cold", hot = vit.cpu > 85;
    const el = this.osEleven && this.osEleven.ok ? this.osEleven : null, posts = this.queue ? this.queue.posted : null, lv = this.todo && this.todo.live;
    if (this.orb) this.orb.mode(run ? 1 : cold ? 0.15 : 0.28, !!cold);
    const msg = hqBusy && run === 1 ? "Claude is working" : run ? run + (run === 1 ? " agent" : " agents") + " running" : cold ? "Cache cold: next message re-reads the chat" : hot ? "High system load" : "All systems operational", cls = run ? "run" : (cold || hot) ? "warn" : "ok";
    this.osReg("mid", JSON.stringify([msg, cls, run, posts, el && el.left, this.osEleven && this.osEleven.err, lv]), () => {
      u.status.empty(); u.status.className = "os-status " + cls; u.status.createSpan({ cls: "os-dot" }); u.status.createSpan({ text: msg.toUpperCase() });
      if (true) return; const t = u.tick; t.empty(); const it = (k, v, c, tip) => { const e = t.createSpan({ cls: "os-ti " + (c || "") }); e.createSpan({ cls: "k", text: k }); e.createSpan({ cls: "v", text: v }); if (tip) e.title = tip; };
      it("AGENTS", run + " running", run ? "run" : ""); if (posts !== null) it("POSTS TODAY", String(posts));
      if (this.osEleven) it("ELEVENLABS", el ? fmtN(el.left) + " chars left" : (this.osEleven.err ? "n/a" : "checking…"), el && el.left < 20000 ? "warn" : "", this.osEleven.err);
      it("SITE", lv ? "LIVE · " + lv.slice(0, 40) : "n/a", lv ? "ok" : "");
    });
  },
  // ---- ElevenLabs credits: via the existing eleven.mjs, at most once per hour, cached in localStorage ----
  osElevenCheck() {
    const pr = this.project || {}, script = absP(pr.creditsScript || ""); if (!script) { this.osEleven = null; return; }
    if (this.osEleven === undefined) { try { this.osEleven = JSON.parse(localStorage.getItem("hqos-eleven:" + script) || "null"); } catch (e) { this.osEleven = null; } }
    if (this.osElevenBusy || (this.osEleven && Date.now() - this.osEleven.t < 3600000)) return; this.osElevenBusy = true;
    execFile("node", [script, "subscription"], { cwd: path.dirname(script), timeout: 25000, windowsHide: true }, (err, out) => {
      this.osElevenBusy = false; let r = { t: Date.now(), ok: false, err: "" };
      try { const line = String(out || "").split("\n").reverse().find((l) => l.trim().startsWith("{")), j = JSON.parse(line); if (typeof j.left === "number") r = { t: Date.now(), ok: true, left: j.left, limit: j.limit, tier: j.tier }; else r.err = "no data"; } catch (e) { r.err = redact(err ? String(err.message).split("\n")[0] : "no data").slice(0, 100); }
      this.osEleven = r; try { localStorage.setItem("hqos-eleven:" + script, JSON.stringify(r)); } catch (e) {} if (this.osUI) { this.osUI.sig.mid = ""; this.osMidRender(); }
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
        (this.osTaskAll ? open : open.slice(0, 8)).forEach(({ s, i }) => this.osTaskRow(l, i.text, false, (on) => this.osTickLine(i.line, i.raw, on), i.st === "~" ? "in progress" : "", s.name, i.line));
        if (open.length > 8) { const m = l.createEl("button", { cls: "os-more", text: this.osTaskAll ? "Show fewer" : "+" + (open.length - 8) + " more" }); m.onclick = () => { this.osTaskAll = !this.osTaskAll; this.osUI.sig.tasks = ""; this.osTasksRender(); }; }
      });
      group("WAITING ON " + String(this.plugin.settings.person || "YOU").toUpperCase(), wait.length, "wait", (l) => { if (!wait.length) l.createDiv({ cls: "os-muted", text: "Nothing waiting." }); wait.forEach((w) => this.osTaskRow(l, clean(w.text), false, (on) => this.tick(w.line, w.text, on), "", "", w.line)); });
      if (this.project && this.project.queue) group("POST QUEUE · NEXT 5", q.open.length, "queue", (l) => { if (!q.open.length) l.createDiv({ cls: "os-muted", text: "Queue empty." }); q.open.slice(0, 5).forEach((o) => this.osTaskRow(l, o.text, true)); });
    });
  },
  osTaskRow(list, text, ro, onTick, tag, tip, lineNo) {
    const r = list.createDiv({ cls: "os-task" }), id = "os" + Math.random().toString(36).slice(2, 8);
    const cb = r.createEl("input", { attr: { type: "checkbox", id, "aria-label": ro ? "Queued post" : "Mark done: " + text } });
    if (ro) { cb.disabled = true; cb.addClass("ro"); }
    else cb.onchange = () => { // ticking marks the row done; it is written after 4 s, so a second click undoes it
      this.touchedAt = Date.now(); r.toggleClass("done", cb.checked); clearTimeout(r._t);
      if (cb.checked) r._t = setTimeout(() => { r._wrote = true; onTick(true); }, 4000); else if (r._wrote) { r._wrote = false; onTick(false); }
    };
    const lb = r.createEl("span", { cls: "os-tlb", text: text }); lb.title = (tip ? tip + ": " : "") + text + (ro ? "" : "\nClick to open in the note"); if (tag) r.createSpan({ cls: "os-tag", text: tag });
    if (!ro && lineNo !== undefined) { lb.addClass("click"); lb.onclick = () => this.osOpenTodoAt(lineNo); }
  },
  osOpenTodoAt(line) { const f = this.app.vault.getAbstractFileByPath(TODO); if (!(f instanceof TFile)) return; this.app.workspace.getLeaf("tab").openFile(f, { eState: { line } }); },
  async osTickLine(line, raw, on) {
    const f = this.app.vault.getAbstractFileByPath(TODO); if (!(f instanceof TFile)) return;
    await this.app.vault.process(f, (d) => { const ls = d.split("\n"), L = ls[line]; if (L !== undefined && L.includes(String(raw).slice(0, 40))) ls[line] = on === false ? L.replace(/\[x\]/i, "[ ]") : L.replace(/\[[ ~]\]/, "[x]"); return ls.join("\n"); }); // only that one line
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
    const u = this.osUI, need = this.review.filter((i) => i.status === "needs-review"), shown = need;
    this.osReg("rev", this.rsig + "|" + need.length + "|" + this.osRevAll, () => {
      const b = u.rev.body; b.empty(); u.rev.meta.setText(need.length ? need.length + " PENDING" : "CLEAR"); u.rev.meta.toggleClass("warn", need.length > 0);
      if (!need.length) b.createDiv({ cls: "os-muted", text: "Nothing to review." });
      shown.forEach((it) => reviewCard(this, b, it));
    });
  },
  osInsRender() {
    const u = this.osUI;
    this.osReg("ins", this.insSig + "|" + this.liveSig + "|" + JSON.stringify(MODS), () => {
      [["acts", "actions", "actions"], ["files", "files", "files"]].forEach(([k, w, mod]) => {
        const p = u[k]; if (!p) return; const b = p.body; b.empty();
        if (!MODS[mod].on) { b.createDiv({ cls: "os-muted", text: "Mod is off. Switch it on in MODS." }); p.meta.setText("OFF"); return; }
        try { renderInsights(this, b, [w]); modOk(mod); } catch (e) { modErr(mod, e); console.error("Project HQ mod " + mod, e); b.createDiv({ cls: "os-err", text: "Error: " + ((e && e.message) || e) }); p.meta.setText("ERROR"); return; }
        const d = b.querySelector("details"); if (!d) return;
        const s = d.querySelector("summary"), cnt = s && s.querySelector(".lhq-cnt"); p.meta.setText(cnt ? cnt.textContent.toUpperCase() : ""); d.open = true; if (s) s.hide();
      });
    });
  },
  osTick() {
    if (!this.os) return; this.osClockTick(); this.osCountTick(); this.osGate(); this.osHandoffHint(); this.osCQPump(); this.osGoLabel(); if (this.osUI && this.osUI.target && this.osUI.target.value !== "hq" && (this.osClaudTick = (this.osClaudTick || 0) + 1) % 2 === 0) this.osClaudRender(false);
    if (document.hidden || (this.contentEl.isShown && !this.contentEl.isShown())) return;
    const now = Date.now();
    if (now - (this.osVitAt || 0) >= 4000) { this.osVitAt = now; if (this.osPage === "mods") { guardVerify(); this.osModsStatus(); if (this.osUI.guardLog) this.osUI.guardLog.setText(guardLogTail(50)); } sampleVitals(); if (this.osUI) { this.osVitalsRender(); this.osTopRender(); this.osMidRender(); } }
    this.osSessData();
  },
});

// ===== MODS page + THEME editor (HQ_OS style). Settings apply live; nothing needs a reload. =====
const guardCfgPath = () => path.join(BASE || "", WS, "Agent Team", "hooks", "delete-guard.config.json");
const guardLogPath = () => path.join(BASE || "", WS, "Agent Team", "hooks", "delete-guard.log");
function writeGuardConfig() {
  try {
    const f = guardCfgPath(), tmp = f + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ enabled: !!MODS.guard.on, folders: MODS.guard.folders, updated: new Date().toISOString() }, null, 2)); fs.renameSync(tmp, f); modOk("guard"); return true;
  } catch (e) { modErr("guard", "Could not write delete-guard.config.json: " + (e && e.message || e)); return false; }
}
function guardVerify() { // the hook reads this file on every command, so it must match what HQ shows
  try {
    const c = JSON.parse(fs.readFileSync(guardCfgPath(), "utf8"));
    if (!!c.enabled !== !!MODS.guard.on || JSON.stringify(c.folders) !== JSON.stringify(MODS.guard.folders)) { if (!writeGuardConfig()) return; }
    else modOk("guard");
  } catch (e) { if (e && e.code === "ENOENT") writeGuardConfig(); else modErr("guard", "Config unreadable: " + (e && e.message || e)); }
}
function guardLogTail(n) {
  try { const f = guardLogPath(), st = fs.statSync(f), len = Math.min(st.size, 64 * 1024), fd = fs.openSync(f, "r"), b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, st.size - len); fs.closeSync(fd); return redact(b.toString("utf8")).split("\n").filter(Boolean).slice(-n).join("\n") || "(log is empty)"; } catch (e) { return "(no log yet)"; }
}
Object.assign(HQView.prototype, {
  applyTheme() {
    const t = this.plugin.curTheme(), r = this.contentEl; Object.entries(themeVars(t)).forEach(([k, v]) => r.style.setProperty(k, v));
    const orb = t.orb || t.accent; // the sphere follows the accent changer when one is set
    THEME_RGB.a = hex2rgb(orb); THEME_RGB.w = hex2rgb(t.warn); THEME_RGB.e = hueShift(hex2rgb(orb), 110); THEME_RGB.glow = t.glow; THEME_RGB.key = orb + t.warn + t.glow;
  },
  // Accent changer: a dot button in the top bar opens a small swatch tray (AUTO = the theme's own accent, plus a custom picker).
  osAccentPicker(r) {
    const P = this.plugin, cur = P.settings.theme.accent || "", wrap = r.createDiv({ attr: { style: "position:relative;display:inline-flex" } });
    const btn = wrap.createEl("button", { cls: "os-chb", attr: { "aria-label": "Accent colour", title: "Accent: sphere and highlight colour", "aria-expanded": "false" } });
    btn.style.display = "inline-flex"; btn.style.alignItems = "center"; btn.style.gap = "6px";
    const dot = btn.createSpan({ attr: { "aria-hidden": "true", style: "width:11px;height:11px;border-radius:50%;display:inline-block;box-shadow:0 0 6px currentColor" } }); dot.style.background = P.curTheme().accent; dot.style.color = P.curTheme().accent;

    const tray = wrap.createDiv({ attr: { role: "listbox", "aria-label": "Accent colours", style: "position:absolute;top:calc(100% + 6px);right:0;z-index:50;display:none;flex-wrap:wrap;gap:6px;width:236px;padding:8px;background:var(--os-solid,#071217);border:1px solid var(--os-cy,#19e3d0);box-shadow:0 0 14px rgba(0,0,0,.6)" } });
    const close = () => { tray.style.display = "none"; btn.setAttr("aria-expanded", "false"); document.removeEventListener("mousedown", outside, true); };
    const outside = (e) => { if (!wrap.contains(e.target)) close(); };
    btn.onclick = () => { const open = tray.style.display === "none"; tray.style.display = open ? "flex" : "none"; btn.setAttr("aria-expanded", String(open)); if (open) document.addEventListener("mousedown", outside, true); else close(); };
    const pick = (hex) => { close(); P.setAccent(hex); };
    const auto = tray.createEl("button", { cls: "os-chb", text: "AUTO", attr: { role: "option", "aria-selected": String(!cur), title: "Use the theme's own sphere and highlight colour" } }); auto.onclick = () => pick("");
    HQ_ACCENTS.forEach(([name, hex]) => {
      const s = tray.createEl("button", { attr: { role: "option", "aria-label": name, title: name, "aria-selected": String(cur === hex) } });
      s.style.cssText = `width:22px;height:22px;border-radius:50%;padding:0;cursor:pointer;background:${hex};border:2px solid ${cur === hex ? "#fff" : "transparent"};box-shadow:0 0 6px ${hex}`;
      s.onclick = () => pick(hex);
    });
    const cust = tray.createEl("input", { attr: { type: "color", "aria-label": "Custom accent colour", title: "Custom colour" } }); cust.value = hexOk(cur) ? cur : P.curTheme().accent;
    cust.style.cssText = "width:30px;height:24px;padding:0;border:none;background:none;cursor:pointer"; cust.onchange = () => pick(cust.value);
  },
  osModsToggle() { this.osPage = this.osPage === "mods" ? "" : "mods"; this.osPageApply(); },
  osPageApply() {
    const u = this.osUI; if (!u || !u.modsEl) return; const on = this.osPage === "mods";
    u.grid.toggleClass("os-hide", on); u.modsEl.toggleClass("os-hide", !on); u.sig.top = ""; this.osTopRender();
    if (on) { guardVerify(); this.osModsBuild(); } else this.osGate();
  },
  osSetColl(k, on) {
    const u = this.osUI, p = u && u[k === "ap" ? "ap" : k]; if (!p) return; this.osColl = this.osColl || new Set(); on ? this.osColl.add(k) : this.osColl.delete(k);
    p.p.toggleClass("collapsed", on); p.h.setAttr("aria-expanded", String(!on));
  },
  // a mod's settings changed: refresh whatever shows it, right now
  modApplied(k) {
    const u = this.osUI; if (!u) return;
    if (["progress", "files", "cache", "rules", "actions"].includes(k)) { this.insSig = ""; this.insActAt = 0; u.sig.ins = ""; u.sig.top = ""; if (k === "files") this.osSetColl("files", !!MODS.files.collapsed); this.insTick(true); this.osInsRender(); this.osTopRender(); }
    if (k === "orb") this.osGate();
    if (k === "chat") { const hq = this.hq(), c = hq && hq.get(hq.activeId); if (!c && u.model) { u.model.value = MODS.chat.model || ""; u.effort.value = MODS.chat.effort || ""; } this.osChatRender(true); }
    if (k === "guard") { u.sig.top = ""; this.osTopRender(); }
    if (u.modsEl && !u.modsEl.hasClass("os-hide")) this.osModsStatus();
  },
  osModsStatus() {
    const u = this.osUI; if (!u || !u.modEls) return;
    if (!this.plugin.hq) modErr("chat", "Chat engine failed to start (see console).");
    MOD_LIST.forEach(([k]) => {
      const e = u.modEls[k]; if (!e) return; const s = modState(k), ms = MODSTAT[k] || {};
      e.st.setText(s.toUpperCase()); e.st.className = "os-stat " + s; e.c.toggleClass("off", s === "off");
      e.err.setText(ms.err ? "Error: " + ms.err : ms.last ? "Last error (cleared): " + ms.last : ""); e.err.toggleClass("os-hide", !(ms.err || ms.last));
    });
  },
  osModsBuild() {
    const u = this.osUI, el = u.modsEl, keep = el.scrollTop; el.empty(); u.modEls = {}; const P = this.plugin;
    const hd = el.createDiv({ cls: "os-mods-h" }); hd.createSpan({ cls: "t", text: "MODS // SWITCHES, SETTINGS AND THEME" });
    hd.createSpan({ cls: "os-mod-d", text: "Every change applies at once and is saved." }); const back = hd.createEl("button", { cls: "os-chb", text: "BACK TO HQ" }); back.onclick = () => this.osModsToggle();
    const set = (k, patch, rebuild) => { P.setMod(k, patch); if (rebuild) this.osModsBuild(); else this.osModsStatus(); };
    const card = (k) => {
      const def = MOD_LIST.find((x) => x[0] === k), c = el.createDiv({ cls: "os-mod" + (MODS[k].on ? "" : " off") }), h = c.createDiv({ cls: "os-mod-h" });
      h.createSpan({ cls: "os-mod-n", text: def[1] }); const st = h.createSpan({ cls: "os-stat" });
      const sw = h.createEl("button", { cls: "os-sw", attr: { role: "switch", "aria-checked": String(!!MODS[k].on), "aria-label": def[1] + " on or off" } }); sw.onclick = () => set(k, { on: !MODS[k].on }, true);
      const b = c.createDiv({ cls: "os-mod-b" }); b.createDiv({ cls: "os-mod-d", text: def[2] }); const err = b.createDiv({ cls: "os-err os-hide", attr: { role: "status" } }); u.modEls[k] = { st, err, c };
      const f = b.createDiv({ cls: "os-mod-b" }); const rs = b.createEl("button", { cls: "os-chb", text: "RESET TO DEFAULTS", attr: { "aria-label": "Reset " + def[1] + " to defaults" } }); rs.style.alignSelf = "flex-start";
      rs.onclick = () => { P.resetMod(k); this.osModsBuild(); }; return f;
    };
    let idn = 0; const nid = () => "osm" + (++idn);
    const chk = (f, k, fld, label) => { const r = f.createDiv({ cls: "os-f" }), l = r.createEl("label", { cls: "os-tgl" }), i = l.createEl("input", { attr: { type: "checkbox" } }); i.checked = !!MODS[k][fld]; l.createSpan({ text: label }); i.onchange = () => set(k, { [fld]: i.checked }); };
    const num = (f, k, fld, label, lo, hi, step) => { const r = f.createDiv({ cls: "os-f" }), id = nid(); r.createEl("label", { text: label, attr: { for: id } }); const i = r.createEl("input", { attr: { id, type: "number", min: lo, max: hi, step: step || 1 } }); i.value = MODS[k][fld]; i.oninput = () => { const v = Number(i.value); if (i.value !== "" && isFinite(v) && v >= lo && v <= hi) set(k, { [fld]: v }); }; };
    const sel = (f, k, fld, label, opts) => { const r = f.createDiv({ cls: "os-f" }), id = nid(); r.createEl("label", { text: label, attr: { for: id } }); const s = r.createEl("select", { attr: { id } }); opts.forEach(([v, t]) => s.createEl("option", { value: v, text: t })); s.value = MODS[k][fld]; s.onchange = () => set(k, { [fld]: s.value }); };
    const chips = (f, k, fld, label, ph, norm) => {
      const r = f.createDiv({ cls: "os-f" }); r.createEl("label", { text: label }); const L = r.createDiv({ cls: "os-chips-l" });
      MODS[k][fld].forEach((x, i) => { const s = L.createSpan({ text: x }); const rm = s.createEl("button", { text: "×", attr: { "aria-label": "Remove " + x } }); rm.onclick = () => { const a = MODS[k][fld].slice(); a.splice(i, 1); set(k, { [fld]: a }, true); }; });
      const id = nid(), inp = r.createEl("input", { attr: { id, type: "text", placeholder: ph, "aria-label": "Add to " + label } }), add = r.createEl("button", { cls: "os-chb", text: "ADD" });
      const go = () => { const v = (norm ? norm(inp.value) : inp.value).trim(); if (!v || MODS[k][fld].includes(v)) return; set(k, { [fld]: MODS[k][fld].concat(v) }, true); }; add.onclick = go; inp.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter") go(); };
    };
    // --- progress
    let f = card("progress"); chk(f, "progress", "cost", "Show estimated cost"); num(f, "progress", "refresh", "Refresh (seconds)", 1, 60);
    { const tb = f.createEl("table", { cls: "os-prices" }), hr = tb.createEl("tr"); ["$ / MTok", "in", "out", "cache read", "cache 5m", "cache 1h"].forEach((x) => hr.createEl("th", { text: x }));
      ["opus", "sonnet", "haiku"].forEach((fam) => { const tr = tb.createEl("tr"); tr.createEl("td", { text: fam }); ["in", "out", "cr", "c5", "c1"].forEach((fld) => { const i = tr.createEl("td").createEl("input", { attr: { type: "number", min: "0", step: "0.05", "aria-label": fam + " " + fld } }); i.value = (MODS.progress.prices[fam] || {})[fld] || 0; i.oninput = () => { const v = Number(i.value); if (i.value === "" || !isFinite(v) || v < 0) return; const p = cloneJ(MODS.progress.prices); p[fam] = Object.assign({}, p[fam], { [fld]: v }); insCache.clear(); set("progress", { prices: p }); }; }); });
      f.createDiv({ cls: "os-mod-d", text: "Estimates only. Rates apply to every agent as soon as you change them." }); }
    // --- files
    f = card("files"); num(f, "files", "max", "Max files per agent", 1, 30); chk(f, "files", "collapsed", "Collapsed by default");
    // --- cache
    f = card("cache"); num(f, "cache", "warn", "Warn after (min)", 1, 240); num(f, "cache", "cold", "Cold after (min)", 2, 480); num(f, "cache", "compact", "Large chat (k tokens)", 10, 1000, 10);
    // --- rules
    f = card("rules"); chips(f, "rules", "triggers", "Trigger words", "add a word or phrase", (x) => x.toLowerCase()); num(f, "rules", "days", "Days back to scan", 1, 90);
    { const r = f.createDiv({ cls: "os-f" }); r.createEl("label", { text: "Save targets" }); const L = r.createDiv({ cls: "os-chips-l" });
      MODS.rules.targets.forEach((t, i) => { const s = L.createSpan({ text: t.label + " (" + t.kind + (t.path ? ": " + t.path : ": project playbook") + ")" }); const rm = s.createEl("button", { text: "×", attr: { "aria-label": "Remove target " + t.label } }); rm.onclick = () => { const a = MODS.rules.targets.slice(); a.splice(i, 1); set("rules", { targets: a }, true); }; });
      const r2 = f.createDiv({ cls: "os-f" }), lab = r2.createEl("input", { attr: { type: "text", placeholder: "label", "aria-label": "New target label" } }), pth = r2.createEl("input", { attr: { type: "text", placeholder: "vault path, e.g. Claude'sWorkspace/Lumen/Notes/Rules.md", "aria-label": "New target vault path" } }), kd = r2.createEl("select", { attr: { "aria-label": "New target kind" } });
      [["rules", "as a rule"], ["playbook", "to Inbox section"]].forEach(([v, t]) => kd.createEl("option", { value: v, text: t })); const add = r2.createEl("button", { cls: "os-chb", text: "ADD FILE" }), msg = f.createDiv({ cls: "os-err os-hide" });
      [lab, pth].forEach((i) => i.addEventListener("keydown", (e) => e.stopPropagation()));
      add.onclick = () => { const p = pth.value.trim().replace(/\\/g, "/"), l = lab.value.trim() || p.split("/").pop(); msg.addClass("os-hide");
        if (!p || sensitivePath(p) || !(this.app.vault.getAbstractFileByPath(p) instanceof TFile)) { msg.setText(sensitivePath(p) ? "That path is off limits." : "No such note in the vault: " + (p || "(empty)")); msg.removeClass("os-hide"); return; }
        set("rules", { targets: MODS.rules.targets.concat({ label: l, path: p, kind: kd.value }) }, true); }; }
    // --- actions
    f = card("actions"); [["need", "Decisions (needs you)"], ["money", "Costs"], ["sec", "Security"], ["fail", "Failures"]].forEach(([fl, l]) => chk(f, "actions", fl, l));
    { const r = f.createDiv({ cls: "os-f" }), id = nid(); r.createEl("label", { text: "Custom keywords", attr: { for: id } }); const i = r.createEl("input", { attr: { id, type: "text", placeholder: "comma separated, e.g. deadline, refund" } }); i.value = MODS.actions.keywords; i.onkeydown = (e) => e.stopPropagation(); i.oninput = () => set("actions", { keywords: i.value }); }
    // --- orb
    f = card("orb"); num(f, "orb", "particles", "Particles", 100, 1500, 50); num(f, "orb", "fps", "FPS cap", 10, 60); chk(f, "orb", "arcs", "Lightning arcs"); chk(f, "orb", "audio", "Audio equalizer across the globe"); chk(f, "orb", "nowPlaying", "Show what's playing (Spotify, YouTube…)"); num(f, "orb", "audioK", "Audio strength %", 10, 300, 10);
    // --- chat
    f = card("chat"); sel(f, "chat", "model", "Default model", HQ_MODELS.map((m) => [m, m ? m.toUpperCase() : "DEFAULT"])); sel(f, "chat", "effort", "Default effort", HQ_EFFORTS.map((m) => [m, m ? m.toUpperCase() : "DEFAULT"])); chk(f, "chat", "tools", "Show tool lines"); chk(f, "chat", "cost", "Show cost");
    // --- guard
    f = card("guard"); f.createDiv({ cls: "os-mod-d", text: "OFF makes the hook allow everything (the hook entry stays in settings.json). Config: Agent Team\\hooks\\delete-guard.config.json" });
    chips(f, "guard", "folders", "Allowed folders", "name, project/sub, or absolute path", (x) => x.replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""));
    f.createDiv({ cls: "os-mod-d", text: "A plain name (dist) matches inside any project. project/sub (LumenAds/out) is rooted. System Temp is always allowed." });
    { const hr = f.createDiv({ cls: "os-f" }); hr.createEl("label", { text: "Last 50 log lines" }); const rf = hr.createEl("button", { cls: "os-chb", text: "REFRESH" }), pre = f.createEl("pre", { cls: "os-log", text: guardLogTail(50), attr: { tabindex: "0", "aria-label": "delete-guard log, last 50 lines" } }); rf.onclick = () => { pre.setText(guardLogTail(50)); pre.scrollTop = pre.scrollHeight; }; u.guardLog = pre; setTimeout(() => { pre.scrollTop = pre.scrollHeight; }, 0); }
    this.osThemeBuild(el);
    this.osModsStatus(); el.scrollTop = keep;
  },
  osThemeBuild(el) {
    const P = this.plugin, c = el.createDiv({ cls: "os-mod" }); c.style.gridColumn = "1/-1"; const h = c.createDiv({ cls: "os-mod-h" }); h.createSpan({ cls: "os-mod-n", text: "THEME" }); const cur = h.createSpan({ cls: "os-stat", text: "" });
    const b = c.createDiv({ cls: "os-mod-b" }); b.createDiv({ cls: "os-mod-d", text: "Colours apply only to HQ. Pick a preset, or edit the custom theme with a live preview." });
    const pr = b.createDiv({ cls: "os-f" }), refresh = () => { const t = P.curTheme(); cur.setText(t.name.toUpperCase()); cur.className = "os-stat"; };
    const swatch = (t, id) => { const x = pr.createEl("button", { cls: "os-chb", attr: { "aria-pressed": String(P.settings.theme.id === id) } }); x.createSpan({ cls: "os-sw2", attr: { "aria-hidden": "true" } }).style.background = t.accent; x.appendText(" " + t.name.toUpperCase()); x.style.display = "inline-flex"; x.style.gap = "6px"; x.style.alignItems = "center"; x.onclick = () => { P.setThemeId(id); this.osModsBuild(); }; };
    HQ_PRESETS.forEach((t) => swatch(t, t.id)); Object.keys(P.settings.theme.saved || {}).forEach((n) => swatch(Object.assign({ name: n }, P.settings.theme.saved[n]), "saved:" + n));
    const t = P.curTheme(); const edit = (patch, cheap) => { P.editTheme(patch); if (!cheap) this.osModsBuild(); else { refresh(); this.osThemeChecks(); } };
    const cr = b.createDiv({ cls: "os-f" }); cr.createEl("label", { text: "Custom colours" });
    [["accent", "Accent"], ["accent2", "Secondary"], ["warn", "Warning"], ["danger", "Danger"], ["bg", "Background"], ["panel", "Panel"]].forEach(([k, l]) => { const w = cr.createEl("label", { cls: "os-tgl" }), i = w.createEl("input", { attr: { type: "color", "aria-label": l + " colour" } }); i.value = t[k]; w.createSpan({ text: l }); i.oninput = () => edit({ [k]: i.value }, true); });
    const sl = (label, fld, lo, hi) => { const r = b.createDiv({ cls: "os-f" }), id = "osth" + fld; r.createEl("label", { text: label, attr: { for: id } }); const i = r.createEl("input", { attr: { id, type: "range", min: lo, max: hi, step: "0.05" } }); i.value = t[fld]; const o = r.createSpan({ text: Number(t[fld]).toFixed(2) }); i.oninput = () => { o.setText(Number(i.value).toFixed(2)); edit({ [fld]: Number(i.value) }, true); }; };
    sl("Glow strength", "glow", 0, 1.5); sl("Grid opacity", "grid", 0, 1); sl("Scanline opacity", "scan", 0, 1);
    { const r = b.createDiv({ cls: "os-f" }), l = r.createEl("label", { cls: "os-tgl" }), i = l.createEl("input", { attr: { type: "checkbox" } }); i.checked = !!t.scanOn; l.createSpan({ text: "Scanlines on" }); i.onchange = () => edit({ scanOn: i.checked }, true); }
    const sv = b.createDiv({ cls: "os-f" }), nm = sv.createEl("input", { attr: { type: "text", placeholder: "name for this custom theme", "aria-label": "Custom theme name" } }), sb = sv.createEl("button", { cls: "os-chb", text: "SAVE THEME" }); nm.onkeydown = (e) => e.stopPropagation();
    sb.onclick = () => { const n = nm.value.trim().slice(0, 24); if (n) { P.saveTheme(n); this.osModsBuild(); } };
    const sd = P.settings.theme.id.startsWith("saved:") ? P.settings.theme.id.slice(6) : ""; if (sd) { const db = sv.createEl("button", { cls: "os-chb", text: "DELETE \"" + sd.toUpperCase() + "\"" }); db.onclick = () => { P.deleteTheme(sd); this.osModsBuild(); }; }
    const io = b.createDiv({ cls: "os-f" }), ta = io.createEl("textarea", { attr: { "aria-label": "Theme JSON for import or export", rows: "3", spellcheck: "false" } }); ta.onkeydown = (e) => e.stopPropagation();
    const ex = io.createEl("button", { cls: "os-chb", text: "EXPORT JSON" }), im = io.createEl("button", { cls: "os-chb", text: "IMPORT JSON" }), msg = b.createDiv({ cls: "os-mod-d" });
    ex.onclick = () => { const o = Object.assign({ name: P.curTheme().name }, P.curTheme()); delete o.id; ta.value = JSON.stringify(o, null, 1); try { navigator.clipboard.writeText(ta.value); msg.setText("Exported (copied to clipboard)."); } catch (e) { msg.setText("Exported below."); } };
    im.onclick = () => { try { const o = JSON.parse(ta.value); if (!o || typeof o !== "object") throw new Error("not an object"); P.importTheme(o); this.osModsBuild(); } catch (e) { msg.setText("Import failed: " + (e && e.message || e)); } };
    b.createDiv({ cls: "os-mod-d", text: "CONTRAST CHECK (WCAG AA needs 4.5:1 for text)" }); u_checks(this, b); refresh();
  },
  osThemeChecks() { const u = this.osUI; if (u && u.checks) { u.checks.empty(); this.osThemeChecksFill(u.checks); } },
  osThemeChecksFill(box) {
    const rows = themeChecks(this.plugin.curTheme()), bad = rows.filter((r) => !r.pass);
    box.createDiv({ cls: bad.length ? "os-cwarn" : "os-cok", text: bad.length ? "WARNING: " + bad.map((r) => r.label).join(", ") + " below AA (4.5:1) on this theme." : "All checks pass WCAG AA." });
    rows.forEach((r) => { const d = box.createDiv({ cls: "os-f " + (r.pass ? "os-cok" : "os-cwarn") }); d.createSpan({ cls: "os-sw2" }).style.background = r.fg; d.createSpan({ text: r.label + "  " + r.ratio.toFixed(2) + ":1  " + (r.pass ? "PASS" : "FAIL") }); });
  },
});
function u_checks(v, b) { const u = v.osUI; u.checks = b.createDiv({ cls: "os-mod-b" }); u.checks.setAttr("role", "status"); v.osThemeChecksFill(u.checks); }

// ===== HQ chat engine: runs the installed Claude Code CLI headless (stream-json) so HQ is a real chat surface. =====
// One long-lived child process per conversation. User turns go in as stream-json lines; session ids persist for --resume.
// Safety: text typed into HQ is only ever sent to Claude as a message (never run as a command). Permission mode matches Claudian's "yolo" (= bypassPermissions);
// the vault's .claude/settings.json deny rules and PreToolUse delete-guard hook still apply because the CLI runs with cwd = vault root and default setting sources.
const HQ_SLASH = [
  ["compact", "Shrink this chat's history so each message costs less (Claude Code does it)", ""],
  ["clear", "Start a fresh conversation", ""],
  ["model", "Switch model", "sonnet|opus|haiku|default"],
  ["effort", "Set thinking effort", "low|medium|high|xhigh|max|default"],
  ["usage", "Weekly and session usage, and the account in use", ""],
  ["cost", "This chat's turns and estimated cost", ""],
  ["rename", "Rename this chat", "<name>"],
  ["pin", "Pin or unpin this chat at the top of the list", ""],
  ["chats", "Open the chat list", ""],
  ["delete", "Delete this chat", "yes"],
  ["stop", "Stop Claude", ""],
  ["tools", "Show or hide the command lines Claude runs", ""],
  ["help", "List all commands", ""],
];
const HANDOFF_PROMPT = "Write a handoff note so a brand-new chat can continue this work with no other context. Reply with ONLY the note in Markdown, under about 700 words, with these headings: ## Goal, ## Done so far (commits, files, results), ## Current state, ## Key decisions and why, ## Files and paths that matter, ## Next steps (in order), ## Waiting on Hayden / open questions. Be specific (exact paths, commands, names). Do not run tools or do any other work.";
const HANDOFF_TIP = "HANDOFF: Claude writes a detailed handoff summary of this chat, then a NEW chat starts with that summary, so you continue fresh without losing context. Uses one short AI turn. Better than COMPACT for long chats (compacting drops details). Lights up when this chat passes 250k tokens or its cache has gone cold.";
const HQ_MODELS = ["", "sonnet", "opus", "haiku"], HQ_EFFORTS = ["", "low", "medium", "high", "xhigh", "max"];
const toolTarget = (name, inp) => {
  inp = inp || {}; const v = inp.file_path || inp.path || inp.command || inp.pattern || inp.url || inp.query || inp.description || inp.prompt || inp.skill || "";
  if (v) return String(v); const k = Object.keys(inp).find((x) => typeof inp[x] === "string"); return k ? String(inp[k]) : "";
};
const escH = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// Safe markdown: everything is HTML-escaped first; only a fixed set of tags is generated. Links carry data-u (no href) and are opened by a click handler.
function mdSafe(src) {
  return String(src || "").split(/(```[\s\S]*?(?:```|$))/).map((seg) => {
    if (seg.startsWith("```")) return "<pre><code>" + escH(seg.replace(/^```[^\n]*\n?/, "").replace(/```$/, "")) + "</code></pre>";
    const stash = [];
    let h = escH(seg).replace(/`([^`\n]+)`/g, (m, c) => { const raw = c.replace(/&amp;/g, "&"); stash.push(/^[^\s<>|*?"]+\.(md|canvas)$/.test(raw) ? '<a class="os-lk" data-u="' + c + '"><code>' + c + "</code></a>" : "<code>" + c + "</code>"); return "\u0000" + (stash.length - 1) + "\u0000"; });
    h = h.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (m, t, a) => '<a class="os-lk" data-u="[[' + t + ']]">' + (a || t) + "</a>")
      .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, '<a class="os-lk" data-u="$2">$1</a>')
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>").replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");
    const out = []; let list = "";
    const close = () => { if (list) { out.push("</" + list + ">"); list = ""; } };
    h.split("\n").forEach((l) => {
      let m;
      if ((m = /^(#{1,4})\s+(.*)/.exec(l))) { close(); out.push("<h" + (m[1].length + 2) + ">" + m[2] + "</h" + (m[1].length + 2) + ">"); }
      else if ((m = /^\s*[-*]\s+(.*)/.exec(l))) { if (list !== "ul") { close(); out.push("<ul>"); list = "ul"; } out.push("<li>" + m[1] + "</li>"); }
      else if ((m = /^\s*\d+[.)]\s+(.*)/.exec(l))) { if (list !== "ol") { close(); out.push("<ol>"); list = "ol"; } out.push("<li>" + m[1] + "</li>"); }
      else if (!l.trim()) { close(); out.push('<div class="os-gap"></div>'); }
      else { close(); out.push("<p>" + l + "</p>"); }
    });
    close();
    return out.join("").replace(/\u0000(\d+)\u0000/g, (m, i) => stash[+i]);
  }).join("");
}
class HQChats {
  constructor(plugin) {
    this.plugin = plugin; this.convs = new Map(); this.activeId = ""; this.subs = new Set(); this.dead = false; this.loaded = false;
    this.dir = path.join(plugin.app.vault.adapter.getBasePath(), plugin.manifest.dir || ".obsidian/plugins/project-hq");
    this.chats = path.join(this.dir, "chats"); this.logFile = path.join(this.dir, "hq-chat.log");
    this.root = plugin.app.vault.adapter.getBasePath();
    this._quit = () => this.killAll(); window.addEventListener("beforeunload", this._quit);
    this.idle = setInterval(() => { for (const c of this.convs.values()) if (c.proc && !c.busy && Date.now() - c.lastUse > 30 * 60000) this.kill(c, "idle"); }, 60000);
    this.load();
  }
  exe() { return (this.plugin.settings.claudePath || "").trim() || path.join(os.homedir(), ".local", "bin", "claude.exe"); }
  on(fn) { this.subs.add(fn); return () => this.subs.delete(fn); }
  emit(c, what) { this.subs.forEach((f) => { try { f(c, what); } catch (e) { console.error("Project HQ chat ui", e); } }); }
  log(m) { try { fs.mkdirSync(this.dir, { recursive: true }); try { if (fs.statSync(this.logFile).size > 400000) fs.renameSync(this.logFile, this.logFile + ".1"); } catch (e) {} fs.appendFileSync(this.logFile, new Date().toISOString() + " " + redact(String(m)).slice(0, 2000) + "\n"); } catch (e) {} }
  load() {
    try { fs.mkdirSync(this.chats, { recursive: true }); for (const f of fs.readdirSync(this.chats)) if (f.endsWith(".json")) { try { const c = JSON.parse(fs.readFileSync(path.join(this.chats, f), "utf8")); if (c && c.id) { if (c.proj === "lumenads") { c.proj = "lumen"; c.projName = "Lumen"; c.projFolder = "Claude'sWorkspace/Lumen"; c.projExtra = "LumenAds"; } c.proc = null; c.busy = false; c.lastUse = 0; this.convs.set(c.id, c); } } catch (e) {} } } catch (e) { this.log("load " + e.message); }
    this.loaded = true;
  }
  save(c) {
    clearTimeout(c._st); c._st = setTimeout(() => { try { const o = {}; for (const k of ["id", "sessionId", "title", "model", "effort", "created", "updated", "turns", "proj", "projName", "projFolder", "projExtra", "primed", "pinned"]) o[k] = c[k]; o.msgs = c.msgs.slice(-200); fs.mkdirSync(this.chats, { recursive: true }); fs.writeFileSync(path.join(this.chats, c.id + ".json"), redact(JSON.stringify(o))); } catch (e) { this.log("save " + e.message); } }, 400);
  }
  projOf(c) { return c.proj || "lumen"; }
  list(proj) { return [...this.convs.values()].filter((c) => !proj || this.projOf(c) === proj).sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.updated || 0) - (a.updated || 0)); }
  get(id) { return this.convs.get(id); }
  create(model, effort, pr) {
    const id = "hq-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const c = { id, sessionId: "", title: "New conversation", model: model || "", effort: effort || "", created: Date.now(), updated: Date.now(), turns: [], msgs: [], proj: pr ? pr.id : "", projName: pr ? pr.name : "", projFolder: pr ? pr.folder || "" : "", projExtra: pr ? pr.extra || "" : "", primed: false, proc: null, busy: false, lastUse: Date.now(), cur: null };
    this.convs.set(id, c); this.activeId = id; this.save(c); this.emit(c, "list"); return c;
  }
  remove(c) {
    this.kill(c, "delete"); this.convs.delete(c.id); clearTimeout(c._st); try { fs.unlinkSync(path.join(this.chats, c.id + ".json")); } catch (e) {}
    if (this.activeId === c.id) this.activeId = ""; this.emit(c, "list");
  }
  isBusy() { for (const c of this.convs.values()) if (c.busy) return true; return false; }
  todayTotals() { const d0 = new Date(); d0.setHours(0, 0, 0, 0); let cost = 0, tin = 0, tout = 0, cache = 0, n = 0; for (const c of this.convs.values()) for (const t of c.turns || []) if (t.at >= d0.getTime()) { cost += t.cost || 0; tin += t.in || 0; tout += t.out || 0; cache += t.cache || 0; n++; } return { cost, tin, tout, cache, n }; }
  // ---- process ----
  spawnProc(c) {
    const exe = this.exe(); if (!fs.existsSync(exe)) throw new Error("Claude Code was not found at " + exe + ". Install it, or set its path in Project HQ settings (Claude Code path).");
    const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-mode", "bypassPermissions"];
    if (c.model) args.push("--model", c.model); if (c.effort) args.push("--effort", c.effort); if (c.sessionId) args.push("--resume", c.sessionId);
    this.log("spawn " + path.basename(exe) + " " + args.join(" ") + " (conv " + c.id + ")");
    const p = require("child_process").spawn(exe, args, { cwd: this.root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: Object.assign({}, process.env) });
    c.proc = p; c.procModel = c.model; c.procEffort = c.effort; c.buf = ""; c.err = ""; c.costBase = 0; c.cur = null; c.idx = {};
    p.stdout.on("data", (d) => { c.buf += d.toString("utf8"); let i; while ((i = c.buf.indexOf("\n")) >= 0) { const line = c.buf.slice(0, i).trim(); c.buf = c.buf.slice(i + 1); if (line) this.onLine(c, line); } });
    p.stderr.on("data", (d) => { c.err = (c.err + d.toString("utf8")).slice(-4000); });
    p.on("error", (e) => { this.log("proc error " + e.message); if (c.proc === p) { c.proc = null; this.finish(c, "Could not start Claude Code: " + e.message); } });
    p.on("exit", (code, sig) => { this.log("exit " + code + " " + sig + " (conv " + c.id + ") " + c.err.slice(-300)); if (c.proc === p) { c.proc = null; if (c.busy) this.finish(c, c.stopping ? "" : "Claude Code stopped unexpectedly (code " + code + ")." + (c.err ? " " + redact(c.err.trim().split("\n").slice(-2).join(" ")).slice(0, 300) : "")); } });
    p.stdin.on("error", () => {});
    return p;
  }
  kill(c, why) {
    const p = c.proc; if (!p) return; c.proc = null; this.log("kill " + why + " pid " + p.pid + " (conv " + c.id + ")");
    try { p.stdin.end(); } catch (e) {}
    try { require("child_process").execFile("taskkill", ["/PID", String(p.pid), "/T", "/F"], { windowsHide: true }, () => {}); } catch (e) { try { p.kill(); } catch (e2) {} }
  }
  killAll() { for (const c of this.convs.values()) if (c.proc) this.kill(c, "shutdown"); }
  destroy() { this.dead = true; clearInterval(this.idle); window.removeEventListener("beforeunload", this._quit); this.killAll(); for (const c of this.convs.values()) { clearTimeout(c._st); if (c.busy) { c.busy = false; } } }
  send(c, text, imgs) {
    if (c.busy) return; text = String(text || "").trim(); imgs = imgs || []; if (!text && !imgs.length) return; if (!text) text = "(see the attached image" + (imgs.length > 1 ? "s" : "") + ")";
    if (c.proc && (c.procModel !== c.model || c.procEffort !== c.effort)) this.kill(c, "settings changed");
    let p = c.proc; if (!p) { try { p = this.spawnProc(c); } catch (e) { this.addMsgs(c, text, e.message); return; } }
    const slash = /^\/\S/.test(text);
    if (c.title === "New conversation" && !slash) c.title = text.replace(/\s+/g, " ").slice(0, 48);
    let wire = text, ctx = "";
    if (!c.primed && c.proj && !slash) { ctx = "Project: " + c.projName + (c.projFolder ? ", folder " + c.projFolder + ". Notes in " + c.projFolder + "/Notes." : ".");
    const ex = String(c.projExtra || "").split(",").map((x) => x.trim()).filter(Boolean);
    if (ex.length) { const nm = (f) => String(f).split("/").pop() + "\\"; ctx = "Project: " + c.projName + " (one project, folders under Claude'sWorkspace). " + nm(c.projFolder) + " is the app/code; " + ex.map((x) => nm(x) + " is " + (/ads/i.test(x) ? "marketing/ads" : "part of the project")).join("; ") + ". Notes live in each folder's Notes/."; } wire = "[Project context] " + ctx + "\n\n" + text; }
    if (!slash) c.primed = true;
    c.msgs.push({ r: "user", text: redact(text), ctx, imgs: imgs.length }); c.cur = { r: "asst", blocks: [], at: Date.now() }; c.msgs.push(c.cur); c.idx = {}; c.busy = true; c.stopping = false; c.lastUse = Date.now(); c.updated = Date.now();
    try { const content = imgs.length ? imgs.map((i) => ({ type: "image", source: { type: "base64", media_type: i.media, data: i.data } })).concat([{ type: "text", text: wire }]) : wire; p.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n"); } catch (e) { this.finish(c, "Could not write to Claude Code: " + e.message); return; }
    this.save(c); this.emit(c, "turn");
  }
  addMsgs(c, text, err) { c.msgs.push({ r: "user", text: redact(text) }, { r: "asst", blocks: [{ k: "error", text: err }] }); this.save(c); this.emit(c, "turn"); }
  stop(c) {
    if (!c.busy || !c.proc) return; c.stopping = true; this.log("stop requested (conv " + c.id + ")");
    try { c.proc.stdin.write(JSON.stringify({ type: "control_request", request_id: "hq-int-" + Date.now(), request: { subtype: "interrupt" } }) + "\n"); } catch (e) {}
    const p = c.proc; setTimeout(() => { if (c.busy && c.proc === p) { this.kill(c, "stop timeout"); this.finish(c, ""); } }, 4000);
  }
  finish(c, err) {
    const cur = c.cur; if (err && cur) cur.blocks.push({ k: "error", text: err }); if (cur) { cur.blocks.forEach((b) => { if (b.k === "tool") b.open = false; }); if (c.stopping) cur.stopped = true; }
    c.busy = false; c.stopping = false; c.cur = null; c.lastUse = Date.now(); this.save(c); this.emit(c, "done");
    if (c.queue && c.queue.length && !this.dead) setTimeout(() => { if (!c.busy && c.queue && c.queue.length) { const q = c.queue.shift(); this.send(c, q.text, q.imgs); } }, 300);
  }
  onLine(c, line) {
    let j; try { j = JSON.parse(line); } catch (e) { this.log("bad line " + line.slice(0, 120)); return; }
    const t = j.type; c.lastUse = Date.now();
    if (t === "system") { if (j.subtype === "init" && j.session_id) { c.sessionId = j.session_id; this.save(c); } if (j.subtype === "compact_boundary" && c.cur) { c.cur.blocks.push({ k: "text", text: "*Chat history compacted.*" }); this.emit(c, "stream"); } return; }
    if (j.parent_tool_use_id) return; // subagent chatter stays out of the transcript
    const cur = c.cur;
    if (t === "stream_event" && cur) {
      const e = j.event || {};
      if (e.type === "message_start") c.idx = {};
      else if (e.type === "content_block_start") {
        const b = e.content_block || {}; let nb;
        if (b.type === "text") nb = { k: "text", text: "" }; else if (b.type === "thinking" || b.type === "redacted_thinking") nb = { k: "think" };
        else if (b.type === "tool_use") nb = { k: "tool", id: b.id, name: b.name, json: "", target: "", result: "", open: true }; else return;
        cur.blocks.push(nb); c.idx[e.index] = nb; this.emit(c, "stream");
      } else if (e.type === "content_block_delta") {
        const b = c.idx[e.index], d = e.delta || {}; if (!b) return;
        if (d.type === "text_delta" && b.k === "text") b.text += d.text; else if (d.type === "input_json_delta" && b.k === "tool") b.json += d.partial_json || "";
        this.emit(c, "stream");
      } else if (e.type === "content_block_stop") {
        const b = c.idx[e.index]; if (b && b.k === "tool") { try { b.input = JSON.parse(b.json || "{}"); } catch (x) { b.input = {}; } b.target = toolTarget(b.name, b.input); b.json = ""; this.emit(c, "stream"); }
      }
    } else if (t === "user" && cur) {
      const ct = j.message && j.message.content; if (!Array.isArray(ct)) return;
      for (const r of ct) if (r.type === "tool_result") { const b = cur.blocks.find((x) => x.k === "tool" && x.id === r.tool_use_id); if (b) { b.open = false; b.result = redact(typeof r.content === "string" ? r.content : Array.isArray(r.content) ? r.content.map((x) => x.text || "").join("\n") : "").slice(0, 1500); if (r.is_error) b.isErr = true; this.emit(c, "stream"); } }
    } else if (t === "result") {
      const u = j.usage || {}, tot = typeof j.total_cost_usd === "number" ? j.total_cost_usd : 0, cost = Math.max(0, tot - (c.costBase || 0)); c.costBase = tot;
      const turn = { at: Date.now(), cost, in: u.input_tokens || 0, out: u.output_tokens || 0, cache: (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), model: c.model || "default" };
      c.turns = c.turns || []; c.turns.push(turn); if (cur) cur.usage = turn;
      let err = ""; if (j.is_error) { const r = String(j.result || ""); err = /login|log in|authenticat|401|api key|credential/i.test(r) ? "Claude Code is not logged in. Open a terminal, run `claude`, then /login." : (r || "Claude Code reported an error.").slice(0, 400); }
      if (j.session_id) c.sessionId = j.session_id;
      if (c.stopping && cur) cur.stopped = true;
      this.finish(c, c.stopping ? "" : err);
    }
  }
}

// ===== HQ chat UI (centre column): orb shrinks while a conversation is open; the command bar is the chat input =====
Object.assign(HQView.prototype, {
  hq() { return this.plugin.hq; },
  osChatInit() {
    const u = this.osUI, hq = this.hq(); if (!hq) return;
    if (this.osUnsub) this.osUnsub(); this.osUnsub = hq.on((c, what) => this.osChatEvent(c, what));
    u.chatOpen = !!(hq.activeId && this.osChatWas); this.osChatLayout(); this.osChatRender(true);
  },
  osChatEvent(c, what) {
    const u = this.osUI; if (!u) return;
    if (what === "stream") { if (hqChatIsActive(this, c)) this.osChatScheduleStream(); return; }
    if (what === "turn" && hqChatIsActive(this, c)) { u.chatOpen = true; this.osChatWas = true; }
    this.osChatLayout(); this.osChatRender(true); u.sig.mid = ""; this.osMidRender();
  },
  osChatScheduleStream() { if (this.osStreamT) return; this.osStreamT = setTimeout(() => { this.osStreamT = 0; this.osChatRender(false); }, 60); },
  osChatLayout() {
    const u = this.osUI, hq = this.hq(), c = hq && hq.get(hq.activeId), claud = u.target.value !== "hq", open = !u.chatHidden && (claud || !!(u.chatOpen && c)); if (u.showChat) u.showChat.toggleClass("os-hide", !(u.chatHidden && (claud || (u.chatOpen && c))));
    u.chatBox.toggleClass("claud", claud); u.chatBox.toggleClass("nohq", !MODS.chat.on); if (claud && u.claudId !== u.target.value) { u.claudId = u.target.value; u.claudKey = ""; setTimeout(() => this.osClaudRender(true), 0); } if (!claud) u.claudId = "";
    u.mid.toggleClass("chatting", open); u.chatBox.toggleClass("os-hide", !open);
    this.osGoLabel();
    const hqT = u.target.value === "hq"; u.cmdIn.placeholder = hqT ? "Message Claude Code" + (this.project ? " about " + this.project.name : "") + "…  (type / for commands)" : "Message the selected Claudian session…"; u.hint.setText(hqT ? "ENTER sends · SHIFT+ENTER new line · / commands · UP recalls last" : "ENTER sends to Claudian · SHIFT+ENTER new line");
    u.model.toggleClass("os-hide", !hqT); u.effort.toggleClass("os-hide", !hqT);
    if (c && hqT) { u.model.value = c.model || ""; u.effort.value = c.effort || ""; } this.osTargetLabel();
  },
  osChatRender(full) {
    if (this.osUI && this.osUI.target && this.osUI.target.value !== "hq") return; // a Claudian chat is showing (osClaudRender)
    const u = this.osUI, hq = this.hq(), c = hq && hq.get(hq.activeId); if (!u || !c || !u.chatOpen) { if (u && u.chatBody && full) u.chatBody.empty(); return; }
    const sig = c.id + "|" + c.msgs.length + "|" + c.busy;
    if (full || u.chatSig !== sig) { u.chatSig = sig; this.osChatFull(c); } else this.osChatLive(c);
    this.osQueueRender(c); u.chatTitle.setText(c.title); const tot = (c.turns || []).reduce((n, t) => n + (t.cost || 0), 0); u.chatCost.setText(c.busy ? "WORKING" : tot && MODS.chat.cost ? "~" + usd(tot) : "READY"); u.chatCost.toggleClass("run", !!c.busy);
  },
  osChatFull(c) {
    const u = this.osUI, b = u.chatBody, near = u.stick !== false; b.empty(); u.liveEl = null;
    if (!c.msgs.length) b.createDiv({ cls: "os-muted os-chint", text: "Ask Claude Code anything. It runs in this vault with your CLAUDE.md rules. Files it mentions open beside HQ." });
    c.msgs.forEach((m) => this.osChatMsg(b, m, m === c.cur));
    if (c.busy && !(c.cur && c.cur.blocks.length)) b.createDiv({ cls: "os-think", text: "Claude is thinking…" });
    if (near) b.scrollTop = b.scrollHeight;
  },
  osChatLive(c) { // streaming: re-render only the last assistant message
    const u = this.osUI, b = u.chatBody, near = u.stick !== false, last = [...b.querySelectorAll(".os-msg.asst")].pop(); if (!last || !c.cur) { this.osChatFull(c); return; }
    const nw = createDiv(); this.osChatMsg(nw, c.cur, true); last.replaceWith(nw.firstChild); if (near) b.scrollTop = b.scrollHeight;
  },
  osChatMsg(parent, m, live) {
    if (m.r === "user") { const d = parent.createDiv({ cls: "os-msg user" }); if (m.ctx) d.createDiv({ cls: "os-ctx", text: "PROJECT CONTEXT SENT", attr: { title: redact(m.ctx) } }); if (m.imgs) d.createDiv({ cls: "os-ctx", text: "[" + m.imgs + " image" + (m.imgs > 1 ? "s" : "") + " attached]" }); const pics = []; let tx = String(m.text || "").replace(/\s*\[Attached image: ([^\]]+)\]/g, (_, p) => { pics.push(p.trim()); return ""; }).trim(); if (pics.length && /^See the attached images?\.$/.test(tx)) tx = "";
      if (tx) d.createDiv({ cls: "os-mt", text: redact(tx) });
      if (pics.length) { const g = d.createDiv({ cls: "os-upics" }); this.osImgCache = this.osImgCache || new Map(); pics.forEach((p) => { let src = this.osImgCache.get(p); if (!src) { try { const ext = (p.split(".").pop() || "png").toLowerCase(); src = "data:image/" + (ext === "jpg" ? "jpeg" : ext) + ";base64," + require("fs").readFileSync(p).toString("base64"); this.osImgCache.set(p, src); } catch (e) { src = ""; } } if (src) { const im = g.createEl("img", { cls: "os-upic", attr: { src, alt: "Attached image" } }); im.onclick = () => window.open(src); } else g.createDiv({ cls: "os-ctx", text: "[image no longer available]" }); }); }
      return; }
    if (m.r === "sys") { parent.createDiv({ cls: "os-msg sys" }).insertAdjacentHTML("beforeend", mdSafe(m.text)); return; }
    const d = parent.createDiv({ cls: "os-msg asst" + (live ? " live" : "") });
    (m.blocks || []).forEach((bl, i) => {
      if (bl.k === "text") { if (!bl.text.trim()) return; const t = d.createDiv({ cls: "os-mt os-md" }); t.insertAdjacentHTML("beforeend", mdSafe(redact(bl.text))); }
      else if (bl.k === "think") { if (live && i === m.blocks.length - 1) d.createDiv({ cls: "os-think", text: "Claude is thinking…" }); }
      else if (bl.k === "error") d.createDiv({ cls: "os-err", text: redact(bl.text) });
      else if (bl.k === "tool" && MODS.chat.tools) {
        const det = d.createEl("details", { cls: "os-tool" + (bl.isErr ? " err" : "") + (bl.open ? " run" : "")}), s = det.createEl("summary");
        const l1 = s.createDiv({ cls: "os-tl" }); l1.createSpan({ cls: "os-tn", text: (bl.isErr ? "\u2716 " : bl.open ? "\u25CF " : "\u2713 ") + bl.name }); l1.createSpan({ cls: "os-tt", text: redact(bl.target || "").replace(/\s+/g, " ").slice(0, 400) });
        if (bl.result) { const rl = bl.result.split("\n").filter((x) => x.trim()); s.createDiv({ cls: "os-tr", text: "\u23BF " + rl.slice(0, 2).join("\n").slice(0, 240) + (rl.length > 2 ? "  (+" + (rl.length - 2) + " lines)" : "") }); }
        const body = det.createDiv({ cls: "os-tb" }); const inp = bl.input ? redact(JSON.stringify(bl.input, null, 1)).slice(0, 1200) : ""; if (inp) body.createEl("pre", { text: inp }); if (bl.result) body.createEl("pre", { text: bl.result.slice(0, 800) });
      }
    });
    if (m.stopped) d.createDiv({ cls: "os-err", text: "Stopped." });
    if (m.usage && MODS.chat.cost) { const t = m.usage; d.createDiv({ cls: "os-use", text: "in " + kfmt(t.in) + " · out " + kfmt(t.out) + " · cache " + kfmt(t.cache) + " · ~" + usd(t.cost) + " est." }); }
  },
  osChatHeader(box) {
    const u = this.osUI, h = box.createDiv({ cls: "os-chh" });
    u.chatTitle = h.createSpan({ cls: "os-cht", text: "" }); u.chatCost = h.createSpan({ cls: "os-chc", text: "" });
    const bt = (t, label, fn) => { const b = h.createEl("button", { cls: "os-chb", text: t, attr: { "aria-label": label, title: label } }); b.onclick = fn; return b; };
    bt("NEW", "New conversation", () => this.osChatNew()); bt("CHATS", "Conversation list", () => this.osChatList()); const dl = bt("DELETE", "Delete this conversation", () => { const hq = this.hq(), c = hq.get(hq.activeId); if (!c) return; if (c.busy) { new Notice("Stop Claude first."); return; } if (!dl.hasClass("sure")) { dl.addClass("sure"); dl.setText("SURE?"); setTimeout(() => { dl.removeClass("sure"); dl.setText("DELETE"); }, 3000); return; } dl.removeClass("sure"); dl.setText("DELETE"); hq.remove(c); u.chatOpen = false; this.osChatWas = false; this.osChatLayout(); this.osChatRender(true); this.osSessData(true); }); const hb = bt("", "Hide chat (keeps running)", () => { if (u.target.value !== "hq") { u.chatHidden = true; this.osChatLayout(); u.sig.mid = ""; this.osMidRender(); return; } u.chatOpen = false; this.osChatWas = false; this.osChatLayout(); u.sig.mid = ""; this.osMidRender(); }); hb.addClass("os-hidechat");
  },
  osChatNew() { const u = this.osUI, hq = this.hq(); hq.activeId = ""; const c = hq.create(u.model.value, u.effort.value, this.project); u.chatOpen = true; this.osChatWas = true; this.osChatLayout(); this.osChatRender(true); u.cmdIn.focus(); },
  osChatOpenConv(id) { const u = this.osUI, hq = this.hq(); if (!hq.get(id)) return; const cp = hq.projOf(hq.get(id)); if (this.project && cp !== this.project.id && this.plugin.visibleProjects().some((p) => p.id === cp)) { this.osPendingConv = id; hq.activeId = id; this.reload(cp).then(() => { const i = this.osPendingConv; this.osPendingConv = ""; if (i) { hq.activeId = i; this.osChatOpenConv(i); } }); return; } hq.activeId = id; u.chatOpen = true; this.osChatWas = true; u.target.value = "hq"; u.chatList.addClass("os-hide"); this.osChatLayout(); this.osChatRender(true); const b = u.chatBody; b.scrollTop = b.scrollHeight; },
  osChatList() {
    const u = this.osUI, hq = this.hq(), L = u.chatList; if (!L.hasClass("os-hide")) { L.addClass("os-hide"); return; } L.empty(); L.removeClass("os-hide");
    const all = !!this.osChatAll, list = hq.list(all ? "" : this.project && this.project.id), tg = L.createEl("button", { cls: "os-chb os-lall", text: all ? "SHOW " + (this.project ? this.project.name.toUpperCase() : "PROJECT") + " ONLY" : "SHOW ALL PROJECTS", attr: { "aria-pressed": String(all) } }); tg.onclick = () => { this.osChatAll = !all; u.chatList.addClass("os-hide"); this.osChatList(); };
    if (!list.length) L.createDiv({ cls: "os-muted", text: "No conversations for " + (this.project ? this.project.name : "this project") + " yet. Press NEW or just type below." });
    list.slice(0, 30).forEach((c) => {
      const r = L.createDiv({ cls: "os-cli" + (c.id === hq.activeId ? " cur" : ""), attr: { role: "button", tabindex: "0" } }), tot = (c.turns || []).reduce((n, t) => n + (t.cost || 0), 0);
      r.createSpan({ cls: "os-clt", text: c.title }); r.createSpan({ cls: "os-cld", text: (c.busy ? "WORKING · " : "") + (all ? (c.projName || "Lumen") + " · " : "") + new Date(c.updated).toLocaleDateString([], { day: "2-digit", month: "short" }) + (tot && MODS.chat.cost ? " · ~" + usd(tot) : "") });
      const pin = r.createEl("button", { cls: "os-chb" + (c.pinned ? " on" : ""), text: c.pinned ? "\u2605" : "\u2606", attr: { "aria-label": (c.pinned ? "Unpin " : "Pin ") + c.title, title: c.pinned ? "Unpin" : "Pin to top" } }); pin.onclick = (e) => { e.stopPropagation(); this.osChatPin(c); L.addClass("os-hide"); this.osChatList(); };
      const ren = r.createEl("button", { cls: "os-chb", text: "RENAME", attr: { "aria-label": "Rename " + c.title } }); ren.onclick = (e) => { e.stopPropagation(); this.osChatRenameInline(r, c); };
      const del = r.createEl("button", { cls: "os-chb", text: "DELETE", attr: { "aria-label": "Delete conversation " + c.title } }); del.onclick = (e) => { e.stopPropagation(); if (!del.hasClass("sure")) { del.addClass("sure"); del.setText("SURE?"); setTimeout(() => { del.removeClass("sure"); del.setText("DELETE"); }, 3000); return; } hq.remove(c); L.addClass("os-hide"); this.osChatList(); this.osChatLayout(); this.osChatRender(true); };
      const open = () => this.osChatOpenConv(c.id); r.onclick = open; r.addEventListener("keydown", (e) => { if (e.target === r && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); open(); } });
    });
  },
  osChatLink(raw) { // open a link from assistant text: web links externally, vault files beside HQ, never personal paths
    const ws = this.app.workspace, app = this.app, base = app.vault.adapter.getBasePath().replace(/\\/g, "/"); let u = String(raw || "").trim();
    if (/^https?:\/\//i.test(u)) { try { require("electron").shell.openExternal(u); } catch (e) { window.open(u); } return; }
    let f = null; const wl = /^\[\[(.+)\]\]$/.exec(u);
    if (wl) f = app.metadataCache.getFirstLinkpathDest(wl[1].split("#")[0], ""); else { u = decodeURIComponent(u.replace(/^file:\/\/\/?/, "")).replace(/\\/g, "/").replace(/#.*$/, ""); if (u.toLowerCase().startsWith(base.toLowerCase() + "/")) u = u.slice(base.length + 1); u = u.replace(/^\.\//, ""); const g = app.vault.getAbstractFileByPath(u); if (g instanceof TFile) f = g; else f = app.metadataCache.getFirstLinkpathDest(u, ""); }
    if (!f) { new Notice("Not a vault file: " + u.slice(0, 80)); return; } if (OS_PERSONAL.test(f.path)) { new Notice("HQ will not open personal files."); return; }
    ws.getLeaf("tab").openFile(f); // keepFilesBesideHQ places it next to HQ
  },
  osChatSend(text) {
    const u = this.osUI, hq = this.hq(); if (!MODS.chat.on) { new Notice("The HQ chat mod is off. Switch it on in MODS."); return; } text = String(text || "").trim(); const imgs = u.imgs.slice(); if (!text && !imgs.length) return;
    if (!imgs.length && this.osSlash(text)) return;
    let c = hq.get(hq.activeId); if (c && hq.projOf(c) !== (this.project && this.project.id)) c = null;
    if (!c) c = hq.create(u.model.value, u.effort.value, this.project);
    if (c.busy) return; c.model = u.model.value; c.effort = u.effort.value; u.chatOpen = true; this.osChatWas = true; u.cmdIn.value = ""; u.imgs = []; this.osRenderAtts(); if (text) this.osRemember(text); if (u.full) this.osSetFull(false); this.osAutoGrow();
    hq.send(c, text, imgs); this.osChatLayout(); this.osChatRender(true);
  },
  osChatPin(c) { c.pinned = !c.pinned; this.hq().save(c); this.osSessData(true); if (this.osUI) this.osChatRender(true); },
  osChatRename(c, name) { name = String(name || "").replace(/\s+/g, " ").trim().slice(0, 80); if (!name) return; c.title = name; this.hq().save(c); this.osSessData(true); if (this.osUI) this.osChatRender(true); },
  osChatRenameInline(row, c) {
    const t = row.querySelector(".os-clt"); if (!t) return; const inp = createEl("input", { cls: "os-ren", attr: { type: "text", "aria-label": "New name" } }); inp.value = c.title; t.replaceWith(inp); inp.focus(); inp.select();
    let done = false; const fin = (ok) => { if (done) return; done = true; if (ok) this.osChatRename(c, inp.value); const L = this.osUI.chatList; L.addClass("os-hide"); this.osChatList(); };
    inp.onclick = (e) => e.stopPropagation(); inp.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); fin(true); } else if (e.key === "Escape") { e.preventDefault(); fin(false); } }); inp.addEventListener("blur", () => fin(true));
  },
  osSysNote(c, text) { const u = this.osUI; if (c) { c.msgs.push({ r: "sys", text }); this.hq().save(c); u.chatOpen = true; this.osChatWas = true; this.osChatLayout(); this.osChatRender(true); } else { u.cmdMsg.setText(text.replace(/[*`]/g, "")); } },
  // Returns true when HQ handled the command itself; anything else (e.g. /compact, skills) goes to Claude Code as typed.
  osSlash(text) {
    const m = /^\/([a-z-]+)(?:\s+([\s\S]*))?$/i.exec(text.trim()); if (!m) return false;
    const name = m[1].toLowerCase(), arg = (m[2] || "").trim(), u = this.osUI, hq = this.hq(); let c = hq.get(hq.activeId); if (c && hq.projOf(c) !== (this.project && this.project.id)) c = null;
    const done = () => { u.cmdIn.value = ""; this.osAutoGrow(); this.osGoLabel(); this.osSlashMenu(); this.osRemember(text.trim()); return true; };
    const pick = (sel, list, label) => { const v = arg.toLowerCase() === "default" ? "" : arg.toLowerCase(); if (!list.includes(v)) { this.osSysNote(c, "Usage: `/" + name + " " + list.map((x) => x || "default").join("|") + "`"); return done(); } sel.value = v; if (c && !c.busy) { c[name] = v; hq.save(c); } this.osSysNote(c, label + " set to **" + (v || "default") + "**" + (c && c.proc ? " (applies from the next message)." : ".")); return done(); };
    switch (name) {
      case "clear": case "new": this.osChatNew(); return done();
      case "model": return pick(u.model, HQ_MODELS, "Model");
      case "effort": return pick(u.effort, HQ_EFFORTS, "Effort");
      case "usage": case "status": { const us = this.usage || {}, f = (x) => x && x.utilization != null ? Math.round(x.utilization) + "%" + (x.resets_at ? " (resets " + when(x.resets_at) + ")" : "") : "n/a", a = this.osAccount(); this.osSysNote(c, "**Usage** · week " + f(us.seven_day) + " · session " + f(us.five_hour) + (a.email ? "\nAccount: " + a.email + (a.org ? " (" + a.org + ")" : "") : "")); return done(); }
      case "cost": { if (!c) { this.osSysNote(null, "No chat open."); return done(); } const ts = c.turns || [], tot = ts.reduce((n, t) => n + (t.cost || 0), 0), tin = ts.reduce((n, t) => n + (t.in || 0) + (t.cache || 0), 0); this.osSysNote(c, "**This chat** · " + ts.length + " turns · ~" + usd(tot) + " est. · " + kfmt(tin) + " tokens read"); return done(); }
      case "rename": if (!c) { this.osSysNote(null, "Open a chat first."); return done(); } if (!arg) { this.osSysNote(c, "Usage: `/rename New name`"); return done(); } this.osChatRename(c, arg); return done();
      case "pin": if (!c) { this.osSysNote(null, "Open a chat first."); return done(); } this.osChatPin(c); this.osSysNote(c, c.pinned ? "Pinned to the top of the chat list." : "Unpinned."); return done();
      case "delete": if (!c) { this.osSysNote(null, "Open a chat first."); return done(); } if (arg !== "yes") { this.osSysNote(c, "Type `/delete yes` to delete this chat for good."); return done(); } hq.remove(c); u.chatOpen = false; this.osChatLayout(); this.osChatRender(true); return done();
      case "chats": case "resume": this.osChatList(); return done();
      case "stop": if (c && c.busy) hq.stop(c); return done();
      case "tools": this.plugin.setMod("chat", { tools: !MODS.chat.tools }); this.osChatRender(true); this.osSysNote(c, "Command lines " + (MODS.chat.tools ? "shown." : "hidden.")); return done();
      case "help": this.osSysNote(c, "**Commands**\n" + HQ_SLASH.map((x) => "- `/" + x[0] + (x[2] ? " " + x[2] : "") + "` " + x[1]).join("\n") + "\n\nAnything else starting with / (like your skills) is sent to Claude Code as typed."); return done();
    }
    return false;
  },
  osSlashMenu(move) {
    const u = this.osUI; if (!u || !u.slash) return false; const v = u.cmdIn.value, m = /^\/(\S*)$/.exec(v), hqT = u.target.value === "hq";
    const items = m && hqT ? HQ_SLASH.filter((x) => x[0].startsWith(m[1].toLowerCase())) : [];
    if (!items.length) { u.slash.addClass("os-hide"); u.slashItems = null; return false; }
    if (move === undefined || !u.slashItems || u.slashItems.join() !== items.map((x) => x[0]).join()) u.slashI = 0; else u.slashI = (u.slashI + move + items.length) % items.length;
    u.slashItems = items.map((x) => x[0]); u.slash.empty(); u.slash.removeClass("os-hide");
    items.forEach((x, i) => { const r = u.slash.createDiv({ cls: "os-sli" + (i === u.slashI ? " cur" : ""), attr: { role: "option", "aria-selected": String(i === u.slashI) } }); r.createSpan({ cls: "os-sln", text: "/" + x[0] + (x[2] ? " " + x[2] : "") }); r.createSpan({ cls: "os-sld", text: x[1] }); r.onmousedown = (e) => { e.preventDefault(); u.slashI = i; this.osSlashPick(); }; });
    return true;
  },
  osSlashPick() {
    const u = this.osUI, nm = u.slashItems && u.slashItems[u.slashI]; if (!nm) return; const def = HQ_SLASH.find((x) => x[0] === nm);
    if (def[2]) { u.cmdIn.value = "/" + nm + " "; u.slash.addClass("os-hide"); u.slashItems = null; u.cmdIn.focus(); this.osAutoGrow(); return; }
    u.cmdIn.value = "/" + nm; u.slash.addClass("os-hide"); u.slashItems = null; this.osChatSend("/" + nm);
  },
  osGoLabel() {
    const u = this.osUI, hq = this.hq(); if (!u || !u.go) return;
    if (u.target.value !== "hq") { const busy = this.claudBusy(u.target.value), has = !!u.cmdIn.value.trim(), q = busy && has; u.go.setText(q ? "QUEUE" : "SEND"); u.go.toggleClass("stop", false); u.go.toggleClass("queue", q); u.go.setAttr("aria-label", q ? "Queue this message (SEND NOW in the queue interrupts Claude)" : "Send message"); return; } const c = hq && hq.get(hq.activeId), busy = !!(c && c.busy && u.target.value === "hq"), has = !!(u.cmdIn.value.trim() || u.imgs.length), q = busy && has;
    u.go.setText(q ? "QUEUE" : busy ? "STOP" : "SEND"); u.go.toggleClass("stop", busy && !q); u.go.toggleClass("queue", q); u.go.setAttr("aria-label", q ? "Queue this message (sends when Claude finishes)" : busy ? "Stop Claude" : "Send message");
  },
  osChatQueue(text) {
    const u = this.osUI, hq = this.hq(), c = hq.get(hq.activeId); text = String(text || "").trim(); const imgs = u.imgs.slice(); if (!c || (!text && !imgs.length)) return;
    if (!c.busy) return this.osChatSend(text);
    (c.queue = c.queue || []).push({ text, imgs }); u.cmdIn.value = ""; u.imgs = []; this.osRenderAtts(); if (text) this.osRemember(text); if (u.full) this.osSetFull(false); this.osAutoGrow(); this.osGoLabel(); this.osQueueRender(c);
  },
  osQueueRender(c) {
    const u = this.osUI; if (!u || !u.queue) return; const q = (c && c.queue) || []; u.queue.empty(); u.queue.toggleClass("os-hide", !q.length); if (!q.length) return;
    u.queue.createDiv({ cls: "os-q-h", text: "QUEUED (" + q.length + ") · sends when Claude finishes, or SEND NOW to interrupt" });
    q.forEach((m, i) => { const r = u.queue.createDiv({ cls: "os-q-i" }); r.createSpan({ cls: "os-q-n", text: String(i + 1) }); r.createSpan({ cls: "os-q-t", text: (m.text || "").replace(/\s+/g, " ").slice(0, 160) + (m.imgs.length ? "  [" + m.imgs.length + " image" + (m.imgs.length > 1 ? "s" : "") + "]" : ""), attr: { title: m.text } });
      const ed = r.createEl("button", { cls: "os-chb", text: "EDIT", attr: { "aria-label": "Move queued message " + (i + 1) + " back to the box" } }); ed.onclick = () => { q.splice(i, 1); u.cmdIn.value = m.text; u.imgs = m.imgs; this.osRenderAtts(); this.osAutoGrow(); this.osGoLabel(); this.osQueueRender(c); u.cmdIn.focus(); };
      const x = r.createEl("button", { cls: "os-chb", text: "×", attr: { "aria-label": "Remove queued message " + (i + 1) } }); x.onclick = () => { q.splice(i, 1); this.osQueueRender(c); }; });
  },
  osAutoGrow() {
    const u = this.osUI, t = u && u.cmdIn; if (!t) return;
    const n = t.value.length; u.cnt.setText(n ? n.toLocaleString() + " chars · ~" + Math.ceil(n / 4).toLocaleString() + " tokens" : "");
    if (u.full) { t.style.height = ""; t.style.overflowY = "auto"; if (u.go) u.go.style.height = ""; return; }
    const cs = getComputedStyle(t), lh = parseFloat(cs.lineHeight) || 22, pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const most = Math.max(lh * 3 + pad, (u.mid.clientHeight || 600) * 0.5); if (u.userH > most) u.userH = most; const min = Math.max(lh + pad, u.userH || 0), cap = Math.max(min, most);
    t.style.height = "auto"; const sh = t.scrollHeight, h = Math.min(Math.max(sh, min), cap); t.style.height = h + "px"; t.style.overflowY = sh > h + 1 ? "auto" : "hidden"; if (u.go) u.go.style.height = t.offsetHeight + "px";
  },
});
// Extra filler scenes on the same 64x30 pixel canvas. draw(ctx, t, A, B, st, rgb): t = tick, A/B = theme rgb, st = per-scene state.
const hqHash = (n) => { n = (n ^ 61) ^ (n >>> 16); n = Math.imul(n, 9); n ^= n >>> 4; n = Math.imul(n, 0x27d4eb2d); n ^= n >>> 15; return (n >>> 0) / 4294967296; };
const hqSprite = (ctx, x, y, rows, k) => { ctx.fillStyle = k; rows.forEach((r, j) => { for (let i = 0; i < r.length; i++) if (r[i] === "#") ctx.fillRect(x + i, y + j, 1, 1); }); };
const HQ_SCENES = [
  { name: "DUEL" },
  { name: "INVADERS", draw(ctx, t, A, B, st, rgb) {
    const H = 30;
    if (!st.dead) { st.dead = new Set(); st.by = -1; st.bx = 0; st.boom = null; }
    const ox = 4 + Math.abs(((t >> 1) % 16) - 8), fr = (t >> 2) % 2;
    const al = fr ? [".###.", "#.#.#", ".#.#."] : [".###.", "#.#.#", "#...#"];
    const sx = 30 + Math.round(22 * Math.sin(t / 9));
    if (st.by < 0 && t % 5 === 0) { st.bx = sx + 2; st.by = H - 7; }
    if (st.by >= 0) {
      st.by -= 2;
      for (let r = 0; r < 3 && st.by >= 0; r++) for (let c = 0; c < 6; c++) {
        const id = r * 6 + c, x = ox + c * 8, y = 2 + r * 5;
        if (!st.dead.has(id) && st.bx >= x && st.bx < x + 5 && st.by >= y && st.by < y + 4) { st.dead.add(id); st.boom = [x + 2, y + 1, 0]; st.by = -1; break; }
      }
      if (st.by < 0 && st.by !== -1) st.by = -1;
    }
    if (st.dead.size >= 18) st.dead.clear();
    for (let r = 0; r < 3; r++) for (let c = 0; c < 6; c++) if (!st.dead.has(r * 6 + c)) hqSprite(ctx, ox + c * 8, 2 + r * 5, al, rgb(A, r === 0 ? 0.95 : 0.7));
    if (st.by >= 0) { ctx.fillStyle = "rgba(255,255,255,.95)"; ctx.fillRect(st.bx, st.by, 1, 2); }
    if (st.boom) { const [x, y, k] = st.boom; ctx.fillStyle = "rgba(255,240,180," + (1 - k * 0.3) + ")"; [[-1 - k, 0], [1 + k, 0], [0, -1 - k], [0, 1 + k], [-1, -1], [1, 1], [1, -1], [-1, 1]].forEach(([a, b]) => ctx.fillRect(x + a, y + b, 1, 1)); st.boom = k < 2 ? [x, y, k + 1] : null; }
    hqSprite(ctx, sx, H - 5, ["..#..", "#####"], rgb(B, 0.95));
  } },
  { name: "CHASE", draw(ctx, t, A, B, st, rgb) {
    const W = 64, H = 30, L = W + 30, p = t % L, rev = Math.floor(t / L) % 2 === 1, y = H - 10;
    const px = rev ? W + 12 - p : p - 12, gx = rev ? px - 12 : px - 13;
    ctx.fillStyle = rgb(A, 0.6);
    for (let x = 3; x < W; x += 5) if (rev ? false : x > px + 3) ctx.fillRect(x, y, 1, 1);
    if (!rev) { ctx.fillStyle = rgb(A, 0.9); if (W - 4 > px + 3) ctx.fillRect(W - 5, y - 1, 3, 3); }
    // pac: 7x7 disc with a chomping mouth facing its direction
    const f = rev ? -1 : 1, open = t % 4 < 2;
    ctx.fillStyle = rgb(B, 0.95);
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) { if (dx * dx + dy * dy > 10) continue; const fx = dx * f; if (open && fx > 0 && Math.abs(dy) <= fx) continue; ctx.fillRect(px + dx, y + dy, 1, 1); }
    // ghost: chases on the way out, runs scared on the way back
    const scared = rev, gk = scared ? (p > L - 20 && t % 2 ? "rgba(255,255,255,.9)" : "rgba(90,110,255,.95)") : rgb(A, 0.95);
    ctx.fillStyle = gk;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      if (dy === -3 && Math.abs(dx) > 1) continue; if (dy === -2 && Math.abs(dx) > 2) continue;
      if (dy === 3 && (dx + (t % 2)) % 2 !== 0) continue; ctx.fillRect(gx + dx, y + dy, 1, 1);
    }
    ctx.fillStyle = "rgba(255,255,255,.95)"; ctx.fillRect(gx - 2, y - 1, 1, 2); ctx.fillRect(gx + 1, y - 1, 1, 2);
    if (!scared) { ctx.fillStyle = "rgba(20,30,60,.95)"; ctx.fillRect(gx - 1, y, 1, 1); ctx.fillRect(gx + 2, y, 1, 1); }
  } },
  { name: "SNAKE", draw(ctx, t, A, B, st, rgb) {
    const C = 32, R = 13, cell = 2;
    const free = (x, y) => x >= 0 && y >= 0 && x < C && y < R && !st.body.some((b) => b[0] === x && b[1] === y);
    const apple = () => { for (let i = 0; i < 50; i++) { const x = Math.floor(Math.random() * C), y = Math.floor(Math.random() * R); if (free(x, y)) return [x, y]; } return [0, 0]; };
    if (!st.body || st.reset) { st.body = [[6, 6], [5, 6], [4, 6]]; st.dir = [1, 0]; st.apple = apple(); st.reset = 0; }
    const h = st.body[0], opts = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter((d) => !(d[0] === -st.dir[0] && d[1] === -st.dir[1]) && free(h[0] + d[0], h[1] + d[1]));
    if (!opts.length || st.body.length > 45) st.reset = 1;
    else {
      const dist = (d) => Math.abs(h[0] + d[0] - st.apple[0]) + Math.abs(h[1] + d[1] - st.apple[1]) + (Math.random() < 0.08 ? 3 : 0);
      opts.sort((a, b) => dist(a) - dist(b)); st.dir = opts[0];
      const n = [h[0] + st.dir[0], h[1] + st.dir[1]]; st.body.unshift(n);
      if (n[0] === st.apple[0] && n[1] === st.apple[1]) st.apple = apple(); else st.body.pop();
    }
    ctx.fillStyle = rgb(A, 0.12); ctx.fillRect(0, 0, C * cell, R * cell);
    ctx.fillStyle = rgb(B, t % 6 < 3 ? 0.95 : 0.7); ctx.fillRect(st.apple[0] * cell, st.apple[1] * cell, cell, cell);
    st.body.forEach((b, i) => { ctx.fillStyle = rgb(A, i === 0 ? 1 : Math.max(0.35, 0.9 - i * 0.015)); ctx.fillRect(b[0] * cell, b[1] * cell, cell, cell); });
  } },
  { name: "DVD", smooth: true, draw(ctx, t, A, B, st, rgb) {
    // bouncing DVD logo (drawn as vector text so it glides smoothly), new colour on every wall, sparkles on a corner hit
    const W = 64, H = 30, w = 18, h = 11, Hb = H - 3;
    if (!st.init) { st.init = 1; st.x = 3 + Math.random() * 38; st.y = 1 + Math.random() * 12; st.vx = 0.22; st.vy = 0.14; st.c = 0; st.fx = 0; }
    st.x += st.vx; st.y += st.vy; let hx = false, hy = false;
    if (st.x <= 0 || st.x >= W - w) { st.vx = -st.vx; st.x = Math.max(0, Math.min(W - w, st.x)); hx = true; }
    if (st.y <= 0 || st.y >= Hb - h) { st.vy = -st.vy; st.y = Math.max(0, Math.min(Hb - h, st.y)); hy = true; }
    if (hx || hy) st.c++; if (hx && hy) st.fx = 40;
    const cols = [rgb(A, 0.95), rgb(B, 0.95), "rgba(190,110,255,.95)", "rgba(255,255,255,.9)", "rgba(90,230,140,.95)"], k = cols[st.c % cols.length];
    const x = st.x, y = st.y;
    ctx.save(); ctx.fillStyle = k;
    ctx.font = "italic 900 8px Arial Black, Arial, sans-serif"; ctx.textBaseline = "alphabetic";
    const tw = ctx.measureText("DVD").width; ctx.translate(x, y); ctx.scale(w / tw, 1); ctx.fillText("DVD", 0, 7); ctx.restore();
    ctx.save(); ctx.fillStyle = k; ctx.beginPath(); ctx.ellipse(x + w / 2, y + 9, w / 2, 2, 0, 0, Math.PI * 2); ctx.fill();
    ctx.globalCompositeOperation = "destination-out"; ctx.font = "bold 2.6px Arial, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText("VIDEO", x + w / 2, y + 9.15); ctx.restore();
    if (st.fx > 0) { st.fx--; ctx.fillStyle = "rgba(255,240,180," + (st.fx / 40) + ")"; for (let i = 0; i < 12; i++) ctx.fillRect(Math.floor(hqHash(i * 31 + st.c) * W), Math.floor(hqHash(i * 17 + st.c * 3) * Hb), 1, 1); }
  } },
  { name: "CITY", draw(ctx, t, A, B, st, rgb) {
    const W = 64, H = 30;
    if (!st.b) {
      st.b = []; for (let x = 0; x < W;) { const w = 5 + Math.floor(Math.random() * 6), h = 7 + Math.floor(Math.random() * 15); st.b.push({ x, w, h }); x += w + 1; }
      st.d = Array.from({ length: 28 }, () => ({ x: Math.random() * (W + 20), y: Math.random() * H, s: 1.5 + Math.random() }));
    }
    if (t % 140 < 2 && t % 280 < 140) { ctx.fillStyle = "rgba(255,255,255," + (t % 2 ? 0.08 : 0.2) + ")"; ctx.fillRect(0, 0, W, H); }
    ctx.fillStyle = rgb(B, 0.8); ctx.fillRect(52, 3, 3, 3); ctx.fillRect(51, 4, 1, 1);
    st.b.forEach((b, i) => {
      ctx.fillStyle = rgb(A, 0.22); ctx.fillRect(b.x, H - 2 - b.h, b.w, b.h);
      ctx.fillStyle = rgb(A, 0.5); ctx.fillRect(b.x, H - 2 - b.h, b.w, 1);
      for (let wy = H - b.h; wy < H - 3; wy += 3) for (let wx = b.x + 1; wx < b.x + b.w - 1; wx += 2) {
        const on = hqHash(i * 977 + wx * 31 + wy * 7 + Math.floor((t + i * 13) / 40) * 101) < 0.35;
        if (on) { ctx.fillStyle = rgb(B, 0.75); ctx.fillRect(wx, wy, 1, 1); }
      }
    });
    ctx.fillStyle = "rgba(200,225,255,.45)";
    st.d.forEach((d) => { ctx.fillRect(Math.round(d.x), Math.round(d.y), 1, 2); d.y += d.s; d.x -= 0.5; if (d.y > H) { d.y = -2; d.x = Math.random() * (W + 20); } });
  } },
];
// Pixel animations for the spare space in the left column (swordfight + HQ_SCENES). Drawn in code (no assets), theme coloured, ~10 fps, idle when hidden.
function hqDuel(host, key = "hq-fill-scene", def = 0) {
  const wr = host.createDiv({ cls: "os-duelw" }), cv = wr.createEl("canvas", { cls: "os-duel", attr: { "aria-hidden": "true" } }), ctx = cv.getContext("2d"), W = 64, H = 30;
  let tick = 0, round = 0, st = {}, scene = Math.min(HQ_SCENES.length - 1, Math.max(0, parseInt(localStorage.getItem(key) ?? String(def), 10) || 0));
  const swb = wr.createEl("button", { cls: "os-fillsw", text: "⇄" });
  const lbl = () => swb.setAttr("aria-label", "Swap animation (" + HQ_SCENES[scene].name.toLowerCase() + ")");
  lbl();
  swb.addEventListener("click", (e) => { e.stopPropagation(); scene = (scene + 1) % HQ_SCENES.length; localStorage.setItem(key, String(scene)); st = {}; tick = 0; round = 0; lbl(); draw(); });
  const rgb = (v, a) => "rgba(" + (v || "25,227,208") + "," + a + ")";
  // one fighter: x = feet centre, f = facing (1 right, -1 left), pose, flash = hit flash, col = "r,g,b"
  const fighter = (x, f, pose, col, flash, bob) => {
    const c = flash ? "rgba(255,255,255,.95)" : rgb(col, 0.95), d = rgb(col, 0.55), s = "rgba(235,245,255,.95)";
    const P = (dx, dy, w, h, k) => { ctx.fillStyle = k; const px = f === 1 ? x + dx : x - dx - w + 1; ctx.fillRect(px, H - 3 - dy - h + 1 + bob, w, h); };
    const lean = pose === "slash" || pose === "lunge" ? 1 : pose === "hit" ? -1 : 0;
    // legs
    if (pose === "walk" && tick % 4 < 2) { P(-2, 0, 1, 4, d); P(1, 0, 1, 4, d); } else { P(-1, 0, 1, 4, d); P(1, 0, 1, 4, d); }
    if (pose === "lunge") P(3, 0, 1, 2, d);
    // body + head
    P(-1 + lean, 4, 3, 5, c); P(-1 + lean, 5, 3, 1, d); P(-2 + lean, 8, 1, 1, c); P(0 + lean, 10, 2, 3, c); P(1 + lean, 11, 1, 1, "rgba(0,0,0,.65)"); P(-1 + lean, 12, 1, 2, d); P(-2 + lean, 13, 1, 1, d);
    // arm + sword
    const hx = 2 + lean, hy = 7;
    if (pose === "raise") { P(hx, hy, 1, 3, c); P(hx, hy + 3, 1, 6, s); }
    else if (pose === "slash" || pose === "lunge") { P(hx, hy, 2, 1, c); P(hx + 2, hy, 7, 1, s); }
    else if (pose === "block") { P(hx + 1, hy, 1, 1, c); P(hx + 2, hy - 2, 1, 8, s); }
    else if (pose === "hit") { P(hx - 1, hy + 1, 1, 1, c); P(hx - 2, hy + 2, 1, 5, s); }
    else { P(hx, hy, 1, 1, c); for (let i = 1; i <= 5; i++) P(hx + i, hy + i, 1, 1, s); }
  };
  const spark = (x, y, k) => { ctx.fillStyle = "rgba(255,240,180," + (1 - k * 0.3) + ")"; [[0, 0], [1, 1], [-1, 1], [1, -1], [-1, -1], [2 + k, 0], [-2 - k, 0], [0, 2 + k], [0, -2 - k]].forEach(([a, b]) => ctx.fillRect(x + a, y + b, 1, 1)); };
  // 64-tick script; on odd rounds the roles swap so each side wins in turn
  const step = (t) => {
    let ax = 16, bx = 47, ap = "idle", bp = "idle", af = 0, bf = 0, sp = null;
    if (t >= 8 && t < 16) { const k = (t - 8) / 8; ax = 16 + 8 * k; bx = 47 - 8 * k; ap = bp = "walk"; }
    if (t >= 16) { ax = 24; bx = 39; }
    if (t >= 16 && t < 19) ap = "raise";
    if (t >= 19 && t < 22) { ap = "slash"; bp = "block"; if (t < 21) sp = [32, H - 13, t - 19]; }
    if (t >= 23 && t < 26) bp = "raise";
    if (t >= 26 && t < 29) { bp = "slash"; ap = "block"; if (t < 28) sp = [31, H - 13, t - 26]; }
    if (t >= 30 && t < 32) ap = "raise";
    if (t >= 32 && t < 35) { ap = "lunge"; ax = 27; bp = "hit"; bf = t < 34 ? 1 : 0; bx = 39 + (t - 31); if (t < 34) sp = [35, H - 10, t - 32]; }
    if (t >= 35 && t < 44) { ap = "idle"; bp = t % 2 ? "hit" : "idle"; bx = 43; ax = 25; }
    if (t >= 44 && t < 56) { const k = (t - 44) / 12; ax = 25 - 9 * k; bx = 43 + 4 * k; ap = bp = "walk"; }
    return { ax, bx, ap, bp, af, bf, sp };
  };
  const draw = () => {
    if (!host.isConnected) { clearInterval(iv); return; }
    const r = host.getBoundingClientRect(); if (r.height < 10 || document.hidden || !host.offsetParent) return;
    // fixed size: the box shrinks to fit the animation and the panels above take the spare room (width in CSS px, HQ may be zoomed)
    const sc = Math.max(1, Math.min(3, Math.floor(host.clientWidth / W)));
    if (cv.width !== W * sc || cv.height !== H * sc) { cv.width = W * sc; cv.height = H * sc; wr.style.marginBottom = -sc + "px"; }
    const cs = getComputedStyle(host), A = cs.getPropertyValue("--os-acrgb").trim(), B = cs.getPropertyValue("--os-amrgb").trim();
    ctx.setTransform(sc, 0, 0, sc, 0, 0); ctx.imageSmoothingEnabled = false; ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = rgb(A, 0.35); for (let x = 2; x < W - 2; x += 2) ctx.fillRect(x, H - 2, 1, 1);
    if (scene) { try { HQ_SCENES[scene].draw(ctx, tick, A, B, st, rgb); } catch (e) { st = {}; } tick++; return; }
    const t = tick % 64, s = step(t), sw = round % 2 === 1, bob = (k) => (s.ap === "idle" && (tick + k) % 8 < 4 ? 1 : 0);
    // swap who wins: mirror the whole scene on odd rounds
    if (sw) { ctx.setTransform(-sc, 0, 0, sc, W * sc, 0); }
    fighter(s.ax, 1, s.ap, sw ? B : A, s.af, bob(0)); fighter(s.bx, -1, s.bp, sw ? A : B, s.bf, bob(3));
    if (s.sp) spark(s.sp[0], s.sp[1], s.sp[2]);
    tick++; if (tick % 64 === 0) round++;
  };
  let fr = 0; const iv = setInterval(() => { if (!host.isConnected) { clearInterval(iv); return; } if (HQ_SCENES[scene].smooth || fr++ % 3 === 0) draw(); }, 36);
  return cv;
}
function hqChatIsActive(view, c) { const hq = view.hq(); return !!hq && hq.activeId === c.id; }

const DEFAULTS = { mods: {}, theme: { id: "cyan", custom: null, saved: {} }, projects: [], last: "", claudeDir: "", excludeRe: "personal", person: "", chatView: "claudian-view", filesBesideHQ: true, textScale: 125, claudePath: "" };
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
  ["extra", "Extra folders (optional)", "Comma separated sub-folders that belong to this project (e.g. LumenAds). Their Post Queue, Marketing Playbook and tools/eleven.mjs are picked up, and chats mention them.", "LumenAds"],
  ["playbook", "Playbook / rules inbox note (optional)", "Where SAVE AS RULE (playbook option) appends. Auto-detects Notes/Marketing Playbook.md.", "Notes/Marketing Playbook.md"],
  ["repo", "Git repo path (optional)", "Absolute path (or vault-relative); commits of the last 7 days show as dots in the week strip.", ""],
];

class ProjectHQSettings extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const el = this.containerEl, p = this.plugin, st = p.settings; el.empty();
    el.createEl("h2", { text: "Project HQ" });
    el.createEl("h3", { text: "Projects" });
    el.createEl("p", { cls: "setting-item-description", text: "Projects are discovered from the folders of Claude'sWorkspace/. Leave a path blank to auto-detect it from <Project>/Notes (shown as the placeholder); type a path to override it." });
    new Setting(el).addButton((b) => b.setButtonText("Rescan folders").onClick(async () => { if (p.syncProjects()) await p.saveSettings(); p.changed(true); this.display(); }));
    st.projects.forEach((pr) => {
      const rp = resolveProject(pr, p.app.vault.adapter.basePath || ""), d = el.createEl("details", { cls: "lhq-set" }); d.createEl("summary", { text: (pr.pinned ? "\u2605 " : "") + (pr.name || "Untitled project") + (pr.hidden ? " (hidden)" : "") });
      new Setting(d).setName("Name").addText((t) => t.setValue(pr.name || "").onChange((v) => { pr.name = v; p.changed(); }));
      new Setting(d).setName("Project folder").setDesc("Vault path of the project folder. Notes are expected in <folder>/Notes.").addText((t) => t.setPlaceholder("Claude'sWorkspace/Name").setValue(pr.folder || "").onChange((v) => { pr.folder = v.trim().replace(/[/]+$/, ""); p.changed(); }));
      new Setting(d).setName("Pin to top of the switcher").addToggle((t) => t.setValue(!!pr.pinned).onChange((v) => { pr.pinned = v; p.changed(true); }));
      new Setting(d).setName("Hide from the switcher").addToggle((t) => t.setValue(!!pr.hidden).onChange((v) => { pr.hidden = v; p.changed(true); }));
      new Setting(d).setName("Accent colour").addColorPicker((c) => c.setValue(pr.accent || "#f5b83d").onChange((v) => { pr.accent = v; p.changed(); }));
      PFIELDS.forEach(([k, name, desc, ph]) => new Setting(d).setName(name).setDesc(desc).addText((t) => t.setPlaceholder(rp.auto[k] ? "auto: " + rp[k] : ph).setValue(pr[k] || "").onChange((v) => { pr[k] = v; p.changed(); })));
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
    new Setting(el).setName("Claude Code path").setDesc("Used by the HQ chat. Leave empty for ~/.local/bin/claude.exe").addText((t) => t.setPlaceholder("~/.local/bin/claude.exe").setValue(st.claudePath || "").onChange((v) => { st.claudePath = v.trim(); p.changed(); }));
    new Setting(el).setName("Classic layout").setDesc("Safety fallback: turn on to use the original Project HQ pages instead of HQ_OS.")
      .addToggle((t) => t.setValue(!!st.classicLayout).onChange((v) => { st.classicLayout = v; p.changed(true); }));
    new Setting(el).setName("Open files beside Project HQ").setDesc("Notes and files never open in the chat pane; they move to Project HQ's side.")
      .addToggle((t) => t.setValue(st.filesBesideHQ !== false).onChange((v) => { st.filesBesideHQ = v; p.changed(); }));
  }
}

module.exports = class ProjectHQ extends Plugin {
  async onload() {
    const d = (await this.loadData()) || {}; this.settings = Object.assign({}, DEFAULTS, d); if (!Array.isArray(this.settings.projects)) this.settings.projects = [];
    { const th = this.settings.theme = Object.assign({ id: "cyan", custom: null, saved: {} }, this.settings.theme || {}); if (!th.saved || typeof th.saved !== "object") th.saved = {}; if (typeof th.id !== "string") th.id = "cyan"; if (!this.settings.mods || typeof this.settings.mods !== "object") this.settings.mods = {}; MODS = buildMods(this.settings.mods); BASE = this.app.vault.adapter.basePath || ""; guardVerify(); }
    if (this.syncProjects()) await this.saveData(this.settings);
    try { this.hq = new HQChats(this); } catch (e) { console.error("Project HQ chat engine", e); this.hq = null; }
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
  // Add a settings entry for every workspace folder that has none yet (blank fields are auto-detected at use time).
  syncProjects() {
    const st = this.settings, base = this.app.vault.adapter.basePath || "", known = new Set(); let ch = false;
    // LumenAds is part of Lumen: fold its settings into Lumen and drop it as a separate project
    const ads = st.projects.find((p) => p.id === "lumenads" || /[/]LumenAds$/i.test(p.folder || ""));
    if (ads) {
      const lu = st.projects.find((p) => p.id === "lumen");
      if (lu) { for (const k of ["queue", "slots", "creditsScript", "playbook"]) if (ads[k] && !lu[k]) lu[k] = ads[k]; if (!lu.extra) lu.extra = "LumenAds"; }
      st.projects = st.projects.filter((p) => p !== ads); if (st.last === ads.id) st.last = lu ? lu.id : ""; ch = true;
    }
    st.projects.forEach((p) => { if (!p.folder) { const f = folderOf(p); if (f) { p.folder = f; ch = true; } } if (p.folder) known.add(p.folder); });
    discoverFolders(base).forEach((n) => { const f = WS + "/" + n; if (known.has(f)) return; let id = slug(n); while (st.projects.some((p) => p.id === id)) id += "-"; st.projects.push({ id, name: n, folder: f, accent: "#f5b83d", nextHead: "Next", waitHead: "Waiting on", auto: true }); ch = true; });
    return ch;
  }
  visibleProjects() {
    const base = this.app.vault.adapter.basePath || "", v = this.settings.projects.filter((p) => !p.hidden && (!p.folder || isDir(path.join(base, p.folder))));
    return v.map((p, i) => [p, i]).sort((a, b) => (b[0].pinned ? 1 : 0) - (a[0].pinned ? 1 : 0) || a[1] - b[1]).map((x) => x[0]);
  }
  async saveSettings() { await this.saveData(this.settings); }
  views() { return this.app.workspace.getLeavesOfType(VIEW).map((l) => l.view).filter(Boolean); }
  saveSoon() { clearTimeout(this._ms); this._ms = setTimeout(() => this.saveSettings(), 400); }
  // ---- mods ----
  setMod(k, patch) {
    const st = this.settings; st.mods = st.mods || {}; st.mods[k] = Object.assign({}, st.mods[k] || {}, patch); MODS = buildMods(st.mods); this.afterMod(k, patch); this.saveSoon();
  }
  resetMod(k) { const st = this.settings; delete st.mods[k]; MODS = buildMods(st.mods); if (k === "progress") insCache.clear(); this.afterMod(k, { triggers: 1 }); this.saveSoon(); }
  afterMod(k, patch) {
    if (k === "guard") writeGuardConfig();
    if (k === "rules" && patch && patch.triggers) mainState.file = ""; // rescan the chat for the new trigger words
    this.views().forEach((v) => { try { v.modApplied && v.modApplied(k); } catch (e) { modErr(k, e); console.error("Project HQ mod apply", e); } });
  }
  // ---- themes ----
  curTheme() {
    const t = this.baseTheme(), ov = this.settings.theme.accent;
    // Accent changer keeps the theme's MAIN colour (borders, titles, text) and recolours the sphere + secondary highlights.
    if (hexOk(ov)) { t.accent2 = ov.toLowerCase(); t.orb = ov.toLowerCase(); }
    return t;
  }
  baseTheme() {
    const th = this.settings.theme, id = th.id || "cyan";
    if (id.startsWith("saved:") && th.saved[id.slice(6)]) return Object.assign(cleanTheme(th.saved[id.slice(6)]), { id, name: id.slice(6) });
    if (id === "custom") return Object.assign(cleanTheme(th.custom), { id, name: "Custom" });
    return Object.assign({}, HQ_PRESETS.find((x) => x.id === id) || HQ_PRESETS[0]);
  }
  setAccent(hex) { this.settings.theme.accent = hexOk(hex) ? hex.toLowerCase() : ""; this.themeApplyAll(); }
  themeApplyAll() { this.views().forEach((v) => { if (!v.applyTheme) return; v.applyTheme(); if (v.osUI) { v.osUI.sig.top = ""; v.osTopRender(); } }); this.saveSoon(); }
  setThemeId(id) { this.settings.theme.id = id; this.themeApplyAll(); }
  editTheme(patch) { this.settings.theme.custom = cleanTheme(Object.assign({}, this.curTheme(), patch)); this.settings.theme.id = "custom"; this.themeApplyAll(); }
  saveTheme(name) { const th = this.settings.theme; th.saved[name] = cleanTheme(this.curTheme()); th.id = "saved:" + name; this.themeApplyAll(); }
  deleteTheme(name) { const th = this.settings.theme; delete th.saved[name]; if (th.id === "saved:" + name) th.id = "cyan"; this.themeApplyAll(); }
  importTheme(o) { const th = this.settings.theme, t = cleanTheme(o), nm = typeof o.name === "string" ? o.name.trim().slice(0, 24) : ""; th.custom = t; th.id = "custom"; if (nm) { th.saved[nm] = t; th.id = "saved:" + nm; } this.themeApplyAll(); }
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
  onunload() { this.app.workspace.detachLeavesOfType(VIEW); if (this.hq) { this.hq.destroy(); this.hq = null; } }
};
