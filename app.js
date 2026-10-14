// Панель Sapphire: статичный сайт (GitHub Pages), данные — приватный репозиторий через GitHub API.
// Токен GitHub хранится только в этом браузере (localStorage) и уходит только на api.github.com.
// Сайт ничего не меняет у бота напрямую: он кладёт заявку в instances/<бот>/requests/,
// бот проверяет её, применяет и пишет результат в journal.json (см. core/cloud/sync.py).

const API = "https://api.github.com";
const STALE = 150; // секунд без пульса — бот офлайн (как core/cloud/lease.py)
const $app = document.getElementById("app");

// ── хранилище браузера ──
const store = {
  get(k, d = "") { try { return localStorage.getItem("sapphire." + k) ?? d; } catch { return d; } },
  set(k, v) { try { v === null ? localStorage.removeItem("sapphire." + k) : localStorage.setItem("sapphire." + k, v); } catch {} },
};

// ── мелочи ──
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const utf8 = (s) => new TextEncoder().encode(s);
const b64 = (bytes) => { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s.replace(/\s/g, "")), (c) => c.charCodeAt(0));
const now = () => Math.floor(Date.now() / 1000);
const ago = (t) => {
  if (!t) return "—";
  const d = now() - t;
  if (d < 60) return `${d} с назад`;
  if (d < 3600) return `${Math.floor(d / 60)} мин назад`;
  if (d < 86400) return `${Math.floor(d / 3600)} ч назад`;
  return new Date(t * 1000).toLocaleString("ru-RU");
};
const dur = (s) => { const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return d ? `${d} д ${h} ч` : h ? `${h} ч ${m} мин` : `${m} мин`; };
const plain = (v) => v === true ? "вкл" : v === false ? "выкл" : Array.isArray(v) ? v.join(", ") || "—" : v === "" || v == null ? "—" : String(v);
const kb = (n) => n > 1048576 ? `${(n / 1048576).toFixed(1)} МБ` : `${Math.round(n / 1024)} КБ`;

function toast(text, ms = 4000) {
  const box = document.getElementById("toast");
  const el = document.createElement("div");
  el.textContent = text;
  box.append(el);
  setTimeout(() => el.remove(), ms);
}

function dialog(html, { ok = "OK", cancel = "Отмена", danger = false } = {}) {
  const dlg = document.getElementById("dlg");
  document.getElementById("dlg-body").innerHTML = `${html}
    <div class="row spread" style="margin-top:16px">
      <span></span>
      <span class="row">${cancel ? `<button value="cancel">${esc(cancel)}</button>` : ""}
      <button value="ok" class="${danger ? "danger" : "primary"}">${esc(ok)}</button></span>
    </div>`;
  dlg.showModal();
  return new Promise((resolve) => dlg.addEventListener("close", () => resolve(dlg.returnValue === "ok" ? dlg : null), { once: true }));
}

