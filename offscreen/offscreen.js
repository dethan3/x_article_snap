const captureStore = new Map();
const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_IDAT_CHUNK_SIZE = 1_048_576;
const PNG_STREAM_BATCH_BYTES = 1_048_576;
const TEXT_ENCODER = new TextEncoder();
const CRC_TABLE = buildCrcTable();
const SHARE_BRAND_NAME = 'x_share';
const SHARE_BRAND_LOGO_URL = chrome.runtime.getURL('icons/xas_logo.png');

let shareBrandLogoPromise = null;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'resetCaptureSession') {
    captureStore.set(msg.captureSessionId, []);
    sendResponse({ ok: true });
    return false;
  }

  if (msg.action === 'appendCaptureFrame') {
    if (!msg.captureSessionId || !msg.capture) {
      sendResponse({ error: 'invalid capture frame' });
      return false;
    }
    const sessionCaptures = captureStore.get(msg.captureSessionId) || [];
    sessionCaptures.push(msg.capture);
    captureStore.set(msg.captureSessionId, sessionCaptures);
    sendResponse({ ok: true });
    return false;
  }

  if (msg.action === 'clearCaptureSession') {
    if (msg.captureSessionId) {
      captureStore.delete(msg.captureSessionId);
    }
    sendResponse({ ok: true });
    return false;
  }

  if (msg.action === 'stitchScreenshots') {
    let captures;
    try {
      captures = resolveCaptures(msg);
    } catch (e) {
      if (msg.captureSessionId) {
        captureStore.delete(msg.captureSessionId);
      }
      sendResponse({ error: e.message });
      return false;
    }

    stitchAndDownload({ ...msg, captures }).catch(e => {
      chrome.runtime.sendMessage({
        action: 'screenshotError',
        error: e.message
      }).catch(() => {});
    }).finally(() => {
      if (msg.captureSessionId) {
        captureStore.delete(msg.captureSessionId);
      }
    });

    sendResponse({ ok: true, started: true });
    return false;
  }
});

const MAX_CANVAS_EDGE_PX = 8192;
const MAX_CANVAS_AREA_PX = 33_554_432; // 32 MP keeps us below common Chrome/GPU limits.

