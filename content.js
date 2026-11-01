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
    }
  ];

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
