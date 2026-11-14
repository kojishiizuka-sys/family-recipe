// =============================================================
// 家族の定番レシピアプリ（第1段階）
// =============================================================
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';
import { parseAmount, formatAmount, splitIngredientLine } from './amount.js';
import { buildSynonymMap, matchRecipe } from './search.js';

const APP_VERSION = '0.2.0';
const CATEGORIES = ['主菜', '副菜', '汁物', 'ご飯・麺・パン', 'おやつ', 'その他'];
const SOURCE_TYPES = { original: 'オリジナル', url: 'ウェブサイト', book: '料理本', photo: '写真・スクショ' };
const SORTS = { new: '新しく登録した順', often: 'よく作る順', stale: '最近作っていない順' };
const BUCKET = 'recipe-images';
const CACHE_KEY = 'family-recipe-cache-v1';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { flowType: 'pkce', detectSessionInUrl: true, persistSession: true, autoRefreshToken: true },
});

const app = document.getElementById('app');
const state = {
  session: null,
  me: null,
  members: [],
  recipes: [],
  logs: [],
  synonyms: [],
  synMap: new Map(),
  imageUrls: {},
  query: '',
  category: '',
  sort: 'new',
  servings: {},     // レシピごとの表示人数
  draft: null,      // URL取り込みから登録画面へ渡す下書き
  loaded: false,
};
let edit = null;    // 登録・編集中のデータ
let photoPicks = []; // 写真取り込みで選んだ写真
let wakeLock = null;

// ---------------------------------------------------------------
// 小さな道具
// ---------------------------------------------------------------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (sel, root = document) => root.querySelector(sel);
// 古いiPhoneでも動くようにIDを作る
function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function todayStr(d = new Date()) {
  const z = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}
function daysAgo(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const now = new Date();
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((base - new Date(y, m - 1, d)) / 86400000);
}
function agoLabel(dateStr) {
  const n = daysAgo(dateStr);
  if (n <= 0) return '今日';
  if (n === 1) return '昨日';
  return `${n}日前`;
}
function mdLabel(dateStr) {
  const [, m, d] = dateStr.split('-').map(Number);
  return `${m}/${d}`;
}
function memberName(uid) {
  const m = state.members.find(x => x.user_id === uid);
  return m ? m.display_name : '家族';
}
function statsOf(rid) {
  const logs = state.logs
    .filter(l => l.recipe_id === rid)
    .sort((a, b) => (b.cooked_on.localeCompare(a.cooked_on)) || String(b.created_at).localeCompare(String(a.created_at)));
  return { count: logs.length, last: logs[0]?.cooked_on ?? null, logs };
}

let toastTimer = null;
function toast(msg, actionLabel, action) {
  const el = document.getElementById('toast');
  el.innerHTML = `<span>${esc(msg)}</span>${actionLabel ? `<button type="button">${esc(actionLabel)}</button>` : ''}`;
  el.classList.add('show');
  if (actionLabel) {
    el.querySelector('button').onclick = () => { el.classList.remove('show'); action(); };
  }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 5000);
}
function fail(e) {
  console.error(e);
  toast('うまくいきませんでした：' + (e?.message ?? e));
}
function offlineBanner() {
  return navigator.onLine ? '' : '<div class="offline">オフラインです。保存済みのレシピを表示しています（登録・編集はできません）</div>';
}
function requireOnline() {
  if (navigator.onLine) return true;
  toast('オフラインのため、この操作はできません');
  return false;
}

// ---------------------------------------------------------------
// データの読み込みとキャッシュ
// ---------------------------------------------------------------
function saveCache() {
  try {
    const { me, members, recipes, logs, synonyms } = state;
    localStorage.setItem(CACHE_KEY, JSON.stringify({ me, members, recipes, logs, synonyms }));
  } catch (e) { console.warn('cache', e); }
}
function loadCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch { return null; }
}

function normalizeRecipe(r) {
  r.ingredients = (r.ingredients ?? []).sort((a, b) => a.sort_order - b.sort_order);
  r.steps = (r.steps ?? []).sort((a, b) => a.step_no - b.step_no);
  r.recipe_images = (r.recipe_images ?? []).sort((a, b) => a.sort_order - b.sort_order);
  r.tags = (r.recipe_tags ?? []).map(x => x.tags?.name).filter(Boolean);
  delete r.recipe_tags;
  return r;
}

async function loadAll() {
  const [r, l, m, s] = await Promise.all([
    sb.from('recipes')
      .select('*, ingredients(*), steps(*), recipe_images(*), recipe_tags(tags(name))')
      .is('deleted_at', null),
    sb.from('cook_logs').select('*'),
    sb.from('members').select('*'),
    sb.from('synonyms').select('id, group_key, word'),
  ]);
  for (const res of [r, l, m, s]) if (res.error) throw res.error;
  state.recipes = r.data.map(normalizeRecipe);
  state.logs = l.data;
  state.members = m.data;
  state.synonyms = s.data;
  state.synMap = buildSynonymMap(state.synonyms);
  const email = (state.session?.user?.email ?? '').toLowerCase();
  state.me = state.members.find(x => x.email.toLowerCase() === email) ?? state.me;
  saveCache();
  await refreshImageUrls();
}

async function refreshImageUrls() {
  const paths = state.recipes.flatMap(r => r.recipe_images.map(i => i.storage_path));
  if (!paths.length) return;
  const { data, error } = await sb.storage.from(BUCKET).createSignedUrls(paths, 60 * 60 * 6);
  if (error) { console.warn(error); return; }
  for (const x of data) if (x.signedUrl) state.imageUrls[x.path] = x.signedUrl;
}