async function stitchAndDownload({
  captures,
  totalH,
  viewW,
  dpr,
  cropLeft,
  cropRight,
  options,
  title,
  sourceUrl,
  isTruncatedCapture = false,
  fadeHeightCss = 0
}) {
  const reportProgress = (pct, text) => {
    chrome.runtime.sendMessage({ action: 'screenshotProgress', pct, text }).catch(() => {});
  };

  try {
    if (!captures?.length) {
      throw new Error('未获取到截图数据，请重试');
    }

    reportProgress(86, '加载图像...');

    reportProgress(90, '绘制画布...');

    const canvas = document.getElementById('canvas');
    if (!canvas) {
      throw new Error('未找到离屏画布');
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('无法创建画布上下文');
    }
    const date = new Date().toISOString().slice(0, 10);

    /* crop bounds in CSS pixels; fall back to full width */
    const cl = cropLeft || 0;
    const cr = cropRight || viewW;
    const cropW = Math.max(1, cr - cl);

    const longMode = options?.longMode !== false;
    const plan = createRenderPlan({
      cropW,
      totalH,
      requestedScale: dpr,
      longMode
    });
    const { scale, canvasW, maxCanvasHeightPx, tileHeightCss } = plan;
    const footerConfig = getShareFooterConfig(canvasW, sourceUrl, options);
    const fadeHeightPx = isTruncatedCapture
      ? Math.max(1, Math.min(Math.ceil(fadeHeightCss * scale), Math.ceil(totalH * scale)))
      : 0;

    if (!longMode) {
      if (totalH * scale > maxCanvasHeightPx) {
        throw new Error(`页面过长 (${totalH}px)，请开启「长图模式」后重试`);
      }

      const canvasH = Math.ceil(totalH * scale);
      canvas.width = canvasW;
      canvas.height = canvasH;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvasW, canvasH);

      for (let i = 0; i < captures.length; i++) {
        const cap = captures[i];
        const img = await loadImage(cap.dataUrl);
        const imgScaleX = img.width / viewW;
        const srcX = cl * imgScaleX;
        const srcW = cropW * imgScaleX;
        const remaining = totalH - cap.scrollY;
        const drawH = Math.min(cap.viewH, remaining);
        const srcDrawH = (drawH / cap.viewH) * img.height;
        ctx.drawImage(img, srcX, 0, srcW, srcDrawH, 0, cap.scrollY * scale, canvasW, drawH * scale);
        releaseImage(img);
        reportProgress(90 + Math.floor((i / captures.length) * 7), `绘制 ${i + 1}/${captures.length}...`);
      }

      if (options?.watermark && options?.watermarkText) {
        drawWatermark(ctx, options.watermarkText, canvasW, canvasH);
      }
      if (fadeHeightPx > 0) {
        applyBottomFade(ctx, canvasW, canvasH, fadeHeightPx);
      }

      reportProgress(98, '生成文件...');
      const exportCanvas = footerConfig
        ? await createCanvasWithShareFooter({
            baseCanvas: canvas,
            canvasW,
            footerConfig,
            sourceUrl
          })
        : canvas;
      await exportAndDownload(exportCanvas, `${title}_${date}.png`);
      canvas.width = 1;
      canvas.height = 1;
      reportProgress(100, '完成！');
      await chrome.runtime.sendMessage({ action: 'screenshotComplete' }).catch(() => {});
      return { ok: true };
    }

    if (typeof CompressionStream !== 'function') {
      await exportSplitLongMode({
        canvas,
        ctx,
        captures,
        totalH,
        viewW,
        scale,
        cropLeft: cl,
        cropW,
        canvasW,
        tileHeightCss,
        footerConfig,
        isTruncatedCapture,
        fadeHeightPx,
        options,
        sourceUrl,
        title,
        date,
        reportProgress
      });
    } else {
      await exportStreamingLongPng({
        canvas,
        ctx,
        captures,
        totalH,
        viewW,
        scale,
        cropLeft: cl,
        cropW,
        canvasW,
        tileHeightCss,
        footerConfig,
        isTruncatedCapture,
        fadeHeightPx,
        options,
        sourceUrl,
        title,
        date,
        reportProgress
      });
    }

    canvas.width = 1;
    canvas.height = 1;
    reportProgress(100, '完成！');
    await chrome.runtime.sendMessage({ action: 'screenshotComplete' }).catch(() => {});
    return { ok: true };
  } catch (e) {
    throw e;
  }
}

function resolveCaptures({ captureSessionId, captures }) {
  if (Array.isArray(captures) && captures.length) {
    return captures;
  }
  if (!captureSessionId) {
    throw new Error('未找到待合成的截图数据，请重试');
  }
  const sessionCaptures = captureStore.get(captureSessionId);
  if (!sessionCaptures?.length) {
    throw new Error('离屏缓存中的截图数据已丢失，请重新截图');
  }
  return sessionCaptures;
}

function createRenderPlan({ cropW, totalH, requestedScale, longMode }) {
  let scale = Math.max(1, Number(requestedScale) || 1);
  const maxScaleByWidth = MAX_CANVAS_EDGE_PX / Math.max(1, cropW);
  scale = Math.min(scale, Math.max(1, maxScaleByWidth));

  let canvasW = Math.max(1, Math.ceil(cropW * scale));
  let maxCanvasHeightPx = Math.max(
    1,
    Math.min(MAX_CANVAS_EDGE_PX, Math.floor(MAX_CANVAS_AREA_PX / canvasW))
  );

  if (!longMode && totalH * scale > maxCanvasHeightPx) {
    const maxScaleByHeight = maxCanvasHeightPx / Math.max(1, totalH);
    scale = Math.min(scale, Math.max(1, maxScaleByHeight));
    canvasW = Math.max(1, Math.ceil(cropW * scale));
    maxCanvasHeightPx = Math.max(
      1,
      Math.min(MAX_CANVAS_EDGE_PX, Math.floor(MAX_CANVAS_AREA_PX / canvasW))
    );
  }

  const tileHeightCss = Math.max(1, Math.floor(maxCanvasHeightPx / scale));

  return {
    scale,
    canvasW,
    maxCanvasHeightPx,
    tileHeightCss
  };
}

