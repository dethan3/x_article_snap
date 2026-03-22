const OFFSCREEN_URL = chrome.runtime.getURL('offscreen/offscreen.html');
const CONTENT_SCRIPT_FILES = ['libs/readability.js', 'libs/turndown.js', 'content/content.js'];

let offscreenCreating = null;

async function ensureOffscreen() {
  if (offscreenCreating) { await offscreenCreating; return; }
  try {
    const existing = await chrome.offscreen.hasDocument?.();
    if (existing) return;
  } catch (_) {}
  offscreenCreating = chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['DOM_SCRAPING'],
    justification: 'Canvas stitching for full-page screenshot'
  }).catch(e => {
    if (!e.message?.includes('only one')) throw e;
  });
  try {
    await offscreenCreating;
  } finally {
    offscreenCreating = null;
  }
}

async function closeOffscreen() {
  try { await chrome.offscreen.closeDocument(); } catch (_) {}
}

async function sendMessageToContent(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (e) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: CONTENT_SCRIPT_FILES
    });
    await new Promise(r => setTimeout(r, 300));
    return await chrome.tabs.sendMessage(tabId, msg);
  }
}

async function downloadScreenshot(url, filename) {
  return new Promise(resolve => {
    chrome.downloads.download({ url, filename, saveAs: false }, downloadId => {
      if (chrome.runtime.lastError || !downloadId) {
        resolve({
          ok: false,
          error: chrome.runtime.lastError?.message || '下载失败'
        });
        return;
      }

      resolve({ ok: true, downloadId });
    });
  });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'xas-screenshot',
    title: 'X Article Snap — 高清截图',
    contexts: ['page'],
    documentUrlPatterns: ['https://x.com/*', 'https://twitter.com/*']
  });
  chrome.contextMenus.create({
    id: 'xas-markdown',
    title: 'X Article Snap — 转 Markdown',
    contexts: ['page'],
    documentUrlPatterns: ['https://x.com/*', 'https://twitter.com/*']
  });
  chrome.contextMenus.create({
    id: 'xas-article',
    title: 'X Article Snap — 切换阅读模式',
    contexts: ['page'],
    documentUrlPatterns: ['https://x.com/*', 'https://twitter.com/*']
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab) return;
  const opts = await chrome.storage.local.get({ retina: true, longMode: true, watermark: false, watermarkText: '' });
  if (info.menuItemId === 'xas-screenshot') {
    handleScreenshot(tab.id, { ...opts, mode: 'png' });
  } else if (info.menuItemId === 'xas-markdown') {
    sendMessageToContent(tab.id, { action: 'extractMarkdown' }).catch(() => {});
  } else if (info.menuItemId === 'xas-article') {
    sendMessageToContent(tab.id, { action: 'enterArticleMode' }).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'startScreenshot') {
    handleScreenshot(msg.tabId, msg.options || {});
    sendResponse({ ok: true });
    return false;
  }

  if (msg.action === 'captureVisibleTab') {
    const tabId = sender.tab?.id;
    if (!tabId) { sendResponse({ error: 'no tab' }); return false; }
    chrome.tabs.captureVisibleTab(
      sender.tab.windowId,
      { format: 'png', quality: 100 },
      dataUrl => {
        if (chrome.runtime.lastError) {
          sendResponse({ error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ dataUrl });
        }
      }
    );
    return true;
  }

  if (msg.action === 'downloadScreenshot') {
    const downloadUrl = msg.url || msg.dataUrl;
    if (!downloadUrl) {
      sendResponse({ ok: false, error: '下载地址为空' });
      return false;
    }
    downloadScreenshot(downloadUrl, msg.filename).then(sendResponse);
    return true;
  }

  if (msg.action === 'screenshotProgress') {
    notifyPopup(msg);
    sendResponse({ ok: true });
    return false;
  }

  if (msg.action === 'screenshotError') {
    notifyPopup(msg);
    closeOffscreen();
    sendResponse({ ok: true });
    return false;
  }

  if (msg.action === 'screenshotComplete') {
    closeOffscreen();
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

async function handleScreenshot(tabId, options) {
  notifyPopup({ action: 'screenshotProgress', pct: 5, text: '初始化...' });
  try {
    if (!tabId) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      tabId = tab?.id;
    }
    if (!tabId) throw new Error('无法获取当前标签页');
    await ensureOffscreen();
    await sendMessageToContent(tabId, {
      action: 'startScrollCapture',
      options
    });
  } catch (e) {
    await closeOffscreen();
    notifyPopup({ action: 'screenshotError', error: '截图启动失败: ' + e.message });
  }
}

function notifyPopup(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}