// ---------------------------------------------------------------
// 起動とログイン
// ---------------------------------------------------------------
async function start() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
  window.addEventListener('online', () => route());
  window.addEventListener('offline', () => route());
  window.addEventListener('hashchange', route);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && location.hash.startsWith('#/r/')) requestWakeLock();
  });

  if (SUPABASE_URL.includes('YOUR-PROJECT')) {
    app.innerHTML = `<div class="center"><h1>設定が必要です</h1><p>js/config.js に SupabaseのURLとキーを書いてください。</p></div>`;
    return;
  }

  const { data: { session } } = await sb.auth.getSession();
  if (new URLSearchParams(location.search).has('code')) {
    history.replaceState(null, '', location.pathname + location.hash);
  }
  sb.auth.onAuthStateChange((event, s) => {
    state.session = s;
    if (event === 'SIGNED_OUT') renderLogin();
  });
  state.session = session;
  if (!session) { renderLogin(); return; }
  await afterLogin();
}

async function afterLogin() {
  const cached = loadCache();
  if (cached) {
    Object.assign(state, cached, { synMap: buildSynonymMap(cached.synonyms ?? []) });
    state.loaded = true;
    route();
  } else {
    app.innerHTML = '<div class="center"><p>読み込み中…</p></div>';
  }
  try {
    const email = (state.session.user.email ?? '').toLowerCase();
    const { data, error } = await sb.from('members').select('*');
    if (error) throw error;
    const me = data.find(m => m.email.toLowerCase() === email);
    if (!me) { renderNotMember(state.session.user.email); return; }
    if (!me.user_id) {
      const { error: e2 } = await sb.from('members').update({ user_id: state.session.user.id }).eq('email', me.email);
      if (e2) console.warn(e2);
    }
    await loadAll();
    const wasLoaded = state.loaded;
    state.loaded = true;
    // 入力中の登録・編集画面は描き直さない
    if (!(wasLoaded && /^#\/(new|edit|import|photo)/.test(location.hash))) route();
  } catch (e) {
    console.warn(e);
    if (cached) toast('オフラインのため、保存済みのデータを表示しています');
    else app.innerHTML = `<div class="center"><p>読み込めませんでした。電波の良いところでもう一度開いてください。</p><button class="btn" onclick="location.reload()">再読み込み</button></div>`;
  }
}

function renderLogin() {
  app.innerHTML = `
    <div class="center login">
      <div class="logo">🍳</div>
      <h1>家族のレシピ</h1>
      <p>家族の定番レシピをまとめておく場所です。</p>
      <button class="btn primary big" id="login">Googleでログイン</button>
    </div>`;
  $('#login').onclick = () => sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: location.origin + location.pathname },
  });
}

function renderNotMember(email) {
  app.innerHTML = `
    <div class="center">
      <h1>このアカウントは登録されていません</h1>
      <p>${esc(email)} は、家族のメンバーに登録されていません。登録したアカウントでログインし直してください。</p>
      <button class="btn" id="logout">ログアウト</button>
    </div>`;
  $('#logout').onclick = logout;
}

async function logout() {
  await sb.auth.signOut();
  localStorage.removeItem(CACHE_KEY);
  Object.assign(state, { session: null, loaded: false, recipes: [], logs: [] });
  renderLogin();
}