// ── GitHub API ──
const gh = {
  token: () => store.get("token"),
  repo: () => store.get("repo"),
  async req(path, opts = {}) {
    const r = await fetch(path.startsWith("http") ? path : API + path, {
      ...opts,
      headers: { Authorization: `Bearer ${gh.token()}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(opts.headers || {}) },
      cache: "no-store",
    });
    if (r.status === 204) return null;
    const data = await r.json().catch(() => null);
    if (!r.ok) { const e = new Error(data?.message || `GitHub ${r.status}`); e.status = r.status; throw e; }
    return data;
  },
  r: (p = "") => `/repos/${gh.repo()}${p}`,
  async file(path) {
    try {
      const d = await gh.req(gh.r(`/contents/${path}`));
      return { text: new TextDecoder().decode(unb64(d.content || "")), sha: d.sha };
    } catch (e) { if (e.status === 404) return { text: null, sha: null }; throw e; }
  },
  async json(path, dflt = null) {
    const { text, sha } = await gh.file(path);
    if (text === null) return { data: dflt, sha: null };
    try { return { data: JSON.parse(text), sha }; } catch { return { data: dflt, sha }; }
  },
  async put(path, text, message, sha) {
    return gh.req(gh.r(`/contents/${path}`), { method: "PUT", body: JSON.stringify({ message, content: b64(utf8(text)), ...(sha ? { sha } : {}) }) });
  },
  async del(path, sha, message) {
    return gh.req(gh.r(`/contents/${path}`), { method: "DELETE", body: JSON.stringify({ message, sha }) });
  },
  async list(path) {
    try { const d = await gh.req(gh.r(`/contents/${path}`)); return Array.isArray(d) ? d : []; }
    catch (e) { if (e.status === 404) return []; throw e; }
  },
  releases: () => gh.req(gh.r("/releases?per_page=100")),
};

// ── боты (релизы instance-<имя>, статус в описании) ──
function parseStatus(body) {
  if (!body || !body.includes("<!-- sapphire-status -->")) return null;
  const m = body.split("<!-- sapphire-status -->")[1].match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
  try { return m ? JSON.parse(m[1]) : null; } catch { return null; }
}
const isOnline = (st) => st && st.online && now() - (st.heartbeat || 0) < STALE;

let cache = { at: 0, bots: [] };
async function bots(force = false) {
  if (!force && Date.now() - cache.at < 15000) return cache.bots;
  const rels = await gh.releases();
  const list = rels.filter((r) => r.tag_name.startsWith("instance-")).map((r) => ({
    name: r.tag_name.slice("instance-".length), release: r, status: parseStatus(r.body) || {},
    snapshots: (r.assets || []).filter((a) => a.name.startsWith("snapshot-")).sort((a, b) => b.name.localeCompare(a.name)),
  })).sort((a, b) => a.name.localeCompare(b.name));
  cache = { at: Date.now(), bots: list };
  return list;
}
async function bot(name) { return (await bots()).find((b) => b.name === name); }

// ── подпись владельца (Ed25519 в браузере; публичный ключ — в CLOUD_OWNER_KEYS бота) ──
function signKey() { const k = store.get("signkey"); return k ? nacl.sign.keyPair.fromSecretKey(unb64(k)) : null; }
const signPub = () => { const k = signKey(); return k ? b64(k.publicKey) : ""; };

// ── заявки ──
async function sendRequest(instance, payload) {
  const login = store.get("login");
  const id = `${Date.now()}-${login.replace(/[^A-Za-z0-9_.-]/g, "")}-${Math.random().toString(36).slice(2, 7)}`;
  const body = JSON.stringify({ id, ts: now(), by: login, instance, ...payload });
  const key = signKey();
  const sig = key ? b64(nacl.sign.detached(utf8(body), key.secretKey)) : null;
  await gh.put(`instances/${instance}/requests/${id}.json`, JSON.stringify({ v: 1, body, sig }), `Заявка ${payload.type}${payload.action ? ":" + payload.action : ""} от ${login}`);
  return id;
}

async function waitResult(instance, id, { timeout = 150 } = {}) {
  const until = Date.now() + timeout * 1000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 6000));
    const { data } = await gh.json(`instances/${instance}/journal.json`, []);
    const hit = (data || []).find((e) => e.id === id);
    if (hit) return hit;
  }
  return null;
}

async function submit(instance, payload, what) {
  try {
    const id = await sendRequest(instance, payload);
    toast(`⏳ ${what}: заявка отправлена, бот применит её в течение ~30 с`);
    const res = await waitResult(instance, id);
    if (!res) toast(`⌛ ${what}: бот пока не ответил (он выключен?). Заявка применится, когда он появится.`, 7000);
    else if (res.ok) toast(`✅ ${what}: готово`);
    else toast(`⚠️ ${what}: ${res.error}`, 8000);
    return res;
  } catch (e) { toast(`⚠️ ${e.message}`, 8000); return null; }
}

// ── вид ──
function setNav(active, instance) {
  const items = [["#/", "Боты", "home"], ["#/templates", "Шаблоны", "templates"], ["#/sign", "Подпись", "sign"], ["#/logout", "Выйти", "logout"]];
  document.getElementById("nav").innerHTML = gh.token() ? items.map(([h, t, k]) => `<a href="${h}" class="${k === active ? "on" : ""}">${t}</a>`).join("") : "";
}
const badge = (st) => isOnline(st) ? `<span class="badge ok"><span class="dot"></span>онлайн</span>` : `<span class="badge bad"><span class="dot"></span>офлайн${st?.heartbeat ? " · " + ago(st.heartbeat) : ""}</span>`;
const page = (html) => { $app.innerHTML = html; };

// ── страницы ──
function viewLogin() {
  setNav();
  page(`<div class="card stack" style="max-width:560px;margin:40px auto">
    <h1>Вход в панель</h1>
    <p class="muted">Нужен <b>fine-grained</b> токен GitHub: <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">создать</a> →
      Repository access: только репозиторий данных → Permissions: <b>Contents: Read and write</b>.
      Токен хранится только в этом браузере.</p>
    <label class="field"><span>Репозиторий данных (владелец/имя)</span><input id="repo" placeholder="you/sapphire-data" value="${esc(store.get("repo"))}"></label>
    <label class="field"><span>Токен</span><input id="token" type="password" placeholder="github_pat_…" autocomplete="off"></label>
    <button class="primary" id="go">Войти</button>
  </div>`);
  document.getElementById("go").onclick = async () => {
    store.set("repo", document.getElementById("repo").value.trim());
    store.set("token", document.getElementById("token").value.trim());
    try {
      const me = await gh.req("/user");
      await gh.req(gh.r());
      store.set("login", me.login);
      location.hash = "#/";
      route();
    } catch (e) { store.set("token", null); toast(`⚠️ Не получилось: ${e.message}`, 7000); }
  };
}

async function viewHome() {
  setNav("home");
  const list = await bots(true);
  if (!list.length) {
    page(`<h1>Боты</h1><div class="card empty">Пока ни один бот не подключён к облаку.<br>
      В <code>.env</code> бота: <code>CLOUD_ENABLED=1</code>, <code>CLOUD_REPO=${esc(gh.repo())}</code>, <code>GITHUB_TOKEN</code>, <code>INSTANCE_NAME</code> — и перезапуск.</div>`);
    return;
  }
  page(`<div class="row spread"><div><h1>Боты</h1><p class="muted">Вы вошли как <b>${esc(store.get("login"))}</b> · ${esc(gh.repo())}</p></div>
      <button id="refresh">↻ Обновить</button></div>
    <div class="grid">${list.map((b) => {
      const st = b.status, errs = (st.jobs || []).filter((j) => j.consecutive_errors).length;
      return `<a class="card stack" href="#/bot/${esc(b.name)}">
        <div class="row spread"><h3>${st.user?.avatar ? `<img src="${esc(st.user.avatar)}" alt="" width="22" height="22" style="border-radius:50%;vertical-align:-5px"> ` : "🤖 "}${esc(b.name)}</h3>${badge(st)}</div>
        <dl class="kv">
          <dt>Аккаунт</dt><dd>${esc(st.user?.name || "—")}</dd>
          <dt>Компьютер</dt><dd>${esc(st.machine || "—")}</dd>
          <dt>Версия</dt><dd class="mono">${esc(st.version || "—")}</dd>
          <dt>Работает</dt><dd>${isOnline(st) ? dur(now() - st.started) : "—"}${st.latency_ms != null && isOnline(st) ? ` · пинг ${st.latency_ms} мс` : ""}</dd>
          <dt>Серверов</dt><dd>${(st.guilds || []).length}</dd>
          <dt>Снимок</dt><dd>${b.snapshots[0] ? ago(Date.parse(b.snapshots[0].created_at) / 1000) : "—"}</dd>
          <dt>Задания</dt><dd>${errs ? `<span class="badge warn">⚠ ошибок: ${errs}</span>` : `<span class="badge ok">в порядке</span>`}</dd>
        </dl></a>`;
    }).join("")}</div>`);
  document.getElementById("refresh").onclick = viewHome;
}

const TABS = [["servers", "Серверы"], ["jobs", "Задания"], ["keys", "Ключи"], ["snapshots", "Снимки"], ["journal", "Журнал"], ["actions", "Действия"]];

async function viewBot(name, tab = "servers") {
  setNav("home");
  const b = await bot(name);
  if (!b) { page(`<div class="card empty">Бот «${esc(name)}» не найден. <a href="#/">К списку</a></div>`); return; }
  const st = b.status;
  page(`<p class="small"><a href="#/">← Боты</a></p>
    <div class="row spread"><h1>🤖 ${esc(name)}</h1>${badge(st)}</div>
    <p class="muted small">${esc(st.user?.name || "")} · ${esc(st.machine || "")} · версия <span class="mono">${esc(st.version || "?")}</span></p>
    <nav class="tabs">${TABS.map(([k, t]) => `<a href="#/bot/${esc(name)}/${k}" class="${k === tab ? "on" : ""}">${t}</a>`).join("")}</nav>
    <section id="tab"></section>`);
  const $t = document.getElementById("tab");
  await ({ servers: tabServers, jobs: tabJobs, keys: tabKeys, snapshots: tabSnapshots, journal: tabJournal, actions: tabActions }[tab] || tabServers)(b, $t);
}

function tabServers(b, $t) {
  const gs = b.status.guilds || [];
  $t.innerHTML = gs.length ? `<div class="grid">${gs.map((g) => `<a class="card row" href="#/bot/${esc(b.name)}/g/${esc(g.id)}">
      ${g.icon ? `<img src="${esc(g.icon)}" alt="" width="40" height="40" style="border-radius:10px">` : `<span style="font-size:28px">🏰</span>`}
      <div><b>${esc(g.name)}</b><div class="muted small">${g.members} участников</div></div></a>`).join("")}</div>`
    : `<div class="card empty">Бот ещё не прислал список серверов (он онлайн?).</div>`;
}

function tabJobs(b, $t) {
  const jobs = b.status.jobs || [];
  $t.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Задание</th><th>Каждые</th><th>Запусков</th><th>Последний успех</th><th>Состояние</th></tr></thead><tbody>
    ${jobs.map((j) => `<tr><td class="mono">${esc(j.name)}</td><td>${j.interval >= 3600 ? j.interval / 3600 + " ч" : j.interval >= 60 ? j.interval / 60 + " мин" : j.interval + " с"}</td>
      <td>${j.runs}${j.errors ? ` <span class="muted">(ошибок ${j.errors})</span>` : ""}</td><td>${ago(j.last_ok)}</td>
      <td>${!j.alive ? `<span class="badge bad">остановлено</span>` : j.consecutive_errors ? `<span class="badge warn" title="${esc(j.last_error)}">⚠ ${esc(j.last_error).slice(0, 80)}</span>` : `<span class="badge ok">ок</span>`}</td></tr>`).join("")}
    </tbody></table></div>`;
}

function tabKeys(b, $t) {
  const env = b.status.env || [];
  const pub = b.status.public_key;
  $t.innerHTML = `<p class="muted small">Значения шифруются в браузере ключом именно этого бота и не видны в GitHub. Видно только, задан ли ключ, и последние 4 символа.
      Менять ключи может только владелец бота — нужна <a href="#/sign">подпись</a>, добавленная в его <code>CLOUD_OWNER_KEYS</code>.
      Большинство ключей вступают в силу после перезапуска.</p>
    ${!signKey() ? `<div class="card" style="margin-bottom:12px">🔏 У вас ещё нет ключа подписи — <a href="#/sign">создать</a>.</div>` : ""}
    <div class="table-wrap"><table><thead><tr><th>Переменная</th><th>Значение</th><th></th></tr></thead><tbody>
    ${env.map((k) => `<tr><td><span class="mono">${esc(k.key)}</span>${k.help ? `<div class="muted small">${esc(k.help)}</div>` : ""}</td>
      <td>${k.set ? `<span class="badge ok">${esc(k.mask) || "задано"}</span>` : `<span class="badge">не задано</span>`}</td>
      <td>${k.local ? `<span class="muted small">только в .env на ПК</span>` : `<button data-key="${esc(k.key)}" ${pub ? "" : "disabled"}>Задать…</button>`}</td></tr>`).join("")}
    </tbody></table></div>`;
  $t.querySelectorAll("button[data-key]").forEach((btn) => btn.onclick = async () => {
    const key = btn.dataset.key;
    const d = await dialog(`<h3>Новое значение ${esc(key)}</h3><p class="muted small">Будет зашифровано для бота «${esc(b.name)}».</p>
      <input id="secret-val" type="password" autocomplete="off">`, { ok: "Зашифровать и отправить" });
    if (!d) return;
    const value = d.querySelector("#secret-val").value;
    if (!value) return;
    const eph = nacl.box.keyPair(), nonce = nacl.randomBytes(24);
    const ct = nacl.box(utf8(value), nonce, unb64(pub), eph.secretKey);
    const blob = new Uint8Array(32 + 24 + ct.length);
    blob.set(eph.publicKey, 0); blob.set(nonce, 32); blob.set(ct, 56);
    await submit(b.name, { type: "secret", key, enc: b64(blob) }, `Ключ ${key}`);
  });
}

function tabSnapshots(b, $t) {
  $t.innerHTML = `<div class="row spread"><p class="muted small">Снимки базы хранятся в файлах релиза <span class="mono">instance-${esc(b.name)}</span> (последние ${b.snapshots.length}).
      Бот делает снимок сам каждые ~30 мин, если база менялась, и при выключении.</p>
      <button class="primary" id="snap-now">💾 Снимок сейчас</button></div>
    <div class="table-wrap"><table><thead><tr><th>Снимок</th><th>Размер</th><th>Когда</th><th></th></tr></thead><tbody>
    ${b.snapshots.map((a) => `<tr><td class="mono">${esc(a.name)}</td><td>${kb(a.size)}</td><td>${ago(Date.parse(a.created_at) / 1000)}</td>
      <td class="row"><a class="btn" href="${esc(a.browser_download_url)}">Скачать</a><button class="danger" data-restore="${a.id}" data-name="${esc(a.name)}">Восстановить</button></td></tr>`).join("") || `<tr><td colspan="4" class="muted">Снимков пока нет</td></tr>`}
    </tbody></table></div>`;
  document.getElementById("snap-now").onclick = () => submit(b.name, { type: "action", action: "snapshot" }, "Снимок базы").then(() => { cache.at = 0; });
  $t.querySelectorAll("[data-restore]").forEach((btn) => btn.onclick = async () => {
    if (!signKey()) { toast("Нужна подпись владельца — страница «Подпись»"); return; }
    const d = await dialog(`<h3>Восстановить базу?</h3><p>Бот <b>${esc(b.name)}</b> перезапустится с базой из снимка <span class="mono">${esc(btn.dataset.name)}</span>.
      Текущая база перед этим сохранится снимком и локальной копией.</p><p>Введите имя бота для подтверждения:</p><input id="confirm-name">`, { ok: "Восстановить", danger: true });
    if (!d || d.querySelector("#confirm-name").value.trim() !== b.name) return;
    await submit(b.name, { type: "action", action: "restore", arg: btn.dataset.restore }, "Восстановление базы");
  });
}

async function tabJournal(b, $t) {
  const [{ data: journal }, { data: schema }] = await Promise.all([
    gh.json(`instances/${b.name}/journal.json`, []), gh.json(`instances/${b.name}/schema.json`, { settings: [] })]);
  const labels = Object.fromEntries((schema?.settings || []).map((s) => [s.key, s.label]));
  const names = Object.fromEntries((b.status.guilds || []).map((g) => [g.id, g.name]));
  const rows = (journal || []).slice().reverse();
  $t.innerHTML = rows.length ? `<div class="table-wrap"><table><thead><tr><th>Когда</th><th>Кто</th><th>Что</th><th></th></tr></thead><tbody>
    ${rows.map((e, i) => `<tr><td>${ago(e.at)}</td><td>${esc(e.by)}${e.owner ? " 🔏" : ""}</td><td>
      ${e.ok ? "" : `<span class="badge bad">отклонено</span> ${esc(e.error)}<br>`}
      ${e.type === "config" ? `<b>${esc(names[e.guild] || e.guild)}</b>${Object.entries(e.diff || {}).map(([k, [o, n]]) =>
        `<div class="small">${esc(labels[k] || k)}: <span class="diff-old">${esc(plain(o))}</span> → <span class="diff-new">${esc(plain(n))}</span></div>`).join("") || (e.ok ? `<div class="small muted">без изменений</div>` : "")}`
      : e.type === "secret" ? `ключ <span class="mono">${esc(e.key)}</span>` : `действие <b>${esc(e.action)}</b>${e.arg ? " " + esc(e.arg) : ""}`}
      </td><td>${e.type === "config" && e.ok && Object.keys(e.diff || {}).length ? `<button data-undo="${i}">↶ Откатить</button>` : ""}</td></tr>`).join("")}
    </tbody></table></div>` : `<div class="card empty">Изменений с сайта ещё не было.</div>`;
  $t.querySelectorAll("[data-undo]").forEach((btn) => btn.onclick = async () => {
    const e = rows[+btn.dataset.undo];
    const changes = Object.fromEntries(Object.entries(e.diff).map(([k, [o]]) => [k, o]));
    if (!await dialog(`<h3>Откатить изменение?</h3><p>Вернуть ${Object.keys(changes).length} настр. на сервере ${esc(names[e.guild] || e.guild)} к прежним значениям.</p>`, { ok: "Откатить" })) return;
    await submit(b.name, { type: "config", guild: e.guild, changes }, "Откат");
  });
}

function tabActions(b, $t) {
  $t.innerHTML = `<div class="grid">
    <div class="card stack"><h3>💾 Снимок базы</h3><p class="muted small">Сразу загрузить снимок в облако.</p><button data-a="snapshot">Сделать</button></div>
    <div class="card stack"><h3>🔄 Слэш-команды</h3><p class="muted small">Принудительно синхронизировать команды с Discord.</p><button data-a="sync_commands">Синхронизировать</button></div>
    <div class="card stack"><h3>♻️ Перезагрузить модуль</h3><p class="muted small">Перечитать код одного кога без перезапуска.</p>
      <input id="cog" placeholder="например, shop"><button data-a="reload">Перезагрузить</button></div>
    <div class="card stack"><h3>🔁 Перезапуск</h3><p class="muted small">Только владелец (подпись). Бот пропадёт примерно на минуту.</p><button class="danger" data-a="restart">Перезапустить</button></div>
  </div>`;
  $t.querySelectorAll("[data-a]").forEach((btn) => btn.onclick = async () => {
    const action = btn.dataset.a;
    const payload = { type: "action", action };
    if (action === "reload") { payload.arg = document.getElementById("cog").value.trim(); if (!payload.arg) return; }
    if (action === "restart" && !await dialog(`<h3>Перезапустить ${esc(b.name)}?</h3>`, { ok: "Перезапустить", danger: true })) return;
    await submit(b.name, payload, btn.textContent);
  });
}

// ── настройки сервера ──
async function viewGuild(name, gid) {
  setNav("home");
  const base = `instances/${name}`;
  const [{ data: schema }, { data: state }, { data: meta }] = await Promise.all([
    gh.json(`${base}/schema.json`), gh.json(`${base}/guilds/${gid}/state.json`), gh.json(`${base}/guilds/${gid}/meta.json`, { channels: [], roles: [] })]);
  if (!schema || !state) { page(`<div class="card empty">Бот ещё не выгрузил настройки этого сервера. <a href="#/bot/${esc(name)}">Назад</a></div>`); return; }
  const draft = { ...state };
  const channels = (meta.channels || []).filter((c) => !c.type.includes("voice"));
  const chOpt = (sel) => `<option value="">—</option>` + channels.map((c) => `<option value="${esc(c.id)}" ${c.id === sel ? "selected" : ""}>#${esc(c.name)}${c.category ? ` · ${esc(c.category)}` : ""}</option>`).join("");
  const roleOpt = (sel) => `<option value="">—</option>` + (meta.roles || []).map((r) => `<option value="${esc(r.id)}" ${r.id === sel ? "selected" : ""}>@${esc(r.name)}</option>`).join("");

  const field = (s) => {
    const v = draft[s.key], id = `f-${s.key}`;
    const help = s.help ? `<div class="help">${esc(s.help)}</div>` : "";
    if (s.kind === "bool") return `<label class="switch"><span class="label">${esc(s.label)}</span><input type="checkbox" id="${id}" ${v ? "checked" : ""}></label>${help}`;
    let input;
    if (s.kind === "choice") input = `<select id="${id}">${s.choices.map((c) => `<option ${c === v ? "selected" : ""}>${esc(c)}</option>`).join("")}</select>`;
    else if (s.kind === "channel") input = `<select id="${id}">${chOpt(v)}</select>`;
    else if (s.kind === "role") input = `<select id="${id}">${roleOpt(v)}</select>`;
    else if (s.kind === "channels") input = `<div class="multi" id="${id}">${channels.map((c) => `<label><input type="checkbox" value="${esc(c.id)}" ${(v || []).includes(c.id) ? "checked" : ""}>#${esc(c.name)}</label>`).join("") || `<span class="muted small">нет каналов</span>`}</div>`;
    else if (s.kind === "int") input = `<input id="${id}" type="number" value="${esc(v)}">`;
    else input = `<input id="${id}" value="${esc(v)}">`;
    return `<label class="field"><span class="label">${esc(s.label)}</span></label>${input}${help}`;
  };
  const read = (s) => {
    const el = document.getElementById(`f-${s.key}`);
    if (s.kind === "bool") return el.checked;
    if (s.kind === "channels") return [...el.querySelectorAll("input:checked")].map((i) => i.value);
    if (s.kind === "int") return el.value === "" ? s.default : parseInt(el.value, 10);
    return el.value;
  };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const changes = () => Object.fromEntries(schema.settings.filter((s) => !same(draft[s.key], state[s.key])).map((s) => [s.key, draft[s.key]]));
  const modName = (s) => s.group === "modules" ? (schema.modules[s.key.replace(/_enabled$/, "")] || s.label) : s.label;

  page(`<p class="small"><a href="#/bot/${esc(name)}">← ${esc(name)}</a></p>
    <div class="row spread"><div class="row">${meta.icon ? `<img src="${esc(meta.icon)}" alt="" width="40" height="40" style="border-radius:10px">` : ""}<h1>${esc(meta.name || gid)}</h1></div>
      <div class="row"><button id="tpl-save">⭳ В шаблон</button><button id="tpl-apply">⭱ Из шаблона</button><button id="compare">⇄ Сравнить</button></div></div>
    ${Object.entries(schema.groups).map(([g, title]) => {
      const items = schema.settings.filter((s) => s.group === g);
      return items.length ? `<h2>${esc(title)}</h2><div class="settings">${items.map((s) => `<div class="setting" data-key="${esc(s.key)}">${field(g === "modules" ? { ...s, label: modName(s) } : s)}</div>`).join("")}</div>` : "";
    }).join("")}
    <div class="bar row spread"><span id="pending" class="muted">Изменений нет</span>
      <span class="row"><button id="reset">Сбросить</button><button class="primary" id="apply" disabled>Применить…</button></span></div>`);

  const refresh = () => {
    const n = Object.keys(changes()).length;
    document.getElementById("pending").textContent = n ? `Изменено настроек: ${n}` : "Изменений нет";
    document.getElementById("apply").disabled = !n;
    document.querySelectorAll(".setting").forEach((el) => el.classList.toggle("changed", !same(draft[el.dataset.key], state[el.dataset.key])));
  };
  schema.settings.forEach((s) => {
    const el = document.getElementById(`f-${s.key}`);
    el?.addEventListener("change", () => { draft[s.key] = read(s); refresh(); });
    el?.addEventListener("input", () => { draft[s.key] = read(s); refresh(); });
  });
  const show = (v, s) => {
    if (s.kind === "bool") return v ? "вкл" : "выкл";
    if (s.kind === "channel") return v ? "#" + (channels.find((c) => c.id === v)?.name || v) : "—";
    if (s.kind === "role") return v ? "@" + ((meta.roles || []).find((r) => r.id === v)?.name || v) : "—";
    if (s.kind === "channels") return (v || []).map((id) => "#" + (channels.find((c) => c.id === id)?.name || id)).join(", ") || "—";
    return v === "" || v == null ? "—" : String(v);
  };
  const byKey = Object.fromEntries(schema.settings.map((s) => [s.key, s]));
  const diffHtml = (ch, from) => `<table>${Object.entries(ch).map(([k, v]) => `<tr><td>${esc(modName(byKey[k]))}</td>
    <td><span class="diff-old">${esc(show(from[k], byKey[k]))}</span> → <span class="diff-new">${esc(show(v, byKey[k]))}</span></td></tr>`).join("")}</table>`;

  document.getElementById("reset").onclick = () => viewGuild(name, gid);
  document.getElementById("apply").onclick = async () => {
    const ch = changes();
    if (!await dialog(`<h3>Применить на «${esc(meta.name)}»?</h3>${diffHtml(ch, state)}`, { ok: "Применить" })) return;
    const res = await submit(name, { type: "config", guild: gid, changes: ch }, "Настройки");
    if (res?.ok) viewGuild(name, gid);
  };
  document.getElementById("tpl-save").onclick = async () => {
    const d = await dialog(`<h3>Сохранить шаблон</h3><p class="muted small">Сохраняются текущие значения формы (кроме каналов и ролей — они у каждого сервера свои).</p>
      <label class="field"><span>Название</span><input id="tpl-name" placeholder="Например: RP-сервер базовый"></label>`, { ok: "Сохранить" });
    const title = d?.querySelector("#tpl-name").value.trim();
    if (!title) return;
    const values = Object.fromEntries(schema.settings.filter((s) => !["channel", "role", "channels"].includes(s.kind)).map((s) => [s.key, draft[s.key]]));
    const slug = title.toLowerCase().replace(/[^a-zа-яё0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 50) || "template";
    const path = `templates/${slug}.json`;
    const { sha } = await gh.file(path);
    await gh.put(path, JSON.stringify({ title, from: `${name}/${meta.name}`, by: store.get("login"), at: now(), values }, null, 1), `Шаблон «${title}»`, sha);
    toast("✅ Шаблон сохранён");
  };
  document.getElementById("tpl-apply").onclick = async () => {
    const files = (await gh.list("templates")).filter((f) => f.name.endsWith(".json"));
    if (!files.length) { toast("Шаблонов пока нет"); return; }
    const tpls = await Promise.all(files.map((f) => gh.json(f.path).then((r) => ({ ...r.data, path: f.path }))));
    const d = await dialog(`<h3>Применить шаблон</h3><select id="tpl">${tpls.map((t, i) => `<option value="${i}">${esc(t.title)} — ${esc(t.from)}</option>`).join("")}</select>
      <p class="muted small">Значения подставятся в форму — проверьте и нажмите «Применить».</p>`, { ok: "Подставить" });
    if (!d) return;
    const t = tpls[+d.querySelector("#tpl").value];
    Object.entries(t.values || {}).forEach(([k, v]) => { if (k in byKey) draft[k] = v; });
    rerenderForm();
  };
  document.getElementById("compare").onclick = async () => {
    const list = await bots();
    const opts = list.flatMap((bb) => (bb.status.guilds || []).map((g) => [bb.name, g.id, `${bb.name} · ${g.name}`])).filter(([n, g]) => !(n === name && g === gid));
    if (!opts.length) { toast("Сравнивать не с чем"); return; }
    const d = await dialog(`<h3>Сравнить с…</h3><select id="cmp">${opts.map(([n, g, t], i) => `<option value="${i}">${esc(t)}</option>`).join("")}</select>`, { ok: "Сравнить" });
    if (!d) return;
    const [n2, g2, t2] = opts[+d.querySelector("#cmp").value];
    const { data: other } = await gh.json(`instances/${n2}/guilds/${g2}/state.json`, {});
    const diff = schema.settings.filter((s) => !["channel", "role", "channels"].includes(s.kind) && !same(other[s.key], draft[s.key]));
    const d2 = await dialog(`<h3>Отличия: здесь → ${esc(t2)}</h3>${diff.length ? `<table>${diff.map((s) => `<tr><td>${esc(modName(s))}</td><td>${esc(show(draft[s.key], s))} → ${esc(show(other[s.key], s))}</td></tr>`).join("")}</table>` : "<p>Настройки совпадают (каналы и роли не сравниваются).</p>"}`,
      { ok: diff.length ? "Взять значения оттуда" : "OK", cancel: diff.length ? "Закрыть" : "" });
    if (d2 && diff.length) { diff.forEach((s) => { draft[s.key] = other[s.key]; }); rerenderForm(); }
  };
  function rerenderForm() {
    schema.settings.forEach((s) => {
      const box = document.querySelector(`.setting[data-key="${CSS.escape(s.key)}"]`);
      if (!box) return;
      box.innerHTML = field(s.group === "modules" ? { ...s, label: modName(s) } : s);
      const el = document.getElementById(`f-${s.key}`);
      el?.addEventListener("change", () => { draft[s.key] = read(s); refresh(); });
      el?.addEventListener("input", () => { draft[s.key] = read(s); refresh(); });
    });
    refresh();
  }
}

// ── шаблоны и подпись ──
async function viewTemplates() {
  setNav("templates");
  const files = (await gh.list("templates")).filter((f) => f.name.endsWith(".json"));
  const tpls = await Promise.all(files.map((f) => gh.json(f.path).then((r) => ({ ...r.data, path: f.path, sha: r.sha }))));
  page(`<h1>Шаблоны настроек</h1><p class="muted">Сохраняются со страницы сервера («⭳ В шаблон») и применяются к любому серверу любого бота («⭱ Из шаблона»).</p>
    ${tpls.length ? `<div class="grid">${tpls.map((t, i) => `<div class="card stack"><h3>${esc(t.title)}</h3>
      <p class="muted small">из ${esc(t.from)} · ${esc(t.by)} · ${ago(t.at)} · настроек: ${Object.keys(t.values || {}).length}</p>
      <button class="danger" data-del="${i}">Удалить</button></div>`).join("")}</div>` : `<div class="card empty">Шаблонов пока нет.</div>`}`);
  document.querySelectorAll("[data-del]").forEach((btn) => btn.onclick = async () => {
    const t = tpls[+btn.dataset.del];
    if (!await dialog(`<h3>Удалить шаблон «${esc(t.title)}»?</h3><p class="muted small">В истории репозитория он останется.</p>`, { ok: "Удалить", danger: true })) return;
    await gh.del(t.path, t.sha, `Удалён шаблон «${t.title}»`);
    viewTemplates();
  });
}

function viewSign() {
  setNav("sign");
  const pub = signPub();
  page(`<div class="card stack" style="max-width:680px">
    <h1>🔏 Подпись владельца</h1>
    <p class="muted">Ключи <code>.env</code>, перезапуск и восстановление базы бот выполняет только по заявкам, подписанным ключом владельца.
      Ключ создаётся и хранится в этом браузере. Бот доверяет ему, только если публичная часть записана в его локальный <code>.env</code> —
      через облако её подменить нельзя.</p>
    ${pub ? `<label class="field"><span>Ваш публичный ключ — добавьте в .env бота:</span>
        <input readonly class="mono" value="CLOUD_OWNER_KEYS=${esc(pub)}" onclick="this.select()"></label>
      <p class="muted small">Несколько владельцев или браузеров — через запятую. После правки .env перезапустите бота.</p>
      <div class="row"><button id="export">Экспорт ключа (для другого браузера)</button><button id="drop" class="danger">Удалить из браузера</button></div>`
    : `<button class="primary" id="gen">Создать ключ</button><button id="import">Импортировать</button>`}
  </div>`);
  const gen = document.getElementById("gen");
  if (gen) gen.onclick = () => { store.set("signkey", b64(nacl.sign.keyPair().secretKey)); viewSign(); };
  const imp = document.getElementById("import");
  if (imp) imp.onclick = async () => {
    const d = await dialog(`<h3>Импорт ключа</h3><input id="k" type="password" placeholder="секретный ключ base64">`, { ok: "Импортировать" });
    const k = d?.querySelector("#k").value.trim();
    try { if (k && unb64(k).length === 64) { store.set("signkey", k); viewSign(); } else if (k) toast("Это не ключ подписи"); } catch { toast("Это не ключ подписи"); }
  };
  const exp = document.getElementById("export");
  if (exp) exp.onclick = () => dialog(`<h3>Секретный ключ</h3><p class="muted small">Никому не отправляйте. Нужен только чтобы перенести подпись в другой ваш браузер.</p>
    <input readonly class="mono" value="${esc(store.get("signkey"))}" onclick="this.select()">`, { cancel: "" });
  const drop = document.getElementById("drop");
  if (drop) drop.onclick = async () => { if (await dialog("<h3>Удалить ключ из этого браузера?</h3>", { ok: "Удалить", danger: true })) { store.set("signkey", null); viewSign(); } };
}

// ── маршруты ──
async function route() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  if (parts[0] === "logout") { store.set("token", null); store.set("login", null); location.hash = "#/"; return; }
  if (!gh.token()) return viewLogin();
  try {
    if (parts[0] === "bot" && parts[2] === "g") return await viewGuild(parts[1], parts[3]);
    if (parts[0] === "bot") return await viewBot(parts[1], parts[2]);
    if (parts[0] === "templates") return await viewTemplates();
    if (parts[0] === "sign") return viewSign();
    return await viewHome();
  } catch (e) {
    if (e.status === 401) { store.set("token", null); toast("Токен больше не действует — войдите снова"); return viewLogin(); }
    page(`<div class="card empty">⚠️ ${esc(e.message)}<br><button onclick="location.reload()">Повторить</button></div>`);
  }
}

// ── тема ──
function applyTheme() { const t = store.get("theme"); t ? document.documentElement.setAttribute("data-theme", t) : document.documentElement.removeAttribute("data-theme"); }
document.getElementById("theme").onclick = () => {
  const dark = document.documentElement.getAttribute("data-theme") === "dark" || (!store.get("theme") && matchMedia("(prefers-color-scheme: dark)").matches);
  store.set("theme", dark ? "light" : "dark");
  applyTheme();
};
applyTheme();
window.addEventListener("hashchange", route);
route();