function getShareFooterConfig(canvasW, sourceUrl, options) {
  if (!sourceUrl) return null;

  const qrEnabled = options?.includeQrCode === true;
  const paddingX = Math.max(24, Math.round(canvasW * 0.05));
  const paddingY = Math.max(16, Math.round(canvasW * 0.028));
  const logoSize = Math.max(24, Math.min(34, Math.round(canvasW * 0.05)));
  const brandFontSize = Math.max(18, Math.round(canvasW * 0.032));
  const metaFontSize = Math.max(12, Math.round(canvasW * 0.021));
  const linkFontSize = Math.max(13, Math.round(canvasW * 0.023));
  const qrSize = qrEnabled
    ? Math.max(72, Math.min(108, Math.round(canvasW * 0.16)))
    : 0;
  const footerHeight = Math.max(
    qrEnabled ? qrSize + paddingY * 2.4 + logoSize : 88,
    Math.round(paddingY * 2.4 + logoSize + linkFontSize)
  );

  return {
    footerHeight,
    paddingX,
    paddingY,
    logoSize,
    brandFontSize,
    metaFontSize,
    linkFontSize,
    qrEnabled,
    qrSize
  };
}

async function createCanvasWithShareFooter({ baseCanvas, canvasW, footerConfig, sourceUrl }) {
  if (!footerConfig) return baseCanvas;

  const exportCanvas = document.createElement('canvas');
  exportCanvas.width = canvasW;
  exportCanvas.height = baseCanvas.height + footerConfig.footerHeight;
  const exportCtx = exportCanvas.getContext('2d');
  if (!exportCtx) {
    throw new Error('无法创建 footer 画布上下文');
  }

  exportCtx.drawImage(baseCanvas, 0, 0);
  await drawShareFooter(exportCtx, {
    canvasW,
    footerTop: baseCanvas.height,
    footerConfig,
    sourceUrl
  });

  return exportCanvas;
}

async function renderShareFooterToCanvas({ canvas, ctx, canvasW, footerConfig, sourceUrl }) {
  canvas.width = canvasW;
  canvas.height = footerConfig.footerHeight;
  await drawShareFooter(ctx, {
    canvasW,
    footerTop: 0,
    footerConfig,
    sourceUrl
  });
}

async function exportSplitLongMode({
  canvas,
  ctx,
  captures,
  totalH,
  viewW,
  scale,
  cropLeft,
  cropW,
  canvasW,
  tileHeightCss,
  footerConfig,
  isTruncatedCapture,
  fadeHeightPx,
  options,
  sourceUrl,
  title,
  date,
  reportProgress
}) {
  const slicePlans = buildSlicePlans(totalH, tileHeightCss, scale);

  for (let s = 0; s < slicePlans.length; s++) {
    const slice = slicePlans[s];
    await renderSliceToCanvas({
      canvas,
      ctx,
      captures,
      viewW,
      cropLeft,
      cropW,
      canvasW,
      scale,
      slice,
      options
    });

    if (isTruncatedCapture && s === slicePlans.length - 1 && fadeHeightPx > 0) {
      applyBottomFade(ctx, canvasW, canvas.height, Math.min(fadeHeightPx, canvas.height));
    }

    reportProgress(
      90 + Math.floor(((s + 0.5) / slicePlans.length) * 8),
      slicePlans.length > 1 ? `生成第 ${s + 1}/${slicePlans.length} 张...` : '生成文件...'
    );

    const suffix = slicePlans.length > 1 ? `_${s + 1}of${slicePlans.length}` : '';
    const exportCanvas = s === slicePlans.length - 1 && footerConfig
      ? await createCanvasWithShareFooter({
          baseCanvas: canvas,
          canvasW,
          footerConfig,
          sourceUrl
        })
      : canvas;
    await exportAndDownload(exportCanvas, `${title}${suffix}_${date}.png`);
  }
}

