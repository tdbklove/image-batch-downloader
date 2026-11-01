const $ = selector => document.querySelector(selector);
const scanButton = $('#scan');
const selectAllButton = $('#selectAll');
const selectNoneButton = $('#selectNone');
const downloadButton = $('#download');
const statusEl = $('#status');
const imagesEl = $('#images');
const countEl = $('#count');
const sourceEl = $('#source');
const folderEl = $('#folder');

let scan = null; // { source, title, folder, images, note }
let settings = DEFAULT_SETTINGS; // 掃描時重新讀取
let lastClickedIndex = null;

const checkboxes = () => [...imagesEl.querySelectorAll('input[type=checkbox]')];

function isTooSmall(image) {
  const min = Number(settings.minSize) || 0;
  if (!image.width || !image.height) return false;
  return image.width < min || image.height < min;
}

function updateSelection() {
  const checked = checkboxes().filter(box => box.checked).length;
  downloadButton.disabled = checked === 0;
  downloadButton.textContent = `下載勾選項目 (${checked})`;
}

function render() {
  const visible = scan.images.map((image, index) => ({ image, index })).filter(({ image }) => !isTooSmall(image));
  const hidden = scan.images.length - visible.length;
  countEl.textContent = hidden ? `${visible.length} 張（隱藏 ${hidden} 張小圖）` : `${visible.length} 張`;
  imagesEl.replaceChildren();
  lastClickedIndex = null;

  for (const { image, index } of visible) {
    const card = document.createElement('label');
    card.className = 'card';

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = true;
    check.dataset.index = index;
    check.addEventListener('click', onCheckClick);

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

    const dims = document.createElement('span');
    dims.className = 'dims';
    dims.textContent = image.width ? `${image.width} × ${image.height}` : '尺寸未知';

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = image.filename;
    card.title = image.url;

    card.append(check, preview, dims, name);
    imagesEl.append(card);
  }

  const enabled = visible.length > 0;
  selectAllButton.disabled = !enabled;
  selectNoneButton.disabled = !enabled;
  updateSelection();
}

function onCheckClick(event) {
  const boxes = checkboxes();
  const current = boxes.indexOf(event.currentTarget);
  if (event.shiftKey && lastClickedIndex != null) {
    const [from, to] = [Math.min(lastClickedIndex, current), Math.max(lastClickedIndex, current)];
    for (let i = from; i <= to; i++) boxes[i].checked = event.currentTarget.checked;
  }
  lastClickedIndex = current;
  updateSelection();
}

scanButton.addEventListener('click', async () => {
  scanButton.disabled = true;
  statusEl.textContent = '正在掃描…';
  imagesEl.replaceChildren();
  try {
    settings = await loadSettings();
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('無法取得目前分頁。');
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
    render();
    const tips = [scan.note];
    if (!scan.images.length) {
      tips.push(settings.autoScroll
        ? '沒有找到可下載圖片。'
        : '沒有找到可下載圖片。如果圖片要捲動才會出現，可以在設定開啟「自動捲動載入」。');
    } else {
      tips.push('勾選圖片後開始下載。');
    }
    statusEl.textContent = tips.filter(Boolean).join(' ');
  } catch (error) {
    console.error(error);
    scan = null;
    countEl.textContent = '掃描失敗';
    statusEl.textContent = `掃描失敗：${error.message || error}。瀏覽器內部頁面（chrome://、線上應用程式商店）無法掃描。`;
  } finally {
    scanButton.disabled = false;
  }
});

selectAllButton.addEventListener('click', () => {
  checkboxes().forEach(box => { box.checked = true; });
  updateSelection();
});

selectNoneButton.addEventListener('click', () => {
  checkboxes().forEach(box => { box.checked = false; });
  updateSelection();
});

chrome.runtime.onMessage.addListener(message => {
  if (message.type !== 'DOWNLOAD_PROGRESS') return;
  statusEl.textContent = `下載中 ${message.done} / ${message.total}` + (message.failed ? `（失敗 ${message.failed}）` : '');
});

document.querySelector('#settings').addEventListener('click', () => chrome.runtime.openOptionsPage());

