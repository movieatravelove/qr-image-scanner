/**
 * 图片二维码识别 Chrome 扩展 - 后台脚本
 * 功能：右键识别网页中的二维码图片（支持 img 和 canvas），识别结果弹窗展示，链接可点击跳转
 */

console.log('QR Scanner extension loaded');

/**
 * 创建右键菜单
 */
function createContextMenu(callback) {
  // 先移除所有旧菜单，避免重复创建
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'scan-qr',
      title: '识别二维码',
      contexts: ['all']  // 在所有上下文都显示菜单（这样 canvas 右键也能看到）
    }, () => {
      if (chrome.runtime.lastError) {
        console.error('Create menu error:', chrome.runtime.lastError);
      }
      if (callback) callback();
    });
  });
}

// 扩展安装/更新时创建菜单
chrome.runtime.onInstalled.addListener(() => {
  createContextMenu();
});

// Service Worker 启动时也创建菜单（修复刷新扩展后菜单消失问题）
createContextMenu();

/**
 * 处理右键菜单点击事件
 */
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  // 先注入 jsQR 二维码识别库
  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['jsQR.js']
  }, () => {
    // 注入识别逻辑到页面
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scanInPage,
      args: [info.srcUrl || null]  // info.srcUrl: 如果右键是图片，这里会有图片URL
    });
  });
});

/**
 * 以下函数会注入到页面中执行，处理识别逻辑
 */