async function exportStreamingLongPng({
  canvas,
  ctx,
  captures,
  totalH,
  viewW,
  scale,
  cropLeft,
  cropW,
  canvasW,
  tileHeightCss,
  footerConfig,
  isTruncatedCapture,
  fadeHeightPx,
  options,
  sourceUrl,
  title,
  date,
  reportProgress
}) {
  const slicePlans = buildSlicePlans(totalH, tileHeightCss, scale);
  const contentHeight = slicePlans[slicePlans.length - 1]?.pixelEnd || Math.max(1, Math.round(totalH * scale));
  const finalHeight = contentHeight + (footerConfig?.footerHeight || 0);
  const compressionStream = new CompressionStream('deflate');
  const writer = compressionStream.writable.getWriter();
  const compressedPromise = new Response(compressionStream.readable).arrayBuffer();

  for (let s = 0; s < slicePlans.length; s++) {
    const slice = slicePlans[s];
    reportProgress(90 + Math.floor((s / slicePlans.length) * 4), `渲染第 ${s + 1}/${slicePlans.length} 段...`);

    await renderSliceToCanvas({
      canvas,
      ctx,
      captures,
      viewW,
      cropLeft,
      cropW,
      canvasW,
      scale,
      slice,
      options
    });

    if (isTruncatedCapture && s === slicePlans.length - 1 && fadeHeightPx > 0) {
      applyBottomFade(ctx, canvasW, canvas.height, Math.min(fadeHeightPx, canvas.height));
    }

    reportProgress(94 + Math.floor(((s + 0.5) / slicePlans.length) * 3), `编码第 ${s + 1}/${slicePlans.length} 段...`);
    await writeCanvasToPngStream(writer, ctx, canvasW, canvas.height);
  }

  if (footerConfig) {
    await renderShareFooterToCanvas({
      canvas,
      ctx,
      canvasW,
      footerConfig,
      sourceUrl
    });
    await writeCanvasToPngStream(writer, ctx, canvasW, canvas.height);
  }

  await writer.close();
  const compressedData = new Uint8Array(await compressedPromise);
  const pngBlob = buildPngBlob({
    width: canvasW,
    height: finalHeight,
    compressedData
  });

  reportProgress(98, '生成单张 PNG...');
  await downloadBlob(pngBlob, `${title}_${date}.png`);
}

function buildSlicePlans(totalH, tileHeightCss, scale) {
  const slices = [];

  for (let startY = 0; startY < totalH; startY += tileHeightCss) {
    const endY = Math.min(startY + tileHeightCss, totalH);
    slices.push({
      startY,
      endY,
      pixelStart: Math.round(startY * scale),
      pixelEnd: Math.round(endY * scale)
    });
  }

  return slices;
}

async function renderSliceToCanvas({
  canvas,
  ctx,
  captures,
  viewW,
  cropLeft,
  cropW,
  canvasW,
  scale,
  slice,
  options
}) {
  const slicePixelHeight = Math.max(1, slice.pixelEnd - slice.pixelStart);

  canvas.width = canvasW;
  canvas.height = slicePixelHeight;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvasW, canvas.height);

  for (let i = 0; i < captures.length; i++) {
    const cap = captures[i];
    const capStart = cap.scrollY;
    const capEnd = cap.scrollY + Math.min(cap.viewH, Math.max(0, cap.totalH - cap.scrollY));
    const overlapStart = Math.max(capStart, slice.startY);
    const overlapEnd = Math.min(capEnd, slice.endY);
    if (overlapStart >= overlapEnd) continue;

    const img = await loadImage(cap.dataUrl);
    const imgScaleX = img.width / viewW;
    const imgScaleY = img.height / cap.viewH;
    const srcX = cropLeft * imgScaleX;
    const srcW = cropW * imgScaleX;
    const srcY = (overlapStart - capStart) * imgScaleY;
    const srcH = (overlapEnd - overlapStart) * imgScaleY;
    const destY = Math.round(overlapStart * scale) - slice.pixelStart;
    const destEndY = Math.round(overlapEnd * scale) - slice.pixelStart;
    const destH = Math.max(1, destEndY - destY);

    ctx.drawImage(img, srcX, srcY, srcW, srcH, 0, destY, canvasW, destH);
    releaseImage(img);
  }

  if (options?.watermark && options?.watermarkText) {
    drawWatermark(ctx, options.watermarkText, canvasW, canvas.height, slice.pixelStart);
  }
}

