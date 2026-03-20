chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'stitchScreenshots') {
    stitchAndDownload(msg).then(sendResponse).catch(e => {
      sendResponse({ error: e.message });
    });
    return true;
  }
});

async function stitchAndDownload({ captures, totalH, viewW, dpr, cropLeft, cropRight, options, title }) {
  const reportProgress = (pct, text) => {
    chrome.runtime.sendMessage({ action: 'screenshotProgress', pct, text });
  };

  reportProgress(86, '加载图像...');

  const images = await Promise.all(captures.map(c => loadImage(c.dataUrl)));

  reportProgress(90, '绘制画布...');

  const canvas = document.getElementById('canvas');
  const scale = dpr;

  /* crop bounds in CSS pixels; fall back to full width */
  const cl = cropLeft || 0;
  const cr = cropRight || viewW;
  const cropW = cr - cl;

  const canvasW = cropW * scale;
  const MAX_CANVAS_DIM = 32000;
  const requiredCanvasH = totalH * scale;

  if (requiredCanvasH > MAX_CANVAS_DIM) {
    throw new Error('页面过长，超出单张图片导出上限，请关闭 2x 高清或缩短截图范围');
  }

  const canvasH = requiredCanvasH;

  canvas.width = canvasW;
  canvas.height = canvasH;

  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvasW, canvasH);

  for (let i = 0; i < captures.length; i++) {
    const cap = captures[i];
    const img = images[i];

    const viewH = cap.viewH;
    const scrollY = cap.scrollY;

    const destY = scrollY * scale;
    const remaining = totalH - scrollY;
    const drawH = Math.min(viewH, remaining);

    /* map CSS crop coords to actual image pixels */
    const imgScaleX = img.width / viewW;
    const srcX = cl * imgScaleX;
    const srcW = cropW * imgScaleX;
    const srcDrawH = (drawH / viewH) * img.height;

    ctx.drawImage(img, srcX, 0, srcW, srcDrawH, 0, destY, canvasW, drawH * scale);

    reportProgress(90 + Math.floor((i / captures.length) * 7), `绘制 ${i + 1}/${captures.length}...`);
  }

  if (options?.watermark && options?.watermarkText) {
    drawWatermark(ctx, options.watermarkText, canvasW, canvasH);
  }

  reportProgress(98, '生成文件...');

  const date = new Date().toISOString().slice(0, 10);
  const filename = `${title}_${date}.png`;

  const dataUrl = canvas.toDataURL('image/png', 1.0);

  const downloadResp = await chrome.runtime.sendMessage({
    action: 'downloadScreenshot',
    dataUrl,
    filename
  });

  if (downloadResp?.error) {
    throw new Error(downloadResp.error);
  }
  if (!downloadResp?.ok) {
    throw new Error('下载失败');
  }

  await chrome.runtime.sendMessage({ action: 'screenshotComplete' });
  return { ok: true };
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = src;
  });
}

function drawWatermark(ctx, text, w, h) {
  const spacing = 300;
  const rows = Math.ceil(h / spacing);
  const cols = Math.ceil(w / spacing);

  ctx.save();
  ctx.globalAlpha = 0.08;
  ctx.fillStyle = '#888888';
  ctx.font = `bold ${Math.max(16, w / 40)}px -apple-system, sans-serif`;

  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      const x = c * spacing - spacing / 2;
      const y = r * spacing;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(-Math.PI / 6);
      ctx.fillText(text, 0, 0);
      ctx.restore();
    }
  }
  ctx.restore();
}
