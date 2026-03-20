const $ = id => document.getElementById(id);
const CONTENT_SCRIPT_FILES = ['libs/readability.js', 'libs/turndown.js', 'content/content.js'];

let currentTab = null;
let settings = {};

async function loadSettings() {
  return new Promise(resolve => {
    chrome.storage.local.get(
      { watermark: false, watermarkText: '', retina: true },
      data => { resolve(data); }
    );
  });
}

async function saveSettings(patch) {
  return new Promise(resolve => {
    chrome.storage.local.set(patch, resolve);
  });
}

function toast(msg, type = 'info', duration = 3000) {
  const area = $('toastArea');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  const icons = { success: '✓', error: '✕', info: 'ℹ' };
  const icon = document.createElement('span');
  icon.textContent = icons[type] || '';
  const text = document.createElement('span');
  text.textContent = msg;
  el.append(icon, text);
  area.appendChild(el);
  setTimeout(() => el.remove(), duration);
}

function setProgress(pct, text) {
  const area = $('progressArea');
  area.style.display = pct >= 0 ? 'flex' : 'none';
  if (pct >= 0) {
    $('progressBar').style.width = pct + '%';
    $('progressText').textContent = text || '';
  }
}

function setStatus(state) {
  const dot = $('statusDot');
  dot.className = 'status-dot status-' + state;
}

async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function isXTab(url) {
  return url && (url.includes('x.com') || url.includes('twitter.com'));
}

function isArticleUrl(url) {
  return url && url.includes('/article/');
}

function isStatusUrl(url) {
  return url && /\/(status|i\/web\/status)\/\d+/.test(url);
}

function setAllButtonsDisabled(disabled) {
  ['btnArticleMode', 'btnScreenshot', 'btnMarkdown'].forEach(id => {
    $(id).disabled = disabled;
  });
}

async function sendToContent(msg) {
  try {
    return await chrome.tabs.sendMessage(currentTab.id, msg);
  } catch (e) {
    await chrome.scripting.executeScript({
      target: { tabId: currentTab.id },
      files: CONTENT_SCRIPT_FILES
    });
    await new Promise(r => setTimeout(r, 300));
    return await chrome.tabs.sendMessage(currentTab.id, msg);
  }
}