function applyBottomFade(ctx, width, height, fadeHeightPx) {
  const safeFadeHeight = Math.max(0, Math.min(fadeHeightPx || 0, height));
  if (safeFadeHeight <= 0) return;

  const fadeTop = Math.max(0, height - safeFadeHeight);
  const gradient = ctx.createLinearGradient(0, fadeTop, 0, height);
  gradient.addColorStop(0, 'rgba(255, 255, 255, 0)');
  gradient.addColorStop(0.7, 'rgba(255, 255, 255, 0.82)');
  gradient.addColorStop(1, '#ffffff');

  ctx.save();
  ctx.fillStyle = gradient;
  ctx.fillRect(0, fadeTop, width, safeFadeHeight);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, height - 2, width, 2);
  ctx.restore();
}

async function writeCanvasToPngStream(writer, ctx, width, height) {
  const stride = width * 4;
  const rowsPerBatch = Math.max(1, Math.floor(PNG_STREAM_BATCH_BYTES / Math.max(1, stride)));

  for (let y = 0; y < height; y += rowsPerBatch) {
    const batchH = Math.min(rowsPerBatch, height - y);
    const imageData = ctx.getImageData(0, y, width, batchH).data;
    const scanlines = new Uint8Array(batchH * (stride + 1));

    for (let row = 0; row < batchH; row++) {
      const srcStart = row * stride;
      const destStart = row * (stride + 1);
      scanlines[destStart] = 0;
      scanlines.set(imageData.subarray(srcStart, srcStart + stride), destStart + 1);
    }

    await writer.write(scanlines);
  }
}

function buildPngBlob({ width, height, compressedData }) {
  const parts = [
    PNG_SIGNATURE,
    createPngChunk('IHDR', createIHDRData(width, height))
  ];

  for (let offset = 0; offset < compressedData.length; offset += PNG_IDAT_CHUNK_SIZE) {
    parts.push(
      createPngChunk(
        'IDAT',
        compressedData.subarray(offset, offset + PNG_IDAT_CHUNK_SIZE)
      )
    );
  }

  parts.push(createPngChunk('IEND', new Uint8Array(0)));
  return new Blob(parts, { type: 'image/png' });
}

function createIHDRData(width, height) {
  const data = new Uint8Array(13);
  writeUint32(data, 0, width);
  writeUint32(data, 4, height);
  data[8] = 8;
  data[9] = 6;
  data[10] = 0;
  data[11] = 0;
  data[12] = 0;
  return data;
}

function createPngChunk(type, data) {
  const typeBytes = TEXT_ENCODER.encode(type);
  const chunk = new Uint8Array(12 + data.length);

  writeUint32(chunk, 0, data.length);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  writeUint32(chunk, 8 + data.length, crc32(typeBytes, data));

  return chunk;
}

function writeUint32(target, offset, value) {
  const view = new DataView(target.buffer, target.byteOffset, target.byteLength);
  view.setUint32(offset, value >>> 0);
}

async function canvasToPngBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(b => {
      if (b) resolve(b);
      else reject(new Error('图像生成失败，画布内容为空（可能超出设备内存限制）'));
    }, 'image/png', 1.0);
  });
}

