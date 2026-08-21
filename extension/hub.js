// まとめるくん：自作拡張をひとつの窓で切り替えて使うハブ。
// 各拡張の sidepanel.html を iframe で埋め込む。埋め込めるのは
// 相手側の web_accessible_resources がこの拡張のIDを許可している場合だけ
// （＝自作拡張どうしの連携。他人の拡張は埋め込めない）。

// 埋め込む拡張の一覧。id はChromeウェブストア版のID。
// 開発版などIDが違うものを使うときは設定（⚙）で上書きできる。
// クリップボードへの書き込みは Permissions Policy の既定が self のため、
// 別オリジン（＝別拡張）の iframe には allow で委譲しないと
// navigator.clipboard.writeText がすべて拒否される。各拡張ともコピー機能を持つので共通で付ける。
const BASE_ALLOW = 'clipboard-write';

const APPS = [
  {
    key: 'mamorukun',
    labelKey: 'appMamorukun',
    id: 'pnmjcgdobakecldppfhghdccblaoolla',
    page: 'sidepanel.html',
    // 音声書き起こしにマイクを使う。iframeには allow で明示的に委譲が要る
    allow: 'microphone',
  },
  {
    key: 'osamukun',
    labelKey: 'appOsamukun',
    id: 'hhbldkmlimbjbjficjbdpnohallkledi',
    page: 'sidepanel.html',
  },
  {
    key: 'unagasukun',
    labelKey: 'appUnagasukun',
    id: 'fenmdmkgdollhelglcbheknnheeclabe',
    page: 'sidepanel.html',
  },
  {
    key: 'hitorigoto',
    labelKey: 'appHitorigoto',
    id: 'aleiapbacffelpgabepjjmnbfclcodpm',
    page: 'sidepanel.html',
    // 英語の独り言を音声認識で聞き取るため、まもるくんと同じくマイクの委譲が要る
    allow: 'microphone',
  },
];

// 起動時に開くタブ。以前は最後に使ったタブを記憶していたが、
// 「開くたびに違う画面になる」ほうが迷うため、まもるくん固定にした（2026-08-21 本人指示）
const DEFAULT_APP_KEY = 'mamorukun';

const hasChromeStorage = typeof chrome !== 'undefined' && !!chrome.storage;
const hasChromeI18n = typeof chrome !== 'undefined' && !!chrome.i18n;

// ---- i18n（うながすくん・おさむくんと同じ型）----

let previewMessages = null; // プレビュー用（?lang=ja / ?lang=en で切替）

function T(key, subs) {
  const arr = subs == null ? [] : Array.isArray(subs) ? subs : [subs];
  if (hasChromeI18n) {
    return chrome.i18n.getMessage(key, arr.map(String)) || key;
  }
  const m = previewMessages && previewMessages[key];
  if (!m) return key;
  let out = m.message;
  if (m.placeholders) {
    for (const [name, def] of Object.entries(m.placeholders)) {
      const idx = parseInt(String(def.content).replace('$', ''), 10) - 1;
      out = out.replaceAll('$' + name.toUpperCase() + '$', String(arr[idx] ?? ''));
    }
  }
  return out;
}

async function loadPreviewMessages() {
  if (hasChromeI18n) return;
  const lang = new URLSearchParams(location.search).get('lang') || 'ja';
  try {
    previewMessages = await (await fetch(`_locales/${lang}/messages.json`)).json();
  } catch {
    previewMessages = null;
  }
}

function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = T(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.title = T(el.dataset.i18nTitle);
  });
  document.querySelectorAll('[data-i18n-aria]').forEach((el) => {
    el.setAttribute('aria-label', T(el.dataset.i18nAria));
  });
}

function appLabel(app) {
  return T(app.labelKey);
}