// ---------------------------------------------------------------
// 画面の切り替え
// ---------------------------------------------------------------
function route() {
  if (!state.session) { renderLogin(); return; }
  if (!state.loaded) return;
  releaseWakeLock();
  window.scrollTo(0, 0);
  const parts = location.hash.replace(/^#/, '').split('/').filter(Boolean);
  if (parts[0] === 'r' && parts[1]) return renderDetail(parts[1]);
  if (parts[0] === 'edit' && parts[1]) return renderEdit(parts[1]);
  if (parts[0] === 'new') return renderEdit(null);
  if (parts[0] === 'import') return renderImport();
  if (parts[0] === 'photo') return renderPhotoImport();
  if (parts[0] === 'settings') return renderSettings();
  renderList();
}

// ---------------------------------------------------------------
// 一覧・検索
// ---------------------------------------------------------------
function renderList() {
  app.innerHTML = `
    <header class="bar">
      <h1>家族のレシピ</h1>
      <a class="icon-btn" href="#/settings" aria-label="設定">⚙︎</a>
    </header>
    ${offlineBanner()}
    <div class="search">
      <input id="q" type="search" enterkeyhint="search" placeholder="レシピ名・材料で検索（例：鶏肉 キャベツ）" value="${esc(state.query)}">
    </div>
    <div class="chips">
      ${['', ...CATEGORIES].map(c => `<button type="button" class="chip ${state.category === c ? 'on' : ''}" data-cat="${esc(c)}">${esc(c || 'すべて')}</button>`).join('')}
    </div>
    <div class="sortrow">
      <span id="count"></span>
      <select id="sort" aria-label="並び替え">
        ${Object.entries(SORTS).map(([k, v]) => `<option value="${k}" ${state.sort === k ? 'selected' : ''}>${v}</option>`).join('')}
      </select>
    </div>
    <ul class="cards" id="cards"></ul>
    <button type="button" class="fab" id="add" aria-label="レシピを追加">＋</button>
    <div class="sheet-bg hidden" id="sheet">
      <div class="sheet">
        <h2>レシピを追加</h2>
        <a class="sheet-item" href="#/new">✏️ 手入力で登録</a>
        <a class="sheet-item" href="#/import">🔗 URLから取り込む</a>
        <a class="sheet-item" href="#/photo">📷 写真から取り込む</a>
        <button type="button" class="btn" id="sheetClose">閉じる</button>
      </div>
    </div>`;

  fillCards();
  $('#q').addEventListener('input', e => { state.query = e.target.value; fillCards(); });
  $$('.chip').forEach(b => b.onclick = () => {
    state.category = b.dataset.cat;
    $$('.chip').forEach(x => x.classList.toggle('on', x === b));
    fillCards();
  });
  $('#sort').onchange = e => { state.sort = e.target.value; fillCards(); };
  $('#add').onclick = () => { state.draft = null; $('#sheet').classList.remove('hidden'); };
  $('#sheetClose').onclick = () => $('#sheet').classList.add('hidden');
  $('#sheet').onclick = e => { if (e.target.id === 'sheet') $('#sheet').classList.add('hidden'); };
}

function fillCards() {
  const list = state.recipes
    .filter(r => (!state.category || r.category === state.category) && matchRecipe(r, state.query, state.synMap))
    .map(r => ({ r, s: statsOf(r.id) }));

  if (state.sort === 'new') {
    list.sort((a, b) => String(b.r.created_at).localeCompare(String(a.r.created_at)));
  } else if (state.sort === 'often') {
    list.sort((a, b) => (b.s.count - a.s.count) || String(b.s.last ?? '').localeCompare(String(a.s.last ?? '')));
  } else {
    // 最近作っていない順：記録があるものを古い順、未記録は最後
    list.sort((a, b) => {
      if (!a.s.last && !b.s.last) return 0;
      if (!a.s.last) return 1;
      if (!b.s.last) return -1;
      return a.s.last.localeCompare(b.s.last);
    });
  }

  $('#count').textContent = `${list.length}件`;
  $('#cards').innerHTML = list.length
    ? list.map(({ r, s }) => card(r, s)).join('')
    : `<li class="empty">${state.recipes.length ? '見つかりませんでした' : 'まだレシピがありません。右下の＋から登録しましょう'}</li>`;
}

function card(r, s) {
  const img = r.recipe_images.find(i => i.kind === 'finished');
  const url = img && state.imageUrls[img.storage_path];
  const meta = s.count ? `${s.count}回・${agoLabel(s.last)}` : '未記録';
  return `
    <li><a class="card" href="#/r/${r.id}">
      ${url ? `<img src="${esc(url)}" alt="" loading="lazy">` : `<div class="ph">${esc((r.title || '？').slice(0, 1))}</div>`}
      <div class="ci">
        <div class="ct">${esc(r.title)}</div>
        <div class="cm"><span class="cat">${esc(r.category)}</span> ${esc(meta)}</div>
      </div>
    </a></li>`;
}

// ---------------------------------------------------------------
// 詳細（分量換算・作ったボタン）
// ---------------------------------------------------------------
function renderDetail(id) {
  const r = state.recipes.find(x => x.id === id);
  if (!r) {
    app.innerHTML = `<header class="bar"><a class="icon-btn" href="#/">‹</a><h1>見つかりません</h1></header><p class="pad">このレシピは見つかりませんでした。</p>`;
    return;
  }
  const base = Number(r.servings_base) || 1;
  const serv = state.servings[id] ?? base;
  const factor = serv / base;
  const s = statsOf(id);
  const finished = r.recipe_images.filter(i => i.kind === 'finished');
  const sources = r.recipe_images.filter(i => i.kind === 'source');
  const heroUrl = finished[0] && state.imageUrls[finished[0].storage_path];

  let lastGroup = null;
  const ingHtml = r.ingredients.map(ing => {
    const g = ing.group_label || '';
    const head = g && g !== lastGroup ? `<li class="ghead">${esc(g)}</li>` : '';
    lastGroup = g;
    const amt = formatAmount(ing, factor);
    const changed = Math.abs(factor - 1) > 1e-9 && ing.scalable && ing.quantity != null;
    return `${head}<li class="${g ? 'ingroup' : ''}">
      <span class="iname">${esc(ing.name)}${ing.note ? `<small>（${esc(ing.note)}）</small>` : ''}</span>
      <span class="amt">${esc(amt)}${changed ? `<small class="orig">元 ${esc(ing.quantity_text)}</small>` : ''}</span>
    </li>`;
  }).join('');

  const sourceHtml = (() => {
    const label = SOURCE_TYPES[r.source_type] ?? '';
    const parts = [];
    if (r.source_url) parts.push(`<a href="${esc(r.source_url)}" target="_blank" rel="noopener">${esc(r.source_name || r.source_url)}</a>`);
    else if (r.source_name) parts.push(esc(r.source_name));
    if (!parts.length && !sources.length) return '';
    return `<section class="box"><h2>出典（${esc(label)}）</h2><p>${parts.join('')}</p>
      ${sources.length ? `<div class="thumbs">${sources.map(i => {
        const u = state.imageUrls[i.storage_path];
        return u ? `<a href="${esc(u)}" target="_blank" rel="noopener"><img src="${esc(u)}" alt="元のレシピ" loading="lazy"></a>` : '<div class="ph small">写真</div>';
      }).join('')}</div>` : ''}
    </section>`;
  })();

  app.innerHTML = `
    <header class="bar">
      <a class="icon-btn" href="#/" aria-label="一覧へ戻る">‹</a>
      <h1>${esc(r.title)}</h1>
      <a class="icon-btn" href="#/edit/${r.id}" aria-label="編集">✎</a>
    </header>
    ${offlineBanner()}
    ${heroUrl ? `<img class="hero" src="${esc(heroUrl)}" alt="">` : ''}
    <div class="pad">
      <div class="meta">
        <span class="cat">${esc(r.category)}</span>
        ${r.cook_time_min ? `<span>⏱ ${esc(r.cook_time_min)}分</span>` : ''}
        ${r.tags.map(t => `<span class="tag">#${esc(t)}</span>`).join('')}
      </div>

      <section class="cook">
        <div class="cookstat">
          <div><b>${s.count}</b> 回作った</div>
          <div>${s.last ? `最後：${mdLabel(s.last)}（${agoLabel(s.last)}）` : 'まだ記録がありません'}</div>
        </div>
        <button type="button" class="btn primary big" id="cook">作った！</button>
        <button type="button" class="linkbtn" id="cookMoreBtn">日付・メモを変えて記録</button>
        <form id="cookForm" class="cookform hidden">
          <label>作った日 <input type="date" name="date" value="${todayStr()}" max="${todayStr()}" required></label>
          <label>ひとことメモ <input type="text" name="memo" placeholder="例：塩控えめでよかった"></label>
          <button class="btn primary">記録する</button>
        </form>
      </section>

      <section class="box">
        <div class="servings">
          <h2>材料</h2>
          <div class="stepper">
            <button type="button" id="minus" aria-label="1人減らす">−</button>
            <span><b>${serv}</b>人分</span>
            <button type="button" id="plus" aria-label="1人増やす">＋</button>
          </div>
        </div>
        ${serv !== base ? `<p class="hint">元のレシピは${base}人分です。<button type="button" class="linkbtn" id="resetServ">元に戻す</button></p>` : ''}
        <ul class="ings">${ingHtml || '<li class="empty">材料が登録されていません</li>'}</ul>
      </section>

      <section class="box">
        <h2>作り方</h2>
        <ol class="steps">${r.steps.map(st => `<li>${esc(st.text)}</li>`).join('') || '<li class="empty">手順が登録されていません</li>'}</ol>
      </section>

      ${r.family_note ? `<section class="box note"><h2>我が家メモ</h2><p>${esc(r.family_note).replace(/\n/g, '<br>')}</p></section>` : ''}
      ${sourceHtml}

      <details class="box history">
        <summary>作った記録（${s.count}件）</summary>
        <ul>${s.logs.map(l => `
          <li>
            <span>${mdLabel(l.cooked_on)}　${esc(memberName(l.cooked_by))}${l.servings ? `　${esc(l.servings)}人分` : ''}${l.memo ? `<br><small>${esc(l.memo)}</small>` : ''}</span>
            <button type="button" class="del" data-log="${l.id}" aria-label="この記録を削除">×</button>
          </li>`).join('') || '<li class="empty">まだ記録がありません</li>'}
        </ul>
      </details>
    </div>`;

  const setServ = n => { state.servings[id] = Math.max(1, n); renderDetail(id); };
  $('#minus').onclick = () => setServ(serv - 1);
  $('#plus').onclick = () => setServ(serv + 1);
  $('#resetServ')?.addEventListener('click', () => { delete state.servings[id]; renderDetail(id); });
  $('#cook').onclick = () => cook(r, { date: todayStr(), servings: serv });
  $('#cookMoreBtn').onclick = () => $('#cookForm').classList.toggle('hidden');
  $('#cookForm').onsubmit = e => {
    e.preventDefault();
    const f = new FormData(e.target);
    cook(r, { date: f.get('date'), memo: f.get('memo'), servings: serv });
  };
  $$('[data-log]').forEach(b => b.onclick = () => deleteLog(b.dataset.log, id));
  requestWakeLock();
}

async function cook(r, { date, memo, servings }) {
  if (!requireOnline()) return;
  const uid = state.session.user.id;
  const dup = state.logs.some(l => l.recipe_id === r.id && l.cooked_on === date && l.cooked_by === uid);
  if (dup && !confirm('この日はもう記録済みです。もう1回追加しますか？')) return;
  const { data, error } = await sb.from('cook_logs')
    .insert({ recipe_id: r.id, cooked_on: date, servings, memo: memo || null })
    .select()
    .single();
  if (error) return fail(error);
  state.logs.push(data);
  saveCache();
  renderDetail(r.id);
  toast('記録しました', '取り消す', async () => {
    const { error: e2 } = await sb.from('cook_logs').delete().eq('id', data.id);
    if (e2) return fail(e2);
    state.logs = state.logs.filter(l => l.id !== data.id);
    saveCache();
    if (location.hash === `#/r/${r.id}`) renderDetail(r.id);
    toast('取り消しました');
  });
}

