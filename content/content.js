(() => {
  if (globalThis.__xasContentScriptLoaded) return;
  globalThis.__xasContentScriptLoaded = true;
  'use strict';

  /* ── Article Mode ── */
  function parseStatusUrl(url) {
    if (!url) return null;
    try {
      const { pathname } = new URL(url, location.origin);
      let m = pathname.match(/^\/([^/]+)\/status\/(\d+)/);
      if (m) return { username: m[1], statusId: m[2] };
      m = pathname.match(/^\/i\/web\/status\/(\d+)/);
      if (m) return { username: null, statusId: m[1] };
    } catch (_) {}
    return null;
  }

  function findCanonicalStatusUrl(statusId) {
    const candidates = [
      document.querySelector('link[rel="canonical"]')?.href,
      document.querySelector('meta[property="og:url"]')?.content,
      ...Array.from(document.querySelectorAll(`a[href*="/status/${statusId}"]`), el => el.href)
    ];
    return candidates.find(url => {
      const info = parseStatusUrl(url);
      return info?.statusId === statusId && !!info.username;
    }) || null;
  }

  function getArticleUrl() {
    const current = parseStatusUrl(location.href);
    if (!current) return null;

    let username = current.username;
    if (!username) {
      const canonicalUrl = findCanonicalStatusUrl(current.statusId);
      username = parseStatusUrl(canonicalUrl)?.username || null;
    }

    if (username) {
      return `${location.origin}/${username}/article/${current.statusId}`;
    }
    return null;
  }

  function enterArticleMode() {
    const articleUrl = getArticleUrl();
    if (articleUrl) {
      location.href = articleUrl;
    } else if (location.pathname.includes('/article/')) {
      injectCleanCSS();
    }
  }

  function exitArticleMode() {
    const url = location.href;
    const m = url.match(/^(https:\/\/(?:x|twitter)\.com\/)([^/]+)\/article\/(\d+)/);
    if (m) {
      location.href = `${m[1]}${m[2]}/status/${m[3]}`;
    }
  }

  function injectCleanCSS() {
    if (document.getElementById('xas-clean-style')) return;
    const style = document.createElement('style');
    style.id = 'xas-clean-style';
    style.textContent = `
      /* X Article Snap – clean article view */
      [data-testid="TopNavBar"],
      [data-testid="sidebarColumn"],
      nav[aria-label="Primary"],
      [aria-label="Trending"],
      [data-testid="BottomBar"],
      [data-testid="DMDrawer"],
      [data-testid="ScrollSnap-SwipeableList"],
      aside[role="complementary"],
      [role="complementary"] {
        display: none !important;
      }
      [data-testid="primaryColumn"] {
        max-width: 680px !important;
        padding: 20px 16px !important;
      }
      main[role="main"] {
        overflow-y: auto !important;
      }
    `;
    document.head.appendChild(style);
    document.body.classList.add('xas-article-mode');
    observeAndHide();
    startCenteringLoop();
  }

  /* ── Center column (setInterval beats React node replacement) ── */
  let _centerInterval = null;
  let _hideObserver = null;

  function stopObserveAndHide() {
    if (_hideObserver) {
      _hideObserver.disconnect();
      _hideObserver = null;
    }
    // 清理所有被隐藏的元素的 inline style
    const selectors = [
      '[data-testid="TopNavBar"]',
      '[data-testid="sidebarColumn"]',
      'nav[aria-label="Primary"]',
      '[data-testid="BottomBar"]',
      '[role="complementary"]',
      'header[role="banner"]'
    ];
    selectors.forEach(sel => {
      document.querySelectorAll(sel).forEach(el => {
        el.style.removeProperty('display');
      });
    });
  }

  function forceCenterColumn() {
    const col = document.querySelector('[data-testid="primaryColumn"]');
    if (!col) return;
    /* 1) Flex/margin approach (may work on its own) */
    col.style.setProperty('max-width', '680px', 'important');
    col.style.setProperty('width', '680px', 'important');
    col.style.setProperty('min-width', '0', 'important');
    col.style.setProperty('flex', '0 0 auto', 'important');
    col.style.setProperty('margin-left', 'auto', 'important');
    col.style.setProperty('margin-right', 'auto', 'important');
    let el = col.parentElement;
    for (let i = 0; i < 8 && el && el !== document.documentElement; i++, el = el.parentElement) {
      const cs = window.getComputedStyle(el);
      if (cs.display === 'flex' && !cs.flexDirection.includes('column')) {
        el.style.setProperty('justify-content', 'center', 'important');
        el.style.setProperty('align-items', 'flex-start', 'important');
      }
    }
    /* 2) Transform fallback: re-query in rAF to avoid stale node after React re-render */
    requestAnimationFrame(() => {
      const fresh = document.querySelector('[data-testid="primaryColumn"]');
      if (!fresh) return;
      const r = fresh.getBoundingClientRect();
      if (r.width < 10) return;
      const vw = window.innerWidth;
      const targetLeft = (vw - r.width) / 2;
      const offset = targetLeft - r.left;
      if (Math.abs(offset) > 3) {
        fresh.style.setProperty('transform', `translateX(${Math.round(offset)}px)`, 'important');
      } else {
        fresh.style.removeProperty('transform');
      }
    });
  }

  function startCenteringLoop() {
    if (_centerInterval) return;
    forceCenterColumn();
    _centerInterval = setInterval(forceCenterColumn, 200);
  }

  function stopCenteringLoop() {
    clearInterval(_centerInterval);
    _centerInterval = null;
  }

  function observeAndHide() {
    if (_hideObserver) return; // 避免重复创建
    const selectors = [
      '[data-testid="TopNavBar"]',
      '[data-testid="sidebarColumn"]',
      'nav[aria-label="Primary"]',
      '[data-testid="BottomBar"]',
      '[role="complementary"]'
    ];
    _hideObserver = new MutationObserver(() => {
      selectors.forEach(sel => {
        document.querySelectorAll(sel).forEach(el => {
          el.style.setProperty('display', 'none', 'important');
        });
      });
    });
    _hideObserver.observe(document.body, { childList: true, subtree: true });
  }

  /* ── Auto-detect article page ── */
  function autoInit() {
    // 不再自动注入CSS，只在截图时调用 hideElementsForCapture
    // 保持函数用于其他初始化逻辑
  }

  let captureAborted = false;

  /* ── Markdown Extraction ── */
  async function extractMarkdown() {
    try {
      const docClone = document.cloneNode(true);
      const reader = new Readability(docClone, { keepClasses: true });
      const article = reader.parse();

      if (!article) return { success: false, error: '无法提取文章内容' };

      const td = new TurndownService({
        headingStyle: 'atx',
        codeBlockStyle: 'fenced',
        bulletListMarker: '-'
      });

      td.addRule('images', {
        filter: 'img',
        replacement: (_, node) => {
          const src = node.getAttribute('src') || '';
          const alt = node.getAttribute('alt') || '图片';
          if (!src || src.startsWith('data:')) return '';
          return `![${alt}](${src})`;
        }
      });

      const date = new Date().toISOString().slice(0, 10);
      const author = article.byline ? `\n作者：${article.byline}` : '';
      const source = `\n来源：${location.href}`;
      const header = `# ${article.title}\n${author}${source}\n日期：${date}\n\n---\n\n`;
      const body = td.turndown(article.content);
      const markdown = header + body;

      const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const safeTitle = (article.title || 'article').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
      a.download = `${safeTitle}_${date}.md`;
      a.href = url;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 5000);

      return { success: true, markdown };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }


  function hideElementsForCapture() {
    const style = document.createElement('style');
    style.id = 'xas-capture-style';
    style.textContent = `
      body.xas-capturing [data-testid="TopNavBar"],
      body.xas-capturing [data-testid="BottomBar"],
      body.xas-capturing [data-testid="DMDrawer"],
      body.xas-capturing [data-testid="ScrollSnap-SwipeableList"],
      body.xas-capturing nav[aria-label="Primary"],
      body.xas-capturing header[role="banner"],
      body.xas-capturing [data-testid="sidebarColumn"],
      body.xas-capturing aside[role="complementary"],
      body.xas-capturing [role="complementary"] {
        display: none !important;
      }
      body.xas-capturing ::-webkit-scrollbar { display: none !important; }
    `;
    document.head.appendChild(style);
    document.body.classList.add('xas-capturing');

    return () => {
      document.body.classList.remove('xas-capturing');
      document.getElementById('xas-capture-style')?.remove();
    };
  }

  /* ── Scroll Capture ── */
  async function startScrollCapture(options) {
    const reportProgress = (pct, text) => {
      chrome.runtime.sendMessage({ action: 'screenshotProgress', pct, text });
    };

    captureAborted = false;
    reportProgress(5, '获取页面信息...');

    await waitForContent();

    const dpr = (options.retina !== false) ? Math.min(window.devicePixelRatio || 1, 2) : 1;
    const viewW = window.innerWidth;
    const viewH = window.innerHeight;

    const origScrollY = window.scrollY;
    const origOverflow = document.documentElement.style.overflow;
    const restoreHidden = hideElementsForCapture();
    let captureSessionId = null;
    let stitchingStarted = false;

    try {
      document.documentElement.style.overflow = 'hidden';
      window.scrollTo(0, 0);
      await sleep(600);

      /* 只在 article 页面执行居中逻辑 */
      const isArticlePage = location.pathname.includes('/article/');
      if (isArticlePage) {
        forceCenterColumn();
        await sleep(300);
        forceCenterColumn();
        await sleep(60);
      }

      /* crop to article column */
      const colSel = '[data-testid="primaryColumn"], main[role="main"] > div, main[role="main"]';
      const col = document.querySelector('[data-testid="primaryColumn"]') ||
                  document.querySelector('main[role="main"] > div') ||
                  document.querySelector('main[role="main"]');
      let cropLeft = 0, cropRight = viewW;
      if (col) {
        const r = col.getBoundingClientRect();
        /* Only use bounds if they look sane (>100px wide and <90% of viewport) */
        if (r.width > 100 && r.width < viewW * 0.9) {
          cropLeft = Math.max(0, Math.floor(r.left));
          cropRight = Math.min(viewW, Math.ceil(r.right));
        }
      }
      reportProgress(9, `裁剪: ${cropLeft}–${cropRight}px`);

      /* determine capture height */
      let totalH = Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight
      );

      /* on status pages, stop before comments */
      const isStatusPage = /\/status\/\d+/.test(location.pathname) &&
                           !/\/article\//.test(location.pathname);
      if (isStatusPage && col) {
        /* 找到主推文：在 primaryColumn 内，且在主要内容区域，不是推荐 */
        const articles = col.querySelectorAll('article[data-testid="tweet"]');
        let mainTweet = null;
        /* X 平台 /status/ 页面的主推文通常是第一个 article，但需要验证 */
        for (const art of articles) {
          /* 排除侧边栏和推荐区域 */
          const parentSection = art.closest('section[role="region"]');
          const isInRecommended = parentSection && (
            parentSection.textContent.includes('推荐') ||
            parentSection.getAttribute('aria-label')?.includes('Related') ||
            art.closest('[data-testid="sidebarColumn"]') !== null
          );
          /* 主推文应该有互动按钮组 */
          const hasActionBar = art.querySelector('[role="group"][aria-label]') !== null ||
                               art.querySelector('[data-testid="tweetText"]') !== null;
          if (!isInRecommended && hasActionBar) {
            mainTweet = art;
            break;
          }
        }
        /* 如果没找到，回退到第一个 */
        if (!mainTweet && articles.length > 0) {
          mainTweet = articles[0];
        }
        if (mainTweet) {
          const rect = mainTweet.getBoundingClientRect();
          const artBottom = rect.bottom + window.scrollY;
          /* 精确截到推文底部，不加额外边距 */
          totalH = Math.min(totalH, artBottom + 20);
        }
      }

      captureSessionId = createCaptureSessionId();
      const sessionResp = await sendToOffscreen({ action: 'resetCaptureSession', captureSessionId });
      if (sessionResp?.error) {
        throw new Error(sessionResp.error || '初始化截图缓存失败');
      }

      let scrollY = 0;
      const step = viewH;
      const steps = Math.ceil(totalH / step);

      let lastCaptureTime = 0;
      for (let i = 0; i < steps; i++) {
        if (captureAborted) throw new Error('截图已取消');
        window.scrollTo(0, scrollY);
        const elapsed = Date.now() - lastCaptureTime;
        await sleep(Math.max(400, 700 - elapsed));
        if (captureAborted) throw new Error('截图已取消');

        /* 每次截图前重新隐藏导航栏（防止 React 重新渲染） */
        document.querySelectorAll('[data-testid="TopNavBar"], [data-testid="BottomBar"], nav[aria-label="Primary"], header[role="banner"]').forEach(el => {
          el.style.setProperty('display', 'none', 'important');
        });
        await sleep(100);

        reportProgress(10 + Math.floor((i / steps) * 70), `截图 ${i + 1}/${steps}...`);

        lastCaptureTime = Date.now();
        const resp = await chrome.runtime.sendMessage({ action: 'captureVisibleTab' });
        if (resp?.error) throw new Error(resp.error);
        if (!resp?.dataUrl) throw new Error('截图返回为空');

        const actualScrollY = Math.min(scrollY, Math.max(0, totalH - viewH));
        const frameResp = await sendToOffscreen({
          action: 'appendCaptureFrame',
          captureSessionId,
          capture: {
            dataUrl: resp.dataUrl,
            scrollY: actualScrollY,
            viewH,
            viewW,
            totalH
          }
        });
        if (frameResp?.error) {
          throw new Error(frameResp.error || '缓存截图帧失败');
        }

        scrollY += step;
        if (scrollY >= totalH) break;
      }

      reportProgress(85, '拼接图像...');

      stitchingStarted = true;

      sendToOffscreen({
        action: 'stitchScreenshots',
        captureSessionId,
        totalH,
        viewW,
        dpr,
        cropLeft,
        cropRight,
        options,
        title: document.title?.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || 'screenshot'
      }).then(resp => {
        if (resp?.error) {
          chrome.runtime.sendMessage({ action: 'screenshotError', error: resp.error }).catch(() => {});
        }
      }).catch(e => {
        sendToOffscreen({ action: 'clearCaptureSession', captureSessionId }).catch(() => {});
        chrome.runtime.sendMessage({ action: 'screenshotError', error: e?.message || '拼接失败' }).catch(() => {});
      });
    } finally {
      if (captureSessionId && !stitchingStarted) {
        sendToOffscreen({ action: 'clearCaptureSession', captureSessionId }).catch(() => {});
      }
      captureAborted = false;
      restoreHidden();
      document.documentElement.style.overflow = origOverflow;
      window.scrollTo(0, origScrollY);
      /* 清理可能残留的内联样式 */
      const col = document.querySelector('[data-testid="primaryColumn"]');
      if (col) {
        col.style.removeProperty('max-width');
        col.style.removeProperty('width');
        col.style.removeProperty('min-width');
        col.style.removeProperty('flex');
        col.style.removeProperty('margin-left');
        col.style.removeProperty('margin-right');
        col.style.removeProperty('transform');
      }
      /* 移除 article mode 的样式和类 */
      document.getElementById('xas-clean-style')?.remove();
      document.body.classList.remove('xas-article-mode');
      stopCenteringLoop();
      stopObserveAndHide();
    }
  }

  async function sendToOffscreen(msg) {
    return chrome.runtime.sendMessage(msg);
  }

  async function waitForContent() {
    return new Promise(resolve => {
      const root = document.body || document.documentElement;
      if (!root) {
        resolve();
        return;
      }
      let settled = false;
      const observer = new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          observer.disconnect();
          settled = true;
          resolve();
        }, 800);
      });
      let timer = setTimeout(() => {
        observer.disconnect();
        if (!settled) resolve();
      }, 3000);
      observer.observe(root, { childList: true, subtree: true });
    });
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  function createCaptureSessionId() {
    return `xas-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  /* ── Message listener ── */
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const handle = async () => {
      switch (msg.action) {
        case 'ping':               return { ok: true };
        case 'enterArticleMode':   enterArticleMode();  return { ok: true };
        case 'exitArticleMode':    exitArticleMode();   return { ok: true };
        case 'extractMarkdown':    return await extractMarkdown();
        case 'cancelCapture':
          captureAborted = true;
          return { ok: true };
        case 'startScrollCapture':
          startScrollCapture(msg.options || {}).catch(e => {
            chrome.runtime.sendMessage({ action: 'screenshotError', error: e.message });
          });
          return { ok: true, started: true };
        default:
          return { ok: false, error: 'unknown action' };
      }
    };
    handle().then(sendResponse);
    return true;
  });

  /* ── SPA navigation observer ── */
  let lastUrl = location.href;
  const navObserver = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(autoInit, 1200);
    }
  });
  navObserver.observe(document, { subtree: true, childList: true });

  autoInit();
})();