// ブラウザプレビュー（chrome.* が無い環境）でもUIを確認できるようにするフォールバック
const store = {
  async get(keys) {
    if (hasChromeStorage) return chrome.storage.local.get(keys);
    const out = {};
    for (const k of Array.isArray(keys) ? keys : [keys]) {
      const raw = localStorage.getItem(k);
      if (raw != null) out[k] = JSON.parse(raw);
    }
    return out;
  },
  async set(obj) {
    if (hasChromeStorage) return chrome.storage.local.set(obj);
    for (const [k, v] of Object.entries(obj)) localStorage.setItem(k, JSON.stringify(v));
  },
  async remove(keys) {
    if (hasChromeStorage) return chrome.storage.local.remove(keys);
    for (const k of Array.isArray(keys) ? keys : [keys]) localStorage.removeItem(k);
  },
};

const OVERRIDES_KEY = 'idOverrides';
const ENABLED_KEY = 'enabledApps';
const ORDER_KEY = 'appOrder';

let idOverrides = {};
// タブに表示する拡張のキー一覧。未設定なら全部表示する
let enabledApps = APPS.map((a) => a.key);
// タブの並び順（ドラッグで入れ替えられる）。未設定なら APPS の定義順
let appOrder = APPS.map((a) => a.key);

// 保存された並び順を安全な形に直す：知らないキーは捨て、足りないキーは定義順で後ろに足す
function sanitizeOrder(saved) {
  const known = Array.isArray(saved) ? saved.filter((k) => APPS.some((a) => a.key === k)) : [];
  const missing = APPS.map((a) => a.key).filter((k) => !known.includes(k));
  return [...known, ...missing];
}

// APPS を並び順どおりに返す。タブ・設定の表示はこちらを使う
function orderedApps() {
  return [...APPS].sort((a, b) => appOrder.indexOf(a.key) - appOrder.indexOf(b.key));
}
const frames = new Map(); // key -> iframe（一度作ったら切替では消さない。録音などを止めないため）
let activeKey = null;

const tabBar = document.getElementById('tabBar');
const framesEl = document.getElementById('frames');
const settingsView = document.getElementById('settingsView');
const settingsFields = document.getElementById('settingsFields');
const toastEl = document.getElementById('toast');

let toastTimer = null;
function showToast(msg, isError = false) {
  toastEl.textContent = msg;
  toastEl.classList.toggle('error', isError);
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2500);
}

function resolveId(app) {
  const o = idOverrides[app.key];
  return (typeof o === 'string' && o.trim()) ? o.trim() : app.id;
}

function appUrl(app) {
  return `chrome-extension://${resolveId(app)}/${app.page}`;
}

// iframe に委譲する権限。app.allow（マイクなど個別のもの）に共通分を足す
function frameAllow(app) {
  return [app.allow, BASE_ALLOW].filter(Boolean).join('; ');
}

// 相手の拡張が入っていて、こちらへの埋め込みを許可しているかを確かめる。
// 許可が無い・未インストールだと fetch 自体が失敗する
async function isAvailable(app) {
  try {
    const res = await fetch(appUrl(app), { method: 'GET' });
    return res.ok;
  } catch {
    return false;
  }
}

function showNotice(app) {
  const notice = document.createElement('div');
  notice.className = 'frame-notice';
  notice.dataset.key = app.key;
  notice.innerHTML = `
    <p class="notice-main"></p>
    <p class="notice-sub"></p>`;
  notice.querySelector('.notice-main').textContent = T('noticeMain', appLabel(app));
  notice.querySelector('.notice-sub').textContent = T('noticeSub');
  framesEl.appendChild(notice);
  return notice;
}