function scanInPage(srcUrl) {
  // 清理之前可能残留的遮罩层
  const oldOverlay = document.getElementById('qr-scanner-overlay');
  if (oldOverlay) oldOverlay.remove();

  /**
   * 显示轻提示（2秒自动消失）
   */
  function showToast(message) {
    const toast = document.createElement('div');
    toast.style.cssText = `
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      background: rgba(0,0,0,0.8);
      color: white;
      padding: 12px 20px;
      border-radius: 8px;
      font-family: Arial, sans-serif;
      font-size: 14px;
      z-index: 9999999;
      white-space: nowrap;
    `;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => {
      if (toast.parentNode) toast.remove();
    }, 2000);
  }

  /**
   * 处理识别结果
   * @param {object} code jsQR 识别结果，包含 data 属性
   */
  function handleResult(code) {
    // 识别失败
    if (!code || !code.data) {
      showToast('未能识别到二维码');
      return;
    }

    const data = code.data;
    const isLink = data.startsWith('http://') || data.startsWith('https://');

    // 创建弹窗显示结果
    const modal = document.createElement('div');
    modal.style.cssText = `
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.6);
      z-index: 1000001;
      display: flex;
      align-items: center;
      justify-content: center;
    `;

    const box = document.createElement('div');
    box.style.cssText = `
      background: white;
      border-radius: 8px;
      padding: 24px;
      max-width: 80%;
      max-height: 80%;
      overflow: auto;
      font-family: Arial, sans-serif;
    `;

    box.innerHTML = `
      <h3 style="margin-top:0;">二维码内容：</h3>
      <div style="background:#f5f5f5;padding:12px;border-radius:4px;margin:16px 0;word-break:break-all;white-space:pre-wrap;">${data.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</div>
      ${isLink ? `<button id="qr-go-btn" style="background:#007bff;color:white;border:none;padding:10px 20px;border-radius:4px;cursor:pointer;font-size:14px;">打开链接</button>` : ''}
      <button id="qr-close-btn" style="${isLink ? 'margin-left:10px;' : ''}background:#ccc;color:black;border:none;padding:10px 20px;border-radius:4px;cursor:pointer;font-size:14px;">关闭</button>
    `;

    modal.appendChild(box);
    document.body.appendChild(modal);

    // 点击遮罩关闭
    modal.addEventListener('click', e => {
      if (e.target === modal) modal.remove();
    });

    // 关闭按钮
    document.getElementById('qr-close-btn').addEventListener('click', () => modal.remove());

    // 如果是链接，点击打开按钮跳转
    if (isLink) {
      document.getElementById('qr-go-btn').addEventListener('click', () => {
        window.open(data, '_blank');
        modal.remove();
      });
    }

    // ESC 关闭
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') {
        modal.remove();
        document.removeEventListener('keydown', esc);
      }
    });
  }

  /**
   * 识别指定的 DOM 元素（img 或 canvas）
   */
  function scanElement(el) {
    if (!el) {
      showToast('未能识别到二维码');
      return;
    }

    if (el.tagName === 'CANVAS') {
      // canvas 直接读取像素数据识别
      const ctx = el.getContext('2d');
      const imageData = ctx.getImageData(0, 0, el.width, el.height);
      const result = jsQR(imageData.data, imageData.width, imageData.height);
      handleResult(result);
    } else if (el.tagName === 'IMG') {
      // img 元素绘制到 canvas 再识别
      const canvas = document.createElement('canvas');
      canvas.width = el.naturalWidth || el.width;
      canvas.height = el.naturalHeight || el.height;
      const ctx = canvas.getContext('2d');

      // 先尝试直接使用页面上已经加载的图片
      try {
        ctx.drawImage(el, 0, 0);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const result = jsQR(imageData.data, imageData.width, imageData.height);
        handleResult(result);
      } catch (e) {
        // 跨域错误时，重新加载图片并添加 crossOrigin = anonymous
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = function() {
          canvas.width = img.width;
          canvas.height = img.height;
          ctx.drawImage(img, 0, 0);
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const result = jsQR(imageData.data, imageData.width, imageData.height);
          handleResult(result);
        };
        // 加载失败处理
        img.onerror = function() {
          handleResult(null);
        };
        img.onabort = function() {
          handleResult(null);
        };
        img.src = el.src;
      }
    } else {
      // 不是图片也不是canvas
      showToast('未能识别到二维码');
    }
  }

  /**
   * 开启选择模式：页面变暗，提示用户点击要识别的二维码
   * 用于右键不是图片的情况（比如 canvas）
   */
  function startSelection() {
    const overlay = document.createElement('div');
    overlay.id = 'qr-scanner-overlay';
    overlay.style.cssText = `
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.4);
      z-index: 999999;
      cursor: crosshair;
      pointer-events: none;
    `;

    const tip = document.createElement('div');
    tip.style.cssText = `
      position: fixed;
      top: 20px; left: 50%;
      transform: translateX(-50%);
      background: #222;
      color: #fff;
      padding: 12px 24px;
      border-radius: 6px;
      z-index: 1000000;
      font-family: Arial, sans-serif;
      font-size: 14px;
      pointer-events: none;
    `;
    tip.textContent = '点击二维码（图片或canvas），按ESC取消';
    overlay.appendChild(tip);
    document.body.appendChild(overlay);

    // 处理点击事件
    function clickHandler(e) {
      e.preventDefault();
      e.stopPropagation();
      // 识别完成后移除事件监听
      document.removeEventListener('click', clickHandler, true);
      document.removeEventListener('keydown', keyHandler, true);
      overlay.remove();
      // 获取用户实际点击的元素
      const el = document.elementFromPoint(e.clientX, e.clientY);
      scanElement(el);
    }

    // ESC 取消
    function keyHandler(e) {
      if (e.key === 'Escape') {
        document.removeEventListener('click', clickHandler, true);
        document.removeEventListener('keydown', keyHandler, true);
        overlay.remove();
      }
    }

    document.addEventListener('click', clickHandler, true);
    document.addEventListener('keydown', keyHandler, true);
  }

  /**
   * 入口逻辑
   * 如果右键点击的就是图片（srcUrl 存在），尝试直接找到这个图片元素识别
   * 否则进入选择模式让用户点击
   */
  if (srcUrl) {
    const imgs = Array.from(document.querySelectorAll('img'));
    for (const img of imgs) {
      if (img.src === srcUrl) {
        // 找到了，直接识别
        scanElement(img);
        return;
      }
    }
    // 没找到图片元素，进入选择模式
    startSelection();
  } else {
    // 右键不是图片，进入选择模式
    startSelection();
  }
}