async function deleteLog(logId, rid) {
  if (!requireOnline()) return;
  if (!confirm('この記録を削除しますか？')) return;
  const { error } = await sb.from('cook_logs').delete().eq('id', logId);
  if (error) return fail(error);
  state.logs = state.logs.filter(l => l.id !== logId);
  saveCache();
  renderDetail(rid);
}

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch { /* 対応していない端末では何もしない */ }
}
function releaseWakeLock() {
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}

// ---------------------------------------------------------------
// 登録・編集
// ---------------------------------------------------------------
function blankIngredient() { return { group_label: '', name: '', amount: '', note: '' }; }

function renderEdit(id) {
  if (id) {
    const r = state.recipes.find(x => x.id === id);
    if (!r) { location.hash = '#/'; return; }
    edit = {
      id: r.id, title: r.title, category: r.category, servings_base: r.servings_base,
      cook_time_min: r.cook_time_min ?? '', tags: r.tags.join('、'),
      source_type: r.source_type, source_url: r.source_url ?? '', source_name: r.source_name ?? '',
      family_note: r.family_note ?? '',
      ingredients: r.ingredients.map(i => ({ group_label: i.group_label ?? '', name: i.name, amount: i.quantity_text ?? '', note: i.note ?? '' })),
      steps: r.steps.map(s => s.text),
      images: r.recipe_images.map(i => ({ ...i })),
      removedImages: [], newImages: [],
    };
  } else {
    const d = state.draft ?? {};
    state.draft = null;
    edit = {
      id: null, title: d.title ?? '', category: d.category ?? '主菜', servings_base: d.servings_base ?? 2,
      cook_time_min: '', tags: '', source_type: d.source_type ?? 'original',
      source_url: d.source_url ?? '', source_name: d.source_name ?? '', family_note: '',
      fromAi: !!d.fromAi,
      ingredients: d.ingredients?.length ? d.ingredients : [blankIngredient(), blankIngredient(), blankIngredient()],
      steps: d.steps?.length ? d.steps : ['', ''],
      images: [], removedImages: [], newImages: d.newImages ?? [],
    };
  }
  drawEdit();
}

