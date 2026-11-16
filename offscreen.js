// 在擴充功能頁面環境中 fetch 圖片（會套用 background.js 加的 Referer 規則），轉成 blob URL 交給下載管理員。
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'OFFSCREEN_FETCH') {
    fetch(message.url)
      .then(async response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        const problem = await checkMediaBlob(blob, response); // shared.js
        if (problem) throw new Error(problem);
        return blob;
      })
      .then(blob => sendResponse({ blobUrl: URL.createObjectURL(blob) }))
      .catch(error => sendResponse({ error: String(error.message || error) }));
    return true;
  }
  if (message.type === 'OFFSCREEN_REVOKE') URL.revokeObjectURL(message.blobUrl);
});
