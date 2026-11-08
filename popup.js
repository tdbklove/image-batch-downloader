const $ = selector => document.querySelector(selector);
const scanButton = $('#scan');
const selectAllButton = $('#selectAll');
const selectNoneButton = $('#selectNone');
const downloadButton = $('#download');
const stitchButton = $('#stitch');
const thumbSizeInput = $('#thumbSize');
const statusEl = $('#status');
const imagesEl = $('#images');
const countEl = $('#count');
const sourceEl = $('#source');
const targetEl = $('#target');
const folderEl = $('#folder');

// 帶 ?tab=<分頁ID> 時是「下載分頁」，掃描指定的分頁；否則是彈窗，掃描目前分頁。
const targetTabId = Number(new URLSearchParams(location.search).get('tab')) || null;
const isPage = targetTabId != null;
document.body.classList.toggle('page', isPage);
document.body.classList.toggle('popup', !isPage);

let scan = null; // { source, title, folder, images, note }
let settings = DEFAULT_SETTINGS; // 掃描時重新讀取
let visible = []; // 目前列出的圖片 { image, index, card, check }
let hoverPos = null; // 滑鼠所在的卡片（visible 的位置），空白鍵開大圖用
let lastClickedPos = null;

let selectionOrder = []; // 勾選的先後順序（visible 的位置），拼接時照這個順序

// 所有勾選狀態的變更都經過這裡，才能記住勾選順序。
function setChecked(pos, checked) {
  visible[pos].check.checked = checked;
  selectionOrder = selectionOrder.filter(p => p !== pos);
  if (checked) selectionOrder.push(pos);
}

const checkedItems = () => selectionOrder.map(pos => visible[pos]);

function isTooSmall(image) {
  const min = Number(settings.minSize) || 0;
  if (!image.width || !image.height) return false;
  return image.width < min || image.height < min;
}

// 單色線條圖示（定義在 popup.html 的 <symbol>）。
function icon(name) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

function updateSelection() {
  const checked = checkedItems().length;
  downloadButton.disabled = checked === 0;
  $('#downloadLabel').textContent = checked ? `下載 ${checked} 張` : '下載';
  stitchButton.disabled = checked < 2;
  $('#stitchLabel').textContent = checked >= 2 ? `拼接 ${checked} 張` : '拼接';
}

// ---- 縮圖大小 ----

const THUMB_KEY = `thumbSize:${isPage ? 'page' : 'popup'}`;
if (isPage) {
  thumbSizeInput.min = 100;
  thumbSizeInput.max = 400;
}
function applyThumbSize(value) {
  thumbSizeInput.value = value;
  imagesEl.style.setProperty('--thumb', `${thumbSizeInput.value}px`);
}
try {
  applyThumbSize(localStorage.getItem(THUMB_KEY) || (isPage ? 180 : 110));
} catch {
  applyThumbSize(isPage ? 180 : 110);
}
thumbSizeInput.addEventListener('input', () => {
  applyThumbSize(thumbSizeInput.value);
  try { localStorage.setItem(THUMB_KEY, thumbSizeInput.value); } catch {}
});

// ---- 清單 ----

