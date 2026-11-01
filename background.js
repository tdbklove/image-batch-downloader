importScripts('shared.js');

const CONCURRENCY = 3;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'ENSURE_REFERERS') {
    ensureRefererRules(message.images || []).then(() => sendResponse({ ok: true }), error => sendResponse({ error: String(error) }));
    return true;
  }
  if (message.type !== 'DOWNLOAD_IMAGES') return;
  downloadAll(message.images || [], message.folder || 'page-images').then(sendResponse);
  return true;
});

// 防盜鏈網站（Pixiv、Postype 的 CDN）要求特定 Referer。對每個圖片網域加一條 session 規則，
// 只套用在不屬於任何分頁的請求（擴充功能自己的 fetch、popup 預覽、下載），不影響一般瀏覽。
let ruleUpdate = Promise.resolve();
function ensureRefererRules(images) {
  ruleUpdate = ruleUpdate.then(async () => {
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
      if (current?.action.requestHeaders?.[0]?.value === referer) continue;
      if (current) removeRuleIds.push(current.id);
      addRules.push({
        id: nextId++,
        priority: 1,
        action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Referer', operation: 'set', value: referer }] },
        condition: { requestDomains: [host], tabIds: [chrome.tabs.TAB_ID_NONE] }
      });
    }
    if (addRules.length || removeRuleIds.length) {
      await chrome.declarativeNetRequest.updateSessionRules({ addRules, removeRuleIds });
    }
  });
  return ruleUpdate;
}

// 存到瀏覽器下載資料夾（自選資料夾模式由 popup 直接寫檔，不經過這裡）。
async function downloadAll(images, folder) {
  await ensureRefererRules(images);
  const settings = await loadSettings();
  const total = images.length;
  let done = 0;
  const failures = [];
  const queue = images.map((image, index) => ({ image, index }));

  const worker = async () => {
    while (queue.length) {
      const { image, index } = queue.shift();
      try {
        await downloadOne(image, buildPathParts({ settings, folder, image, index }).join('/'));
      } catch (error) {
        console.warn('Image download failed', image.url, error);
        failures.push({ url: image.url, reason: String(error.message || error) });
      }
      done++;
      notify({ type: 'DOWNLOAD_PROGRESS', done, total, failed: failures.length });
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));
  return { total, succeeded: total - failures.length, failures };
}

// 需要 Referer 的網站改由 offscreen 文件 fetch 成 blob 再下載，
// 確保上面的 Referer 規則會套用；其他網址直接交給下載管理員。
async function downloadOne(image, filename) {
  if (!image.referer) {
    await startAndWait({ url: image.url, filename });
    return;
  }
  await ensureOffscreen();
  const fetched = await chrome.runtime.sendMessage({ type: 'OFFSCREEN_FETCH', url: image.url });
  if (!fetched?.blobUrl) throw new Error(fetched?.error || '下載內容失敗');
  try {
    await startAndWait({ url: fetched.blobUrl, filename });
  } finally {
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_REVOKE', blobUrl: fetched.blobUrl }).catch(() => {});
  }
}

async function startAndWait(options) {
  const id = await chrome.downloads.download({ ...options, conflictAction: 'uniquify', saveAs: false });
  await new Promise((resolve, reject) => {
    const listener = delta => {
      if (delta.id !== id || !delta.state) return;
      if (delta.state.current === 'complete') {
        chrome.downloads.onChanged.removeListener(listener);
        resolve();
      } else if (delta.state.current === 'interrupted') {
        chrome.downloads.onChanged.removeListener(listener);
        chrome.downloads.search({ id }).then(([item]) => reject(new Error(item?.error || 'INTERRUPTED')));
      }
    };
    chrome.downloads.onChanged.addListener(listener);
  });
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