async function activate(key) {
  const app = APPS.find((a) => a.key === key);
  if (!app || !enabledApps.includes(key)) return;
  activeKey = key;

  for (const btn of tabBar.querySelectorAll('.tab')) {
    btn.classList.toggle('active', btn.dataset.key === key);
  }
  // 既存のフレーム・案内は隠すだけ（破棄しない）
  for (const el of framesEl.children) {
    el.hidden = el.dataset.key !== key;
  }

  if (!frames.has(key)) {
    const existingNotice = framesEl.querySelector(`.frame-notice[data-key="${key}"]`);
    if (existingNotice) existingNotice.remove();
    if (await isAvailable(app)) {
      const iframe = document.createElement('iframe');
      iframe.dataset.key = key;
      iframe.allow = frameAllow(app);
      iframe.src = appUrl(app);
      framesEl.appendChild(iframe);
      frames.set(key, iframe);
    } else {
      showNotice(app);
    }
    // 作っている間にタブが切り替わっていたら隠す
    for (const el of framesEl.children) {
      el.hidden = el.dataset.key !== activeKey;
    }
  }
}

// 案内が出ている拡張は、タブを押し直したら再確認する（あとから拡張を入れた場合のため）
async function retryIfNotice(key) {
  const notice = framesEl.querySelector(`.frame-notice[data-key="${key}"]`);
  if (!notice || frames.has(key)) return;
  const app = APPS.find((a) => a.key === key);
  if (await isAvailable(app)) {
    notice.remove();
    const iframe = document.createElement('iframe');
    iframe.dataset.key = key;
    iframe.allow = frameAllow(app);
    iframe.src = appUrl(app);
    iframe.hidden = key !== activeKey;
    framesEl.appendChild(iframe);
    frames.set(key, iframe);
  }
}

function renderTabs() {
  tabBar.textContent = '';
  for (const app of orderedApps().filter((a) => enabledApps.includes(a.key))) {
    const btn = document.createElement('button');
    btn.className = 'tab';
    btn.dataset.key = app.key;
    btn.textContent = appLabel(app);
    btn.addEventListener('click', () => {
      if (suppressNextTabClick) {
        suppressNextTabClick = false;
        return;
      }
      if (app.key === activeKey) {
        retryIfNotice(app.key);
        return;
      }
      activate(app.key);
    });
    // ドラッグで並べ替えられるようにする。
    // HTML5のドラッグは半透明のゴーストが画面のどこへでも動いてしまうため使わず、
    // ポインタ追従でタブ本体をバーの中だけで横にスライドさせる
    btn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      tabDrag = { btn, startX: e.clientX, moved: false };
      try { btn.setPointerCapture(e.pointerId); } catch { /* 合成イベントでは失敗してよい */ }
    });
    btn.addEventListener('pointermove', onTabPointerMove);
    btn.addEventListener('pointerup', onTabPointerUp);
    btn.addEventListener('pointercancel', onTabPointerUp);
    tabBar.appendChild(btn);
  }
}

// タブのドラッグ状態。ドラッグ直後の click を誤ってタブ切り替えにしないためのフラグも持つ
let tabDrag = null;
let suppressNextTabClick = false;

function onTabPointerMove(e) {
  const d = tabDrag;
  if (!d || d.btn !== e.currentTarget) return;
  if (!d.moved && Math.abs(e.clientX - d.startX) < 5) return;   // 5px未満はクリック扱い
  d.moved = true;
  d.btn.classList.add('dragging');

  // 自分の中心が隣の中心を越えたら、DOMごと入れ替える。
  // 入れ替えると offsetLeft が隣の幅ぶん変わるので、startX を同じだけ補正して続きを滑らかにする
  let guard = 4;
  while (guard--) {
    const dx = e.clientX - d.startX;
    const center = d.btn.offsetLeft + d.btn.offsetWidth / 2 + dx;
    const prev = d.btn.previousElementSibling;
    const next = d.btn.nextElementSibling;
    if (next && center > next.offsetLeft + next.offsetWidth / 2) {
      tabBar.insertBefore(next, d.btn);
      d.startX += next.offsetWidth;
    } else if (prev && center < prev.offsetLeft + prev.offsetWidth / 2) {
      tabBar.insertBefore(d.btn, prev);
      d.startX -= prev.offsetWidth;
    } else {
      break;
    }
  }

  // バーの外へは出さない（横方向にだけ、端まででクランプ）
  const minDx = -d.btn.offsetLeft;
  const maxDx = tabBar.clientWidth - d.btn.offsetLeft - d.btn.offsetWidth;
  const dx = Math.max(minDx, Math.min(maxDx, e.clientX - d.startX));
  d.btn.style.transform = `translateX(${dx}px)`;
}