async function exportAndDownload(canvas, filename) {
  const blob = await canvasToPngBlob(canvas);
  await downloadBlob(blob, filename);
}

async function downloadBlob(blob, filename) {
  const objectUrl = URL.createObjectURL(blob);

  try {
    let resp = await chrome.runtime.sendMessage({
      action: 'downloadScreenshot',
      url: objectUrl,
      filename
    });

    if (resp?.ok) return;

    const dataUrl = await blobToDataUrl(blob);
    resp = await chrome.runtime.sendMessage({
      action: 'downloadScreenshot',
      dataUrl,
      filename
    });

    if (resp?.error) {
      throw new Error(resp.error);
    }
    if (!resp?.ok) {
      throw new Error('下载失败');
    }
  } finally {
    setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
  }
}

async function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('FileReader 转换失败'));
    reader.readAsDataURL(blob);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = src;
  });
}

function releaseImage(img) {
  try {
    img.src = '';
  } catch (_) {}
}

function crc32(typeBytes, data) {
  let crc = 0xffffffff;

  for (let i = 0; i < typeBytes.length; i++) {
    crc = CRC_TABLE[(crc ^ typeBytes[i]) & 0xff] ^ (crc >>> 8);
  }
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function buildCrcTable() {
  const table = new Uint32Array(256);

  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }

  return table;
}