function render(existing = new Set()) {
  const shown = scan.images.map((image, index) => ({ image, index })).filter(({ image }) => !isTooSmall(image));
  const hidden = scan.images.length - shown.length;
  const done = shown.filter(({ index }) => existing.has(index)).length;
  const parts = [`${shown.length} 張`];
  if (done) parts.push(`${done} 張已下載`);
  if (hidden) parts.push(`隱藏 ${hidden} 張小圖`);
  countEl.textContent = parts.join('・');

  imagesEl.replaceChildren();
  lastClickedPos = null;
  hoverPos = null;
  visible = shown.map(({ image, index }, pos) => {
    const card = document.createElement('label');
    card.className = 'card';
    card.title = image.url;

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = !existing.has(index); // 已下載過的預設不勾選
    check.addEventListener('click', event => onCheckClick(event, pos));

    const zoom = document.createElement('button');
    zoom.type = 'button';
    zoom.className = 'zoom';
    zoom.title = '看大圖（空白鍵）';
    zoom.setAttribute('aria-label', '看大圖');
    zoom.append(icon('zoom'));
    zoom.addEventListener('click', event => {
      event.preventDefault();
      openLightbox(pos);
    });

    const frame = document.createElement('span');
    frame.className = 'frame';
    const preview = document.createElement('img');
    preview.src = image.preview || image.url;
    preview.alt = '';
    preview.loading = 'lazy';
    preview.referrerPolicy = 'no-referrer';
    preview.addEventListener('load', () => {
      // 一般網頁掃描時延遲載入的圖片沒有尺寸，用預覽圖補上。
      if (!image.width && !image.preview) {
        image.width = preview.naturalWidth;
        image.height = preview.naturalHeight;
        dims.textContent = `${image.width} × ${image.height}`;
      }
    });
    frame.append(preview);

    const dims = document.createElement('span');
    dims.className = 'dims';
    dims.textContent = image.width ? `${image.width} × ${image.height}` : '尺寸未知';

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = image.filename;

    card.append(check, zoom, frame, dims, name);
    if (existing.has(index)) {
      card.classList.add('downloaded');
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.append(icon('check'), '已下載');
      card.append(badge);
    }
    card.addEventListener('mouseenter', () => { hoverPos = pos; });
    card.addEventListener('mouseleave', () => { if (hoverPos === pos) hoverPos = null; });
    imagesEl.append(card);
    return { image, index, card, check };
  });

  selectionOrder = visible.flatMap((item, pos) => (item.check.checked ? [pos] : []));
  const enabled = visible.length > 0;
  selectAllButton.disabled = !enabled;
  selectNoneButton.disabled = !enabled;
  updateSelection();
}

function onCheckClick(event, pos) {
  const checked = event.currentTarget.checked; // 瀏覽器已經切換好了
  if (event.shiftKey && lastClickedPos != null) {
    const step = pos > lastClickedPos ? 1 : -1;
    for (let i = lastClickedPos; i !== pos + step; i += step) setChecked(i, checked);
  } else {
    setChecked(pos, checked);
  }
  lastClickedPos = pos;
  updateSelection();
}

selectAllButton.addEventListener('click', () => {
  // 已勾選的保留原本順序，其餘依清單順序接在後面。
  visible.forEach((item, pos) => { if (!item.check.checked) setChecked(pos, true); });
  updateSelection();
});

selectNoneButton.addEventListener('click', () => {
  visible.forEach((_, pos) => setChecked(pos, false));
  updateSelection();
});

// ---- 大圖檢視 ----

const lightbox = $('#lightbox');
const lbImage = $('#lbImage');
let lightboxPos = null;

function openLightbox(pos) {
  if (!visible[pos]) return;
  lightboxPos = pos;
  lightbox.hidden = false;
  showLightboxImage();
}

function closeLightbox() {
  lightbox.hidden = true;
  lbImage.removeAttribute('src');
  visible[lightboxPos]?.card.scrollIntoView({ block: 'nearest' });
  lightboxPos = null;
}

function showLightboxImage() {
  const { image } = visible[lightboxPos];
  $('#lbIndex').textContent = `${lightboxPos + 1} / ${visible.length}`;
  $('#lbName').textContent = image.filename;
  $('#lbDims').textContent = image.width ? `${image.width} × ${image.height}` : '';
  // 先顯示已載入的預覽圖，原圖載好再換上。
  lbImage.src = image.preview || image.url;
  if (image.preview && image.preview !== image.url) {
    const full = new Image();
    full.referrerPolicy = 'no-referrer';
    full.onload = () => { if (visible[lightboxPos]?.image === image) lbImage.src = image.url; };
    full.src = image.url;
  }
  renderLightboxToggle();
}

function renderLightboxToggle() {
  const checked = visible[lightboxPos].check.checked;
  const button = $('#lbToggle');
  button.replaceChildren(...(checked ? [icon('check'), '已勾選'] : ['勾選這張']));
  button.classList.toggle('primary', checked);
}

function moveLightbox(step) {
  lightboxPos = (lightboxPos + step + visible.length) % visible.length;
  showLightboxImage();
}

function toggleLightboxCheck() {
  setChecked(lightboxPos, !visible[lightboxPos].check.checked);
  renderLightboxToggle();
  updateSelection();
}

$('#lbPrev').addEventListener('click', () => moveLightbox(-1));
$('#lbNext').addEventListener('click', () => moveLightbox(1));
$('#lbClose').addEventListener('click', closeLightbox);
$('#lbToggle').addEventListener('click', toggleLightboxCheck);
lightbox.addEventListener('click', event => {
  if (event.target.classList.contains('lightbox-stage')) closeLightbox();
});

