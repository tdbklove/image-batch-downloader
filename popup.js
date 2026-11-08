const $ = selector => document.querySelector(selector);
const scanButton = $('#scan');
const selectAllButton = $('#selectAll');
const selectNoneButton = $('#selectNone');
const downloadButton = $('#download');
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

const checkedItems = () => visible.filter(item => item.check.checked);

function isTooSmall(image) {
  const min = Number(settings.minSize) || 0;
  if (!image.width || !image.height) return false;
  return image.width < min || image.height < min;
}

function updateSelection() {
  const checked = checkedItems().length;
  downloadButton.disabled = checked === 0;
  downloadButton.textContent = `下載勾選項目 (${checked})`;
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
    zoom.textContent = '🔍';
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
      badge.textContent = '已下載';
      card.append(badge);
    }
    card.addEventListener('mouseenter', () => { hoverPos = pos; });
    card.addEventListener('mouseleave', () => { if (hoverPos === pos) hoverPos = null; });
    imagesEl.append(card);
    return { image, index, card, check };
  });

  const enabled = visible.length > 0;
  selectAllButton.disabled = !enabled;
  selectNoneButton.disabled = !enabled;
  updateSelection();
}

function onCheckClick(event, pos) {
  if (event.shiftKey && lastClickedPos != null) {
    const [from, to] = [Math.min(lastClickedPos, pos), Math.max(lastClickedPos, pos)];
    for (let i = from; i <= to; i++) visible[i].check.checked = event.currentTarget.checked;
  }
  lastClickedPos = pos;
  updateSelection();
}

selectAllButton.addEventListener('click', () => {
  visible.forEach(item => { item.check.checked = true; });
  updateSelection();
});

selectNoneButton.addEventListener('click', () => {
  visible.forEach(item => { item.check.checked = false; });
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
  button.textContent = checked ? '✓ 已勾選' : '勾選這張';
  button.classList.toggle('primary', checked);
}

function moveLightbox(step) {
  lightboxPos = (lightboxPos + step + visible.length) % visible.length;
  showLightboxImage();
}

function toggleLightboxCheck() {
  const { check } = visible[lightboxPos];
  check.checked = !check.checked;
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

document.addEventListener('keydown', event => {
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
    sourceEl.textContent = `來源：${scan.source}`;
    renderLocation();
    render(await findDownloaded().catch(() => new Set()));
    const tips = [scan.note];
    if (!scan.images.length) {
      tips.push(settings.autoScroll
        ? '沒有找到可下載圖片。'
        : '沒有找到可下載圖片。如果圖片要捲動才會出現，可以在設定開啟「自動捲動載入」。');
    } else {
      tips.push('勾選圖片後開始下載。');
    }
    statusEl.textContent = tips.filter(Boolean).join(' ');
    if (isPage) scanButton.textContent = '重新掃描';
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
  let root = ['下載', ...splitFolder(settings.subfolder)].join('/');
  if (settings.mode === 'custom') root = (await getDirectoryHandle().catch(() => null))?.name || '（尚未選擇資料夾）';
  const parts = settings.organize && scan ? [root, ...splitFolder(scan.folder)] : [root];
  folderEl.textContent = `${parts.join('/')}/`;
  folderEl.parentElement.title = `存到 ${folderEl.textContent}\n點一下變更存放位置`;
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
async function writeFile(root, parts, blob) {
  let dir = root;
  for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
  const name = parts.at(-1);
  let candidate = name;
  if (settings.onExisting !== 'overwrite') {
    const dot = name.lastIndexOf('.');
    const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    for (let n = 1; ; n++) {
      try {
        await dir.getFileHandle(candidate);
      } catch (error) {
        if (error.name === 'NotFoundError') break;
        throw error;
      }
      if (settings.onExisting === 'skip') return 'skipped';
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
    statusEl.textContent = `${parts.join('，')}。`;
  }
  updateSelection();
});

renderLocation();
if (isPage) runScan();