function drawEdit() {
  const e = edit;
  app.innerHTML = `
    <header class="bar">
      <a class="icon-btn" href="${e.id ? `#/r/${e.id}` : '#/'}" aria-label="やめる">✕</a>
      <h1>${e.id ? 'レシピを編集' : 'レシピを登録'}</h1>
      <span class="icon-btn"></span>
    </header>
    ${offlineBanner()}
    <form id="editForm" class="pad form" autocomplete="off">
      ${e.fromAi ? '<p class="notice">AIで読み取った内容です。材料・分量・手順に読み間違いがないか確認してから保存してください。</p>' : ''}
      <label><span class="lt">レシピ名<span class="req">必須</span></span>
        <input data-k="title" value="${esc(e.title)}" required placeholder="例：豚の生姜焼き">
      </label>
      <div class="row3">
        <label>カテゴリ
          <select data-k="category">${CATEGORIES.map(c => `<option ${e.category === c ? 'selected' : ''}>${c}</option>`).join('')}</select>
        </label>
        <label>何人分
          <input data-k="servings_base" type="number" inputmode="decimal" min="0.5" step="0.5" value="${esc(e.servings_base)}">
        </label>
        <label>調理時間（分）
          <input data-k="cook_time_min" type="number" inputmode="numeric" min="0" value="${esc(e.cook_time_min)}">
        </label>
      </div>

      <fieldset>
        <legend>材料</legend>
        <p class="hint">分量は「200g」「大さじ1と1/2」「1/2個」「少々」のように書くと、人数を変えたときに換算されます。グループ欄は「A」「B」など（任意）。</p>
        <div id="ings">
          ${e.ingredients.map((ing, i) => `
            <div class="ingrow">
              <input class="g" data-list="ingredients" data-i="${i}" data-f="group_label" value="${esc(ing.group_label)}" placeholder="組" aria-label="グループ">
              <input class="n" data-list="ingredients" data-i="${i}" data-f="name" value="${esc(ing.name)}" placeholder="材料名" aria-label="材料名">
              <input class="a" data-list="ingredients" data-i="${i}" data-f="amount" value="${esc(ing.amount)}" placeholder="分量" aria-label="分量">
              <div class="rowbtns">
                <button type="button" data-act="up" data-list="ingredients" data-i="${i}" aria-label="上へ">↑</button>
                <button type="button" data-act="down" data-list="ingredients" data-i="${i}" aria-label="下へ">↓</button>
                <button type="button" data-act="del" data-list="ingredients" data-i="${i}" aria-label="削除">×</button>
              </div>
            </div>`).join('')}
        </div>
        <div class="addrow">
          <button type="button" class="btn" data-act="add" data-list="ingredients">＋ 材料を追加</button>
          <button type="button" class="linkbtn" data-act="bulk" data-list="ingredients">まとめて貼り付け</button>
        </div>
        <div class="bulk hidden" id="bulk-ingredients">
          <textarea rows="6" placeholder="1行に1つずつ。例：&#10;豚こま切れ肉 200g&#10;(A)しょうゆ 大さじ2&#10;塩 少々"></textarea>
          <button type="button" class="btn" data-act="bulk-apply" data-list="ingredients">材料に追加</button>
        </div>
      </fieldset>

      <fieldset>
        <legend>作り方</legend>
        <div id="steps">
          ${e.steps.map((t, i) => `
            <div class="steprow">
              <span class="no">${i + 1}</span>
              <textarea rows="2" data-list="steps" data-i="${i}" placeholder="手順 ${i + 1}">${esc(t)}</textarea>
              <div class="rowbtns">
                <button type="button" data-act="up" data-list="steps" data-i="${i}" aria-label="上へ">↑</button>
                <button type="button" data-act="down" data-list="steps" data-i="${i}" aria-label="下へ">↓</button>
                <button type="button" data-act="del" data-list="steps" data-i="${i}" aria-label="削除">×</button>
              </div>
            </div>`).join('')}
        </div>
        <div class="addrow">
          <button type="button" class="btn" data-act="add" data-list="steps">＋ 手順を追加</button>
          <button type="button" class="linkbtn" data-act="bulk" data-list="steps">まとめて貼り付け</button>
        </div>
        <div class="bulk hidden" id="bulk-steps">
          <textarea rows="6" placeholder="1行に1手順ずつ"></textarea>
          <button type="button" class="btn" data-act="bulk-apply" data-list="steps">手順に追加</button>
        </div>
      </fieldset>

      <label>我が家メモ・アレンジ
        <textarea data-k="family_note" rows="3" placeholder="例：砂糖は控えめ、ピーマン抜き">${esc(e.family_note)}</textarea>
      </label>
      <label>タグ（読点「、」で区切る）
        <input data-k="tags" value="${esc(e.tags)}" placeholder="例：作り置き、お弁当">
      </label>

      <fieldset>
        <legend>出典</legend>
        <label>種類
          <select data-k="source_type">${Object.entries(SOURCE_TYPES).map(([k, v]) => `<option value="${k}" ${e.source_type === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
        </label>
        <label>URL <input data-k="source_url" type="url" inputmode="url" value="${esc(e.source_url)}" placeholder="https://"></label>
        <label>出典名 <input data-k="source_name" value="${esc(e.source_name)}" placeholder="例：〇〇の本 p.42、サイト名"></label>
      </fieldset>

      <fieldset>
        <legend>写真</legend>
        <div class="imgs">
          ${e.images.map((img, i) => {
            const u = state.imageUrls[img.storage_path];
            return `<div class="imgbox">${u ? `<img src="${esc(u)}" alt="">` : '<div class="ph small">写真</div>'}
              <span class="kind">${img.kind === 'finished' ? '完成' : '元レシピ'}</span>
              <button type="button" data-act="del-img" data-i="${i}" aria-label="写真を削除">×</button></div>`;
          }).join('')}
          ${e.newImages.map((img, i) => `<div class="imgbox new"><img src="${img.preview}" alt="">
              <span class="kind">${img.kind === 'finished' ? '完成' : '元レシピ'}（未保存）</span>
              <button type="button" data-act="del-new" data-i="${i}" aria-label="写真を削除">×</button></div>`).join('')}
        </div>
        <div class="addrow">
          <label class="btn file">完成写真を追加<input type="file" accept="image/*" data-kind="finished" hidden></label>
          <label class="btn file">元のレシピの写真を追加<input type="file" accept="image/*" multiple data-kind="source" hidden></label>
        </div>
      </fieldset>

      <button class="btn primary big" id="save">保存する</button>
      ${e.id ? '<button type="button" class="btn danger" id="trash">このレシピをゴミ箱に移す</button>' : ''}
    </form>`;

  const form = $('#editForm');
  form.addEventListener('input', ev => {
    const t = ev.target;
    if (t.dataset.k) edit[t.dataset.k] = t.value;
    else if (t.dataset.list === 'ingredients' && t.dataset.f) edit.ingredients[+t.dataset.i][t.dataset.f] = t.value;
    else if (t.dataset.list === 'steps' && t.dataset.i != null) edit.steps[+t.dataset.i] = t.value;
  });
  form.addEventListener('change', ev => {
    const t = ev.target;
    if (t.type === 'file' && t.files?.length) {
      for (const f of t.files) {
        if (t.dataset.kind === 'finished') {
          // 完成写真は1枚にする（古いものは削除扱い）
          edit.newImages = edit.newImages.filter(x => x.kind !== 'finished');
          edit.images.filter(x => x.kind === 'finished').forEach(x => edit.removedImages.push(x));
          edit.images = edit.images.filter(x => x.kind !== 'finished');
        }
        edit.newImages.push({ kind: t.dataset.kind, file: f, preview: URL.createObjectURL(f) });
      }
      drawEdit();
    }
  });
  form.addEventListener('click', ev => {
    const b = ev.target.closest('button[data-act]');
    if (!b) return;
    const list = b.dataset.list;
    const i = +b.dataset.i;
    const arr = list ? edit[list] : null;
    switch (b.dataset.act) {
      case 'add': arr.push(list === 'ingredients' ? blankIngredient() : ''); break;
      case 'del': arr.splice(i, 1); break;
      case 'up': if (i > 0) [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]]; break;
      case 'down': if (i < arr.length - 1) [arr[i + 1], arr[i]] = [arr[i], arr[i + 1]]; break;
      case 'bulk': $(`#bulk-${list}`).classList.toggle('hidden'); return;
      case 'bulk-apply': {
        const lines = $(`#bulk-${list} textarea`).value.split(/\n+/).map(s => s.trim()).filter(Boolean);
        if (list === 'ingredients') {
          edit.ingredients = edit.ingredients.filter(x => x.name.trim()).concat(lines.map(splitIngredientLine));
        } else {
          const cleaned = lines.map(s => s.replace(/^(\d+[.)．、]|[①-⑳]|\(\d+\))\s*/, ''));
          edit.steps = edit.steps.filter(x => x.trim()).concat(cleaned);
        }
        break;
      }
      case 'del-img': edit.removedImages.push(edit.images[i]); edit.images.splice(i, 1); break;
      case 'del-new': edit.newImages.splice(i, 1); break;
      default: return;
    }
    drawEdit();
  });
  form.onsubmit = ev => { ev.preventDefault(); saveRecipe(); };
  $('#trash')?.addEventListener('click', trashRecipe);
}