// ---- 操作說明 ----

const helpButton = $('#helpButton');
const helpPanel = $('#helpPanel');

function setHelpOpen(open) {
  helpPanel.hidden = !open;
  helpButton.setAttribute('aria-expanded', String(open));
  if (open) try { localStorage.setItem('helpSeen', '1'); } catch {}
}
helpButton.addEventListener('click', () => setHelpOpen(helpPanel.hidden));
$('#helpClose').addEventListener('click', () => setHelpOpen(false));
document.addEventListener('click', event => {
  if (!helpPanel.hidden && !event.target.closest('.help-wrap')) setHelpOpen(false);
});

// 第一次掃描出圖片時自動打開一次，之後只在點 ? 時顯示。
function showHelpFirstTime() {
  let seen = true;
  try { seen = localStorage.getItem('helpSeen') === '1'; } catch {}
  if (!seen) setHelpOpen(true);
}

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !helpPanel.hidden) {
    setHelpOpen(false);
    return;
  }
  if (!$('#stitchPanel').hidden) return; // 拼接面板有自己的按鍵處理（stitch.js）
  if (!lightbox.hidden) {
    const actions = {
      Escape: closeLightbox,
      ArrowLeft: () => moveLightbox(-1),
      ArrowRight: () => moveLightbox(1),
      ' ': toggleLightboxCheck
    };
    if (actions[event.key]) {
      event.preventDefault();
      actions[event.key]();
    }
    return;
  }
  if (event.key === ' ' && hoverPos != null && event.target.tagName !== 'BUTTON') {
    event.preventDefault();
    openLightbox(hoverPos);
  }
});

// ---- 掃描 ----

async function getTargetTab() {
  if (isPage) return chrome.tabs.get(targetTabId);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// 自選資料夾已經有權限時才查得到哪些檔案存在；沒有權限不跳提示，當作都沒下載過。
async function findDownloaded() {
  let root = null;
  if (settings.mode === 'custom') {
    const handle = await getDirectoryHandle().catch(() => null);
    if (handle && (await handle.queryPermission({ mode: 'readwrite' })) === 'granted') root = handle;
  }
  const paths = scan.images.map((image, index) => buildPathParts({ settings, folder: scan.folder, image, index }));
  const existing = await findExistingFiles(paths, settings, root);
  return new Set(paths.flatMap((parts, index) => (existing.has(parts.join('/')) ? [index] : [])));
}

async function runScan() {
  scanButton.disabled = true;
  statusEl.textContent = '正在掃描…';
  imagesEl.replaceChildren();
  try {
    settings = await loadSettings();
    const tab = await getTargetTab();
    if (!tab?.id) throw new Error('無法取得目前分頁。');
    if (isPage) {
      targetEl.textContent = tab.title || tab.url;
      targetEl.title = tab.url;
      document.title = `圖片：${tab.title || tab.url}`;
    }
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: options => globalThis.__imageBatchScan(options),
      args: [{ scroll: settings.autoScroll }]
    });
    scan = result;
    // 先替防盜鏈網域加上 Referer 規則，預覽縮圖才載得出來。
    await chrome.runtime.sendMessage({ type: 'ENSURE_REFERERS', images: scan.images });
    sourceEl.textContent = scan.source;
    sourceEl.hidden = false;
    renderLocation();
    render(await findDownloaded().catch(() => new Set()));
    const tips = [scan.note];
    if (!scan.images.length) {
      tips.push(settings.autoScroll
        ? '沒有找到可下載圖片。'
        : '沒有找到可下載圖片。如果圖片要捲動才會出現，可以在設定開啟「自動捲動載入」。');
    }
    statusEl.textContent = tips.filter(Boolean).join(' ');
    $('#scanLabel').textContent = '重新掃描';
    if (scan.images.length) showHelpFirstTime();
  } catch (error) {
    console.error(error);
    scan = null;
    countEl.textContent = '掃描失敗';
    const reason = isPage && /No tab with id/.test(error.message) ? '原本的分頁已經關閉' : (error.message || error);
    statusEl.textContent = `掃描失敗：${reason}。瀏覽器內部頁面（chrome://、線上應用程式商店）無法掃描。`;
  } finally {
    scanButton.disabled = false;
  }
}

