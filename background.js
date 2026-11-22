importScripts('shared.js');

const CONCURRENCY = 3;

// 開啟方式設為「分頁」時拿掉彈窗，點圖示改成開下載分頁。
// setPopup 的設定在瀏覽器重開後會消失，所以啟動時也要同步一次。
async function syncActionPopup() {
  const settings = await loadSettings();
  await chrome.action.setPopup({ popup: settings.openMode === 'tab' ? '' : 'popup.html' });
}
chrome.runtime.onInstalled.addListener(syncActionPopup);
chrome.runtime.onStartup.addListener(syncActionPopup);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) syncActionPopup();
});

chrome.action.onClicked.addListener(tab => {
  if (tab.url?.startsWith(chrome.runtime.getURL(''))) return; // 已經在下載分頁裡
  chrome.tabs.create({ url: `popup.html?tab=${tab.id}`, index: tab.index + 1, openerTabId: tab.id });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'ENSURE_REFERERS') {
    // 從下載分頁送來時 sender.tab 是那個分頁，規則也要套用到它；彈窗送來時沒有 tab。
    ensureRefererRules(message.images || [], sender.tab?.id)
      .then(() => sendResponse({ ok: true }), error => sendResponse({ error: String(error) }));
    return true;
  }
  if (message.type === 'FETCH_X_TWEET') {
    // X 頁面上的掃描腳本受 CORS 限制，改由這裡查詢公開的嵌入推文 API。
    if (!/^\d+$/.test(message.id) || !/^\w+$/.test(message.token)) return;
    fetch(`https://cdn.syndication.twimg.com/tweet-result?id=${message.id}&token=${message.token}&lang=en`)
      .then(response => (response.ok ? response.json() : { error: `HTTP ${response.status}` }))
      .then(sendResponse, error => sendResponse({ error: String(error.message || error) }));
    return true;
  }
  if (message.type === 'FIRST_WORKING_URL') {
    firstWorkingUrls(message.items || []).then(sendResponse, () => sendResponse({}));
    return true;
  }
  if (message.type === 'RESOLVE_X_FORMATS') {
    resolveXFormats(message.items || []).then(sendResponse, () => sendResponse({}));
    return true;
  }
  if (message.type === 'CANCEL_DOWNLOADS') {
    cancelDownloads();
    sendResponse({ ok: true });
    return;
  }
  if (message.type !== 'DOWNLOAD_IMAGES') return;
  downloadAll(message.images || [], message.folder || 'page-images').then(sendResponse);
  return true;
});

// 防盜鏈網站（Pixiv、Postype 的 CDN）要求特定 Referer。對每個圖片網域加一條 session 規則，
// 只套用在不屬於任何分頁的請求（擴充功能自己的 fetch、彈窗預覽、下載）以及下載分頁，
// 不影響一般瀏覽。
let ruleUpdate = Promise.resolve();
function ensureRefererRules(images, extensionTabId = null) {
  // 前一次更新失敗也不要卡住後面的更新。
  ruleUpdate = ruleUpdate.catch(() => {}).then(async () => {
    const wanted = new Map();
    for (const image of images) {
      if (!image.referer) continue;
      for (const url of [image.url, image.preview]) {
        if (url) wanted.set(new URL(url).hostname, image.referer);
      }
    }
    const existing = await chrome.declarativeNetRequest.getSessionRules();
    const byHost = new Map(existing.map(rule => [rule.condition.requestDomains?.[0], rule]));
    let nextId = Math.max(0, ...existing.map(rule => rule.id)) + 1;
    const addRules = [];
    const removeRuleIds = [];
    for (const [host, referer] of wanted) {
      const current = byHost.get(host);
      const tabIds = new Set(current?.condition.tabIds || [chrome.tabs.TAB_ID_NONE]);
      if (extensionTabId != null) tabIds.add(extensionTabId);
      const sameReferer = current?.action.requestHeaders?.[0]?.value === referer;
      if (sameReferer && tabIds.size === current.condition.tabIds?.length) continue;
      if (current) removeRuleIds.push(current.id);
      addRules.push({
        id: nextId++,
        priority: 1,
        action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Referer', operation: 'set', value: referer }] },
        condition: { requestDomains: [host], tabIds: [...tabIds] }
      });
    }
    if (addRules.length || removeRuleIds.length) {
      await chrome.declarativeNetRequest.updateSessionRules({ addRules, removeRuleIds });
    }
  });
  return ruleUpdate;
}