function onTabPointerUp(e) {
  const d = tabDrag;
  if (!d || d.btn !== e.currentTarget) return;
  tabDrag = null;
  d.btn.style.transform = '';
  d.btn.classList.remove('dragging');
  if (d.moved) {
    suppressNextTabClick = true;   // このあと飛んでくる click はドラッグの締めなので無視する
    persistTabOrder();
  }
}

// 並べ替えた結果を保存する。タブに出していない拡張は相対順そのままで後ろに置く
async function persistTabOrder() {
  const domOrder = [...tabBar.querySelectorAll('.tab')].map((b) => b.dataset.key);
  const rest = appOrder.filter((k) => !domOrder.includes(k));
  appOrder = [...domOrder, ...rest];
  await store.set({ [ORDER_KEY]: appOrder }).catch(() => {});
  renderSettings();
}

// ===== 設定（IDの上書き） =====

function renderSettings() {
  settingsFields.textContent = '';
  for (const app of orderedApps()) {
    const field = document.createElement('div');
    field.className = 'field';

    const row = document.createElement('label');
    row.className = 'app-row';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.id = `en-${app.key}`;
    check.checked = enabledApps.includes(app.key);
    const rowText = document.createElement('span');
    rowText.textContent = T('showEnabledRow', appLabel(app));
    row.append(check, rowText);

    const idLabel = document.createElement('label');
    idLabel.className = 'id-label';
    idLabel.textContent = T('idLabel');
    idLabel.setAttribute('for', `id-${app.key}`);
    const input = document.createElement('input');
    input.type = 'text';
    input.id = `id-${app.key}`;
    input.placeholder = app.id;
    input.value = idOverrides[app.key] || '';
    input.autocomplete = 'off';
    input.spellcheck = false;

    field.append(row, idLabel, input);
    settingsFields.appendChild(field);
  }
}

async function saveSettings() {
  const nextEnabled = orderedApps().filter((app) => document.getElementById(`en-${app.key}`).checked)
    .map((app) => app.key);
  if (nextEnabled.length === 0) {
    showToast(T('toastPickOne'), true);
    return;
  }
  const next = {};
  for (const app of APPS) {
    const v = document.getElementById(`id-${app.key}`).value.trim();
    if (v && v !== app.id) next[app.key] = v;
  }
  idOverrides = next;
  enabledApps = nextEnabled;
  await store.set({ [OVERRIDES_KEY]: next, [ENABLED_KEY]: nextEnabled });
  // 表示対象やIDが変わったら作り直す（次にタブを開いたときに新しい構成で読み込む）
  for (const [key, iframe] of frames) {
    iframe.remove();
    frames.delete(key);
  }
  for (const el of [...framesEl.children]) el.remove();
  renderTabs();
  settingsView.hidden = true;
  showToast(T('toastSaved'));
  const target = enabledApps.includes(activeKey) ? activeKey : enabledApps[0];
  activate(target);
}

// ===== 別ウィンドウ表示（おさむくん v1.2〜1.3 の実装を移植） =====
// サイドパネルはChromeの仕様で枠から切り離せないため、独立したウィンドウで開く手段を用意する。
// chrome.windows は権限宣言なしで使えるので、権限は sidePanel / storage のまま増えない。
const WINDOW_WIDTH = 430;
const WINDOW_HEIGHT = 720;
const POPUP_ID_KEY = 'hubPopupWindowId';
const ORIGIN_ID_KEY = 'hubPopupOriginWindowId';
const isPopupWindow = new URLSearchParams(location.search).get('view') === 'window';
const canOpenWindow = typeof chrome !== 'undefined' && !!chrome.windows && !!chrome.runtime;