async function init() {
  currentTab = await getCurrentTab();
  settings = await loadSettings();

  applySettingsToUI();

  if (!isXTab(currentTab?.url)) {
    $('notOnX').style.display = 'flex';
    $('mainPanel').style.display = 'none';
    setStatus('idle');
    return;
  }

  setStatus('ok');

  const url = currentTab.url;
  const pageInfo = $('pageInfo');
  const tag = $('pageTypeTag');
  const titleEl = $('pageTitle');

  if (isArticleUrl(url)) {
    tag.textContent = '📖 Article 模式';
    tag.className = 'tag tag-article';
    $('btnArticleMode').textContent = '← 退出阅读模式';
  } else if (isStatusUrl(url)) {
    tag.textContent = '🐦 Status 页面';
    tag.className = 'tag tag-status';
    $('btnArticleMode').innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z" fill="currentColor"/></svg>
      切换纯阅读模式`;
  } else {
    tag.textContent = 'X 页面';
    tag.className = 'tag';
  }

  try {
    titleEl.textContent = currentTab.title?.replace(' / X', '').replace(' / Twitter', '') || '';
  } catch (_) {}
}

function applySettingsToUI() {
  $('optWatermark').checked = settings.watermark || false;
  $('optRetina').checked = settings.retina !== false;
  $('watermarkText').value = settings.watermarkText || '';
  $('watermarkRow').style.display = settings.watermark ? 'block' : 'none';
}

$('btnArticleMode').addEventListener('click', async () => {
  if (!currentTab) return;
  setStatus('busy');
  try {
    if (isArticleUrl(currentTab.url)) {
      await sendToContent({ action: 'exitArticleMode' });
    } else {
      await sendToContent({ action: 'enterArticleMode' });
    }
    await new Promise(r => setTimeout(r, 600));
    currentTab = await getCurrentTab();
    await init();
  } catch (e) {
    toast('切换失败: ' + e.message, 'error');
    setStatus('ok');
  }
});

$('btnScreenshot').addEventListener('click', async () => {
  if (!currentTab) return;
  setAllButtonsDisabled(true);
  setStatus('busy');
  setProgress(0, '准备截图...');
  try {
    await chrome.runtime.sendMessage({
      action: 'startScreenshot',
      tabId: currentTab.id,
      options: {
        retina: settings.retina !== false,
        watermark: settings.watermark,
        watermarkText: settings.watermarkText,
        mode: 'png'
      }
    });
  } catch (e) {
    toast('截图失败: ' + e.message, 'error');
    setProgress(-1);
    setAllButtonsDisabled(false);
    setStatus('ok');
  }
});

$('btnMarkdown').addEventListener('click', async () => {
  if (!currentTab) return;
  setAllButtonsDisabled(true);
  setStatus('busy');
  try {
    const result = await sendToContent({ action: 'extractMarkdown' });
    if (result?.success) {
      if (result.markdown) {
        try {
          await navigator.clipboard.writeText(result.markdown);
          toast('✓ Markdown 已复制到剪贴板并下载', 'success');
        } catch (_) {
          toast('✓ Markdown 已下载（剪贴板写入需页面聚焦）', 'success');
        }
      } else {
        toast('✓ Markdown 已下载', 'success');
      }
    } else {
      toast(result?.error || 'Markdown 提取失败', 'error');
    }
  } catch (e) {
    toast('提取失败: ' + e.message, 'error');
  }
  setAllButtonsDisabled(false);
  setStatus('ok');
});

$('btnCancel').addEventListener('click', async () => {
  if (!currentTab) return;
  try {
    await sendToContent({ action: 'cancelCapture' });
  } catch (_) {}
  setProgress(-1);
  setAllButtonsDisabled(false);
  setStatus('ok');
  toast('截图已取消', 'info');
});

$('btnMarkdown').addEventListener('click', async () => {
  if (!currentTab) return;
  setAllButtonsDisabled(true);
  setStatus('busy');
  try {
    const result = await sendToContent({ action: 'extractMarkdown' });
    if (result?.success) {
      if (result.markdown) {
        try {
          await navigator.clipboard.writeText(result.markdown);
          toast('✓ Markdown 已复制到剪贴板并下载', 'success');
        } catch (_) {
          toast('✓ Markdown 已下载（剪贴板写入需页面聚焦）', 'success');
        }
      } else {
        toast('✓ Markdown 已下载', 'success');
      }
    } else {
      toast(result?.error || 'Markdown 提取失败', 'error');
    }
  } catch (e) {
    toast('提取失败: ' + e.message, 'error');
  }
  setAllButtonsDisabled(false);
  setStatus('ok');
});

$('optWatermark').addEventListener('change', e => {
  settings.watermark = e.target.checked;
  saveSettings({ watermark: settings.watermark });
  $('watermarkRow').style.display = settings.watermark ? 'block' : 'none';
});

$('optRetina').addEventListener('change', e => {
  settings.retina = e.target.checked;
  saveSettings({ retina: settings.retina });
});

$('watermarkText').addEventListener('input', e => {
  settings.watermarkText = e.target.value;
  saveSettings({ watermarkText: settings.watermarkText });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'screenshotProgress') {
    setProgress(msg.pct, msg.text);
    if (msg.pct >= 100) {
      setTimeout(() => {
        setProgress(-1);
        setAllButtonsDisabled(false);
        setStatus('ok');
        toast('截图已保存！', 'success');
      }, 800);
    }
  }
  if (msg.action === 'screenshotError') {
    toast(msg.error || '截图失败', 'error');
    setProgress(-1);
    setAllButtonsDisabled(false);
    setStatus('ok');
  }
});

init();