// 下載分頁關閉後，把它從各條 Referer 規則中移除。
chrome.tabs.onRemoved.addListener(tabId => {
  chrome.storage.session.remove(`scan:${tabId}`).catch(() => {}); // popup.js 記住的掃描結果
  ruleUpdate = ruleUpdate.then(async () => {
    const rules = (await chrome.declarativeNetRequest.getSessionRules())
      .filter(rule => rule.condition.tabIds?.includes(tabId));
    if (!rules.length) return;
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: rules.map(rule => rule.id),
      addRules: rules.map(rule => ({
        ...rule,
        condition: { ...rule.condition, tabIds: rule.condition.tabIds.filter(id => id !== tabId) }
      }))
    });
  }).catch(error => console.warn('Referer rule cleanup failed', error));
});

// 存到瀏覽器下載資料夾（自選資料夾模式由頁面直接寫檔，不經過這裡）。
async function downloadAll(images, folder) {
  await ensureRefererRules(images);
  const settings = await loadSettings();
  const jobs = images.map((image, index) => ({ image, parts: buildPathParts({ settings, folder, image, index }) }));
  const existing = settings.onExisting === 'skip'
    ? await findExistingFiles(jobs.map(job => job.parts), settings)
    : new Set();
  const conflictAction = settings.onExisting === 'overwrite' ? 'overwrite' : 'uniquify';

  const total = jobs.length;
  let done = 0;
  let skipped = 0;
  let canceled = 0;
  const failures = [];
  const queue = [...jobs];
  const job = { canceled: false, ids: new Set() };
  activeJob = job;

  const worker = async () => {
    while (queue.length && !job.canceled) {
      const { image, parts } = queue.shift();
      const filename = parts.join('/');
      try {
        if (existing.has(filename)) skipped++;
        else await downloadOne(image, filename, conflictAction, job);
      } catch (error) {
        if (job.canceled) { canceled++; continue; } // 取消時中斷的那幾張不算失敗
        console.warn('Image download failed', image.url, error);
        failures.push({ url: image.url, reason: String(error.message || error) });
      }
      done++;
      notify({ type: 'DOWNLOAD_PROGRESS', done, total, failed: failures.length });
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));
  if (activeJob === job) activeJob = null;
  canceled += queue.length; // 還沒開始的
  return { total, succeeded: total - skipped - failures.length - canceled, skipped, failures, canceled };
}

// 每個項目有幾個候選網址（例如原圖的各種副檔名），用 HEAD 依序試，回傳 { key: 第一個存在的網址 }。
// 只接受 Pinterest、噗浪的圖片伺服器，避免被拿來探測任意網址。
const PROBE_HOSTS = /^https:\/\/(i\.pinimg\.com|images\.plurk\.com)\//;
async function firstWorkingUrls(items) {
  const result = {};
  const queue = items.filter(item => item?.key && Array.isArray(item.candidates));
  const worker = async () => {
    while (queue.length) {
      const { key, candidates } = queue.shift();
      for (const url of candidates.filter(candidate => PROBE_HOSTS.test(candidate))) {
        try {
          // 圖片只讀開頭一小段：確認存在，順便從檔頭讀出原圖尺寸。影片只確認存在。
          const isImage = !/\.mp4$/i.test(url);
          const response = await fetch(url, isImage ? { headers: { Range: 'bytes=0-65535' } } : { method: 'HEAD' });
          if (!response.ok) continue;
          const size = isImage ? imageSize(new Uint8Array(await response.arrayBuffer())) : null;
          result[key] = { url, width: size?.width || 0, height: size?.height || 0 };
          break;
        } catch {}
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  return result;
}

// 從檔頭讀出圖片寬高（PNG、GIF、JPEG、WebP），讀不出來回傳 null。
function imageSize(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (offset, length) => String.fromCharCode(...bytes.subarray(offset, offset + length));
  if (bytes.length >= 24 && ascii(1, 3) === 'PNG') return { width: view.getUint32(16), height: view.getUint32(20) };
  if (bytes.length >= 10 && ascii(0, 3) === 'GIF') return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  if (bytes.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const chunk = ascii(12, 4);
    if (chunk === 'VP8X') return { width: 1 + (bytes[24] | bytes[25] << 8 | bytes[26] << 16), height: 1 + (bytes[27] | bytes[28] << 8 | bytes[29] << 16) };
    if (chunk === 'VP8 ') return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    if (chunk === 'VP8L') {
      const bits = view.getUint32(21, true);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    // JPEG：逐段找 SOF（C0–CF，但不含 C4 DHT、C8、CC DAC）。
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) return null;
      const marker = bytes[offset + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) };
      }
      offset += 2 + view.getUint16(offset + 2);
    }
  }
  return null;
}