async function getOwnWindow() {
  try {
    return await chrome.windows.getCurrent();
  } catch {
    try {
      return await chrome.windows.getLastFocused();
    } catch {
      return null;
    }
  }
}

async function ensureWindow() {
  try {
    const saved = await chrome.storage.local.get(POPUP_ID_KEY);
    const id = saved[POPUP_ID_KEY];
    if (id != null) {
      await chrome.windows.update(id, { focused: true, drawAttention: true });
      return true;
    }
  } catch {
    // 閉じられているとIDが無効になる。そのまま新規作成に進む
  }

  const options = {
    url: chrome.runtime.getURL('hub.html') + '?view=window',
    type: 'popup',
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
  };
  const base = await getOwnWindow();
  if (base && typeof base.left === 'number' && typeof base.width === 'number') {
    options.left = Math.max(0, base.left + base.width - WINDOW_WIDTH - 20);
    options.top = Math.max(0, (base.top || 0) + 20);
  }

  try {
    const created = await chrome.windows.create(options);
    // 閉じる前にIDを確実に保存する（保存前にパネルを閉じると次回の再利用ができなくなる）
    const toSave = { [POPUP_ID_KEY]: created.id };
    if (base && base.type === 'normal') toSave[ORIGIN_ID_KEY] = base.id;
    await chrome.storage.local.set(toSave);
    return true;
  } catch {
    showToast(T('toastWindowFailed'), true);
    return false;
  }
}

async function findSidePanelTarget() {
  try {
    const saved = await chrome.storage.local.get(ORIGIN_ID_KEY);
    const originId = saved[ORIGIN_ID_KEY];
    if (originId != null) {
      const origin = await chrome.windows.get(originId);
      if (origin && origin.type === 'normal') return origin;
    }
  } catch {
    // 元のウィンドウが閉じられている。下のフォールバックへ
  }
  try {
    const normals = (await chrome.windows.getAll()).filter((w) => w.type === 'normal');
    return normals.find((w) => w.focused) || normals[0] || null;
  } catch {
    return null;
  }
}

async function openInWindow() {
  // 同じものが2つ並ぶと分かりにくいので、別ウィンドウを開けたらサイドパネル側は閉じる
  if (await ensureWindow()) window.close();
}

// 順序が重要：記憶しているウィンドウIDを消してから chrome.sidePanel.open() を呼ぶ。
// IDが残ったままだと、開いたサイドパネルが「別ウィンドウが生きている」と判断して即座に閉じる
async function returnToSidePanel() {
  const target = await findSidePanelTarget();
  const self = await getOwnWindow();
  if (!target) {
    showToast(T('toastNoBrowserWindow'), true);
    return;
  }
  try {
    await chrome.storage.local.remove([POPUP_ID_KEY, ORIGIN_ID_KEY]);
  } catch {
    // 消せなくても続行する
  }
  try {
    await chrome.sidePanel.open({ windowId: target.id });
  } catch {
    if (self) {
      try {
        await chrome.storage.local.set({ [POPUP_ID_KEY]: self.id, [ORIGIN_ID_KEY]: target.id });
      } catch {
        // 戻せない場合は二重表示になりうるが、実害は表示だけ
      }
    }
    showToast(T('toastSidePanelFailed'), true);
    return;
  }
  try {
    await chrome.windows.update(target.id, { focused: true });
  } catch {
    // 前面化に失敗しても閉じてよい
  }
  window.close();
}

