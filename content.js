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

  // 一路捲到底，讓延遲載入的圖片出現，最後捲回原位。
  async function autoScroll() {
    const startY = scrollY;
    let lastHeight = 0;
    for (let i = 0; i < 60; i++) {
      scrollBy(0, innerHeight * 0.9);
      await sleep(250);
      const atBottom = innerHeight + scrollY >= document.documentElement.scrollHeight - 4;
      if (atBottom) {
        if (document.documentElement.scrollHeight === lastHeight) break;
        lastHeight = document.documentElement.scrollHeight;
        await sleep(600);
      }
    }
    scrollTo(0, startY);
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
          if (scroll) await autoScroll();
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
        const images = collectFromDom({ roots: roots.filter(Boolean), upgrade, skip })
          .filter(image => !/\/assets\//.test(new URL(image.url).pathname))
          .map(image => ({ ...image, referer: 'https://www.postype.com/' }));
        return { title, folder, images };
      }
    },
    {
      name: 'X',
      match: () => /(^|\.)(x|twitter)\.com$/.test(location.hostname),
      scan: scanX
    }
  ];

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
      const startY = scrollY;
      let lastHeight = 0;
      for (let i = 0; i < 80; i++) {
        scrollBy(0, innerHeight * 0.8);
        await sleep(400);
        collectXMedia(found);
        const atBottom = innerHeight + scrollY >= document.documentElement.scrollHeight - 4;
        if (atBottom) {
          if (document.documentElement.scrollHeight === lastHeight) break;
          lastHeight = document.documentElement.scrollHeight;
          await sleep(1000);
          collectXMedia(found);
        }
      }
      scrollTo(0, startY);
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
    return { title: document.title, folder, images: unique, note: notes.join(' ') };
  }

  const generic = {
    name: '一般網頁',
    async scan({ scroll }) {
      if (scroll) await autoScroll();
      return {
        title: document.title,
        folder: `page-images/${sanitize(location.hostname)}`,
        images: collectFromDom()
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
