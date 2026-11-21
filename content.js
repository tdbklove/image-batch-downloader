// 由 popup 透過 chrome.scripting 按需注入；重複注入時只定義一次。
(() => {
  if (globalThis.__imageBatchScan) return;

  const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif|bmp|svg)(?:$|[?#])/i;
  const LAZY_ATTRS = ['data-src', 'data-original', 'data-lazy-src', 'data-full-path', 'data-url', 'data-hi-res-src'];
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function toAbsolute(raw) {
    if (!raw) return null;
    try {
      const url = new URL(raw.trim(), location.href);
      return ['http:', 'https:'].includes(url.protocol) ? url : null;
    } catch {
      return null;
    }
  }

  // srcset 取寬度描述最大的那個候選。
  function largestFromSrcset(srcset) {
    let best = null;
    let bestScore = -1;
    for (const part of (srcset || '').split(/,\s+(?=\S)/)) {
      const [url, descriptor = '1x'] = part.trim().split(/\s+/);
      const score = parseFloat(descriptor) || 1;
      if (url && score > bestScore) {
        best = url;
        bestScore = score;
      }
    }
    return best;
  }

  function fileNameFromUrl(url) {
    const last = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || '');
    return last || 'image';
  }

  // 只是讓資料夾名稱好讀；真正的檔名檢查在 background.js 的 sanitizeComponent。
  function sanitize(name) {
    return String(name).replace(/[\\/:*?"<>|~\p{Cc}\p{Cf}]/gu, '_').replace(/^[\s.]+|[\s.]+$/gu, '').slice(0, 80) || 'untitled';
  }

  // 一般網頁：從 DOM 收集圖片候選。upgrade 可把縮圖網址換成原圖網址。
  // skip(img) 回傳 true 的 <img> 會被略過。
  function collectFromDom({ roots = [document], upgrade = url => url, skip = () => false } = {}) {
    const found = new Map();
    const add = (raw, width = 0, height = 0, preview = null) => {
      const parsed = toAbsolute(raw);
      if (!parsed) return;
      const url = upgrade(parsed);
      const key = url.href;
      const current = found.get(key);
      if (current && current.width * current.height >= width * height) return;
      found.set(key, {
        url: key,
        preview: preview || parsed.href,
        width,
        height,
        filename: fileNameFromUrl(url)
      });
    };

    for (const img of roots.flatMap(root => [...root.querySelectorAll('img')])) {
      if (skip(img)) continue;
      const holder = img.closest('[data-width][data-height]');
      const width = Number(holder?.dataset.width) || img.naturalWidth || Number(img.getAttribute('width')) || 0;
      const height = Number(holder?.dataset.height) || img.naturalHeight || Number(img.getAttribute('height')) || 0;
      const shown = img.currentSrc || img.src;
      add(largestFromSrcset(img.srcset) || shown, width, height, shown);
      for (const attr of LAZY_ATTRS) add(img.getAttribute(attr), width, height, shown);
      const picture = img.closest('picture');
      if (picture) {
        for (const source of picture.querySelectorAll('source')) add(largestFromSrcset(source.srcset), width, height, shown);
      }
      // 縮圖外層常常直接連到原圖。
      const link = img.closest('a[href]');
      if (link && IMAGE_EXT.test(link.getAttribute('href'))) add(link.href, width, height, shown);
    }

    for (const el of roots.flatMap(root => [...root.querySelectorAll('[style*="background"]')])) {
      const bg = getComputedStyle(el).backgroundImage;
      for (const match of bg.matchAll(/url\(["']?(.*?)["']?\)/g)) add(match[1], el.clientWidth, el.clientHeight);
    }

    return [...found.values()];
  }

  // 自動捲動：一邊往下捲一邊呼叫 collect（虛擬清單捲過去的項目會被移除，要邊捲邊收），最後捲回原位。
  // 無限捲動的頁面捲不到底，所以有上限：張數、時間、捲動次數，也可以從彈窗按「停止捲動」。
  // 回傳停止的原因，用來在狀態列說明。
  const SCROLL_LIMITS = { items: 300, ms: 90000, steps: 120 };
  async function scrollCollect(collect = () => {}, count = () => 0, delay = 450) {
    globalThis.__imageBatchStop = false;
    const startY = scrollY;
    const started = Date.now();
    let lastHeight = 0;
    let reason = 'steps';
    // 頁面上的提示；按 Esc 或切到別的分頁就停止（下載分頁模式時停止按鈕不在眼前）。
    const stop = () => { globalThis.__imageBatchStop = true; };
    const onKey = event => { if (event.key === 'Escape') stop(); };
    const onHide = () => { if (document.hidden) stop(); };
    addEventListener('keydown', onKey, true);
    document.addEventListener('visibilitychange', onHide);
    const hint = document.createElement('div');
    hint.textContent = '頁面圖片：自動捲動收集中… 按 Esc 或切到其他分頁即可停止';
    hint.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;padding:10px 16px;border-radius:8px;background:rgba(31,35,40,.9);color:#fff;font:14px system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.25);pointer-events:none';
    document.documentElement.append(hint);
    try {
      for (let i = 0; i < SCROLL_LIMITS.steps; i++) {
        if (globalThis.__imageBatchStop) { reason = 'stopped'; break; }
        if (count() >= SCROLL_LIMITS.items) { reason = 'items'; break; }
        if (Date.now() - started > SCROLL_LIMITS.ms) { reason = 'time'; break; }
        scrollBy(0, innerHeight * 0.8);
        await sleep(delay);
        collect();
        chrome.runtime.sendMessage({ type: 'SCAN_PROGRESS', count: count(), seconds: Math.round((Date.now() - started) / 1000) }).catch(() => {});
        if (innerHeight + scrollY >= document.documentElement.scrollHeight - 4) {
          if (document.documentElement.scrollHeight === lastHeight) { reason = 'end'; break; }
          lastHeight = document.documentElement.scrollHeight;
          await sleep(1000); // 等下一批載入
          collect();
        }
      }
    } finally {
      hint.remove();
      removeEventListener('keydown', onKey, true);
      document.removeEventListener('visibilitychange', onHide);
      scrollTo(0, startY);
    }
    return reason;
  }

  // 停止原因 → 狀態列說明（捲到底就不用說）。
  function scrollNote(reason) {
    return {
      stopped: '已停止自動捲動，列出目前找到的。',
      items: `自動捲動已收集 ${SCROLL_LIMITS.items} 張，先停在這裡；要更多可以捲到頁面後段再掃描一次。`,
      time: `自動捲動已進行 ${SCROLL_LIMITS.ms / 1000} 秒，先停在這裡（可能是無限捲動的頁面）。`,
      steps: '自動捲動已達次數上限，先停在這裡（可能是無限捲動的頁面）。'
    }[reason] || '';
  }

  const adapters = [
    {
      name: 'Pixiv',
      match: () => /(^|\.)pixiv\.net$/.test(location.hostname) && /\/artworks\/(\d+)/.test(location.pathname),
      async scan() {
        const id = location.pathname.match(/\/artworks\/(\d+)/)[1];
        const getJson = async path => {
          const response = await fetch(path, { credentials: 'include' });
          const data = await response.json();
          if (data.error) throw new Error(data.message || `Pixiv API 錯誤（${path}）`);
          return data.body;
        };
        const [info, pages] = await Promise.all([getJson(`/ajax/illust/${id}`), getJson(`/ajax/illust/${id}/pages`)]);
        const folder = `pixiv/${sanitize(`${info.userName}_${info.userId}`)}/${sanitize(`${id}_${info.illustTitle}`)}`;
        const images = pages.map(page => ({
          url: page.urls.original,
          preview: page.urls.small || page.urls.thumb_mini,
          width: page.width,
          height: page.height,
          filename: fileNameFromUrl(new URL(page.urls.original)),
          referer: 'https://www.pixiv.net/'
        }));
        const note = info.illustType === 2 ? '這是動圖（ugoira），只能下載第一格靜態圖。' : '';
        return { title: info.illustTitle, folder, images, note };
      }
    },
    {
      name: 'Postype',
      match: () => /(^|\.)postype\.com$/.test(location.hostname),
      async scan({ scroll }) {
        // 文章內的相簿是虛擬輪播，DOM 只留幾張；伺服器回傳的原始 HTML 才有完整清單。
        // 兩邊都掃，並只取文章本文，避開側欄與推薦文章的封面。
        // 原始 HTML 放前面，清單才會照文章順序排列。
        const roots = [];
        try {
          const html = await fetch(location.href, { credentials: 'include' }).then(response => response.text());
          roots.push(new DOMParser().parseFromString(html, 'text/html').querySelector('#post-content'));
        } catch {}
        roots.push(document.querySelector('#post-content'));
        if (!roots.some(Boolean)) {
          if (scroll) await scrollCollect(() => {}, () => document.images.length, 300);
          roots.push(document);
        }
        // Postype 的 CDN 網址帶 ?w=1000&q=90 之類的縮放參數，拿掉就是原圖。
        const upgrade = url => {
          if (url.hostname.endsWith('.cloudfront.net') && (url.searchParams.has('w') || url.searchParams.has('q'))) {
            return new URL(url.origin + url.pathname);
          }
          return url;
        };
        const postId = location.pathname.match(/\/post\/(\d+)/)?.[1];
        const title = document.querySelector('meta[property="og:title"]')?.content || document.title;
        const author = location.pathname.match(/\/@([^/]+)/)?.[1] || 'unknown';
        const folder = `postype/${sanitize(author)}/${sanitize(postId ? `${postId}_${title}` : title)}`;
        // 排除作者頭像，以及放在 /assets/ 底下的網站素材（預設頭像、圖示）。
        // CDN 有防盜鏈，沒帶 Postype 的 Referer 會回 403。
        const skip = img => Boolean(img.closest('.profile-img, [class*="avatar" i]'));
        // 原始檔名是亂數，存下來排序會亂；改成「文章ID_順序」（清單已經是文章中的順序）。
        const images = collectFromDom({ roots: roots.filter(Boolean), upgrade, skip })
          .filter(image => !/\/assets\//.test(new URL(image.url).pathname))
          .map((image, i) => ({
            ...image,
            filename: postId ? `${postId}_${i + 1}.${image.filename.match(/\.(\w+)$/)?.[1] || 'jpg'}` : image.filename,
            referer: 'https://www.postype.com/'
          }));
        return { title, folder, images };
      }
    },
    {
      name: 'X',
      match: () => /(^|\.)(x|twitter)\.com$/.test(location.hostname),
      scan: scanX
    },
    {
      name: 'Poipiku',
      match: () => /(^|\.)poipiku\.com$/.test(location.hostname) && /^\/\d+\/\d+\.html/.test(location.pathname),
      scan: scanPoipiku
    },
    {
      name: '微博',
      match: () => /(^|\.)weibo\.com$/.test(location.hostname) && /^\/\d+\/[A-Za-z0-9]+\/?$/.test(location.pathname),
      scan: scanWeibo
    },
    {
      name: 'Pinterest',
      match: () => /(^|\.)pinterest\.[a-z.]+$/.test(location.hostname),
      scan: scanPinterest
    }
  ];

  // ---- Pinterest ----
  // 圖片網址 i.pinimg.com/{尺寸}/aa/bb/cc/雜湊.jpg，尺寸換成 originals 就是原圖，
  // 但副檔名必須和原圖一致（猜錯會 403），所以請 background 試出存在的那個。
  // 影片是 HLS（.m3u8），同一路徑通常有 720p 的 MP4 可以直接下載。

  const PIN_IMAGE = /^\/(?:\d+x\d*|\d+x|originals)(?:_RS)?\/([0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]+)\.(\w+)$/;
  const PIN_VIDEO = /^\/videos\/([\w-]+)\/(?:hls|expmp4|\d+p)\/([0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]+)/;

  function pinIdOf(el) {
    return el.closest('a[href*="/pin/"]')?.getAttribute('href').match(/\/pin\/([\w-]+)/)?.[1]
      || (location.pathname.match(/^\/pin\/([\w-]+)/) && !el.closest('[data-grid-item]') ? location.pathname.match(/^\/pin\/([\w-]+)/)[1] : null);
  }

  // 收集 scope 裡的圖片與影片；key 用雜湊，同一張圖不同尺寸只算一次。
  function collectPins(found, scope) {
    for (const img of scope.querySelectorAll('img[src*="pinimg.com"]')) {
      const url = toAbsolute(img.currentSrc || img.src);
      const match = url?.pathname.match(PIN_IMAGE);
      if (!match || /^\/\d+x\d+_RS\//.test(url.pathname)) continue; // 頭像、看板小圖
      if (img.closest('video, [data-test-id*="avatar" i], [data-test-id*="board" i]')) continue;
      const key = `img:${match[1]}`;
      if (!found.has(key)) found.set(key, { kind: 'image', hash: match[1], ext: match[2], preview: url.href, pin: pinIdOf(img), seen: found.size });
    }
    for (const video of scope.querySelectorAll('video')) {
      const src = toAbsolute(video.currentSrc || video.src || video.querySelector('source')?.src);
      const match = src?.pathname.match(PIN_VIDEO);
      if (!match) continue;
      const key = `video:${match[2]}`;
      if (!found.has(key)) found.set(key, { kind: 'video', family: match[1], hash: match[2], preview: video.poster || '', pin: pinIdOf(video), seen: found.size });
    }
  }

  async function scanPinterest({ scroll }) {
    const pinPage = location.pathname.match(/^\/pin\/([\w-]+)/);
    const found = new Map();
    const notes = [];
    if (pinPage) {
      // Pin 頁：只拿主圖（含輪播、多頁的 Pin），不要下面「更多類似內容」的格狀清單。
      const main = document.querySelector('[data-test-id="closeup-body"], [data-test-id="pin-closeup"], [data-test-id="visual-content-container"]')
        || document.querySelector('[data-test-id="pin-closeup-image"]')?.closest('div[data-test-id]')?.parentElement
        || document.body;
      collectPins(found, main);
      for (const [key, entry] of found) {
        if (entry.pin && entry.pin !== pinPage[1]) found.delete(key); // 混進來的其他 Pin
        else entry.pin = pinPage[1]; // 主圖有時包在格狀容器裡，找不到 Pin ID
      }
    } else {
      const collect = () => document.querySelectorAll('[data-grid-item]').forEach(item => collectPins(found, item));
      collect();
      if (scroll) {
        notes.push(scrollNote(await scrollCollect(collect, () => found.size, 500)));
      } else {
        notes.push('Pinterest 只會載入畫面附近的 Pin；要一次列出更多，請在設定開啟「自動捲動載入」。');
      }
    }

    // 請 background 找出原圖真正的副檔名、影片的 MP4。
    const entries = [...found.values()].sort((a, b) => a.seen - b.seen);
    const items = entries.map(entry => ({
      key: entry.hash,
      candidates: entry.kind === 'image'
        ? [...new Set([entry.ext, 'jpg', 'png', 'gif', 'webp'])].map(ext => `https://i.pinimg.com/originals/${entry.hash}.${ext}`)
        : ['720p', '1080p', 'expmp4'].map(size => `https://v1.pinimg.com/videos/${entry.family}/${size}/${entry.hash}.mp4`)
    }));
    const resolved = items.length ? (await chrome.runtime.sendMessage({ type: 'FIRST_WORKING_URL', items }).catch(() => ({}))) || {} : {};

    const images = [];
    const perPin = new Map();
    let missingVideos = 0;
    let fallbacks = 0;
    for (const entry of entries) {
      const hit = resolved[entry.hash]; // { url, width, height }
      let url = hit?.url;
      if (!url && entry.kind === 'video') { missingVideos++; continue; }
      if (!url) { url = `https://i.pinimg.com/736x/${entry.hash}.${entry.ext}`; fallbacks++; }
      const ext = url.match(/\.(\w+)$/)[1];
      const n = (perPin.get(entry.pin) || 0) + 1;
      perPin.set(entry.pin, n);
      const base = entry.pin ? `${entry.pin}${n > 1 ? `_${n}` : ''}` : entry.hash.split('/').pop();
      images.push({
        url,
        preview: entry.preview || url,
        width: hit?.width || 0,
        height: hit?.height || 0,
        filename: `${base}.${ext}`,
        ...(entry.kind === 'video' ? { type: 'video' } : {})
      });
    }
    if (fallbacks) notes.push(`有 ${fallbacks} 張找不到原圖，改用 736px。`);
    if (missingVideos) notes.push(`有 ${missingVideos} 部影片找不到可下載的 MP4（只有串流版本）。`);

    const query = new URLSearchParams(location.search).get('q');
    const parts = location.pathname.split('/').filter(Boolean);
    const folder = pinPage ? 'pinterest/pins'
      : query ? `pinterest/search_${sanitize(query)}`
      : parts.length >= 2 && !['search', 'ideas', 'today'].includes(parts[0]) ? `pinterest/${sanitize(parts[0])}_${sanitize(parts[1])}`
      : `pinterest/${sanitize(parts[0] || 'home')}`;
    return { title: document.title, folder, images, note: notes.filter(Boolean).join(' ') };
  }

  // ---- 微博 ----
  // 用頁面自己用的貼文 API（/ajax/statuses/show），圖片取 largest（原圖），影片取畫質最高的 MP4。

  const extOf = url => new URL(url).pathname.match(/\.(\w+)$/)?.[1]?.toLowerCase() || 'jpg';

  // 影片：playback_list 裡解析度最高的 MP4，沒有的話用舊欄位。
  function weiboVideo(mediaInfo, cover) {
    if (!mediaInfo) return null;
    const best = (mediaInfo.playback_list || [])
      .map(entry => entry.play_info)
      .filter(info => info?.url && /mp4/.test(info.mime || ''))
      .sort((a, b) => (b.width * b.height || 0) - (a.width * a.height || 0))[0];
    const url = best?.url || mediaInfo.mp4_720p_mp4 || mediaInfo.mp4_hd_url || mediaInfo.mp4_sd_url || mediaInfo.stream_url_hd || mediaInfo.stream_url;
    if (!url) return null;
    return { url: url.replace(/^http:/, 'https:'), preview: cover || '', width: best?.width || 0, height: best?.height || 0, type: 'video', ext: 'mp4' };
  }

  // 一張圖（pic_infos 的項目）→ 0～2 個清單項目（Live Photo 有圖也有影片）。
  function weiboPicture(info) {
    const best = info.largest || info.original || info.large || info.mw2000;
    if (!best?.url) return [];
    const preview = (info.bmiddle || info.large || best).url;
    const items = [{ url: best.url, preview, width: best.width || 0, height: best.height || 0, ext: extOf(best.url) }];
    // Live Photo 另外附上動態的影片；GIF 的 largest 本身就是 .gif，不用再拿影片版。
    if (info.type === 'livephoto' && info.video) {
      const motion = info.video.replace(/^http:/, 'https:');
      items.push({ url: motion, preview, width: 0, height: 0, type: 'video', ext: extOf(motion) === 'mov' ? 'mov' : 'mp4' });
    }
    return items;
  }

  function weiboMedia(post) {
    const items = [];
    for (const entry of post.mix_media_info?.items || []) {
      if (entry.type === 'pic') items.push(...weiboPicture(entry.data));
      else if (entry.type === 'video') {
        const video = weiboVideo(entry.data?.media_info, entry.data?.page_pic);
        if (video) items.push(video);
      }
    }
    if (!items.length) {
      for (const id of post.pic_ids || []) if (post.pic_infos?.[id]) items.push(...weiboPicture(post.pic_infos[id]));
      if (post.page_info?.object_type === 'video') {
        const video = weiboVideo(post.page_info.media_info, post.page_info.page_pic);
        if (video) items.push(video);
      }
    }
    return items;
  }

  async function scanWeibo() {
    const id = location.pathname.split('/')[2];
    const response = await fetch(`/ajax/statuses/show?id=${encodeURIComponent(id)}`, { credentials: 'include' });
    const post = await response.json();
    if (!post.idstr) throw new Error(post.message || post.msg || '讀不到這則微博');
    // 轉發的貼文：自己沒有圖時，下載被轉發的那則。
    const source = !weiboMedia(post).length && post.retweeted_status ? post.retweeted_status : post;
    const user = source.user || post.user || {};
    const key = source.mblogid || source.idstr;
    // 新浪的圖片、影片伺服器對瀏覽器的請求要求微博的 Referer，否則回 403（縮圖、播放、下載都要）。
    const images = weiboMedia(source).map((item, i) => ({ ...item, filename: `${key}_${i + 1}.${item.ext}`, referer: 'https://weibo.com/' }));
    const notes = [];
    if (source !== post) notes.push('這是轉發的微博，列出的是原貼文的圖片。');
    if (!images.length) notes.push('這則微博沒有圖片或影片。');
    return {
      title: (source.text_raw || '').slice(0, 60) || document.title,
      folder: `weibo/${sanitize(`${user.screen_name || 'unknown'}_${user.idstr || ''}`)}`,
      images,
      note: notes.join(' ')
    };
  }

  // ---- Poipiku ----
  // 頁面上只有第一張的 640px 縮圖；其餘的要呼叫「展開」API（有密碼時要帶密碼），
  // 原圖網址要呼叫「全畫面」API 取得（需要登入）。兩個都是頁面自己用的 API。

  async function poipikuPost(path, data) {
    const response = await fetch(path, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
      body: new URLSearchParams(data)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  const parseHtml = html => new DOMParser().parseFromString(html || '', 'text/html');
  // 網站素材（R-18／警告／密碼的佔位圖、表情）不是作品圖。
  const isPoipikuArt = src => {
    try {
      const url = new URL(src, location.href);
      return /(^|\.)poipiku\.com$/.test(url.hostname) && !/^\/(img|assets)\//.test(url.pathname);
    } catch {
      return false;
    }
  };

  async function scanPoipiku() {
    const [, uid, iid] = location.pathname.match(/^\/(\d+)\/(\d+)\.html/);
    const item = document.getElementById(`IllustItem_${iid}`);
    // 密碼：讀你在頁面上密碼欄輸入的內容（不用另外輸入）。
    const passInput = item?.querySelector('input[name="PAS"], .IllustItemExpandPass');
    const password = (passInput?.value || '').trim();
    const userName = item?.querySelector('.IllustItemUserName')?.textContent.trim() || uid;
    const desc = (item?.querySelector('.IllustItemDesc')?.innerText || '').split('\n').find(line => line.trim()) || '';
    const folder = `poipiku/${sanitize(`${userName}_${uid}`)}/${sanitize(desc ? `${iid}_${desc.slice(0, 30)}` : iid)}`;
    const notes = [];

    // 每張圖的「全畫面」ID：第一張是 -1，其餘從展開 API 的 showIllustDetail(uid, iid, ID) 取得。
    const pages = [{ append: -1, thumb: item?.querySelector('.IllustItemThumbImg')?.src }];
    if (passInput && !password) {
      notes.push('這篇有密碼：請先在 Poipiku 頁面的密碼欄輸入密碼（不用按展開），再重新掃描。');
    }
    try {
      const appended = await poipikuPost('/f/ShowAppendFileF.jsp', { UID: uid, IID: iid, PAS: password, MD: 0, TWF: -1 });
      if (appended.result_num > 0) {
        for (const link of parseHtml(appended.html).querySelectorAll('[onclick*="showIllustDetail"]')) {
          const id = link.getAttribute('onclick').match(/showIllustDetail\(\s*\d+\s*,\s*\d+\s*,\s*(-?\d+)/)?.[1];
          if (id) pages.push({ append: Number(id), thumb: link.querySelector('img')?.src });
        }
      } else if (appended.result_num < 0 && !notes.length) {
        notes.push(password ? '密碼不正確，或這篇需要登入／追蹤作者才能看全部。' : '其餘的圖需要密碼、登入或追蹤作者才能看。');
      }
    } catch (error) {
      notes.push(`展開其餘圖片失敗（${error.message}）。`);
    }

    let fallback = 0;
    const problems = new Set(); // 取不到原圖的原因（顯示在狀態列，方便判斷）
    const seenFiles = new Set();
    const images = [];
    for (const page of pages) {
      let original = null;
      try {
        const detail = await poipikuPost('/f/ShowIllustDetailF.jsp', { ID: uid, TD: iid, AD: page.append, PAS: password });
        if (detail.result === 1) {
          const candidates = [...parseHtml(detail.html).querySelectorAll('img')]
            .flatMap(img => [img.getAttribute('src'), img.getAttribute('data-src')]);
          original = candidates.find(isPoipikuArt) || null;
          if (original) original = new URL(original, location.href).href;
          else problems.add(`全畫面沒有圖片網址：${(detail.html || '').replace(/\s+/g, ' ').slice(0, 150)}`);
        } else {
          // 代碼對照 Poipiku 自己的 trkDetailGate()：-2 是需要登入。
          problems.add(detail.error_code === -2
            ? '原圖需要登入 Poipiku 帳號才能取得（只按年齡確認不夠），登入後重新掃描即可'
            : `全畫面 API 回傳 result=${detail.result}、error_code=${detail.error_code}`);
        }
      } catch (error) {
        problems.add(`全畫面 API 失敗：${error.message}`);
      }
      const thumb = isPoipikuArt(page.thumb) ? page.thumb : null;
      const url = original || thumb;
      if (!url) continue;
      if (!original) fallback++;
      const path = new URL(url).pathname;
      // 登入後第一張會同時出現在頁面和展開結果裡；同一個檔案只列一次（網址參數是時效簽章，不比）。
      const fileKey = path.replace(/_\d+\.jpg$/, '');
      if (seenFiles.has(fileKey)) {
        if (!original) fallback--;
        continue;
      }
      seenFiles.add(fileKey);
      const ext = path.replace(/_\d+\.jpg$/, '').match(/\.(\w+)$/)?.[1] || 'jpg';
      images.push({
        url,
        preview: thumb || url,
        width: 0,
        height: 0,
        filename: `${iid}_${images.length + 1}.${original ? ext : 'jpg'}`, // 跳過佔位圖後重新編號
        referer: 'https://poipiku.com/'
      });
    }
    if (fallback) {
      notes.push(`有 ${fallback} 張取不到原圖，改列出縮小版：${[...problems].join('；')}。`);
      console.warn('Poipiku original lookup failed', [...problems]);
    }
    if (!images.length && !notes.length) notes.push('沒有找到圖片；R-18 作品需要先登入並開啟成人內容顯示。');
    return { title: desc || document.title, folder, images, note: notes.join(' ') };
  }

  // ---- X（Twitter）----
  // 圖片與 GIF 直接從頁面上的元素換成原檔網址；影片在頁面上是 blob:（串流），
  // 要向嵌入推文用的 syndication API 查 MP4 網址（由 background 代為 fetch）。

  const X_MEDIA = /^\/media\/([\w-]+)(?:\.(\w+))?/;
  const X_GIF_THUMB = /^\/tweet_video_thumb\/([\w-]+)/;
  const X_VIDEO_THUMB = /^\/(?:ext_tw_video_thumb|amplify_video_thumb)\/(\d+)/;
  const X_RESERVED = new Set(['home', 'explore', 'search', 'notifications', 'messages', 'i', 'settings', 'compose', 'bookmarks', 'lists']);

  // 從元素找出所屬推文：{ id, user, photoIndex }。
  function tweetOf(el) {
    const parse = href => href?.match(/^\/([^/]+)\/status\/(\d+)(?:\/(?:photo|video)\/(\d+))?/);
    let match = parse(el.closest('a[href*="/status/"]')?.getAttribute('href'));
    if (!match) {
      const article = el.closest('article');
      const link = article?.querySelector('a[href*="/status/"] time')?.closest('a');
      match = parse(link?.getAttribute('href'));
    }
    return match ? { user: match[1], id: match[2], photoIndex: Number(match[3]) || 0 } : null;
  }

  // 頁面上目前渲染出來的推文媒體；X 的時間軸是虛擬清單，捲動時要分次收集。
  function collectXMedia(found, root = document) {
    const add = (key, entry) => { if (!found.has(key)) found.set(key, { ...entry, seen: found.size }); };
    for (const img of root.querySelectorAll('img[src*="pbs.twimg.com/media/"]')) {
      if (img.closest('[data-testid="videoPlayer"], [data-testid="videoComponent"]')) continue; // 影片封面
      const url = toAbsolute(img.src);
      const match = url?.pathname.match(X_MEDIA);
      if (!match) continue;
      let format = match[2] || url.searchParams.get('format') || 'jpg';
      if (format === 'webp') format = 'jpg';
      add(`photo:${match[1]}`, {
        kind: 'photo',
        tweet: tweetOf(img),
        url: `https://pbs.twimg.com/media/${match[1]}?format=${format}&name=orig`,
        preview: img.src,
        mediaId: match[1],
        ext: format
      });
    }
    for (const video of root.querySelectorAll('video')) {
      const poster = toAbsolute(video.poster);
      const tweet = tweetOf(video);
      const gif = poster?.pathname.match(X_GIF_THUMB);
      if (gif) {
        // GIF 在 X 上其實是 MP4，網址可以直接由縮圖推出來。
        add(`gif:${gif[1]}`, { kind: 'gif', tweet, url: `https://video.twimg.com/tweet_video/${gif[1]}.mp4`, preview: poster.href, ext: 'mp4' });
        continue;
      }
      // 其他影片的封面可能在 *_video_thumb/ 或 /media/ 底下；網址要靠 API 查。
      const key = poster?.pathname.match(X_VIDEO_THUMB)?.[1] || poster?.pathname || tweet?.id;
      if (key) add(`video:${key}`, { kind: 'video', tweet, preview: poster?.href || '', ext: 'mp4' });
    }
  }

  async function fetchTweet(id) {
    // 嵌入推文（publish.twitter.com）用的公開 API；token 演算法與官方 react-tweet 相同。
    const token = ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
    const data = await chrome.runtime.sendMessage({ type: 'FETCH_X_TWEET', id, token });
    if (!data || data.error) throw new Error(data?.error || '查詢推文失敗');
    if (data.__typename === 'TweetTombstone' || !data.id_str) throw new Error('推文無法公開查詢（可能是敏感內容或已刪除）');
    return data;
  }

  // syndication 的 mediaDetails → 清單項目。
  function mediaFromTweet(data) {
    return (data.mediaDetails || []).map((media, i) => {
      const base = { width: media.original_info?.width || 0, height: media.original_info?.height || 0, preview: `${media.media_url_https}?name=small`, user: data.user?.screen_name };
      const name = `${data.id_str}_${i + 1}`;
      if (media.type === 'photo') {
        const ext = media.media_url_https.match(/\.(\w+)$/)?.[1] || 'jpg';
        return { ...base, url: `${media.media_url_https}?name=orig`, filename: `${name}.${ext}`, mediaKey: `photo:${media.media_url_https.match(/\/media\/([\w-]+)/)?.[1]}` };
      }
      const best = (media.video_info?.variants || [])
        .filter(variant => variant.content_type === 'video/mp4')
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
      if (!best) return null;
      return { ...base, url: best.url, filename: `${name}.mp4`, type: 'video', gif: media.type === 'animated_gif' };
    }).filter(Boolean);
  }

  async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        try { results[index] = await fn(items[index]); } catch (error) { results[index] = error; }
      }
    }));
    return results;
  }

  async function scanX({ scroll }) {
    const status = location.pathname.match(/^\/([^/]+)\/status\/(\d+)/);
    const pageUser = status?.[1] || location.pathname.split('/')[1];
    const userPage = pageUser && !X_RESERVED.has(pageUser.toLowerCase());
    const folder = userPage ? `x/${sanitize(pageUser)}` : `x/${sanitize(location.pathname.split('/').filter(Boolean).join('_') || 'home')}`;
    const notes = [];

    // 單則推文頁：直接查 API，順序、原始尺寸、影片都最完整。
    if (status) {
      try {
        const data = await fetchTweet(status[2]);
        const images = mediaFromTweet(data);
        if (images.length) return { title: `@${data.user?.screen_name || pageUser} ${data.text || ''}`.slice(0, 80), folder: `x/${sanitize(data.user?.screen_name || pageUser)}`, images };
      } catch (error) {
        notes.push(`${error.message}，改從頁面讀取。`);
      }
    }

    // 時間軸／媒體頁（或 API 查不到時）：收集頁面上的媒體。
    const found = new Map();
    let root = document;
    if (status) {
      // 只取主推文，不要回覆串裡的圖。
      const main = [...document.querySelectorAll('article')].find(article => tweetOf(article.querySelector('time') || article)?.id === status[2]);
      if (main) root = main;
    }
    collectXMedia(found, root);
    if (scroll && !status) {
      notes.push(scrollNote(await scrollCollect(() => collectXMedia(found), () => found.size, 400)));
    }

    // 再向 API 查每則推文：頁面上只有縮圖網址，查了才有原始尺寸，影片也才有 MP4 網址。
    // 有影片的推文優先；查不到的（敏感內容、超過上限）沿用頁面上的資料。
    const entries = [...found.values()];
    const tweetIds = [...new Set(entries.filter(entry => entry.tweet).map(entry => entry.tweet.id))];
    const hasVideo = new Set(entries.filter(entry => entry.kind === 'video' && entry.tweet).map(entry => entry.tweet.id));
    const lookup = [...tweetIds.filter(id => hasVideo.has(id)), ...tweetIds.filter(id => !hasVideo.has(id))].slice(0, 150);
    const fromApi = new Map();
    const results = await mapLimit(lookup, 4, fetchTweet);
    results.forEach((result, i) => {
      const media = result instanceof Error ? [] : mediaFromTweet(result);
      if (media.length) fromApi.set(lookup[i], media);
    });
    const missingVideos = entries.filter(entry => entry.kind === 'video' && !fromApi.has(entry.tweet?.id)).length;
    if (missingVideos) notes.push(`有 ${missingVideos} 部影片查不到下載網址（可能是敏感內容），只列出圖片和 GIF。`);
    if (!scroll && !status) notes.push('時間軸只會載入畫面附近的推文；要一次列出更多，請在設定開啟「自動捲動載入」。');

    // API 查不到的圖片（例如敏感內容）只能從縮圖推原圖網址，請 background 試出正確格式。
    const guessing = entries.filter(entry => entry.kind === 'photo' && !fromApi.has(entry.tweet?.id));
    let resolvedFormats = {};
    if (guessing.length) {
      resolvedFormats = await chrome.runtime.sendMessage({
        type: 'RESOLVE_X_FORMATS',
        items: guessing.map(entry => ({ id: entry.mediaId, guess: entry.ext }))
      }).catch(() => ({})) || {};
    }

    // 依出現順序排列，同一則推文的媒體編號 _1、_2…
    const images = [];
    const counters = new Map();
    const usedApi = new Set();
    const prefix = tweet => (userPage || !tweet ? '' : `${sanitize(tweet.user)}_`);
    for (const entry of entries.sort((a, b) => a.seen - b.seen)) {
      const tweetId = entry.tweet?.id;
      if (tweetId && fromApi.has(tweetId)) {
        if (usedApi.has(tweetId)) continue;
        usedApi.add(tweetId);
        for (const item of fromApi.get(tweetId)) images.push({ ...item, filename: prefix({ user: item.user || entry.tweet.user }) + item.filename });
        continue;
      }
      if (entry.kind === 'video') continue;
      if (entry.kind === 'photo') {
        // 原圖（name=orig）要用正確的格式，縮圖的格式不一定一樣；格式猜錯會 404。
        const format = resolvedFormats[entry.mediaId];
        if (format) {
          entry.ext = format;
          entry.url = `https://pbs.twimg.com/media/${entry.mediaId}?format=${format}&name=orig`;
        } else {
          // 查不出來時改用 4096x4096：任何格式都拿得到，只有超過 4096 的超大圖會被縮小。
          entry.url = `https://pbs.twimg.com/media/${entry.mediaId}?format=${entry.ext}&name=4096x4096`;
        }
      }
      const n = entry.tweet ? (counters.get(tweetId) || 0) + 1 : 0;
      if (entry.tweet) counters.set(tweetId, n);
      const base = entry.tweet ? `${tweetId}_${entry.tweet.photoIndex || n}` : entry.url.match(/\/(?:media|tweet_video)\/([\w-]+)/)[1];
      images.push({
        url: entry.url,
        preview: entry.preview,
        width: 0,
        height: 0,
        filename: `${prefix(entry.tweet)}${base}.${entry.ext}`,
        ...(entry.kind === 'gif' ? { type: 'video', gif: true } : {})
      });
    }
    // 同一張圖可能因為檔名規則重複出現（例如 API 與頁面都有），以網址去重。
    const unique = [...new Map(images.map(image => [image.url, image])).values()];
    return { title: document.title, folder, images: unique, note: notes.filter(Boolean).join(' ') };
  }

  const generic = {
    name: '一般網頁',
    async scan({ scroll }) {
      // 一般網頁捲完再收集；張數以頁面上的圖片數估算。
      const reason = scroll ? await scrollCollect(() => {}, () => document.images.length, 300) : 'end';
      return {
        title: document.title,
        folder: `page-images/${sanitize(location.hostname)}`,
        images: collectFromDom(),
        note: scrollNote(reason)
      };
    }
  };

  globalThis.__imageBatchScan = async (options = {}) => {
    const adapter = adapters.find(item => item.match()) || generic;
    try {
      const result = await adapter.scan(options);
      return { source: adapter.name, ...result };
    } catch (error) {
      // 專用轉接器失敗時退回一般掃描，至少列出頁面上的圖。
      if (adapter === generic) throw error;
      const result = await generic.scan(options);
      return { source: generic.name, ...result, note: `${adapter.name} 解析失敗（${error.message}），改用一般掃描。` };
    }
  };
})();