// サイドパネルとして開かれたとき、すでに別ウィンドウが生きていればそちらへ寄せる
async function handOverToExistingWindow() {
  if (isPopupWindow || !canOpenWindow) return false;
  let id;
  try {
    const saved = await chrome.storage.local.get(POPUP_ID_KEY);
    id = saved[POPUP_ID_KEY];
  } catch {
    return false;
  }
  if (id == null) return false;
  try {
    await chrome.windows.update(id, { focused: true, drawAttention: true });
    window.close();
    return true;
  } catch {
    // ウィンドウが閉じられていた。IDを掃除して普通に表示する
    try {
      await chrome.storage.local.remove([POPUP_ID_KEY, ORIGIN_ID_KEY]);
    } catch { /* 無視 */ }
    return false;
  }
}

// サイドパネルとして開かれたとき、別のウィンドウで既にサイドパネルが開いていればそちらへ寄せる。
// アイコンをクリックするたびにウィンドウごとへ増えていくのを防ぐ（まもるくんと同じ「既存を前面に」の挙動）。
// 同じウィンドウで開き直したときは寄せない（それは普通の開閉なので）
async function handOverToExistingSidePanel() {
  if (isPopupWindow || !canOpenWindow) return false;
  if (typeof chrome.runtime.getContexts !== 'function') return false; // Chrome 116未満
  try {
    const self = await getOwnWindow();
    if (!self) return false;
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] });
    const other = contexts.find((c) => c.windowId != null && c.windowId !== self.id);
    if (!other) return false;
    await chrome.windows.update(other.windowId, { focused: true, drawAttention: true });
    window.close();
    return true;
  } catch {
    // 判定に失敗したら普通に表示する（二重表示になっても実害は表示だけ）
    return false;
  }
}

// ===== 初期化 =====

async function init() {
  await loadPreviewMessages();
  applyI18n();

  // バージョンバッジはmanifestから入れる（手書きだと更新漏れでズレる）
  try {
    document.getElementById('versionBadge').textContent =
      'v' + chrome.runtime.getManifest().version;
  } catch {
    // プレビュー（chrome.* なし）ではバッジを空のままにする
  }

  const saved = await store.get([OVERRIDES_KEY, ENABLED_KEY, ORDER_KEY]);
  idOverrides = saved[OVERRIDES_KEY] || {};
  appOrder = sanitizeOrder(saved[ORDER_KEY]);
  // 以前の「最後に使ったタブ」の記憶は使わなくなったので掃除しておく
  store.remove('lastAppKey').catch(() => {});
  const savedEnabled = Array.isArray(saved[ENABLED_KEY])
    ? saved[ENABLED_KEY].filter((k) => APPS.some((a) => a.key === k))
    : null;
  if (savedEnabled && savedEnabled.length > 0) enabledApps = savedEnabled;

  renderTabs();
  renderSettings();

  document.getElementById('btnSettings').addEventListener('click', () => {
    settingsView.hidden = !settingsView.hidden;
    if (!settingsView.hidden) renderSettings();
  });
  document.getElementById('btnSettingsClose').addEventListener('click', () => {
    settingsView.hidden = true;
  });
  document.getElementById('btnSettingsSave').addEventListener('click', saveSettings);

  const btnPopout = document.getElementById('btnPopout');
  const btnDock = document.getElementById('btnDock');
  if (canOpenWindow && !isPopupWindow) {
    btnPopout.hidden = false;
    btnPopout.addEventListener('click', openInWindow);
  }
  if (canOpenWindow && isPopupWindow && chrome.sidePanel && chrome.sidePanel.open) {
    btnDock.hidden = false;
    btnDock.addEventListener('click', returnToSidePanel);
  }

  if (canOpenWindow && await handOverToExistingWindow()) return;
  if (await handOverToExistingSidePanel()) return;

  const orderedEnabled = orderedApps().map((a) => a.key).filter((k) => enabledApps.includes(k));
  const first = enabledApps.includes(DEFAULT_APP_KEY) ? DEFAULT_APP_KEY : orderedEnabled[0];
  await activate(first);
}

init();
