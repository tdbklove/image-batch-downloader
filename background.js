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
  const failures = [];
  const queue = [...jobs];

  const worker = async () => {
    while (queue.length) {
      const { image, parts } = queue.shift();
      const filename = parts.join('/');
      try {
        if (existing.has(filename)) skipped++;
        else await downloadOne(image, filename, conflictAction);
      } catch (error) {
        console.warn('Image download failed', image.url, error);
        failures.push({ url: image.url, reason: String(error.message || error) });
      }
      done++;
      notify({ type: 'DOWNLOAD_PROGRESS', done, total, failed: failures.length });
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));
  return { total, succeeded: total - skipped - failures.length, skipped, failures };
}

// 需要 Referer 的網站改由 offscreen 文件 fetch 成 blob 再下載，
// 確保上面的 Referer 規則會套用；其他網址直接交給下載管理員。
async function downloadOne(image, filename, conflictAction) {
  if (!image.referer) {
    await startAndWait({ url: image.url, filename, conflictAction });
    return;
  }
  await ensureOffscreen();
  const fetched = await chrome.runtime.sendMessage({ type: 'OFFSCREEN_FETCH', url: image.url });
  if (!fetched?.blobUrl) throw new Error(fetched?.error || '下載內容失敗');
  try {
    await startAndWait({ url: fetched.blobUrl, filename, conflictAction });
  } finally {
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_REVOKE', blobUrl: fetched.blobUrl }).catch(() => {});
  }
}

async function startAndWait(options) {
  const id = await chrome.downloads.download({ ...options, saveAs: false });
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