scanButton.addEventListener('click', runScan);

$('#openTab').addEventListener('click', async () => {
  const tab = await getTargetTab();
  if (!tab?.id) return;
  await chrome.tabs.create({ url: `popup.html?tab=${tab.id}`, index: tab.index + 1, openerTabId: tab.id });
  window.close();
});

chrome.runtime.onMessage.addListener(message => {
  if (message.type !== 'DOWNLOAD_PROGRESS') return;
  statusEl.textContent = `下載中 ${message.done} / ${message.total}` + (message.failed ? `（失敗 ${message.failed}）` : '');
});

// ---- 存放位置 ----

$('#settings').addEventListener('click', () => chrome.runtime.openOptionsPage());

async function renderLocation() {
  settings = await loadSettings();
  const custom = settings.mode === 'custom';
  let root = ['下載', ...splitFolder(settings.subfolder)].join('/');
  if (custom) root = (await getDirectoryHandle().catch(() => null))?.name || '（尚未選擇資料夾）';
  const parts = settings.organize && scan ? [root, ...splitFolder(scan.folder)] : [root];
  folderEl.textContent = `${parts.join('/')}/`;
  const location = $('#location');
  location.classList.toggle('no-open', custom);
  location.title = custom
    ? `存到自選資料夾 ${folderEl.textContent}\n（瀏覽器不允許擴充功能開啟自選資料夾，請在檔案總管中前往）`
    : `存到 ${folderEl.textContent}\n點一下在檔案總管中開啟`;
}

// 在下載紀錄裡找一個存在 parts 所在資料夾的檔案：優先同檔名，否則同資料夾中最新的
//（另存新檔時檔名會變成 name (1).ext）。
async function findDownloadIn(parts) {
  const items = await chrome.downloads.search({ exists: true, state: 'complete', orderBy: ['-startTime'], limit: 0 });
  const normalize = path => path.replace(/\\/g, '/').toLowerCase();
  const file = `/${parts.join('/').toLowerCase()}`;
  const dir = `/${parts.slice(0, -1).join('/').toLowerCase()}/`;
  const exact = items.find(item => normalize(item.filename).endsWith(file));
  if (exact) return exact.id;
  const sameDir = items.find(item => {
    const path = normalize(item.filename);
    return path.slice(0, path.lastIndexOf('/') + 1).endsWith(dir);
  });
  return sameDir?.id ?? null;
}

// 左下角的存放位置：開啟這次掃描的作品資料夾（chrome.downloads.show 會開檔案總管並選取檔案）。
// 只能開「下載紀錄裡有檔案」的資料夾；還沒下載過就開下載資料夾本身。
$('#location').addEventListener('click', async () => {
  settings = await loadSettings();
  if (settings.mode === 'custom') {
    statusEl.textContent = `瀏覽器不允許擴充功能開啟自選資料夾，請在檔案總管中前往 ${folderEl.textContent}`;
    return;
  }
  const parts = buildPathParts({ settings, folder: scan?.folder ?? '', image: { filename: '_' }, index: 0 });
  const id = await findDownloadIn(parts).catch(() => null);
  if (id != null) {
    chrome.downloads.show(id);
  } else {
    chrome.downloads.showDefaultFolder();
    statusEl.textContent = '這個資料夾還沒有下載過的檔案，已開啟下載資料夾。';
  }
});

// 拼接輸出後，在 container 後面加「開啟資料夾」；自選資料夾改顯示完整的相對路徑。
async function appendOpenFolder(container, parts) {
  container.querySelector('.open-folder')?.remove();
  if (settings.mode === 'custom') {
    const root = await getDirectoryHandle().catch(() => null);
    const path = document.createElement('span');
    path.className = 'open-folder saved-path';
    path.textContent = `位置：${[root?.name, ...parts.slice(0, -1)].filter(Boolean).join('/')}/`;
    container.append(' ', path);
    return;
  }
  const id = await findDownloadIn(parts).catch(() => null);
  if (id == null) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'open-folder';
  button.title = '在檔案總管中開啟並選取檔案';
  button.append(icon('folder'), '開啟資料夾');
  button.addEventListener('click', () => chrome.downloads.show(id));
  container.append(' ', button);
}