async function saveRecipe() {
  if (!requireOnline()) return;
  const e = edit;
  if (!e.title.trim()) { toast('レシピ名を入れてください'); return; }
  const btn = $('#save');
  btn.disabled = true;
  btn.textContent = '保存中…';
  try {
    const rid = e.id ?? uuid();
    const p = {
      id: rid,
      title: e.title.trim(),
      category: e.category,
      servings_base: Number(e.servings_base) || 2,
      cook_time_min: e.cook_time_min === '' ? null : Number(e.cook_time_min),
      source_type: e.source_type,
      source_url: e.source_url,
      source_name: e.source_name,
      family_note: e.family_note,
      tags: String(e.tags).split(/[、,，\s]+/).map(s => s.trim()).filter(Boolean),
      ingredients: e.ingredients.filter(i => i.name.trim()).map(i => {
        const a = parseAmount(i.amount);
        return {
          group_label: i.group_label, name: i.name.trim(), note: i.note,
          quantity: a.quantity, quantity_text: a.text, unit: a.unit, scalable: a.scalable,
        };
      }),
      steps: e.steps.map(s => s.trim()).filter(Boolean),
    };
    const { error } = await sb.rpc('save_recipe', { p });
    if (error) throw error;

    // 写真：削除したもの
    for (const img of e.removedImages) {
      await sb.storage.from(BUCKET).remove([img.storage_path]);
      await sb.from('recipe_images').delete().eq('id', img.id);
    }
    // 写真：追加したもの（縮小してから保存）
    let order = e.images.length;
    for (const n of e.newImages) {
      btn.textContent = '写真を保存中…';
      const blob = await resizeImage(n.file);
      const path = `${rid}/${uuid()}.jpg`;
      const up = await sb.storage.from(BUCKET).upload(path, blob, { contentType: 'image/jpeg' });
      if (up.error) throw up.error;
      const ins = await sb.from('recipe_images').insert({ recipe_id: rid, kind: n.kind, storage_path: path, sort_order: order++ });
      if (ins.error) throw ins.error;
    }

    await loadAll();
    toast('保存しました');
    location.hash = `#/r/${rid}`;
  } catch (err) {
    fail(err);
    btn.disabled = false;
    btn.textContent = '保存する';
  }
}