// X 的原圖（name=orig）必須用原始格式，格式不對會 404。依序試猜測的格式、jpg、png、webp，
// 回傳 { 媒體ID: 格式 }；都失敗的不列入（content.js 會改用 4096x4096）。
async function resolveXFormats(items) {
  const result = {};
  const queue = items.filter(item => /^[\w-]+$/.test(item.id || ''));
  const worker = async () => {
    while (queue.length) {
      const { id, guess } = queue.shift();
      for (const format of [...new Set([guess, 'jpg', 'png', 'webp'].filter(f => /^\w+$/.test(f || '')))]) {
        try {
          const response = await fetch(`https://pbs.twimg.com/media/${id}?format=${format}&name=orig`, { method: 'HEAD' });
          if (response.ok) {
            result[id] = format;
            break;
          }
        } catch {}
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  return result;
}

// 目前進行中的批次下載：{ canceled, ids: 進行中的下載 ID }
let activeJob = null;

// 停止排隊中的下載，並取消已經開始的（Chrome 會刪掉未完成的檔案）。
function cancelDownloads() {
  if (!activeJob) return;
  activeJob.canceled = true;
  for (const id of activeJob.ids) chrome.downloads.cancel(id).catch(() => {});
}

// 需要 Referer 的網站改由 offscreen 文件 fetch 成 blob 再下載，
// 確保上面的 Referer 規則會套用；其他網址直接交給下載管理員。
async function downloadOne(image, filename, conflictAction, job = null) {
  if (!image.referer) {
    await startAndWait({ url: image.url, filename, conflictAction }, job);
    return;
  }
  await ensureOffscreen();
  const fetched = await chrome.runtime.sendMessage({ type: 'OFFSCREEN_FETCH', url: image.url });
  if (!fetched?.blobUrl) throw new Error(fetched?.error || '下載內容失敗');
  try {
    await startAndWait({ url: fetched.blobUrl, filename, conflictAction }, job);
  } finally {
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_REVOKE', blobUrl: fetched.blobUrl }).catch(() => {});
  }
}

async function startAndWait(options, job = null) {
  const id = await chrome.downloads.download({ ...options, saveAs: false });
  job?.ids.add(id);
  if (job?.canceled) chrome.downloads.cancel(id).catch(() => {}); // 剛好在取消後才開始的
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = state => {
      if (settled || (state !== 'complete' && state !== 'interrupted')) return;
      settled = true;
      chrome.downloads.onChanged.removeListener(listener);
      if (state === 'complete') resolve();
      else chrome.downloads.search({ id }).then(([item]) => reject(new Error(item?.error || 'INTERRUPTED')));
    };
    const listener = delta => { if (delta.id === id && delta.state) finish(delta.state.current); };
    chrome.downloads.onChanged.addListener(listener);
    // 很小的檔案可能在掛上監聽前就下載完了，補查一次目前狀態。
    chrome.downloads.search({ id }).then(([item]) => finish(item?.state));
  });
  // 伺服器回 200 卻給錯誤網頁或空檔時，Chrome 也算下載成功；檢查類型，不對就刪掉並算失敗。
  const [item] = await chrome.downloads.search({ id });
  const problem = !item ? null
    : item.fileSize === 0 ? '下載到空的檔案'
    : /^(text\/(html|plain|xml)|application\/(json|xml))/i.test(item.mime || '') ? '下載到的是網頁，不是圖片'
    : item.totalBytes > 0 && item.bytesReceived < item.totalBytes ? '檔案不完整（下載中斷）'
    : null;
  if (problem) {
    await chrome.downloads.removeFile(id).catch(() => {});
    chrome.downloads.erase({ id }).catch(() => {});
    throw new Error(problem);
  }
}

let creatingOffscreen = null;
async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) return;
  creatingOffscreen ??= chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['BLOBS'],
    justification: '下載需要特定 Referer 的圖片'
  }).finally(() => { creatingOffscreen = null; });
  await creatingOffscreen;
}

function notify(message) {
  chrome.runtime.sendMessage(message).catch(() => {}); // popup 關閉時沒有接收端
}