// 自選資料夾模式：取得寫入權限（按鈕點擊的使用者手勢內才能跳出允許提示）。
async function getWritableRoot() {
  const root = await getDirectoryHandle();
  if (!root) throw new Error('尚未選擇資料夾，請點左下角的存放位置進行設定');
  const options = { mode: 'readwrite' };
  if ((await root.queryPermission(options)) === 'granted') return root;
  if ((await root.requestPermission(options)) === 'granted') return root;
  throw new Error('沒有資料夾的寫入權限，請點左下角的存放位置重新允許');
}

// 回傳 'written' 或 'skipped'。
async function writeFile(root, parts, blob, onExisting = settings.onExisting) {
  let dir = root;
  for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
  const name = parts.at(-1);
  let candidate = name;
  if (onExisting !== 'overwrite') {
    const dot = name.lastIndexOf('.');
    const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    for (let n = 1; ; n++) {
      try {
        await dir.getFileHandle(candidate);
      } catch (error) {
        if (error.name === 'NotFoundError') break;
        throw error;
      }
      if (onExisting === 'skip') return 'skipped';
      // 另存為「name (1).ext」，和瀏覽器下載的行為一致。
      candidate = `${base} (${n})${ext}`;
    }
  }
  const file = await dir.getFileHandle(candidate, { create: true });
  const writable = await file.createWritable();
  await writable.write(blob);
  await writable.close();
  return 'written';
}

async function saveToCustomFolder(root, items) {
  const total = items.length;
  let done = 0;
  let skipped = 0;
  const failures = [];
  const keepOpen = isPage ? '，請保持此分頁開啟' : '，請保持此視窗開啟';
  const queue = [...items];
  const worker = async () => {
    while (queue.length) {
      const { image, index } = queue.shift();
      try {
        const parts = buildPathParts({ settings, folder: scan.folder, image, index });
        // 跳過模式先檢查，省得下載已存在的檔案。
        if (settings.onExisting === 'skip' && (await fileExists(root, parts))) {
          skipped++;
        } else {
          const response = await fetch(image.url, { credentials: 'include' });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          if ((await writeFile(root, parts, await response.blob())) === 'skipped') skipped++;
        }
      } catch (error) {
        console.warn('Image save failed', image.url, error);
        failures.push({ url: image.url, reason: String(error.message || error) });
      }
      done++;
      statusEl.textContent = `寫入中 ${done} / ${total}` + (failures.length ? `（失敗 ${failures.length}）` : '') + keepOpen;
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, total) }, worker));
  return { total, succeeded: total - skipped - failures.length, skipped, failures };
}

// ---- 下載 ----

downloadButton.addEventListener('click', async () => {
  const selected = checkedItems();
  if (!selected.length) return;
  downloadButton.disabled = true;
  settings = await loadSettings();
  let result;
  if (settings.mode === 'custom') {
    statusEl.textContent = `開始寫入 ${selected.length} 張…`;
    try {
      // 先要權限：允許提示只能在點擊後短時間內跳出。
      const root = await getWritableRoot();
      await chrome.runtime.sendMessage({ type: 'ENSURE_REFERERS', images: selected.map(item => item.image) });
      result = await saveToCustomFolder(root, selected);
    } catch (error) {
      statusEl.textContent = error.message;
      updateSelection();
      return;
    }
  } else {
    statusEl.textContent = `開始下載 ${selected.length} 張…` + (isPage ? '' : '（可以關閉這個視窗，下載會繼續）');
    result = await chrome.runtime.sendMessage({
      type: 'DOWNLOAD_IMAGES',
      images: selected.map(item => item.image),
      folder: scan.folder
    });
  }
  if (!result) {
    statusEl.textContent = '下載狀態未知，請到 chrome://downloads 查看。';
  } else {
    const parts = [`完成 ${result.succeeded} 張`];
    if (result.skipped) parts.push(`跳過 ${result.skipped} 張已存在的檔案`);
    if (result.failures.length) {
      parts.push(`失敗 ${result.failures.length} 張（${result.failures[0].reason}）`);
      console.warn('Failed downloads', result.failures);
    }
    // 重新標示已下載的圖片。
    render(await findDownloaded().catch(() => new Set()));
    if (settings.mode !== 'custom' && (result.succeeded || result.skipped)) parts.push('點下方的存放位置可開啟資料夾');
    statusEl.textContent = `${parts.join('，')}。`;
  }
  updateSelection();
});

renderLocation();
if (isPage) runScan();