async function drawShareFooter(ctx, { canvasW, footerTop, footerConfig, sourceUrl }) {
  const {
    footerHeight,
    paddingX,
    paddingY,
    logoSize,
    brandFontSize,
    metaFontSize,
    linkFontSize,
    qrEnabled,
    qrSize
  } = footerConfig;

  const brandGap = Math.max(10, Math.round(logoSize * 0.35));
  const brandBottom = footerTop + footerHeight - paddingY;
  const brandBaselineY = brandBottom - Math.max(1, Math.round((logoSize - brandFontSize) * 0.2));

  ctx.font = `700 ${brandFontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
  const brandWidth = ctx.measureText(SHARE_BRAND_NAME).width;
  const brandX = canvasW - paddingX - brandWidth;
  const logoX = brandX - brandGap - logoSize;
  const logoY = brandBottom - logoSize;
  const qrX = canvasW - paddingX - qrSize;
  const qrY = footerTop + paddingY;

  const linkCenterY = qrEnabled
    ? footerTop + Math.round(footerHeight * 0.5)
    : footerTop + Math.round(footerHeight * 0.56);
  const label = '原帖 · ';
  const compactUrl = formatFooterUrl(sourceUrl);
  const linkRightLimit = Math.max(
    paddingX + 120,
    (qrEnabled ? qrX : logoX) - Math.max(24, Math.round(paddingX * 0.8))
  );

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, footerTop, canvasW, footerHeight);

  ctx.fillStyle = '#e5e7eb';
  ctx.fillRect(0, footerTop, canvasW, 1);

  ctx.textBaseline = 'middle';
  ctx.font = `600 ${metaFontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
  ctx.fillStyle = '#6b7280';
  ctx.fillText(label, paddingX, linkCenterY);

  const labelWidth = ctx.measureText(label).width;
  const availableUrlWidth = Math.max(80, linkRightLimit - (paddingX + labelWidth));
  ctx.font = `500 ${linkFontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
  ctx.fillStyle = '#374151';
  ctx.fillText(
    truncateTextToWidth(ctx, compactUrl, availableUrlWidth),
    paddingX + labelWidth,
    linkCenterY
  );

  if (qrEnabled) {
    drawShareQrCode(ctx, {
      x: qrX,
      y: qrY,
      size: qrSize,
      url: sourceUrl
    });
  }

  await drawShareBrandLogo(ctx, {
    x: logoX,
    y: logoY,
    size: logoSize
  });

  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#111827';
  ctx.font = `700 ${brandFontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
  ctx.fillText(SHARE_BRAND_NAME, brandX, brandBaselineY);
}

function drawShareQrCode(ctx, { x, y, size, url }) {
  if (!url || !globalThis.qrcodegen?.QrCode) return;

  const quietZone = 4;
  const qr = globalThis.qrcodegen.QrCode.encodeText(
    url,
    globalThis.qrcodegen.QrCode.Ecc.MEDIUM
  );
  const moduleCount = qr.size + quietZone * 2;
  const moduleSize = size / moduleCount;

  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(x, y, size, size);
  ctx.strokeStyle = '#e5e7eb';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);
  ctx.fillStyle = '#111827';

  for (let moduleY = 0; moduleY < qr.size; moduleY++) {
    for (let moduleX = 0; moduleX < qr.size; moduleX++) {
      if (!qr.getModule(moduleX, moduleY)) continue;
      const drawX = x + (moduleX + quietZone) * moduleSize;
      const drawY = y + (moduleY + quietZone) * moduleSize;
      const startX = Math.round(drawX);
      const startY = Math.round(drawY);
      const endX = Math.round(x + (moduleX + quietZone + 1) * moduleSize);
      const endY = Math.round(y + (moduleY + quietZone + 1) * moduleSize);
      ctx.fillRect(startX, startY, Math.max(1, endX - startX), Math.max(1, endY - startY));
    }
  }

  ctx.restore();
}

async function drawShareBrandLogo(ctx, { x, y, size }) {
  const logo = await loadShareBrandLogo();

  ctx.save();
  drawRoundedRect(ctx, x, y, size, size, Math.max(10, Math.round(size * 0.22)));
  ctx.clip();
  if (logo) {
    ctx.drawImage(logo, x, y, size, size);
  } else {
    ctx.fillStyle = '#e5e7eb';
    ctx.fillRect(x, y, size, size);
    ctx.fillStyle = '#4b5563';
    ctx.font = `700 ${Math.max(16, Math.round(size * 0.42))}px -apple-system, BlinkMacSystemFont, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('X', x + size / 2, y + size / 2 + 1);
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
  }
  ctx.restore();
}

function drawRoundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function truncateTextToWidth(ctx, text, maxWidth) {
  const ellipsis = '...';
  if (ctx.measureText(text).width <= maxWidth) return text;

  let output = text;
  while (output && ctx.measureText(output + ellipsis).width > maxWidth) {
    output = output.slice(0, -1);
  }
  return output + ellipsis;
}

function formatFooterUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.host.replace(/^www\./, '');
    const statusMatch = parsed.pathname.match(/^\/([^/]+)\/status\/(\d+)/);

    if (statusMatch) {
      const username = statusMatch[1];
      const statusId = statusMatch[2];
      const compactId = statusId.length > 12
        ? `${statusId.slice(0, 6)}...${statusId.slice(-4)}`
        : statusId;
      return `${host}/${username}/status/${compactId}`;
    }

    const plainPath = parsed.pathname.replace(/\/$/, '');
    return `${host}${plainPath || ''}`;
  } catch (_) {
    return (url || '').replace(/^https?:\/\//, '');
  }
}

function loadShareBrandLogo() {
  if (!shareBrandLogoPromise) {
    shareBrandLogoPromise = loadImage(SHARE_BRAND_LOGO_URL).catch(() => null);
  }
  return shareBrandLogoPromise;
}

function drawWatermark(ctx, text, w, h, offsetY = 0) {
  const spacing = 300;
  const cols = Math.ceil(w / spacing);
  const startY = -(((offsetY % spacing) + spacing) % spacing);

  ctx.save();
  ctx.globalAlpha = 0.08;
  ctx.fillStyle = '#888888';
  ctx.font = `bold ${Math.max(16, w / 40)}px -apple-system, sans-serif`;

  for (let y = startY; y <= h + spacing; y += spacing) {
    for (let c = 0; c <= cols; c++) {
      const x = c * spacing - spacing / 2;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(-Math.PI / 6);
      ctx.fillText(text, 0, 0);
      ctx.restore();
    }
  }
  ctx.restore();
}
