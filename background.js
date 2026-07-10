// 整合所有消息处理到一个监听器
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // 处理GET_TAB_ID消息
  if (request.type === 'GET_TAB_ID') {
    sendResponse({ tabId: sender.tab.id });
    return true;
  }

  // 处理MOVE_MOUSE消息
  if (request.type === 'MOVE_MOUSE') {
    const { x, y, tabId } = request;

    // 连接 debugger
    chrome.debugger.attach({ tabId }, "1.3")
      .then(() => {
        // 移动鼠标
        return chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: x,
          y: y
        });
      })
      .then(() => {
        // 等待一小段时间
        return new Promise(resolve => setTimeout(resolve, 500));
      })
      .then(() => {
        // 点击鼠标
        return chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
          type: "mousePressed",
          button: "left",
          x: x,
          y: y
        });
      })
      .then(() => {
        return chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
          type: "mouseReleased",
          button: "left",
          x: x,
          y: y
        });
      })
      .then(() => {
        // 断开 debugger
        return chrome.debugger.detach({ tabId });
      })
      .then(() => {
        sendResponse({ success: true });
      })
      .catch((error) => {
        console.error('Debugger error:', error);
        sendResponse({ success: false, error: error.message });
      });

    return true; // 保持消息通道开放
  }

  if (request.action === 'ocrRequest') {
    // 转发OCR请求到第三方服务
    fetch('https://api.yourocrservice.com/recognize', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${request.apiKey}`
      },
      body: JSON.stringify({
        image: request.imageData
      })
    })
      .then(response => response.json())
      .then(data => {
        sendResponse({ success: true, text: data.text });
      })
      .catch(error => {
        console.error('OCR请求失败:', error);
        sendResponse({ success: false, error: error.message });
      });

    return true; // 保持消息通道开放
  }

  if (request.action === 'paddleLocal') {
    // 代理本地 PaddleOCR (绕过 HTTPS 混合内容限制)
    fetch('http://192.168.110.22:8866/ocr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: request.b64 })
    })
      .then(r => r.json())
      .then(data => sendResponse({ ok: data.success, text: data.text || '', error: data.success ? null : 'OCR返回空' }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (request.action === 'deepseekProxy') {
    // 代理 DeepSeek 调用 — API key 只存在于后端
    fetch('$$BACKEND_URL$$/deepseek/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request.body)
    })
      .then(r => r.json())
      .then(data => sendResponse({ ok: true, data: data }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (request.action === 'paddleOcr') {
    // 代理 PaddleOCR: 从 b64 构建 FormData
    const byteChars = atob(request.b64);
    const byteArr = new Uint8Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) byteArr[i] = byteChars.charCodeAt(i);
    const blob = new Blob([byteArr], {type: 'image/png'});
    const form = new FormData();
    form.append('file', blob, 'resume.png');
    form.append('model', 'PaddleOCR-VL-1.6');
    form.append('optionalPayload', JSON.stringify({useDocOrientationClassify:false, useDocUnwarping:false, useChartRecognition:false}));

    fetch('https://paddleocr.aistudio-app.com/api/v2/ocr/jobs', {
      method: 'POST',
      headers: { 'Authorization': 'bearer ' + request.token },
      body: form
    })
      .then(r => r.json())
      .then(data => {
        if (data.code !== 0) { sendResponse({ ok: false, error: '提交失败: ' + (data.msg || '') }); return; }
        const jobId = data.data.jobId;
        const poll = () => {
          fetch('https://paddleocr.aistudio-app.com/api/v2/ocr/jobs/' + jobId, {
            headers: { 'Authorization': 'bearer ' + request.token }
          })
            .then(r => r.json())
            .then(sd => {
              if (sd.data.state === 'done') {
                fetch(sd.data.resultUrl.jsonUrl)
                  .then(r => r.text())
                  .then(raw => sendResponse({ ok: true, text: raw }));
              } else if (sd.data.state === 'failed') {
                sendResponse({ ok: false, error: sd.data.errorMsg || '识别失败' });
              } else {
                setTimeout(poll, 2000);
              }
            })
            .catch(e => sendResponse({ ok: false, error: e.message }));
        };
        setTimeout(poll, 2000);
      })
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (request.action === 'captureVisibleTab') {
    try {
      // 显式指定所属窗口，避免 null 可能导致的权限或焦点问题
      const windowId = sender.tab ? sender.tab.windowId : null;
      chrome.tabs.captureVisibleTab(windowId, { format: 'png' }, (dataUrl) => {
        if (chrome.runtime.lastError) {
          console.error('截图失败:', chrome.runtime.lastError.message);
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else {
          console.log('截图成功，数据长度:', dataUrl.length);
          sendResponse({ success: true, imageData: dataUrl });
        }
      });
      return true; // 保持消息通道开放，等待异步响应
    } catch (e) {
      console.error('调用截图API时出错:', e);
      sendResponse({ success: false, error: e.message });
    }
  }


  if (request.type === 'GET_TAB_ID') {
    sendResponse({ tabId: sender.tab.id });
    return true;
  }

});
