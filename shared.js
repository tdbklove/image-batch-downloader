// popup、設定頁與 background 共用：設定存取、下載路徑規則、自選資料夾的 handle。

const DEFAULT_SETTINGS = {
  mode: 'downloads', // 'downloads'：瀏覽器下載資料夾；'custom'：自選資料夾
  subfolder: '',     // mode 為 downloads 時，下載資料夾底下的子資料夾
  organize: true,    // 依網站與作品自動分資料夾
  minSize: 200,      // 長或寬小於此值的圖片不列出（尺寸未知的仍列出）
  autoScroll: false, // 一般網頁掃描前先捲到底，讓延遲載入的圖片出現
  openMode: 'popup', // 點插件圖示時：'popup' 彈窗；'tab' 開下載分頁
  onExisting: 'skip' // 檔案已存在時：'skip' 跳過；'overwrite' 覆蓋；'keep' 另存為 name (1).ext
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

// 找出哪些路徑已經有檔案，回傳 Set（內容為 parts.join('/')）。
// 下載資料夾模式查 Chrome 的下載紀錄（只算檔案還在原位的）；自選資料夾模式直接查資料夾，
// 需要傳入已取得權限的 root，沒有權限時傳 null，視為都不存在。
async function findExistingFiles(pathList, settings, root = null) {
  const found = new Set();
  if (settings.mode === 'custom') {
    if (!root) return found;
    await Promise.all(pathList.map(async parts => {
      if (await fileExists(root, parts)) found.add(parts.join('/'));
    }));
    return found;
  }
  const items = await chrome.downloads.search({ exists: true, state: 'complete', limit: 0 });
  const downloaded = items.map(item => item.filename.replace(/\\/g, '/').toLowerCase());
  for (const parts of pathList) {
    const suffix = `/${parts.join('/').toLowerCase()}`;
    if (downloaded.some(path => path.endsWith(suffix))) found.add(parts.join('/'));
  }
  return found;
}

async function fileExists(root, parts) {
  try {
    let dir = root;
    for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
    await dir.getFileHandle(parts.at(-1));
    return true;
  } catch {
    return false;
  }
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