async function renderLocation() {
  settings = await loadSettings();
  let root = ['下載', ...splitFolder(settings.subfolder)].join('/');
  if (settings.mode === 'custom') root = (await getDirectoryHandle())?.name || '（尚未選擇資料夾）';
  const parts = settings.organize && scan ? [root, ...splitFolder(scan.folder)] : [root];
  folderEl.textContent = `${parts.join('/')}/`;
  folderEl.parentElement.title = `存到 ${folderEl.textContent}\n點一下變更存放位置`;
}
renderLocation();

// 自選資料夾模式：取得寫入權限（按鈕點擊的使用者手勢內才能跳出允許提示）。
async function getWritableRoot() {
  const root = await getDirectoryHandle();
  if (!root) throw new Error('尚未選擇資料夾，請點左下角的存放位置進行設定');
  const options = { mode: 'readwrite' };
  if ((await root.queryPermission(options)) === 'granted') return root;
  if ((await root.requestPermission(options)) === 'granted') return root;
  throw new Error('沒有資料夾的寫入權限，請點左下角的存放位置重新允許');
}

async function writeFile(root, parts, blob) {
  let dir = root;
  for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
  // 同名檔案已存在時改成「name (1).ext」，和瀏覽器下載的行為一致。
  const name = parts.at(-1);
  const dot = name.lastIndexOf('.');
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  let candidate = name;
  for (let n = 1; ; n++) {
    try {
      await dir.getFileHandle(candidate);
      candidate = `${base} (${n})${ext}`;
    } catch (error) {
      if (error.name === 'NotFoundError') break;
      throw error;
    }
  }
  const file = await dir.getFileHandle(candidate, { create: true });
  const writable = await file.createWritable();
  await writable.write(blob);
  await writable.close();
}

async function saveToCustomFolder(root, images, folder, settings) {
  const total = images.length;
  let done = 0;
  const failures = [];
  const queue = images.map((image, index) => ({ image, index }));
  const worker = async () => {
    while (queue.length) {
      const { image, index } = queue.shift();
      try {
        const response = await fetch(image.url, { credentials: 'include' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        await writeFile(root, buildPathParts({ settings, folder, image, index }), await response.blob());
      } catch (error) {
        console.warn('Image save failed', image.url, error);
        failures.push({ url: image.url, reason: String(error.message || error) });
      }
      done++;
      statusEl.textContent = `寫入中 ${done} / ${total}` + (failures.length ? `（失敗 ${failures.length}）` : '') + '，請保持此視窗開啟';
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, total) }, worker));
  return { total, succeeded: total - failures.length, failures };
}

downloadButton.addEventListener('click', async () => {
  const selected = checkboxes().filter(box => box.checked).map(box => scan.images[Number(box.dataset.index)]);
  if (!selected.length) return;
  downloadButton.disabled = true;
  settings = await loadSettings();
  let result;
  if (settings.mode === 'custom') {
    statusEl.textContent = `開始寫入 ${selected.length} 張…（請保持此視窗開啟）`;
    try {
      // 先要權限：允許提示只能在點擊後短時間內跳出。
      const root = await getWritableRoot();
      await chrome.runtime.sendMessage({ type: 'ENSURE_REFERERS', images: selected });
      result = await saveToCustomFolder(root, selected, scan.folder, settings);
    } catch (error) {
      statusEl.textContent = error.message;
      updateSelection();
      return;
    }
  } else {
    statusEl.textContent = `開始下載 ${selected.length} 張…（可以關閉這個視窗，下載會繼續）`;
    result = await chrome.runtime.sendMessage({ type: 'DOWNLOAD_IMAGES', images: selected, folder: scan.folder });
  }
  if (!result) {
    statusEl.textContent = '下載狀態未知，請到 chrome://downloads 查看。';
  } else if (result.failures.length) {
    statusEl.textContent = `完成 ${result.succeeded} 張，失敗 ${result.failures.length} 張（${result.failures[0].reason}）。`;
    console.warn('Failed downloads', result.failures);
  } else {
    statusEl.textContent = `已完成 ${result.succeeded} 張下載。`;
  }
  updateSelection();
});
