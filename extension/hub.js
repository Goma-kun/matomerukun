// まとめるくん：自作拡張をひとつの窓で切り替えて使うハブ。
// 各拡張の sidepanel.html を iframe で埋め込む。埋め込めるのは
// 相手側の web_accessible_resources がこの拡張のIDを許可している場合だけ
// （＝自作拡張どうしの連携。他人の拡張は埋め込めない）。

// 埋め込む拡張の一覧。id はChromeウェブストア版のID。
// 開発版などIDが違うものを使うときは設定（⚙）で上書きできる。
const APPS = [
  {
    key: 'mamorukun',
    label: 'まもるくん',
    id: 'pnmjcgdobakecldppfhghdccblaoolla',
    page: 'sidepanel.html',
    // 音声書き起こしにマイクを使う。iframeには allow で明示的に委譲が要る
    allow: 'microphone',
  },
  {
    key: 'osamukun',
    label: 'おさむくん',
    id: 'hhbldkmlimbjbjficjbdpnohallkledi',
    page: 'sidepanel.html',
  },
  {
    key: 'unagasukun',
    label: 'うながすくん',
    id: 'fenmdmkgdollhelglcbheknnheeclabe',
    page: 'sidepanel.html',
  },
];

const hasChromeStorage = typeof chrome !== 'undefined' && !!chrome.storage;

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
const LAST_APP_KEY = 'lastAppKey';

let idOverrides = {};
// タブに表示する拡張のキー一覧。未設定なら全部表示する
let enabledApps = APPS.map((a) => a.key);
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
    <p class="notice-sub">拡張機能がインストールされていないか、<br>
    まとめるくんへの埋め込みに対応した版になっていません。<br>
    最新版に更新されているか確認してください。</p>`;
  notice.querySelector('.notice-main').textContent = `${app.label}を表示できません`;
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
      if (app.allow) iframe.allow = app.allow;
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

  store.set({ [LAST_APP_KEY]: key }).catch(() => {});
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
    if (app.allow) iframe.allow = app.allow;
    iframe.src = appUrl(app);
    iframe.hidden = key !== activeKey;
    framesEl.appendChild(iframe);
    frames.set(key, iframe);
  }
}

function renderTabs() {
  tabBar.textContent = '';
  for (const app of APPS.filter((a) => enabledApps.includes(a.key))) {
    const btn = document.createElement('button');
    btn.className = 'tab';
    btn.dataset.key = app.key;
    btn.textContent = app.label;
    btn.addEventListener('click', () => {
      if (app.key === activeKey) {
        retryIfNotice(app.key);
        return;
      }
      activate(app.key);
    });
    tabBar.appendChild(btn);
  }
}

// ===== 設定（IDの上書き） =====

function renderSettings() {
  settingsFields.textContent = '';
  for (const app of APPS) {
    const field = document.createElement('div');
    field.className = 'field';

    const row = document.createElement('label');
    row.className = 'app-row';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.id = `en-${app.key}`;
    check.checked = enabledApps.includes(app.key);
    const rowText = document.createElement('span');
    rowText.textContent = `${app.label} をタブに表示`;
    row.append(check, rowText);

    const idLabel = document.createElement('label');
    idLabel.className = 'id-label';
    idLabel.textContent = 'ID';
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
  const nextEnabled = APPS.filter((app) => document.getElementById(`en-${app.key}`).checked)
    .map((app) => app.key);
  if (nextEnabled.length === 0) {
    showToast('表示する拡張機能を1つ以上選んでください', true);
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
  showToast('保存しました');
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
    showToast('ウィンドウを開けませんでした', true);
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
    showToast('戻り先のウィンドウが見つかりません', true);
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
    showToast('サイドパネルを開けませんでした', true);
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

// ===== 初期化 =====

async function init() {
  const saved = await store.get([OVERRIDES_KEY, ENABLED_KEY, LAST_APP_KEY]);
  idOverrides = saved[OVERRIDES_KEY] || {};
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

  const last = saved[LAST_APP_KEY];
  const first = enabledApps.includes(last) ? last : enabledApps[0];
  await activate(first);
}

init();