async function trashRecipe() {
  if (!requireOnline()) return;
  if (!confirm(`「${edit.title}」をゴミ箱に移しますか？\n（設定画面のゴミ箱から戻せます）`)) return;
  const { error } = await sb.from('recipes').update({ deleted_at: new Date().toISOString() }).eq('id', edit.id);
  if (error) return fail(error);
  await loadAll();
  toast('ゴミ箱に移しました');
  location.hash = '#/';
}

async function resizeImage(file, max = 1600) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch { bmp = await createImageBitmap(file); }
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale);
  const h = Math.round(bmp.height * scale);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').drawImage(bmp, 0, 0, w, h);
  return await new Promise(res => c.toBlob(res, 'image/jpeg', 0.85));
}

// ---------------------------------------------------------------
// URLから取り込む
// ---------------------------------------------------------------
function renderImport() {
  app.innerHTML = `
    <header class="bar">
      <a class="icon-btn" href="#/" aria-label="戻る">‹</a>
      <h1>URLから取り込む</h1>
      <span class="icon-btn"></span>
    </header>
    ${offlineBanner()}
    <form class="pad form" id="importForm">
      <label>レシピページのURL
        <input id="url" type="url" inputmode="url" required placeholder="https://">
      </label>
      <button class="btn primary big" id="go">取り込む</button>
      <p class="hint">クックパッドやクラシルなどの大手サイトはすぐに読み取れます。
      それ以外のサイトは、ページの本文をAIで読み取ります（少し時間がかかります）。
      読み取った内容は登録画面で確認・修正してから保存します。</p>
      <p class="hint">InstagramやTikTokなどのSNSは読み取れないことが多いです。その場合はスクショを撮り、
      「写真から取り込む」を使ってください。</p>
    </form>`;
  $('#importForm').onsubmit = async ev => {
    ev.preventDefault();
    if (!requireOnline()) return;
    const url = $('#url').value.trim();
    const btn = $('#go');
    btn.disabled = true;
    btn.textContent = '読み取り中…（AIを使う場合は30秒ほどかかります）';
    try {
      const { data, error } = await sb.functions.invoke('import-url', { body: { url } });
      if (error) {
        let code = '';
        try { code = (await error.context.json()).error; } catch { /* 読めないときは空 */ }
        toast(importErrorMessage(code, 'このページ'));
        return;
      }
      state.draft = {
        title: data.title,
        servings_base: data.servings || 2,
        source_type: 'url',
        source_url: url,
        source_name: data.siteName,
        ingredients: data.ingredientRows?.length ? data.ingredientRows : (data.ingredients ?? []).map(splitIngredientLine),
        steps: data.steps ?? [],
        fromAi: data.via === 'ai',
      };
      location.hash = '#/new';
    } catch (err) {
      fail(err);
    } finally {
      btn.disabled = false;
      btn.textContent = '取り込む';
    }
  };
}

function importErrorMessage(code, what) {
  return {
    no_recipe: `${what}からはレシピを読み取れませんでした。手入力で登録してください。`,
    fetch_failed: 'ページを開けませんでした。URLを確認してください。',
    bad_url: 'URLの形が正しくありません。',
    not_member: '家族として登録されていないアカウントです。',
    no_api_key: 'AIの設定（APIキー）がまだです。README の手順を確認してください。',
    ai_failed: 'AIでの読み取りに失敗しました。少し待ってからもう一度試してください。',
    no_images: '写真を選んでください。',
  }[code] ?? 'うまく読み取れませんでした。手入力で登録してください。';
}

// ---------------------------------------------------------------
// 写真から取り込む（AI）
// ---------------------------------------------------------------
const MAX_PHOTOS = 4;

function renderPhotoImport() {
  app.innerHTML = `
    <header class="bar">
      <a class="icon-btn" href="#/" aria-label="戻る">‹</a>
      <h1>写真から取り込む</h1>
      <span class="icon-btn"></span>
    </header>
    ${offlineBanner()}
    <div class="pad form">
      <p class="hint">料理本のページ、手書きのメモ、SNSのスクショなどを撮影・選択してください。
      2ページにまたがるときは、続けて追加すると1つのレシピにまとめます（最大${MAX_PHOTOS}枚）。</p>
      <div class="imgs" id="picks">
        ${photoPicks.map((p, i) => `<div class="imgbox"><img src="${p.preview}" alt="">
          <span class="kind">${i + 1}枚目</span>
          <button type="button" data-del="${i}" aria-label="外す">×</button></div>`).join('')}
      </div>
      <div class="addrow">
        <label class="btn file">📷 撮影する<input type="file" accept="image/*" capture="environment" hidden id="cam"></label>
        <label class="btn file">🖼 写真を選ぶ<input type="file" accept="image/*" multiple hidden id="lib"></label>
      </div>
      <button type="button" class="btn primary big" id="read" ${photoPicks.length ? '' : 'disabled'}>読み取る</button>
      <p class="hint">読み取りには30秒ほどかかります。写真は「元のレシピの写真」として一緒に保存されます。</p>
    </div>`;

  const add = files => {
    for (const f of files) {
      if (photoPicks.length >= MAX_PHOTOS) { toast(`写真は${MAX_PHOTOS}枚までです`); break; }
      photoPicks.push({ file: f, preview: URL.createObjectURL(f) });
    }
    renderPhotoImport();
  };
  $('#cam').onchange = e => add(e.target.files);
  $('#lib').onchange = e => add(e.target.files);
  $$('[data-del]').forEach(b => b.onclick = () => { photoPicks.splice(+b.dataset.del, 1); renderPhotoImport(); });
  $('#read').onclick = readPhotos;
}

function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1]);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}

