// 圖片拼接（只在下載分頁使用）：依勾選順序把圖片接成一張，輸出到和一般下載相同的位置。
// 和 popup.js 共用頂層變數與函式（visible、selectionOrder、settings、scan、writeFile…）。

const MAX_SIDE = 32767;       // Chrome 單一畫布每邊的上限
const MAX_AREA = 268435456;   // Chrome 單一畫布的像素總數上限（16384²）
const PREVIEW_MAX_SIDE = 30000;

const stitchPanel = $('#stitchPanel');
const stPreview = $('#stPreview');
const stStage = $('#stStage');
const stLoading = $('#stLoading');
const stOrder = $('#stOrder');
const stSize = $('#stSize');
const stLimit = $('#stLimit');
const stExport = $('#stExport');

let stItems = []; // 拼接順序：{ pos, image, bitmap }
let stReady = false;
const bitmapCache = new Map(); // 圖片網址 → Promise<ImageBitmap>

function loadBitmap(image) {
  if (!bitmapCache.has(image.url)) {
    const promise = (async () => {
      const response = await fetch(image.url, { credentials: 'include' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return createImageBitmap(await response.blob());
    })();
    promise.catch(() => bitmapCache.delete(image.url)); // 失敗的不留快取，下次重試
    bitmapCache.set(image.url, promise);
  }
  return bitmapCache.get(image.url);
}

function stitchOptions() {
  return {
    direction: document.querySelector('input[name=stDirection]:checked').value, // down / right / left
    align: $('#stAlign').value, // max / min
    gap: Math.min(200, Math.max(0, Math.round(Number($('#stGap').value) || 0))),
    format: $('#stFormat').value,
    overflow: document.querySelector('input[name=stOverflow]:checked').value // shrink / split
  };
}

// ---- 版面計算 ----

// 向下拼接時統一寬度，橫向拼接時統一高度。
function alignTarget(items, options) {
  const sizes = items.map(({ bitmap }) => (options.direction === 'down' ? bitmap.width : bitmap.height));
  return options.align === 'min' ? Math.min(...sizes) : Math.max(...sizes);
}

// 每張圖縮放後沿拼接方向的長度。
function itemLength({ bitmap }, options, target) {
  return options.direction === 'down'
    ? Math.round(bitmap.height * target / bitmap.width)
    : Math.round(bitmap.width * target / bitmap.height);
}

// 算出一張輸出圖的尺寸與每張圖的位置（未縮放）。items 為勾選順序；向左時第一張放在最右邊。
function layout(items, options, target) {
  const vertical = options.direction === 'down';
  const ordered = options.direction === 'left' ? [...items].reverse() : items;
  let offset = 0;
  const placements = ordered.map(item => {
    const length = itemLength(item, options, target);
    const placement = vertical
      ? { item, x: 0, y: offset, w: target, h: length }
      : { item, x: offset, y: 0, w: length, h: target };
    offset += length + options.gap;
    return placement;
  });
  const total = Math.max(0, offset - options.gap);
  return { placements, width: vertical ? target : total, height: vertical ? total : target };
}

const fitsCanvas = (width, height) => width <= MAX_SIDE && height <= MAX_SIDE && width * height <= MAX_AREA;
const shrinkScale = (width, height) =>
  Math.min(1, MAX_SIDE / width, MAX_SIDE / height, Math.sqrt(MAX_AREA / (width * height)));

// 決定要輸出幾張、每張的版面與縮放比例。
function planOutputs(items, options) {
  const target = alignTarget(items, options);
  const full = layout(items, options, target);
  if (fitsCanvas(full.width, full.height)) return { full, pages: [{ ...full, items, scale: 1 }] };
  if (options.overflow === 'shrink') {
    return { full, pages: [{ ...full, items, scale: shrinkScale(full.width, full.height) }] };
  }
  // 分成多張：依勾選順序，能放多少就放多少。
  const limit = Math.min(MAX_SIDE, Math.floor(MAX_AREA / target));
  const chunks = [];
  let chunk = [];
  let length = 0;
  for (const item of items) {
    const next = itemLength(item, options, target);
    const needed = chunk.length ? length + options.gap + next : next;
    if (chunk.length && needed > limit) {
      chunks.push(chunk);
      chunk = [item];
      length = next;
    } else {
      chunk.push(item);
      length = needed;
    }
  }
  chunks.push(chunk);
  const pages = chunks.map(part => {
    const page = layout(part, options, target);
    return { ...page, items: part, scale: shrinkScale(page.width, page.height) }; // 單張本身就超過時再縮小
  });
  return { full, pages };
}

function drawPage(ctx, page, scale, options) {
  const width = Math.round(page.width * scale);
  const height = Math.round(page.height * scale);
  if (options.gap > 0 || options.format === 'image/jpeg') {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
  } else {
    ctx.clearRect(0, 0, width, height);
  }
  ctx.imageSmoothingQuality = 'high';
  for (const { item, x, y, w, h } of page.placements) {
    // 用四捨五入後的邊界算寬高，避免縮小後相鄰兩張之間出現細縫。
    const left = Math.round(x * scale);
    const top = Math.round(y * scale);
    ctx.drawImage(item.bitmap, left, top, Math.round((x + w) * scale) - left, Math.round((y + h) * scale) - top);
  }
}

// ---- 面板 ----

function renderOrder() {
  stOrder.replaceChildren(...stItems.map((item, index) => {
    const li = document.createElement('li');
    li.draggable = true;
    li.dataset.index = index;
    li.title = item.image.filename;
    const img = document.createElement('img');
    img.src = item.image.preview || item.image.url;
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    const number = document.createElement('span');
    number.textContent = index + 1;
    li.append(img, number);
    return li;
  }));
}

let dragIndex = null;
stOrder.addEventListener('dragstart', event => {
  dragIndex = Number(event.target.closest('li')?.dataset.index);
  event.dataTransfer.effectAllowed = 'move';
});
stOrder.addEventListener('dragover', event => {
  if (dragIndex == null) return;
  event.preventDefault();
  stOrder.querySelectorAll('li').forEach(li => li.classList.remove('drop-before', 'drop-after'));
  const li = event.target.closest('li');
  if (li) li.classList.add(Number(li.dataset.index) > dragIndex ? 'drop-after' : 'drop-before');
});
stOrder.addEventListener('drop', event => {
  event.preventDefault();
  const li = event.target.closest('li');
  if (li && dragIndex != null) {
    const [moved] = stItems.splice(dragIndex, 1);
    stItems.splice(Number(li.dataset.index), 0, moved);
    syncSelectionOrder();
    renderOrder();
    renderStitchPreview();
  }
  dragIndex = null;
});
stOrder.addEventListener('dragend', () => {
  dragIndex = null;
  stOrder.querySelectorAll('li').forEach(li => li.classList.remove('drop-before', 'drop-after'));
});

// 面板裡調整的順序也寫回清單，關掉再開仍是同樣順序。
function syncSelectionOrder() {
  selectionOrder = stItems.map(item => item.pos);
}

$('#stReset').addEventListener('click', () => {
  stItems.sort((a, b) => a.pos - b.pos);
  syncSelectionOrder();
  renderOrder();
  renderStitchPreview();
});

function renderStitchPreview() {
  if (!stReady) return;
  const options = stitchOptions();
  $('#stAlignLabel').textContent = options.direction === 'down' ? '寬度對齊' : '高度對齊';
  const { full, pages } = planOutputs(stItems, options);
  const tooBig = !fitsCanvas(full.width, full.height);
  stLimit.hidden = !tooBig;
  const outputs = pages.map(page => `${Math.round(page.width * page.scale)} × ${Math.round(page.height * page.scale)}`);
  stSize.textContent = pages.length > 1
    ? `輸出 ${pages.length} 張：${outputs.join('、')} px`
    : `輸出尺寸：${outputs[0]} px` + (tooBig ? `（原始 ${full.width} × ${full.height}）` : '');
  stExport.textContent = pages.length > 1 ? `輸出並下載 ${pages.length} 張` : '輸出並下載';

  // 預覽：向下時寬度貼齊畫面，橫向時高度貼齊畫面，超出的部分可捲動。
  const vertical = options.direction === 'down';
  const room = vertical ? stStage.clientWidth - 32 : stStage.clientHeight - 32;
  let scale = Math.min(1, room / (vertical ? full.width : full.height));
  scale = Math.min(scale, PREVIEW_MAX_SIDE / Math.max(full.width, full.height));
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  stPreview.width = Math.max(1, Math.round(full.width * scale * ratio));
  stPreview.height = Math.max(1, Math.round(full.height * scale * ratio));
  stPreview.style.width = `${Math.round(full.width * scale)}px`;
  stPreview.style.height = `${Math.round(full.height * scale)}px`;
  const ctx = stPreview.getContext('2d');
  drawPage(ctx, full, scale * ratio, options);

  // 分成多張時，用虛線標出切開的位置。
  if (pages.length > 1) {
    ctx.save();
    ctx.strokeStyle = '#e8453c';
    ctx.lineWidth = 2 * ratio;
    ctx.setLineDash([8 * ratio, 6 * ratio]);
    const ends = new Map(full.placements.map(p => [p.item, p]));
    for (const page of pages.slice(0, -1)) {
      // 每張的最後一張圖（向左時是視覺上最左邊那張）之後切開。
      const edge = ends.get(page.items.at(-1));
      const at = options.direction === 'down' ? edge.y + edge.h
        : options.direction === 'right' ? edge.x + edge.w
        : edge.x;
      const px = Math.round(at * scale * ratio);
      ctx.beginPath();
      if (vertical) { ctx.moveTo(0, px); ctx.lineTo(stPreview.width, px); }
      else { ctx.moveTo(px, 0); ctx.lineTo(px, stPreview.height); }
      ctx.stroke();
    }
    ctx.restore();
  }
  stPreview.classList.toggle('horizontal', !vertical);
}

async function openStitch() {
  if (selectionOrder.length < 2) return;
  // pos 是在 visible 中的位置（visible 項目本身沒有這個欄位）
  stItems = selectionOrder.map(pos => ({ pos, image: visible[pos].image, bitmap: null }));
  stReady = false;
  stitchPanel.hidden = false;
  $('#stCount').textContent = `${stItems.length} 張，依勾選順序`;
  renderOrder();
  stPreview.width = stPreview.height = 0;
  stSize.textContent = '';
  stLimit.hidden = true;
  stExport.disabled = true;

  let loaded = 0;
  const failed = [];
  stLoading.hidden = false;
  stLoading.textContent = `載入原圖 0 / ${stItems.length}…`;
  const current = stItems;
  await Promise.all(current.map(async item => {
    try {
      item.bitmap = await loadBitmap(item.image);
    } catch (error) {
      failed.push(`${item.image.filename}（${error.message}）`);
    }
    loaded++;
    if (stItems === current) stLoading.textContent = `載入原圖 ${loaded} / ${current.length}…`;
  }));
  if (stItems !== current || stitchPanel.hidden) return; // 載入期間關掉或重開了
  if (failed.length) {
    stLoading.textContent = `有 ${failed.length} 張載入失敗，無法拼接：${failed.join('、')}`;
    return;
  }
  stLoading.hidden = true;
  stReady = true;
  stExport.disabled = false;
  renderStitchPreview();
}

function closeStitch() {
  stitchPanel.hidden = true;
  stItems = [];
  stReady = false;
  updateSelection();
}

stitchButton.addEventListener('click', openStitch);
$('#stClose').addEventListener('click', closeStitch);
document.addEventListener('keydown', event => {
  if (!stitchPanel.hidden && event.key === 'Escape') closeStitch();
});
stitchPanel.querySelectorAll('input, select').forEach(input => input.addEventListener('change', renderStitchPreview));
$('#stGap').addEventListener('input', renderStitchPreview);
window.addEventListener('resize', () => { if (!stitchPanel.hidden) renderStitchPreview(); });

// ---- 輸出 ----

function stitchFileName(index, count, format) {
  const first = stItems[0].image.filename.replace(/\.[^.]+$/, '');
  const ext = format === 'image/jpeg' ? 'jpg' : 'png';
  return `${first}_拼接${count > 1 ? `_${index + 1}` : ''}.${ext}`;
}

function downloadBlob(blob, filename, conflictAction) {
  const url = URL.createObjectURL(blob);
  return new Promise((resolve, reject) => {
    chrome.downloads.download({ url, filename, conflictAction, saveAs: false }).then(id => {
      const listener = delta => {
        if (delta.id !== id || !delta.state) return;
        if (delta.state.current === 'complete' || delta.state.current === 'interrupted') {
          chrome.downloads.onChanged.removeListener(listener);
          URL.revokeObjectURL(url);
          if (delta.state.current === 'complete') resolve();
          else chrome.downloads.search({ id }).then(([item]) => reject(new Error(item?.error || 'INTERRUPTED')));
        }
      };
      chrome.downloads.onChanged.addListener(listener);
    }, error => {
      URL.revokeObjectURL(url);
      reject(error);
    });
  });
}

stExport.addEventListener('click', async () => {
  if (!stReady) return;
  stExport.disabled = true;
  const options = stitchOptions();
  let firstParts = null;
  try {
    settings = await loadSettings();
    // 先要權限：允許提示只能在點擊後短時間內跳出，畫圖可能要好幾秒。
    const root = settings.mode === 'custom' ? await getWritableRoot() : null;
    const { pages } = planOutputs(stItems, options);
    // 拼接結果是你明確要輸出的，不套用「跳過」：只分覆蓋或另存新檔。
    const overwrite = settings.onExisting === 'overwrite';
    for (const [index, page] of pages.entries()) {
      stSize.textContent = `輸出中 ${index + 1} / ${pages.length}…（大圖可能要幾秒）`;
      const canvas = new OffscreenCanvas(Math.round(page.width * page.scale), Math.round(page.height * page.scale));
      drawPage(canvas.getContext('2d'), page, page.scale, options);
      const blob = await canvas.convertToBlob({ type: options.format, quality: 0.92 });
      const filename = stitchFileName(index, pages.length, options.format);
      const parts = buildPathParts({ settings, folder: scan.folder, image: { filename }, index: 0 });
      firstParts ??= parts;
      if (root) await writeFile(root, parts, blob, overwrite ? 'overwrite' : 'keep');
      else await downloadBlob(blob, parts.join('/'), overwrite ? 'overwrite' : 'uniquify');
    }
    const where = settings.mode === 'custom' ? '自選資料夾' : '下載資料夾';
    stSize.textContent = `已輸出 ${pages.length} 張到${where}：${stitchFileName(0, pages.length, options.format)}${pages.length > 1 ? ' 等' : ''}`;
    statusEl.textContent = stSize.textContent;
    await appendOpenFolder(stSize, firstParts);
  } catch (error) {
    console.error(error);
    stSize.textContent = `輸出失敗：${error.message || error}`;
  } finally {
    stExport.disabled = false;
  }
});
