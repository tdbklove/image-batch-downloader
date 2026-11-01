// popup、設定頁與 background 共用：設定存取、下載路徑規則、自選資料夾的 handle。

const DEFAULT_SETTINGS = {
  mode: 'downloads', // 'downloads'：瀏覽器下載資料夾；'custom'：自選資料夾
  subfolder: '',     // mode 為 downloads 時，下載資料夾底下的子資料夾
  organize: true,    // 依網站與作品自動分資料夾
  minSize: 200,      // 長或寬小於此值的圖片不列出（尺寸未知的仍列出）
  autoScroll: false  // 一般網頁掃描前先捲到底，讓延遲載入的圖片出現
};

const KNOWN_EXT = /\.(jpe?g|png|gif|webp|avif|bmp|svg)$/i;

async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...settings };
}

async function saveSettings(patch) {
  const settings = { ...(await loadSettings()), ...patch };
  await chrome.storage.local.set({ settings });
  return settings;
}

// Chrome 與 Windows 會拒絕含非法字元、前後有空白／「.」／「~」或是保留名稱的路徑段落。
function sanitizeComponent(name, fallback = 'untitled') {
  let clean = String(name ?? '')
    .replace(/[\\/:*?"<>|~\p{Cc}\p{Cf}]/gu, '_')
    .replace(/^[\s.]+|[\s.]+$/gu, '')
    .slice(0, 80)
    .replace(/[\s.]+$/u, '');
  if (!clean) clean = fallback;
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(clean)) clean = `_${clean}`;
  return clean;
}

// 「Art/Pixiv」或「Art\Pixiv」→ ['Art', 'Pixiv']；「..」之類的段落會被丟掉。
function splitFolder(path) {
  return String(path || '')
    .split(/[\\/]+/)
    .map(part => sanitizeComponent(part, ''))
    .filter(Boolean);
}

// 回傳相對於下載根目錄的路徑段落，最後一段是檔名。
function buildPathParts({ settings, folder, image, index }) {
  const dirs = [];
  if (settings.mode === 'downloads') dirs.push(...splitFolder(settings.subfolder));
  if (settings.organize) dirs.push(...splitFolder(folder));
  let name = sanitizeComponent(image.filename, String(index + 1).padStart(3, '0'));
  if (!KNOWN_EXT.test(name)) name += '.jpg';
  return [...dirs, name];
}

// 自選資料夾的 FileSystemDirectoryHandle 只能存在 IndexedDB（chrome.storage 存不了）。
function openHandleDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('image-batch-downloader', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('handles');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function handleStore(mode, action) {
  const db = await openHandleDb();
  return new Promise((resolve, reject) => {
    const request = action(db.transaction('handles', mode).objectStore('handles'));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

const getDirectoryHandle = () => handleStore('readonly', store => store.get('downloadRoot'));
const setDirectoryHandle = handle => handleStore('readwrite', store => store.put(handle, 'downloadRoot'));