async function readPhotos() {
  if (!requireOnline() || !photoPicks.length) return;
  const btn = $('#read');
  btn.disabled = true;
  btn.textContent = '写真を準備中…';
  try {
    const blobs = [];
    for (const p of photoPicks) blobs.push(await resizeImage(p.file));
    const images = await Promise.all(blobs.map(blobToBase64));
    btn.textContent = '読み取り中…（30秒ほどかかります）';
    const { data, error } = await sb.functions.invoke('import-url', { body: { images } });
    if (error) {
      let code = '';
      try { code = (await error.context.json()).error; } catch { /* 読めないときは空 */ }
      toast(importErrorMessage(code, 'この写真'));
      return;
    }
    state.draft = {
      title: data.title,
      servings_base: data.servings || 2,
      source_type: 'photo',
      ingredients: data.ingredientRows ?? [],
      steps: data.steps ?? [],
      newImages: blobs.map(b => ({ kind: 'source', file: b, preview: URL.createObjectURL(b) })),
      fromAi: true,
    };
    photoPicks = [];
    location.hash = '#/new';
  } catch (err) {
    fail(err);
  } finally {
    if (btn.isConnected) {
      btn.disabled = false;
      btn.textContent = '読み取る';
    }
  }
}

// ---------------------------------------------------------------
// 設定
// ---------------------------------------------------------------
function renderSettings() {
  const groups = {};
  for (const s of state.synonyms) (groups[s.group_key] ??= []).push(s);
  const me = state.me;

  app.innerHTML = `
    <header class="bar">
      <a class="icon-btn" href="#/" aria-label="戻る">‹</a>
      <h1>設定</h1>
      <span class="icon-btn"></span>
    </header>
    ${offlineBanner()}
    <div class="pad">
      <section class="box">
        <h2>表示名</h2>
        <form id="nameForm" class="inline">
          <input id="dname" value="${esc(me?.display_name ?? '')}" required>
          <button class="btn">変更</button>
        </form>
        <p class="hint">${esc(state.session.user.email)} でログイン中</p>
      </section>

      <section class="box">
        <h2>ゴミ箱</h2>
        <div id="trashList"><p class="hint">読み込み中…</p></div>
      </section>

      <details class="box">
        <summary>検索用の「同じ意味の言葉」（${Object.keys(groups).length}組）</summary>
        <p class="hint">左の言葉で検索すると、右の言葉を含むレシピも見つかります。</p>
        <form id="synForm" class="inline">
          <input id="synKey" placeholder="検索する言葉（例：豚肉）" required>
          <input id="synWord" placeholder="一緒に見つける言葉（例：豚こま）" required>
          <button class="btn">追加</button>
        </form>
        <ul class="syns">
          ${Object.entries(groups).sort(([a], [b]) => a.localeCompare(b, 'ja')).map(([k, ws]) => `
            <li><b>${esc(k)}</b>：${ws.map(w => `<span class="syn">${esc(w.word)}<button type="button" data-syn="${w.id}" aria-label="削除">×</button></span>`).join('')}</li>`).join('')}
        </ul>
      </details>

      <section class="box">
        <h2>バックアップ</h2>
        <p class="hint">全部のレシピと作った記録をファイルに書き出します。月に1回くらいが目安です。（写真は含みません）</p>
        <button type="button" class="btn" id="export">書き出す（JSON）</button>
      </section>

      <button type="button" class="btn" id="logout">ログアウト</button>
      <p class="hint center">バージョン ${APP_VERSION}</p>
    </div>`;

  $('#nameForm').onsubmit = async ev => {
    ev.preventDefault();
    if (!requireOnline()) return;
    const name = $('#dname').value.trim();
    const { error } = await sb.from('members').update({ display_name: name }).eq('email', me.email);
    if (error) return fail(error);
    await loadAll();
    toast('表示名を変更しました');
  };

  $('#synForm').onsubmit = async ev => {
    ev.preventDefault();
    if (!requireOnline()) return;
    const { error } = await sb.from('synonyms').insert({ group_key: $('#synKey').value.trim(), word: $('#synWord').value.trim() });
    if (error) return fail(error);
    await loadAll();
    renderSettings();
    $('details.box').open = true;
  };
  $$('[data-syn]').forEach(b => b.onclick = async () => {
    if (!requireOnline()) return;
    const { error } = await sb.from('synonyms').delete().eq('id', b.dataset.syn);
    if (error) return fail(error);
    await loadAll();
    renderSettings();
    $('details.box').open = true;
  });

  $('#export').onclick = () => {
    const data = {
      exported_at: new Date().toISOString(),
      recipes: state.recipes,
      cook_logs: state.logs,
      synonyms: state.synonyms,
      members: state.members.map(({ email, display_name, user_id }) => ({ email, display_name, user_id })),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `family-recipes-${todayStr()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  $('#logout').onclick = logout;
  loadTrash();
}

async function loadTrash() {
  const box = $('#trashList');
  if (!navigator.onLine) { box.innerHTML = '<p class="hint">オフラインのため表示できません</p>'; return; }
  const { data, error } = await sb.from('recipes').select('id, title, deleted_at').not('deleted_at', 'is', null).order('deleted_at', { ascending: false });
  if (!box.isConnected) return;
  if (error) { box.innerHTML = '<p class="hint">読み込めませんでした</p>'; return; }
  box.innerHTML = data.length
    ? `<ul class="trash">${data.map(r => `<li><span>${esc(r.title)}</span><button type="button" class="btn" data-restore="${r.id}">戻す</button></li>`).join('')}</ul>`
    : '<p class="hint">ゴミ箱は空です</p>';
  $$('[data-restore]').forEach(b => b.onclick = async () => {
    const { error: e2 } = await sb.from('recipes').update({ deleted_at: null }).eq('id', b.dataset.restore);
    if (e2) return fail(e2);
    await loadAll();
    toast('レシピを戻しました');
    loadTrash();
  });
}

start();
