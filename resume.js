// 简历分析相关的代码
// 全局变量
const DEBUG = true; // 打包时 build.js 替换为 false
let analyzedResumeIds = new Set();
window.tabId = null;

// ★ 全局 protectSendMessage：扩展热更新后页面未刷新 → sendMessage 抛错 → 提示 F5
var _extDead = false;
function protectSendMessage(msg, callback) {
  if (_extDead) return;
  try {
    chrome.runtime.sendMessage(msg, function(response) {
      var err = chrome.runtime.lastError;
      if (err && err.message && err.message.includes('Extension context invalidated')) {
        _extDead = true;
        showPanelMsg('扩展已更新，请F5刷新页面');
        if (callback) callback({ ok: false, error: 'Extension context invalidated' });
        return;
      }
      if (callback) callback(response);
    });
  } catch(e) {
    if (e.message && e.message.includes('Extension context invalidated')) {
      _extDead = true;
      showPanelMsg('扩展已更新，请F5刷新页面');
    }
  }
}

// ====== 每日用量限制 ======
const DAILY_BROWSE_LIMIT = 100;
const DAILY_SHARE_LIMIT = 100;

function todayKey() { const d = new Date(); return d.getFullYear() + '-' + (d.getMonth()+1) + '-' + d.getDate(); }

async function getDailyCounts() {
  return new Promise(resolve => {
    chrome.storage.local.get({ dailyCounts: { date: '', browse: 0, share: 0 } }, r => {
      const d = r.dailyCounts;
      if (d.date !== todayKey()) d.browse = 0, d.share = 0, d.date = todayKey();
      resolve(d);
    });
  });
}
async function incDailyBrowse() {
  const d = await getDailyCounts(); d.browse++; d.date = todayKey();
  await new Promise(r => chrome.storage.local.set({ dailyCounts: d }, r));
  return d;
}
async function incDailyShare() {
  const d = await getDailyCounts(); d.share++; d.date = todayKey();
  await new Promise(r => chrome.storage.local.set({ dailyCounts: d }, r));
  return d;
}

// ★ 检查试用次数，返回剩余次数（0=用完）。仅 Pro 版生效
async function checkTrialRemaining() {
  if (!('$$IS_PAID$$' === 'true')) return 999999;
  try {
    var result = await new Promise(function(r) { chrome.storage.local.get(['pro_activated', 'pro_trial_remaining'], r); });
    if (result.pro_activated) return 999999;
    // 优先用后端实时查
    try {
      var resp = await new Promise(function(resolve, reject) {
        chrome.runtime.sendMessage({ action: 'trialProxy', body: { action: 'status', activated: false, device: (typeof getDeviceFingerprint==='function' ? getDeviceFingerprint() : '') } }, function(rr) {
          if (rr && rr.ok) resolve(rr.data); else reject(new Error());
        });
      });
      await new Promise(function(r) { chrome.storage.local.set({ 'pro_trial_remaining': resp.remaining }, r); });
      return resp.remaining;
    } catch(e) {
      // 后端不通 → 用本地缓存兜底
      return result.pro_trial_remaining !== undefined ? result.pro_trial_remaining : 10;
    }
  } catch(e) { return 999999; }
}

async function checkTrialRemaining() {
  if (!('$$IS_PAID$$' === 'true')) return 999999;
  try {
    var _trRes = await new Promise(function(r) { chrome.storage.local.get(["pro_activated", "pro_trial_remaining"], r); });
    if (_trRes.pro_activated) return 999999;
    try {
      var _trResp = await new Promise(function(resolve, reject) {
        chrome.runtime.sendMessage({ action: "trialProxy", body: { action: "status", activated: false } }, function(rr) {
          if (rr && rr.ok) resolve(rr.data); else reject(new Error());
        });
      });
      await new Promise(function(r) { chrome.storage.local.set({ "pro_trial_remaining": _trResp.remaining }, r); });
      return _trResp.remaining;
    } catch(e) { return _trRes.pro_trial_remaining !== undefined ? _trRes.pro_trial_remaining : 10; }
  } catch(e) { return 999999; }
}

// 在面板显示提示
let _panelMsgCount = 0;
function showPanelMsg(msg) {
  _panelMsgCount++;
  const el = document.querySelector('#hr-panel-unique #errorContainer, #ai-resume-container-unique #errorContainer');
  if (!el) return;
  const msgEl = el.querySelector('#errorMessage');
  if (msgEl) { msgEl.textContent = '[' + _panelMsgCount + '] ' + msg; el.classList.add('show'); }
}

// 初始化获取 tabId
chrome.runtime.sendMessage({ type: 'GET_TAB_ID' }, response => {
  if (response && response.tabId) {
    window.tabId = response.tabId;
    console.log('Resume helper initialized with tabId:', window.tabId);
  }
});

/**
 * 提取完整的简历内容
 * 注意：Boss直聘 使用 Canvas 渲染简历内容（防爬虫），因此无法直接从 HTML 获取文本
 * 此函数通过访问 Vue 组件的 resumeInfo 数据来获取完整的简历信息
 * 支持：搜索页面（直接 DOM）和推荐牛人页面（iframe 内）
 * 
 * @param {Document} doc - 文档对象
 * @param {string} resumeId - 简历ID
 * @returns {Object} 包含 fullText, vueData, resumeId 的对象
 */
async function extractFullResumeContent(doc = document, resumeId = '') {
  console.log('开始提取完整简历内容（Vue 数据模式）...');

  try {
    // 向下递归查找 Vue 实例中的 resumeInfo 数据
    const findVueDataDown = (el) => {
      if (!el) return null;
      if (el.__vue__) {
        const vue = el.__vue__;
        if (vue.resumeInfo) return vue.resumeInfo;
        if (vue.$options && vue.$options.propsData && vue.$options.propsData.resumeInfo) {
          return vue.$options.propsData.resumeInfo;
        }
        if (vue.$data && vue.$data.resumeInfo) {
          return vue.$data.resumeInfo;
        }
      }
      for (const child of el.children || []) {
        const found = findVueDataDown(child);
        if (found) return found;
      }
      return null;
    };

    // 向上递归查找父元素的 Vue 实例中的 resumeInfo 数据
    const findVueDataUp = (el) => {
      let current = el;
      while (current) {
        if (current.__vue__) {
          const vue = current.__vue__;
          if (vue.resumeInfo) return vue.resumeInfo;
          if (vue.$options && vue.$options.propsData && vue.$options.propsData.resumeInfo) {
            return vue.$options.propsData.resumeInfo;
          }
          if (vue.$data && vue.$data.resumeInfo) {
            return vue.$data.resumeInfo;
          }
        }
        current = current.parentElement;
      }
      return null;
    };

    // 多种选择器尝试查找简历容器（按优先级排序）
    // 注意: .lib-resume-anonymous 和 .lib-resume-recommend 是携带 Vue 数据的父容器
    const containerSelectors = [
      '.lib-resume-anonymous',           // 搜索页简历容器（有 Vue 数据）
      '.lib-resume-recommend',            // 推荐页简历容器（有 Vue 数据）
      '.boss-popup__wrapper.dialog-lib-resume',
      '.boss-dialog__wrapper.dialog-lib-resume',
      '.resume-detail-wrap',              // 简历详情内部容器（可能无 Vue 数据）
      '[class*="lib-resume"]',
      '[class*="resume-detail"]'
    ];

    // 递归在文档和 iframe 中查找简历详情容器
    const findResumeContainer = (root) => {
      // 尝试多种选择器
      for (const selector of containerSelectors) {
        const el = root.querySelector(selector);
        if (el) return { element: el, inIframe: false, selector };
      }

      // 在 iframe 中查找
      const iframes = root.querySelectorAll('iframe');
      for (const iframe of iframes) {
        try {
          if (iframe.contentDocument && iframe.contentDocument.body) {
            for (const selector of containerSelectors) {
              const iframeEl = iframe.contentDocument.querySelector(selector);
              if (iframeEl) {
                return { element: iframeEl, inIframe: true, iframeDoc: iframe.contentDocument, selector };
              }
            }
          }
        } catch (e) {
          console.warn('访问 iframe 时出错:', e);
        }
      }
      return null;
    };

    // 等待简历详情对话框加载
    // 等待简历详情对话框加载
    const startTime = Date.now();
    let result = null;

    while (!result && Date.now() - startTime < 3000) {
      result = findResumeContainer(doc);
      if (!result) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }

    if (!result) {
      console.warn('无法找到简历详情容器');
      return {
        resumeId,
        fullText: '',
        vueData: null,
        extractionMethod: 'failed',
        error: '无法找到简历详情容器',
        timestamp: new Date().toISOString()
      };
    }

    const { element: containerEl, inIframe, iframeDoc, selector } = result;
    console.log(`找到简历容器 (${selector})，位置: ${inIframe ? 'iframe 内' : '主文档'}，等待数据同步...`);

    // --- 核心修复：增加内容等待逻辑 ---
    let vueData = null;
    let extractionWaitTime = 0;
    const MAX_EXTRACTION_WAIT = 2000; // 文本提取最多只等 2 秒，失效时快速切换到 Vision

    while (extractionWaitTime < MAX_EXTRACTION_WAIT) {
      // 检查内容是否仍为"正在加载"
      const currentText = containerEl.innerText || '';
      const isLoading = currentText.includes('正在加载中') || currentText.trim().length < 20;

      // 1. 先尝试向下查找子元素
      vueData = findVueDataDown(containerEl);

      // 2. 如果失败，尝试向上查找父元素
      if (!vueData) {
        vueData = findVueDataUp(containerEl);
      }

      // 3. 如果在 iframe 中，尝试从 iframe body 开始查找
      if (!vueData && inIframe && iframeDoc) {
        vueData = findVueDataDown(iframeDoc.body);
        if (!vueData) {
          vueData = findVueDataUp(iframeDoc.body.querySelector('.resume-detail-wrap') || iframeDoc.body);
        }
      }

      // 如果已经拿到 Vue 数据，且内容不再是加载中，则认为提取成功
      if (vueData && (vueData.geekBaseInfo || !isLoading)) {
        console.log(`数据同步完成，耗时 ${extractionWaitTime}ms`);
        break;
      }

      // 如果没有 Vue 数据但内容已经加载完成，且已经等了至少 2 秒，也可以结束
      if (!isLoading && extractionWaitTime > 2000) {
        console.log(`未找到 Vue 数据但 DOM 内容已就绪，耗时 ${extractionWaitTime}ms`);
        break;
      }

      // 继续等待
      await new Promise(resolve => setTimeout(resolve, 500));
      extractionWaitTime += 500;
      console.log(`正在等待简历数据挂载... (${extractionWaitTime}ms)`);
    }
    // --- 核心修复结束 ---

    // 4. 备用：尝试从其他已知选择器获取
    if (!vueData) {
      console.warn('从容器获取失败，尝试其他已知选择器...');
      for (const altSelector of containerSelectors) {
        const altEl = doc.querySelector(altSelector);
        if (altEl) {
          vueData = findVueDataUp(altEl);
          if (vueData) {
            console.log(`从备用选择器 ${altSelector} 获取到 Vue 数据`);
            break;
          }
        }
      }
    }

    if (!vueData) {
      console.warn('无法从 Vue 组件获取 resumeInfo 数据，回退到 innerText');
      const fallbackText = containerEl.innerText || '';
      return {
        resumeId,
        fullText: fallbackText,
        vueData: null,
        extractionMethod: 'fallback-innertext',
        error: '无法获取 Vue 数据，使用 innerText 备用',
        timestamp: new Date().toISOString()
      };
    }

    console.log('成功获取 Vue 数据');
    const formattedResult = formatVueDataToResult(vueData, resumeId);
    formattedResult.inIframe = inIframe;
    formattedResult.containerSelector = selector;
    return formattedResult;

  } catch (error) {
    console.error('提取简历内容时发生错误:', error);
    return {
      resumeId,
      fullText: '',
      vueData: null,
      extractionMethod: 'error',
      error: error.message,
      timestamp: new Date().toISOString()
    };
  }
}

/**
 * 将 Vue resumeInfo 数据格式化为结果对象
 * @param {Object} data - Vue resumeInfo 数据
 * @param {string} resumeId - 简历ID
 * @returns {Object} 格式化后的结果
 */
function formatVueDataToResult(data, resumeId) {
  try {
    // 构建格式化的文本内容，方便大模型理解
    let fullText = '=== 简历详情 ===\n\n';

    // 基本信息
    if (data.geekBaseInfo) {
      const info = data.geekBaseInfo;
      fullText += '【基本信息】\n';
      fullText += `姓名：${info.name || '未知'}\n`;
      fullText += `年龄：${info.age || '未知'}岁\n`;
      fullText += `性别：${info.gender === 1 ? '男' : info.gender === 2 ? '女' : '未知'}\n`;
      fullText += `工作经验：${info.workYear || '未知'}\n`;
      fullText += `学历：${info.degreeName || '未知'}\n`;
      fullText += `求职状态：${info.jobStatus || '未知'}\n`;
      if (info.expectInfo) {
        fullText += `期望城市：${info.expectInfo.cityName || '未知'}\n`;
        fullText += `期望职位：${info.expectInfo.position || '未知'}\n`;
        fullText += `期望薪资：${info.expectInfo.lowSalary || ''}-${info.expectInfo.highSalary || ''}K\n`;
      }
      fullText += '\n';
    }

    // 工作经历
    if (data.geekWorkExpList && data.geekWorkExpList.length > 0) {
      fullText += '【工作经历】\n';
      data.geekWorkExpList.forEach((exp, index) => {
        fullText += `\n${index + 1}. ${exp.company || '未知公司'}\n`;
        fullText += `   职位：${exp.positionName || '未知'}\n`;
        fullText += `   时间：${exp.startYearMonStr || ''} - ${exp.endYearMonStr || '至今'}\n`;
        if (exp.responsibility) {
          fullText += `   工作职责：${exp.responsibility}\n`;
        }
        if (exp.workContent) {
          fullText += `   工作内容：${exp.workContent}\n`;
        }
      });
      fullText += '\n';
    }

    // 项目经历
    if (data.geekProjExpList && data.geekProjExpList.length > 0) {
      fullText += '【项目经历】\n';
      data.geekProjExpList.forEach((proj, index) => {
        fullText += `\n${index + 1}. ${proj.name || '未知项目'}\n`;
        fullText += `   角色：${proj.roleName || '未知'}\n`;
        fullText += `   时间：${proj.startDateDesc || ''} - ${proj.endDateDesc || ''}\n`;
        if (proj.description) {
          fullText += `   项目描述：${proj.description}\n`;
        }
        if (proj.performance) {
          fullText += `   项目业绩：${proj.performance}\n`;
        }
      });
      fullText += '\n';
    }

    // 教育经历
    if (data.geekEduExpList && data.geekEduExpList.length > 0) {
      fullText += '【教育经历】\n';
      data.geekEduExpList.forEach((edu, index) => {
        fullText += `\n${index + 1}. ${edu.school || '未知学校'}\n`;
        fullText += `   专业：${edu.major || '未知'}\n`;
        fullText += `   学历：${edu.degreeName || '未知'}\n`;
        fullText += `   时间：${edu.startDateDesc || ''} - ${edu.endDateDesc || ''}\n`;
        if (edu.experienceDesc) {
          fullText += `   在校经历：${edu.experienceDesc}\n`;
        }
      });
      fullText += '\n';
    }

    // 自我描述
    if (data.geekDesc) {
      fullText += '【自我描述】\n';
      fullText += `${data.geekDesc}\n\n`;
    }

    // 技能标签
    if (data.skillTagList && data.skillTagList.length > 0) {
      fullText += '【技能标签】\n';
      const skills = data.skillTagList.map(s => s.name || s).join('、');
      fullText += `${skills}\n\n`;
    }

    console.log('简历内容格式化完成');
    console.log('文本长度:', fullText.length);
    console.log('工作经历数:', data.geekWorkExpList?.length || 0);
    console.log('项目经历数:', data.geekProjExpList?.length || 0);
    console.log('教育经历数:', data.geekEduExpList?.length || 0);

    // 提取基本信息
    const geekBaseInfo = data.geekBaseInfo || {};
    const geekWorkExpList = data.geekWorkExpList || [];
    const firstCompany = geekWorkExpList[0]?.company || '';

    return {
      resumeId,
      fullText,
      vueData: data,
      extractionMethod: 'vue-data',
      // 添加基本信息字段
      name: geekBaseInfo.name || '未知',
      age: geekBaseInfo.age || null,
      gender: geekBaseInfo.gender === 1 ? '男' : geekBaseInfo.gender === 2 ? '女' : '未知',
      education: geekBaseInfo.degreeName || '',
      currentTitle: geekBaseInfo.positionName || '',
      currentCompany: firstCompany,
      dataStats: {
        workExpCount: geekWorkExpList.length || 0,
        projExpCount: data.geekProjExpList?.length || 0,
        eduExpCount: data.geekEduExpList?.length || 0,
        hasDesc: !!data.geekDesc,
        hasSkills: !!(data.skillTagList && data.skillTagList.length > 0)
      },
      timestamp: new Date().toISOString()
    };

  } catch (error) {
    console.error('格式化 Vue 数据时出错:', error);
    return {
      resumeId,
      fullText: JSON.stringify(data, null, 2),
      vueData: data,
      extractionMethod: 'vue-data-raw',
      error: '格式化失败，返回原始 JSON',
      timestamp: new Date().toISOString()
    };
  }
}

// 将新函数添加到全局
if (typeof window !== 'undefined') {
  window.extractFullResumeContent = extractFullResumeContent;
  window.formatVueDataToResult = formatVueDataToResult;
}

// API 配置

// API相关函数
async function getApiEndpoint() {
  return '';
}

// 数据处理函数
async function loadAnalysisResults() {
  try {
    const rows = await window.ResumeDB.loadAll();
    window.resumeManager.analysisResults = rows;
    console.log('[DB] 加载', rows.length, '条结果');
  } catch(e) {
    console.warn('[DB] 加载失败，回退 storage:', e);
    return new Promise((resolve) => {
      chrome.storage.local.get(['analysisResults'], (result) => {
        window.resumeManager.analysisResults = result.analysisResults || [];
        resolve(window.resumeManager.analysisResults);
      });
    });
  }
  updateResultsDisplay();
  return window.resumeManager.analysisResults;
}


// 辅助函数
// 仅截取分享卡片图（不发送邮件）
async function captureShareCardImage(doc) {
  try {
    const shareBtn = findShareButton(doc);
    if (!shareBtn) return null;
    shareBtn.click();
    await new Promise(r => setTimeout(r, 800));

    // 点"转发至其他"取卡片弹窗图
    const allOptions = getShareOptions();
    const otherOpt = allOptions.find(el => el.textContent.includes('转发至其他'));
    if (otherOpt) {
      otherOpt.click();
      await new Promise(r => setTimeout(r, 1000));
      const ss = await new Promise((res, rej) => {
        protectSendMessage({ action: 'captureVisibleTab' }, r => {
          if (r && r.success) res(r.imageData); else rej(new Error('截图失败'));
        });
      });
      // 关闭两弹窗
      const cx = document.querySelector('.boss-popup__close i, .boss-popup__close, [class*="close"] i');
      if (cx) { cx.click(); await new Promise(r => setTimeout(r, 300)); }
      shareBtn.click();
      await new Promise(r => setTimeout(r, 300));
      if (cx) { cx.click(); await new Promise(r => setTimeout(r, 300)); }
      return ss; // 返回整页截图作为卡片图
    }
    return null;
  } catch(e) { console.warn('[卡片截取] 失败:', e.message); return null; }
}

function findShareButton(doc) {
  const allEls = Array.from(doc.querySelectorAll('span, i, em, div, button'));
  let btn = allEls.find(el => { const t = (el.textContent||'').trim(); return (t==='转发'||t==='分享') && el.offsetParent && !el.querySelector('*'); });
  if (!btn) btn = doc.querySelector('.resume-layout-wrap .share i, div.icon-coop-forward, em.iboss-zhuanfa');
  if (!btn) {
    const iframes = doc.querySelectorAll('iframe');
    for (const f of iframes) {
      try { const fd = f.contentDocument; if (fd) { btn = Array.from(fd.querySelectorAll('span')).find(el => el.textContent?.trim()==='转发' && el.offsetParent); if (btn) break; } } catch(e) {}
    }
  }
  return btn || null;
}

function getShareOptions() {
  const firstOptions = document.querySelectorAll('.c-share-box .item-content');
  if (firstOptions.length > 0) return Array.from(firstOptions);
  const leftList = document.querySelector("div.boss-popup__content > div > div > div.left-list");
  return leftList ? Array.from(leftList.querySelectorAll(".item")) : [];
}

// 只截卡片图，不发邮件
// 点"转发"→"转发至其他"→截卡片图→关闭弹窗
async function captureCardOnly(doc) {
  try {
    // 1. 找转发按钮 ★ 从主文档+所有 iframe 子文档搜（推荐/沟通页按钮在 iframe 内）
    //    （截卡片图不耗分享额度，只有 generateShareLink 发邮件才消耗日50次限制）
    var _stk = function(el) { var z=0,p=el; while(p&&p!==document.body){ var zi=parseInt(getComputedStyle(p).zIndex,10); if(!isNaN(zi))z=Math.max(z,zi); p=p.parentElement; } return z; };
    var _pAct = function(sel,root) { var els=Array.from((root||document).querySelectorAll(sel)).filter(function(e){var r=e.getBoundingClientRect();return r.width>50&&r.height>50}); if(!els.length)return null; els.sort(function(a,b){return _stk(a)-_stk(b)}); return els[els.length-1]; };
    var _findRec = function(sel, rootDoc) {
      if (!rootDoc || !rootDoc.querySelectorAll) return null;
      var f = _pAct(sel, rootDoc); if (f) return f;
      try { var ifs = rootDoc.querySelectorAll('iframe'); for (var k=0; k<ifs.length; k++) { try { var _r=ifs[k].getBoundingClientRect(); if(_r.width<10||_r.height<10) continue; var _st=(ifs[k].ownerDocument.defaultView||window).getComputedStyle(ifs[k]); if(_st.display==='none'||_st.visibility==='hidden') continue; var fd = ifs[k].contentDocument; if (fd) { f = _findRec(sel, fd); if (f) return f; } } catch(e) {} } } catch(e) {}
      return null;
    };
    var findForwardBtn = function(rootDoc) {
      // 收集主文档+所有【可见】子iframe里的转发/分享按钮，返回所在弹窗 z-index 最高的那个
      var cands = [];
      var _z = function(el){var z=0,p=el;while(p&&p.nodeType===1){var zi=parseInt((el.ownerDocument.defaultView||window).getComputedStyle(p).zIndex,10);if(!isNaN(zi))z=Math.max(z,zi);p=p.parentElement;}return z;};
      var _iframeVisible = function(f){ try{ var r=f.getBoundingClientRect(); if(r.width<10||r.height<10) return false; var st=(f.ownerDocument.defaultView||window).getComputedStyle(f); if(st.display==='none'||st.visibility==='hidden'||st.opacity==='0') return false; return true; }catch(e){ return false; } };
      var walk = function(d) {
        if (!d || !d.querySelectorAll) return;
        try {
          Array.from(d.querySelectorAll('span,i,em,div,button')).forEach(function(el){
            var t=(el.textContent||'').trim();
            if((t==='转发'||t==='分享')&&el.offsetParent&&!el.querySelector('*')) cands.push(el);
          });
        } catch(e) {}
        // ★ 只进【可见】iframe，跳过隐藏的推荐/搜索残留 frame（防止点到旧页面的转发按钮）
        try { var ifs=d.querySelectorAll('iframe'); for(var i=0;i<ifs.length;i++){ try{ if(!_iframeVisible(ifs[i])) continue; var fd=ifs[i].contentDocument; if(fd) walk(fd);}catch(e){} } } catch(e) {}
      };
      walk(rootDoc);
      if (!cands.length) return null;
      cands.sort(function(a,b){ return _z(a)-_z(b); });
      return cands[cands.length-1]; // 最上层弹窗的转发按钮
    };
    // ★ 先关闭所有残留的旧分享弹窗（防止推荐→搜索切换串卡）
    await closeAllShareBoxes();

    var btn = findForwardBtn(document);
    if (!btn) return {shareLink:null,shareCardImage:null};

    // 2. 点转发→弹窗
    await closeAllShareBoxes(); // 再确认一次没有残留
    btn.click();
    await new Promise(function(r){setTimeout(r,800)});

    // 3. 找"转发至其他"并点击（显示分享卡片）— 递归搜主文档+iframe
    var shareBox=_findRec('.c-share-box', document);
    var opts=shareBox?shareBox.querySelectorAll('.item-content, .nav-list .item'):document.querySelectorAll('.c-share-box .item-content, .c-share-box .nav-list .item');
    if(!opts||!opts.length){var ll=(shareBox||document).querySelector('.left-list');opts=ll?ll.querySelectorAll('.item'):[]}
    var other=Array.from(opts).find(function(el){return el.textContent.includes('转发至其他')});
    if(other){other.click();await new Promise(function(r){setTimeout(r,900)})}

    // 4. ★ 等新图生成——BOSS 缓存旧卡片，需确认是当前简历的图（非上一次截的）
    var cardImage = null;
    // 记录上一次成功截取的卡片指纹（前200字符），新卡必须不同
    var _lastCardFp = captureCardOnly._lastFp || '';
    for (var t = 0; t < 18; t++) {
      var imgEl = (shareBox || document).querySelector('img.share-image, .share-image');
      if (imgEl && imgEl.src && imgEl.src.indexOf('data:image') === 0 && imgEl.src.length > 1000) {
        var fp = imgEl.src.substring(100, 300); // 取中间一段当指纹
        if (fp !== _lastCardFp) { cardImage = imgEl.src; captureCardOnly._lastFp = fp; break; }
      }
      await new Promise(function(r) { setTimeout(r, 350); });
    }

    // 4b. 兜底：读不到 img 就截图裁剪弹窗右侧卡片区（含 DPR 修正）
    if(!cardImage){
      try{
        var ss=await new Promise(function(res,rej){chrome.runtime.sendMessage({action:'captureVisibleTab'},function(r){if(r&&r.success)res(r.imageData);else rej(new Error('截图失败'))});});
        var popup=(shareBox||document).querySelector('.right-content')||shareBox||document.querySelector('.boss-popup__content');
        if(popup){var dpr=window.devicePixelRatio||1;var rect=popup.getBoundingClientRect();if(rect.width>150&&rect.height>150){
          var cv=document.createElement('canvas');cv.width=Math.round(rect.width*dpr);cv.height=Math.round(rect.height*dpr);var cxx=cv.getContext('2d');
          var im=new Image();im.src=ss;await new Promise(function(r){im.onload=r});
          cxx.drawImage(im,Math.round(rect.left*dpr),Math.round(rect.top*dpr),Math.round(rect.width*dpr),Math.round(rect.height*dpr),0,0,cv.width,cv.height);
          cardImage=cv.toDataURL('image/jpeg',0.9);
        }}
      }catch(e){console.warn('[卡片] 兜底截图失败',e.message)}
    }

    // 5. 关弹窗（从当前激活的 shareBox 里找）
    var cx2=(shareBox||document).querySelector('.boss-popup__close i,[class*="close"] i');
    if(cx2){cx2.click();await new Promise(function(r){setTimeout(r,300)})}
    incDailyShare();
    return {shareLink:null,shareCardImage:cardImage};
  } catch(e) { console.warn('[卡片]',e.message); return {shareLink:null,shareCardImage:null}; }
}

async function generateShareLink(doc = document) {
  try {
    // ★ 每日分享限制
    const sc2 = await getDailyCounts();
    if (sc2.share >= DAILY_SHARE_LIMIT) {
      showPanelMsg('今日分享'+DAILY_SHARE_LIMIT+'次已满');
      return {shareLink:null,shareCardImage:null};
    }

    console.log('开始生成分享链接...');

    // 1. 点击转发按钮 ★ 递归搜主文档+所有 iframe（推荐/沟通页按钮在 iframe 内）
    var findForwardBtn2 = function(rootDoc) {
      // 收集所有转发/分享按钮，返回所在弹窗 z-index 最高（最上层）的那个
      var cands = [];
      var _z = function(el){var z=0,p=el;while(p&&p.nodeType===1){var zi=parseInt((el.ownerDocument.defaultView||window).getComputedStyle(p).zIndex,10);if(!isNaN(zi))z=Math.max(z,zi);p=p.parentElement;}return z;};
      var _iframeVisible = function(f){ try{ var r=f.getBoundingClientRect(); if(r.width<10||r.height<10) return false; var st=(f.ownerDocument.defaultView||window).getComputedStyle(f); if(st.display==='none'||st.visibility==='hidden'||st.opacity==='0') return false; return true; }catch(e){ return false; } };
      var walk = function(d) {
        if (!d || !d.querySelectorAll) return;
        try {
          Array.from(d.querySelectorAll('span,i,em,div,button')).forEach(function(el){
            var t=(el.textContent||'').trim();
            if((t==='转发'||t==='分享')&&el.offsetParent&&!el.querySelector('*')) cands.push(el);
          });
        } catch(e) {}
        // ★ 只进可见 iframe，跳过隐藏的推荐/搜索残留 frame
        try { var ifs=d.querySelectorAll('iframe'); for(var i=0;i<ifs.length;i++){ try{ if(!_iframeVisible(ifs[i])) continue; var fd=ifs[i].contentDocument; if(fd) walk(fd);}catch(e){} } } catch(e) {}
      };
      walk(rootDoc);
      if (!cands.length) return null;
      cands.sort(function(a,b){ return _z(a)-_z(b); });
      return cands[cands.length-1];
    };
    let shareButton = findForwardBtn2(document);
    if (!shareButton) shareButton = findForwardBtn2(doc);
    if (!shareButton) {
      // Canvas 简历无转发按钮 → 直接截整页作为卡片图
      console.log('[分享] 无转发按钮，截取整页作为卡片');
      const ss = await new Promise((res, rej) => {
        protectSendMessage({ action: 'captureVisibleTab' }, r => {
          if (r && r.success) res(r.imageData); else rej(new Error('截图失败'));
        });
      });
      incDailyShare();
      return { shareLink: null, shareCardImage: ss };
    }
    // ★ 关旧分享弹窗后再打开新的
    await closeAllShareBoxes();
    shareButton.click();

    // 等待分享弹窗出现
    console.log('等待分享弹窗出现...');
    await new Promise(resolve => setTimeout(resolve, 1000));

    // 查找转发选项 ★ 从当前激活的 c-share-box 内查找
    var _stk2 = function(el) { var z=0,p=el; while(p&&p!==document.body){ var zi=parseInt(getComputedStyle(p).zIndex,10); if(!isNaN(zi))z=Math.max(z,zi); p=p.parentElement; } return z; };
    var _pAct2 = function(sel,root) { var els=Array.from((root||document).querySelectorAll(sel)).filter(function(e){var r=e.getBoundingClientRect();return r.width>50&&r.height>50}); if(!els.length)return null; els.sort(function(a,b){return _stk2(a)-_stk2(b)}); return els[els.length-1]; };
    // ★ 递归搜主文档 + 所有子 iframe（推荐页弹窗在 recommendFrame 内）
    var _findRecursive = function(sel, rootDoc) {
      if (!rootDoc || !rootDoc.querySelectorAll) return null;
      var found = _pAct2(sel, rootDoc);
      if (found) return found;
      try {
        var ifs = rootDoc.querySelectorAll('iframe');
        for (var k=0; k<ifs.length; k++) {
          try { var fd = ifs[k].contentDocument; if (fd) { found = _findRecursive(sel, fd); if (found) return found; } } catch(e) {}
        }
      } catch(e) {}
      return null;
    };
    var activeShareBox = _findRecursive('.c-share-box', document);
    let allOptions;
    if (activeShareBox) {
      allOptions = activeShareBox.querySelectorAll('.item-content, .nav-list .item');
    }
    if (!allOptions || !allOptions.length) {
      // 兜底：全文档搜（旧行为）
      const firstOptions = document.querySelectorAll('.c-share-box .item-content');
      allOptions = firstOptions;
    }
    console.log('所有分享选项:', Array.from(allOptions).map(el => el.textContent.trim()));

    // 截取分享卡片图（点"转发至其他"后弹窗展示），直接读 <img class="share-image"> 的 base64 src
    let cardImage = null;
    const shareToOtherOption = Array.from(allOptions).find(el => el.textContent.includes('转发至其他'));
    if (shareToOtherOption) {
      shareToOtherOption.click();
      await new Promise(r => setTimeout(r, 700));
      // 轮询等卡片图片生成（从当前激活 shareBox 读，避免堆叠弹窗错人）
      for (let t = 0; t < 12; t++) {
        const imgEl = (activeShareBox || document).querySelector('img.share-image, .share-image');
        if (imgEl && imgEl.src && imgEl.src.indexOf('data:image') === 0 && imgEl.src.length > 1000) {
          cardImage = imgEl.src;
          console.log('[分享卡片] 直接读取 img.src, 大小:', (cardImage.length / 1024).toFixed(0) + 'KB');
          break;
        }
        await new Promise(r => setTimeout(r, 250));
      }
      // 兜底截图（DPR 修正）
      if (!cardImage) {
        try {
          const ss = await new Promise((res, rej) => { protectSendMessage({ action: 'captureVisibleTab' }, r => { if (r && r.success) res(r.imageData); else rej(new Error('截图失败')); }); });
          const dpr = window.devicePixelRatio || 1;
          const popup = (activeShareBox||document).querySelector('.right-content') || activeShareBox || document.querySelector('.boss-popup__content');
          if (popup) {
            const r2 = popup.getBoundingClientRect();
            if (r2.width > 150 && r2.height > 150) {
              const cv = document.createElement('canvas'); cv.width = Math.round(r2.width * dpr); cv.height = Math.round(r2.height * dpr);
              const cx = cv.getContext('2d'); const im = new Image(); im.src = ss; await new Promise(r => im.onload = r);
              cx.drawImage(im, Math.round(r2.left * dpr), Math.round(r2.top * dpr), Math.round(r2.width * dpr), Math.round(r2.height * dpr), 0, 0, cv.width, cv.height);
              cardImage = cv.toDataURL('image/jpeg', 0.9);
            }
          }
          console.log('[分享卡片] 兜底截图:', cardImage ? 'OK' : '失败');
        } catch(e) { console.warn('[分享卡片] 兜底截图失败:', e.message); }
      }
    }

    // 截图后：卡片图已取，不关弹窗，直接从左侧菜单切换"邮件转发"
    // 左侧 `.left-list .item` 还在，不用重新打开转发面板
    allOptions = (activeShareBox||document).querySelectorAll('.item-content, .nav-list .item');
    if (!allOptions || allOptions.length === 0) {
      const ll = (activeShareBox||document).querySelector('.left-list');
      allOptions = ll ? ll.querySelectorAll('.item') : [];
    }
    let dingTalkOption = Array.from(allOptions).find(el => el.textContent.includes('邮件转发'));
    if (!dingTalkOption) {
      console.warn('[分享] 左侧菜单不可见，关闭卡片重试...');
      var cx = (activeShareBox||document).querySelector('.boss-popup__close i, [class*="close"] i');
      if (cx) { cx.click(); await new Promise(r => setTimeout(r, 300)); }
      await closeAllShareBoxes();
      shareButton.click();
      await new Promise(r => setTimeout(r, 800));
      activeShareBox = _findRecursive('.c-share-box', document); // 重新找激活弹窗
      allOptions = (activeShareBox||document).querySelectorAll('.item-content, .nav-list .item');
      if (!allOptions || !allOptions.length) {
        const ll = (activeShareBox||document).querySelector('.left-list');
        allOptions = ll ? ll.querySelectorAll('.item') : [];
      }
      dingTalkOption = Array.from(allOptions).find(el => el.textContent.includes('邮件转发'));
    }
    if (!dingTalkOption) throw new Error('未找到邮件转发选项');
    dingTalkOption.click();
    await new Promise(resolve => setTimeout(resolve, 500));
    const emailInput = (activeShareBox||document).querySelector('input[placeholder*="邮箱"], input[placeholder*="邮件"], input[type="text"]')
      || Array.from((activeShareBox||document).querySelectorAll('input[type="text"]')).find(i => i.offsetParent && i.closest('[class*="popup"],[class*="dialog"],[class*="modal"]'));
    if (!emailInput) throw new Error('未找到邮箱输入框');
    const { forwardEmail } = await new Promise(r => chrome.storage.sync.get(['forwardEmail'], r));
    emailInput.value = forwardEmail || 'hr@example.com';
    emailInput.dispatchEvent(new Event('input', { bubbles: true }));
    emailInput.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 500));

    // 从邮箱框逐层向上找父容器，在每层里找可见的"转发"按钮（一定在同一弹窗内）
    let forwardBtn = null;
    let node = emailInput.parentElement;
    for (let depth = 0; depth < 8 && node; depth++) {
      const found = Array.from(node.querySelectorAll('button, span, div, a'))
        .find(b => (b.textContent || '').trim() === '转发' && b.offsetParent && !b.querySelector('*'));
      if (found) { forwardBtn = found; break; }
      node = node.parentElement;
    }
    if (!forwardBtn) throw new Error('未找到弹窗内的转发按钮');
    forwardBtn.click();
    console.log('已点击弹窗转发按钮');
    await new Promise(r => setTimeout(r, 2000));

    console.log('邮件转发已提交, cardImage:', cardImage ? (cardImage.length/1024).toFixed(0)+'KB' : 'NULL');
    incDailyShare();
    // ★ 关闭分享弹窗，防止堆叠
    try {
      const closeBtn = (activeShareBox||document).querySelector('.boss-popup__close i, .iboss-close, [class*="close"] i, [class*="close"]');
      if (closeBtn) { closeBtn.click(); await new Promise(r => setTimeout(r, 300)); }
    } catch(e) {}
    return { shareLink: null, shareCardImage: cardImage };

  } catch (error) {
    console.error('生成分享链接失败:', error);
    console.error('错误堆栈:', error.stack);
    // 打印当前DOM状态
    console.log('当前页面分享相关元素:', {
      shareButton: document.querySelector('.resume-layout-wrap .share i'),
      alternativeShareButton: document.querySelector("div.attachment-resume-top-ui > div.attachment-resume-top-content > div:nth-child(1) > span"),
      shareBox: document.querySelector('.c-share-box'),
      shareInput: document.querySelector("div.boss-popup__content > div > div > div.right-content > div > input")
    });
    return null;
  }
}


// 在文件开头添加初始化代码
window.resumeManager = window.resumeManager || {
  analysisResults: [],
  analyzedResumeIds: new Set(),
  extractSearchPageResumeContent,
  extractChatPageResumeContent,
  extractRecommendPageResumeContent,
  extractCardInnerInfo,
  evaluateResume,
  closeResume,
  forceCloseResumeDialog,
  checkTrialRemaining,
  favoriteResume,
  isResumeFavorited,
  saveAnalyzedResumeId,
  loadAnalyzedResumeIds,
  getUserScoreThreshold,
  getAutoFavoriteSetting,
  getAutoGreetSetting,
  getAutoShareSetting,
  getUserPrompt,
  getApiKey,
  loadAnalysisResults,
  saveAnalysisResults,
  clickElement,
  sendGreeting,
  sendGreetingFromList,
  // 新增以下函数
  createAnalysisStatusElement,
  updateAnalysisStatus,
  extractNewGeekCardInfo,
  extractCardInnerInfo,
  extractNewRecommendPageResumeContent,
  generateShareLink,
  captureCardOnly,
  handleChatResumeCollection,
  handleChatResumeDownload,
  checkTrialRemaining,
  // 新增：完整简历内容提取函数
  extractFullResumeContent
};

// 添加获取模型设置的函数
function getModel() {
  return Promise.resolve('deepseek-chat');
}

// AI分析 调用统一走后端代理，API key 只存在于服务端（后端地址由构建时 $$BACKEND_URL$$ 决定）
async function deepseekRequest(body) {
  // ★ 调AI分析前检查试用次数
  var tr = await checkTrialRemaining();
  if (tr <= 0) throw new Error('次数已用完');
  return new Promise((resolve, reject) => {
    protectSendMessage({ action: 'deepseekProxy', body }, response => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else if (response && response.ok) resolve(response.data);
      else reject(new Error(response?.error || '后端服务不可用'));
    });
  });
}


// 优化后的保存分析结果函数
async function saveAnalysisResults() {
  // 使用 Map 提高查找效率
  const uniqueMap = new Map();

  // 遍历并只保留必要字段
  for (const result of window.resumeManager.analysisResults) {
    // 确保工作经历数据的完整性
    const workExperiences = Array.isArray(result.workExperiences) ? result.workExperiences : [];
    const latestWork = workExperiences[0] || {};

    // 优先使用已有的 currentCompany；如果是空或占位“未知”，则回退到最近一份工作经历的公司
    const normalizedCurrentCompany =
      (result.currentCompany && result.currentCompany !== '未知')
        ? result.currentCompany
        : (latestWork.company || '未知');

    // 创建精简的结果对象，只保留必要字段
    const simplifiedResult = {
      name: result.name || '未知',
      gender: result.gender || '未知',
      age: result.age != null ? result.age : (result.age || '未知'),
      experience: result.experience || '未知',
      education: result.education || '未知',
      currentCompany: normalizedCurrentCompany,
      currentTitle: result.currentTitle || '',
      expectCity: result.expectCity || (result.expectInfo?.location) || '',
      expectPosition: result.expectPosition || (result.expectInfo?.position) || '',
      expectSalary: result.expectSalary || (result.expectInfo?.salary) || '',
      jobStatus: result.jobStatus || '未知',
      position: result.position || '未知',
      resumeId: result.resumeId || result.position?.resumeId || '',
      fullText: result.fullText || '',
      workExperiences: result.workExperiences || [],
      projectExperiences: result.projectExperiences || [],
      educationInfo: result.educationInfo || {},
      skills: result.skills || '',
      evaluation: {
        score: result.evaluation?.score || 0,
        isQualified: result.evaluation?.score >= (result.scoreThreshold || 80),
        suggestion: result.evaluation?.suggestion || '',
        details: result.evaluation?.details || null
      },
      prompt_name: result.prompt_name || '默认模板',
      shareLink: result.shareLink || '',
      dsParsed: result.dsParsed || '',
      resumeImage: result.resumeImage || '',
      shareCardImage: result.shareCardImage || '',
      timestamp: result.timestamp || new Date().toISOString()
    };

    // 使用关键字段创建唯一标识
    const fingerprint = [
      simplifiedResult.resumeId,
      simplifiedResult.name,
      simplifiedResult.age,
      simplifiedResult.workExperiences[0]?.company || '',
      simplifiedResult.workExperiences[0]?.position || '',
      simplifiedResult.education
    ].join('_');

    // 如果存在重复项，保留最新的记录
    const existing = uniqueMap.get(fingerprint);
    if (!existing || new Date(simplifiedResult.timestamp) > new Date(existing.timestamp)) {
      uniqueMap.set(fingerprint, simplifiedResult);
    }
  }

  // 转换回数组并更新
  const uniqueResults = Array.from(uniqueMap.values());
  window.resumeManager.analysisResults = uniqueResults;

  // IndexedDB 持久化 — 全量保存
  window.ResumeDB.saveAll(uniqueResults).catch(e => console.warn('[DB] 全量保存失败:', e));
  // ★ 同时写 chrome.storage.local 兜底（IndexedDB 加载失败时回退）
  try {
    var _slim = uniqueResults.map(function(r) {
      return {resumeId: r.resumeId, name: r.name, evaluation: r.evaluation,
              timestamp: r.timestamp, age: r.age, education: r.education};
    });
    await new Promise(function(r) { chrome.storage.local.set({analysisResults: _slim}, r); });
  } catch(e) {}
}

// 提取简历内容函数
async function extractSearchPageResumeContent(doc, resumeId) {
  try {
    // 等待简历详情加载完成（最多等待10秒）
    const startTime = Date.now();
    let resumeDetail = null;

    while (!resumeDetail && Date.now() - startTime < 10000) {
      // 从主文档中查找简历详情
      try {
        resumeDetail = doc.querySelector('.boss-dialog__wrapper .resume-detail-wrap')
      } catch (e) {
        console.warn('查找简历详情元素时出错:', e);
      }

      if (!resumeDetail) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    if (!resumeDetail) {
      console.warn('无法获取简历数据，返回空对象');
      return {
        resumeId,
        name: '',
        gender: '',
        age: null,
        experience: '',
        education: '',
        jobStatus: '',
        expectInfo: { location: '', position: '', salary: '' },
        workExperiences: [],
        projectExperiences: [],
        educationInfo: { school: '', major: '', degree: '', period: '' },
        selfDescription: '',
        timestamp: new Date().toISOString()
      };
    }

    // 提取基本信息
    let baseInfo = {};
    try {

      baseInfo = {
        name: (resumeDetail.querySelector('.geek-name')?.textContent?.trim() ||
          resumeDetail.querySelector('.resume-section.geek-base-info-wrap .section-title')?.textContent?.trim() || ''),
        // gender: (resumeDetail.querySelector('.iboss-icon_man') || 
        //         resumeDetail.querySelector('[class^="iboss-icon_man"]')) ? '男' : 
        //         (resumeDetail.querySelector('.iboss-icon_women') || 
        //         resumeDetail.querySelector('[class^="iboss-icon_women"]')) ? '女' : '',
        isElite: !!resumeDetail.querySelector('img.elite'),
        activeStatus: resumeDetail.querySelector('.active-status')?.textContent?.trim() || ''
      };

    } catch (e) {
      console.warn('提取基本信息时出错:', e);
      baseInfo = {
        name: '',
        gender: '',
        isElite: false,
        activeStatus: ''
      };
    }

    // 提取标签信息
    let labels = [];
    try {

      labels = Array.from(resumeDetail.querySelectorAll('.info-labels span') || [])
        .map(span => span?.textContent?.trim() || '')
        .filter(text => text && !text.includes('line'));

    } catch (e) {
      console.warn('提取标签信息时出错:', e);
    }

    // 解析标签信息
    let age = '', experience = '', education = '', jobStatus = '';
    try {
      if (labels.length >= 1) age = labels[0];
      if (labels.length >= 2) experience = labels[1];
      if (labels.length >= 3) education = labels[2];
      if (labels.length >= 4) jobStatus = labels[3];
    } catch (error) {
      console.warn('解析标签信息失败:', error);
    }

    // 尝试从新页面结构中提取工作经验
    if (!experience) {
      try {

        const positionExperienceTag = resumeDetail.querySelector('.resume-section.geek-position-experience-wrap .tags .tag');
        if (positionExperienceTag) {
          const expText = positionExperienceTag?.textContent || '';
          const expMatch = expText.match(/(\d+)年(\d+)个月/);
          if (expMatch) {
            experience = `${expMatch[1]}年${expMatch[2]}个月`;
          }
        }

      } catch (e) {
        console.warn('提取新页面工作经验时出错:', e);
      }
    }

    // 提取期望职位信息
    let expectInfo = { location: '', position: '', salary: '' };
    try {

      // 尝试从原有结构中获取
      let originalLocation = '', originalPosition = '', originalSalary = '';
      try {
        originalLocation = resumeDetail.querySelector('.geek-expect-wrap .join-text-wrap span:first-child')?.textContent?.trim() ||
          resumeDetail.querySelector('div[data-v-60bcabcd].geek-expect-wrap .join-text-wrap span:first-child')?.textContent?.trim() || '';
        originalPosition = resumeDetail.querySelector('.geek-expect-wrap .join-text-wrap span:nth-child(3)')?.textContent?.trim() ||
          resumeDetail.querySelector('div[data-v-60bcabcd].geek-expect-wrap .join-text-wrap span:nth-child(3)')?.textContent?.trim() || '';
        originalSalary = resumeDetail.querySelector('.geek-expect-wrap .join-text-wrap span:last-child')?.textContent?.trim() ||
          resumeDetail.querySelector('div[data-v-60bcabcd].geek-expect-wrap .join-text-wrap span:last-child')?.textContent?.trim() || '';
      } catch (e) {
        console.warn('提取原有结构期望职位信息时出错:', e);
      }

      // 尝试从新结构中获取
      let newLocation = '', newPosition = '', newSalary = '';
      try {
        const newExpectWrap = resumeDetail.querySelector('.resume-section.geek-expect-wrap .join-text-wrap');
        if (newExpectWrap) {
          const spans = newExpectWrap.querySelectorAll('span') || [];
          if (spans.length >= 1) newLocation = spans[0]?.textContent?.trim() || '';
          if (spans.length >= 2) newPosition = spans[1]?.textContent?.trim() || '';
          if (spans.length >= 4) newSalary = spans[3]?.textContent?.trim() || '';
        }
      } catch (e) {
        console.warn('提取新结构期望职位信息时出错:', e);
      }

      expectInfo = {
        location: originalLocation || newLocation || '',
        position: originalPosition || newPosition || '',
        salary: originalSalary || newSalary || ''
      };

    } catch (error) {
      console.warn('提取期望职位信息失败:', error);
    }

    // 提取自我描述
    let selfDescription = '';
    try {

      selfDescription = resumeDetail.querySelector('.text.selfDescription')?.textContent?.trim() ||
        resumeDetail.querySelector('.geek-base-info-wrap .geek-desc')?.textContent?.trim() || '';

    } catch (e) {
      console.warn('提取自我描述时出错:', e);
    }

    // 提取工作经历
    let workExperiences = [];
    try {

      // 尝试从原有结构中获取
      try {
        const workWraps = resumeDetail.querySelectorAll('.geek-work-experience-wrap .work-wrap') || [];
        if (workWraps.length > 0) {
          workExperiences = Array.from(workWraps).map(work => {
            try {
              return {
                company: work.querySelector('.company-name')?.textContent?.trim() ||
                  work.querySelector('.company-name-wrap .name')?.textContent?.trim() || '',
                position: work.querySelector('.position')?.textContent?.trim() ||
                  work.querySelector('.company-name-wrap .position span')?.textContent?.trim() || '',
                period: work.querySelector('.period')?.textContent?.trim() || '',
                content: work.querySelector('.item-content')?.textContent?.trim() || '',
                skills: Array.from(work.querySelectorAll('.tags span, .tags .tag') || [])
                  .map(tag => tag?.textContent?.trim() || '')
                  .filter(Boolean)
              };
            } catch (e) {
              console.warn('提取单个工作经历时出错:', e);
              return {
                company: '',
                position: '',
                period: '',
                content: '',
                skills: []
              };
            }
          });
        }
      } catch (e) {
        console.warn('提取原有结构工作经历时出错:', e);
      }

      if (!workExperiences.length) {
        // 尝试从第二种结构中获取
        try {
          let workExperienceDiv = null;
          for (let i = 1; i <= 5; i++) {
            try {
              const div = resumeDetail.querySelector(`div.resume-box > div > div > div > div:nth-child(${i})`);
              if (div && div.querySelector('h3')?.textContent?.trim() === '工作经历') {
                workExperienceDiv = div;
                break;
              }
            } catch (e) {
              console.warn(`查找第${i}个div时出错:`, e);
            }
          }

          if (workExperienceDiv) {
            const historyItems = workExperienceDiv.querySelectorAll('.history-list .history-item') || [];
            workExperiences = Array.from(historyItems).map(item => {
              try {
                return {
                  company: item.querySelector('.history-item-title .name span:first-child')?.textContent?.trim() || '',
                  position: item.querySelector('.name span:nth-child(3)')?.textContent?.trim() || '',
                  period: item.querySelector('.period')?.textContent?.trim() || '',
                  content: item.querySelector('.item-text .text')?.textContent?.trim() || '',
                  skills: Array.from(item.querySelectorAll('.tags span') || [])
                    .map(tag => tag?.textContent?.trim() || '')
                    .filter(Boolean)
                };
              } catch (e) {
                console.warn('提取单个工作经历(第二种结构)时出错:', e);
                return {
                  company: '',
                  position: '',
                  period: '',
                  content: '',
                  skills: []
                };
              }
            });
          }
        } catch (e) {
          console.warn('提取第二种结构工作经历时出错:', e);
        }
      }

    } catch (error) {
      console.warn('提取工作经历失败:', error);
    }

    // 提取项目经验
    let projectExperiences = [];
    try {

      try {
        let projectExperienceDiv = null;
        for (let i = 1; i <= 5; i++) {
          try {
            const div = resumeDetail.querySelector(`div.resume-box > div > div > div > div:nth-child(${i})`);
            if (div && div.querySelector('h3')?.textContent?.trim() === '项目经验') {
              projectExperienceDiv = div;
              break;
            }
          } catch (e) {
            console.warn(`查找项目经验第${i}个div时出错:`, e);
          }
        }

        if (projectExperienceDiv) {
          const historyItems = projectExperienceDiv.querySelectorAll('.history-list .history-item') || [];
          projectExperiences = Array.from(historyItems).map(project => {
            try {
              const nameText = project.querySelector('.name')?.textContent || '';
              const nameParts = nameText.split(/\s*<em.*?vline.*?em>\s*|\s*·\s*/);
              return {
                name: nameParts[0]?.trim() || '',
                role: nameParts[1]?.trim() || '',
                period: project.querySelector('.period')?.textContent?.trim() || '',
                content: project.querySelector('.text.project-content')?.textContent?.trim() || ''
              };
            } catch (e) {
              console.warn('提取单个项目经验时出错:', e);
              return {
                name: '',
                role: '',
                period: '',
                content: ''
              };
            }
          });
        }
      } catch (e) {
        console.warn('提取第一种结构项目经验时出错:', e);
      }

      if (!projectExperiences.length) {
        try {
          const projectWraps = resumeDetail.querySelectorAll('.geek-project-experience-wrap .project-wrap') || [];
          projectExperiences = Array.from(projectWraps).map(project => {
            try {
              return {
                name: project.querySelector('.name span:first-child')?.textContent?.trim() || '',
                role: project.querySelector('.name span:last-child')?.textContent?.trim() || '',
                period: project.querySelector('.period')?.textContent?.trim() || '',
                content: project.querySelector('.item-content')?.textContent?.trim() || ''
              };
            } catch (e) {
              console.warn('提取单个项目经验(第二种结构)时出错:', e);
              return {
                name: '',
                role: '',
                period: '',
                content: ''
              };
            }
          });
        } catch (e) {
          console.warn('提取第二种结构项目经验时出错:', e);
        }
      }

    } catch (error) {
      console.warn('提取项目经验失败:', error);
    }

    // 提取教育经历
    let educationInfo = { school: '', major: '', degree: '', period: '' };
    try {

      // 尝试从原有结构中获取
      try {
        educationInfo = {
          school: resumeDetail.querySelector('.school-name')?.textContent?.trim() || '',
          major: resumeDetail.querySelector('.major')?.textContent?.trim() || '',
          degree: resumeDetail.querySelector('.school-name-wrap span:last-child')?.textContent?.trim() || '',
          period: resumeDetail.querySelector('.edu-wrap .period')?.textContent?.trim() || ''
        };
      } catch (e) {
        console.warn('提取原有结构教育经历时出错:', e);
      }

      if (!educationInfo.school || !educationInfo.major) {
        // 尝试从第二种结构中获取
        try {
          const schoolInfo = resumeDetail.querySelector('.school-info');
          if (schoolInfo) {
            const nameText = schoolInfo.querySelector('h4.name b')?.textContent || '';
            const degreeText = schoolInfo.querySelector('h4.name')?.textContent || '';
            educationInfo = {
              school: nameText.trim() || '',
              major: schoolInfo.querySelector('.major')?.textContent?.trim() || '',
              degree: degreeText.split('本科')?.[0]?.trim() || '',
              period: schoolInfo.querySelector('.period')?.textContent?.trim() || ''
            };
          }
        } catch (e) {
          console.warn('提取第二种结构教育经历时出错:', e);
        }
      }

      // 尝试从新结构中获取
      if (!educationInfo.school || !educationInfo.major) {
        try {
          const newEduWrap = resumeDetail.querySelector('.resume-section.geek-education-experience-wrap .edu-wrap');
          if (newEduWrap) {
            const schoolNameWrap = newEduWrap.querySelector('.school-name-wrap');
            if (schoolNameWrap) {
              educationInfo = {
                school: schoolNameWrap.querySelector('.school-name')?.textContent?.trim() || '',
                major: schoolNameWrap.querySelector('.major')?.textContent?.trim() || '',
                degree: schoolNameWrap.querySelector('span:nth-child(5)')?.textContent?.trim() || '',
                period: newEduWrap.querySelector('.period')?.textContent?.trim() || ''
              };
            }
          }
        } catch (e) {
          console.warn('提取新结构教育经历时出错:', e);
        }
      }

    } catch (error) {
      console.warn('提取教育经历失败:', error);
    }

    // 尝试解析年龄为数字
    let ageNum = null;
    try {
      if (age) {
        const ageMatch = age.match(/(\d+)/);
        if (ageMatch) {
          ageNum = parseInt(ageMatch[1]);
        }
      }
    } catch (e) {
      console.warn('解析年龄为数字时出错:', e);
    }

    const content = {
      resumeId,
      ...baseInfo,
      age: ageNum,
      experience,
      education,
      jobStatus,
      expectInfo,
      workExperiences,
      projectExperiences,
      educationInfo,
      selfDescription,
      timestamp: new Date().toISOString()
    };

    console.log('成功提取简历内容:', content);
    return content;
  } catch (error) {
    console.error('提取简历内容时发生错误:', error);
    // 即使发生错误，也返回一个包含基本信息的对象
    return {
      resumeId,
      name: '',
      gender: '',
      age: null,
      experience: '',
      education: '',
      jobStatus: '',
      expectInfo: { location: '', position: '', salary: '' },
      workExperiences: [],
      projectExperiences: [],
      educationInfo: { school: '', major: '', degree: '', period: '' },
      selfDescription: '',
      timestamp: new Date().toISOString(),
      error: error.message
    };
  }
}

// 在函数前部定义全局变量
let thinkingContent = ''; // 用于累积思考内容
let currentResumeId = null; // 当前正在分析的简历ID

// 添加一个全局计数器
let analyzedResumeCounter = 0;

// 修改resetThinkingContent函数
function resetThinkingContent() {
  // 只保留最近的 N 条记录
  const maxRecords = 5;
  const records = thinkingContent.split('================').slice(-maxRecords);
  thinkingContent = records.join('================');

  analyzedResumeCounter++;
  thinkingContent += `\n\n================ 简历 #${analyzedResumeCounter} ================\n\n`;
  currentResumeId = null;
}

/**
 * 调用自定义 API（用户配置的 OpenAI 兼容 API）
 * 数据直接从浏览器发送到用户的 API，不经过我们的服务器
 */
async function callCustomApi(resumeContent, config, doc = document) {
  const { model, systemPrompt } = config;

  console.log('callCustomApi - 通过后端代理, model:', model);

  // 获取用户自定义提示词，如果没有则使用默认
  let userPrompt = systemPrompt;
  if (!userPrompt) {
    // 尝试从用户提示词模板获取
    const prompt_template = await getUserPrompt();
    userPrompt = prompt_template?.content || '请评估这份简历是否符合职位要求。';
  }

  // 构建简历文本
  let resumeText = '';
  if (resumeContent.fullText) {
    resumeText = resumeContent.fullText;
  } else {
    resumeText = `姓名: ${resumeContent.name || '未知'}
基本信息: ${resumeContent.basicInfo || ''}
工作经历: ${resumeContent.workExperience || ''}
项目经历: ${resumeContent.projectExperience || ''}
教育经历: ${resumeContent.education || ''}
技能: ${resumeContent.skills || ''}`;
  }

  // 把评估规则和 JSON 格式要求放在用户消息中，GPT-4o 更难忽略
  const jsonFormat = `\n\n---\n请严格按照以下 JSON 格式返回评估结果，不要包含任何其他文字：
{"score":0,"analysis":"分析","highlights":["亮点"],"concerns":["顾虑"],"suggestion":"建议"}`;

  console.log('callCustomApi - 通过后端代理发送请求...');

  try {
    const data = await deepseekRequest({
      model: model,
      messages: [
        { role: 'system', content: userPrompt },
        { role: 'user', content: `请评估以下简历：\n\n${resumeText}${jsonFormat}` }
      ],
      temperature: 0.3,
      response_format: { type: 'json_object' }
    });

    console.log('callCustomApi - API 响应:', JSON.stringify(data).substring(0, 500));

    const content = data.choices?.[0]?.message?.content || '';
    console.log('callCustomApi - AI 内容:', content.substring(0, 300));

    // 解析 JSON
    let result;
    try {
      result = JSON.parse(content.trim());
    } catch (e) {
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        try { result = JSON.parse(jsonMatch[1].trim()); } catch (e2) {}
      }
      if (!result) {
        const start = content.indexOf('{');
        const end = content.lastIndexOf('}');
        if (start !== -1 && end > start) {
          try { result = JSON.parse(content.substring(start, end + 1)); } catch (e2) {}
        }
      }
      if (!result) throw new Error('无法解析 AI 返回的 JSON: ' + content.substring(0, 200));
    }

    const finalResult = {
      score: typeof result.score === 'number' ? result.score : 0,
      analysis: result.analysis || result.评价 || result.comments || '无分析内容',
      highlights: result.highlights || result.亮点 || [],
      concerns: result.concerns || result.顾虑 || result.不足 || [],
      suggestion: result.suggestion || result.建议 || '',
      prompt_name: '自定义 API',
      model: model,
      apiMode: 'custom'
    };

    let shareLink = null, shareCardImage = null;
    try {
      // 卡片图：达标 or 勾选"未达标仍截取"才截
      const scoreThreshold = await getUserScoreThreshold();
      const captureUnqualified = await getCaptureUnqualifiedCardSetting();
      if (finalResult.score >= scoreThreshold || captureUnqualified) {
        shareCardImage = (await window.resumeManager?.captureCardOnly())?.shareCardImage || null;
      }
      // 邮件：仅勾选时发送
      const shouldAutoShare = await window.resumeManager?.getAutoShareSetting();
      if (shouldAutoShare && finalResult.score >= scoreThreshold) {
        shareLink = (await window.resumeManager?.generateShareLink(doc))?.shareLink || null;
      }
    } catch(e) { console.warn('[分享] 失败:', e.message); }
    return {
      ...finalResult,
      shareLink,
      shareCardImage
    };

  } catch (error) {
    console.error('callCustomApi 错误:', error);
    throw error;
  }
}

// 更新评估简历函数，在开始评估时添加简历标识
async function evaluateResume(resumeContent, doc = document) {
  try {
    console.log('resumeContent', resumeContent);

    // 调试：强制弹窗确认走到了这里
    const hasText = !!(resumeContent.fullText && resumeContent.fullText.length > 20);
    DEBUG && showPanelMsg(hasText ? '文本提取成功,跳过AI识别' : '文本为空,走AI识别');

    // 检查是否提取失败（包含 error 属性），如果是，强制触发视觉识别
    if (resumeContent.error || (!resumeContent.fullText && !resumeContent.name)) {
      console.warn('简历内容提取异常，强制触发视觉识别 (Vision Fallback)...', resumeContent.error);

      // 检查 API 模式，准备配置
      const { apiMode: mode, customApiConfig: config } = await new Promise(resolve => {
        chrome.storage.local.get(['apiMode', 'customApiConfig'], resolve);
      });

      // ========== 修改：先AI识别提取，再评估 ==========
      try {
        const prompt_template = await getUserPrompt();
        const templateName = prompt_template?.name || '默认模板';

        // 1. 先获取截图
        console.log('[AI识别] 第一步：截取简历图片...');
        const imageList = await captureFullResumeScreenshot(doc);
        if (!imageList || imageList.length === 0) {
          throw new Error('无法生成简历截图');
        }
        console.log(`[AI识别] 已获取 ${imageList.length} 张截图`);

        // 2. 调用AI识别服务提取文字（分开调用）
        console.log('[AI识别] 第二步：调用AI识别服务提取文字...');
        const ocrResultText = await callOfficialOcrService(imageList);
        
        if (!ocrResultText || !ocrResultText.trim()) {
          throw new Error('AI识别服务未返回有效内容');
        }

        // 3. 解析AI识别结果
        let structuredResume = null;
        try {
          if (ocrResultText.trim().startsWith('{')) {
            structuredResume = JSON.parse(ocrResultText);
          } else {
            structuredResume = { fullText: ocrResultText };
          }
          console.log('[AI识别] AI识别识别成功:', structuredResume.name || '未知姓名');
        } catch (e) {
          console.warn('[AI识别] 解析AI识别结果失败:', e);
          structuredResume = { fullText: ocrResultText };
        }

        // 4. 合并AI识别结果到resumeContent（不显示，只用于评估）
        resumeContent = {
          ...resumeContent,
          ...structuredResume,
          fullText: structuredResume.fullText || ocrResultText,
          extractionMethod: 'ocr-then-eval',
          resumeId: resumeContent.resumeId
        };

        // 补全基本信息
        if (structuredResume.name) resumeContent.name = structuredResume.name;
        if (structuredResume.gender) resumeContent.gender = structuredResume.gender;
        if (structuredResume.age) resumeContent.age = structuredResume.age;
        if (structuredResume.education) resumeContent.education = structuredResume.education;
        if (structuredResume.experience) resumeContent.experience = structuredResume.experience;
        if (structuredResume.currentTitle) resumeContent.currentTitle = structuredResume.currentTitle;
        if (structuredResume.currentCompany) resumeContent.currentCompany = structuredResume.currentCompany;

        // 5. 调用评估接口（第三步）
        console.log('[EVAL] 第三步：调用评估接口...');
        const evalApiKey = await getApiKey();
        const evalModel = await getModel();
        const evalBaseUrl = await getApiEndpoint();
        
        const settings = {
          prompt: prompt_template.content,
          model: evalModel,
          useCustomEndpoint: false
        };

        // 调用评估服务
        // 注意：callOfficialResumeEvalService 返回的是 { evaluation: {...}, shareLink: ... } 结构
        // 不是直接的 { score: ..., details: ... }
        const evalResult = await callOfficialResumeEvalService(resumeContent, settings, evalApiKey, evalBaseUrl);

        // 从返回结果中提取 evaluation 对象
        // 常见错误：直接使用 evalResult.score，但 evalResult 是 { evaluation: {...} } 结构
        // 正确做法：使用 evalResult.evaluation.score
        const evaluation = evalResult.evaluation;
        const finalScore = evaluation?.score ?? 0;

        console.log('[EVAL] 评估完成，分数:', finalScore);

        // 6. 保存结果
        // 注意：evaluation 字段应该保存 evaluation 对象，不是整个 evalResult
        window.resumeManager.analysisResults.push({
          ...resumeContent,
          evaluation: evaluation,  // 保存 evaluation 对象，不是 evalResult
          shareLink: evalResult.shareLink || null, shareCardImage: evalResult.shareCardImage || null,
          timestamp: new Date().toISOString(),
          position: { resumeId: resumeContent.resumeId },
          prompt_name: templateName
        });
        await saveAnalysisResults();
        if (typeof updateResultsDisplay === 'function') updateResultsDisplay();

        return finalScore;

      } catch (ocrError) {
        console.error('[AI识别+Eval] 流程失败:', ocrError);
        throw new Error(`AI识别提取或评估失败: ${ocrError.message}`);
      }
      // ========== 修改结束 ==========
    }

    // 检查 API 模式
    const { apiMode, customApiConfig } = await new Promise(resolve => {
      chrome.storage.local.get(['apiMode', 'customApiConfig'], resolve);
    });

    // 自定义 API 模式：直接调用用户配置的 API
    if (apiMode === 'custom' && customApiConfig && customApiConfig.baseUrl && customApiConfig.apiKey) {
      console.log('使用自定义 API 模式');

      // 默认优先触发视觉识别 (Vision First)
      console.log('[Vision] 自定义模式统一使用截图识别');
      try {
        const visionText = await performVisionExtraction(doc, resumeContent.resumeId, apiMode, customApiConfig);
        if (visionText) {
          console.log('视觉识别成功，使用 AI识别 文本进行评估');

          if (visionText.trim().startsWith('{')) {
            try {
              const parsedOcr = JSON.parse(visionText);
              if (parsedOcr.name && (!resumeContent.name || resumeContent.name === '未知')) resumeContent.name = parsedOcr.name;
              if (parsedOcr.age && (!resumeContent.age || resumeContent.age === '未知')) resumeContent.age = parsedOcr.age;
              if (parsedOcr.gender && (!resumeContent.gender || resumeContent.gender === '未知')) resumeContent.gender = parsedOcr.gender;
              if (parsedOcr.education && (!resumeContent.education || resumeContent.education === '未知')) resumeContent.education = parsedOcr.education;
            } catch (e) {
              console.warn('解析 AI识别 结构化数据失败:', e);
            }
          }

          resumeContent.fullText = visionText;
          resumeContent.extractionMethod = 'screenshot-ocr';
        }
      } catch (visionError) {
        console.error('视觉识别失败:', visionError);
      }

      const customResult = await callCustomApi(resumeContent, customApiConfig, doc);

      // 构建评估结果对象，兼容原有格式
      const evaluation = {
        score: customResult.score,
        details: {
          baseScore: customResult.score,
          additions: [],
          totalScore: customResult.score,
          analysis: customResult.analysis,
          highlights: customResult.highlights,
          concerns: customResult.concerns
        },
        comments: customResult.analysis,
        suggestion: customResult.suggestion
      };

      // 将结果添加到分析结果数组
      window.resumeManager.analysisResults.push({
        ...resumeContent,
        evaluation,
        shareLink: customResult.shareLink,
        timestamp: new Date().toISOString(),
        position: {
          resumeId: resumeContent.resumeId
        },
        prompt_name: customResult.prompt_name || '自定义 API',
        shareCardImage: customResult.shareCardImage || null
      });

      // 保存结果并更新显示
      await saveAnalysisResults();
      try {
        if (typeof updateResultsDisplay === 'function') {
          updateResultsDisplay();
        }
      } catch (e) {
        console.warn('更新结果显示失败:', e);
      }

      return customResult.score;
    }

    // 官方 API 模式：先AI识别解析图片，再评估结构化数据
    console.log('使用官方 API 模式（先AI识别再评估）');

    // 获取配置
    const apiKey = await getApiKey();
    const prompt_template = await getUserPrompt();
    const model = await getModel();
    const baseUrl = await getApiEndpoint();

    if (!apiKey) throw new Error('API密钥未配置');
    if (!prompt_template || typeof prompt_template !== 'object') throw new Error('无效的提示模板');

    const prompt = prompt_template.content;

    // NEW STRATEGY: 先 AI识别 解析图片得到结构化数据，再用评估接口评估
    let ocrSuccess = false;
    let structuredResume = null;

    try {
      console.log('[AI识别] 尝试 AI识别 解析模式...');

      // 如果之前已经成功进行过视觉识别，跳过重复截图
      if (resumeContent.extractionMethod === 'vision-fallback' && resumeContent.fullText) {
        console.log('[AI识别] 之前已完成视觉识别，尝试解析已有结果...');
        try {
          const visionData = JSON.parse(resumeContent.fullText);
          // 如果已有结构化数据，直接使用
          if (visionData.name || visionData.workExperiences) {
            structuredResume = visionData;
            ocrSuccess = true;
            console.log('[AI识别] 使用已有的结构化数据');
          }
        } catch (e) {
          console.warn('[AI识别] 解析已有视觉识别结果失败:', e);
        }
      }

      // 如果没有已有的结构化数据，则重新截图并进行 AI识别
      if (!ocrSuccess) {
        // 1. 获取截图
        const imageList = await captureFullResumeScreenshot(doc);

        if (imageList && imageList.length > 0) {
          // 2. 调用 AI识别 服务解析图片
          console.log('[AI识别] 调用 AI识别 服务解析图片...');
          const ocrResultText = await callOfficialOcrService(imageList);

          if (ocrResultText && ocrResultText.trim()) {
            console.log('[AI识别] AI识别 识别成功，尝试解析结构化数据...');

            // 解析 AI识别 结果为结构化数据
            try {
              if (ocrResultText.trim().startsWith('{')) {
                structuredResume = JSON.parse(ocrResultText);
              } else {
                // 如果返回的是纯文本，创建一个基础结构
                structuredResume = {
                  name: '',
                  fullText: ocrResultText
                };
              }
              ocrSuccess = true;
              console.log('[AI识别] 结构化数据解析成功:', structuredResume.name || '未知姓名');
            } catch (e) {
              console.warn('[AI识别] 解析结构化数据失败:', e);
              structuredResume = { fullText: ocrResultText };
              ocrSuccess = true; // 仍然认为 AI识别 成功，只是没有结构化
            }
          }
        }
      }

      // 3. 如果 AI识别 成功，调用评估接口
      if (ocrSuccess && structuredResume) {
        console.log('[EVAL] 调用评估接口...');

        // 构建 settings 对象
        const settings = {
          prompt,
          model,
          useCustomEndpoint: await new Promise(resolve => {
            chrome.storage.sync.get(['useCustomEndpoint'], result => resolve(result.useCustomEndpoint || false));
          })
        };

        // 将结构化数据合并到 resumeContent 中
        const mergedResume = {
          ...resumeContent,
          ...structuredResume,
          extractionMethod: 'ocr-structured'
        };

        // 尝试从结构化数据中提取基本信息补全 resumeContent
        if (structuredResume.name) mergedResume.name = structuredResume.name;
        if (structuredResume.gender) mergedResume.gender = structuredResume.gender;
        if (structuredResume.age) mergedResume.age = structuredResume.age;
        if (structuredResume.education) mergedResume.education = structuredResume.education;
        if (structuredResume.experience) mergedResume.experience = structuredResume.experience;
        if (structuredResume.currentTitle) mergedResume.currentTitle = structuredResume.currentTitle;
        if (structuredResume.currentCompany) mergedResume.currentCompany = structuredResume.currentCompany;
        if (structuredResume.jobStatus) mergedResume.jobStatus = structuredResume.jobStatus;
        if (structuredResume.expectInfo) mergedResume.expectInfo = structuredResume.expectInfo;
        if (structuredResume.workExperiences) mergedResume.workExperiences = structuredResume.workExperiences;
        if (structuredResume.educationInfo) mergedResume.educationInfo = structuredResume.educationInfo;
        if (structuredResume.selfDescription) mergedResume.selfDescription = structuredResume.selfDescription;

        // 调用评估接口
        const evalResult = await callOfficialResumeEvalService(mergedResume, settings, apiKey, baseUrl);

        if (evalResult && evalResult.evaluation) {
          // 接口返回的score已经是计算好的总分（baseScore + additions）
          // 直接使用接口返回的score，无需再次累加
          const score = evalResult.evaluation.score;
          // 注意：baseScore可能在 evaluation.baseScore 或 evaluation.details.baseScore
          const baseScore = evalResult.evaluation.baseScore ?? evalResult.evaluation.details?.baseScore;
          const additions = evalResult.evaluation.details?.additions || [];

          console.log('[EVAL] 评分详情:', {
            baseScore,
            additionsScores: additions.map(item => item.score),
            totalScore: score
          });

          // 更新 evaluation 中的分数（保持score不变，因为接口已经计算好了）
          if (evalResult.evaluation.details) {
            evalResult.evaluation.details.baseScore = baseScore;
            evalResult.evaluation.details.totalScore = score;
          }

          console.log('[EVAL] 评估成功，分数:', score);

          // 构造最终结果
          const evaluation = evalResult.evaluation;

          // 将结果添加到分析结果数组
          window.resumeManager.analysisResults.push({
            ...mergedResume,
            evaluation,
            shareLink: evalResult.shareLink || null, shareCardImage: evalResult.shareCardImage || null,
            timestamp: new Date().toISOString(),
            position: { resumeId: resumeContent.resumeId },
            prompt_name: prompt_template.name || 'AI识别+评估',
          });

          await saveAnalysisResults();
          if (typeof updateResultsDisplay === 'function') updateResultsDisplay();

          return score;
        }
      }
    } catch (e) {
      console.warn('[AI识别+评估] 流程失败，回退到传统文本模式:', e);
    }

    // 如果上面成功了，直接返回
    // --- 以下是原有的文本/AI识别 回退逻辑 (作为 Fallback) ---

    // 官方模式同样优先开启视觉识别
    if (!resumeContent.fullText || resumeContent.fullText.length < 500 || resumeContent.extractionMethod === 'fallback-innertext') {

      console.log('[Vision] 官方模式自动触发视觉识别补全...');
      try {
        const visionText = await performVisionExtraction(doc, resumeContent.resumeId, 'official');
        if (visionText) {
          resumeContent.fullText = visionText;
          resumeContent.extractionMethod = 'vision-fallback';

          // 尝试补齐基本信息
          if (visionText.trim().startsWith('{')) {
            try {
              const parsedOcr = JSON.parse(visionText);
              if (parsedOcr.name && (!resumeContent.name || resumeContent.name === '未知')) resumeContent.name = parsedOcr.name;
              if (parsedOcr.age && (!resumeContent.age || resumeContent.age === '未知')) resumeContent.age = parsedOcr.age;
            } catch (e) { }
          }
        }
      } catch (e) {
        console.error('官方模式视觉识别失败:', e);
      }
    }
    // --- 使用之前获取的配置继续执行文本/AI识别 回退逻辑 ---

    const prompt_name = prompt_template.name;

    console.log('Fallback to Text Mode:', { model, prompt_name });
    console.log('prompt content:', prompt);

    if (!apiKey) {
      throw new Error('API密钥未配置');
    }

    // 获取useCustomEndpoint设置 (保持原样，虽然可以在顶部获取，但为了最小化改动范围，暂且留在这里或顶部)
    // 实际上可以在顶部统一获取，这里复用即可


    // 获取useCustomEndpoint设置
    const useCustomEndpoint = await new Promise((resolve) => {
      chrome.storage.sync.get(['useCustomEndpoint'], (result) => {
        resolve(result.useCustomEndpoint || false);
      });
    });

    // 构建settings对象
    const settings = {
      prompt,
      model,
      useCustomEndpoint
    };



    // 根据模型类型决定是否使用流式API
    if (model === 'qwq-plus') {
      // 创建分析状态元素
      // const analysisStatus = createAnalysisStatusElement();

      // 重置思考内容和当前简历ID（改为不完全重置）
      resetThinkingContent();
      currentResumeId = resumeContent.resumeId;

      // 添加开始分析的提示
      // const resumeName = resumeContent.name || '未知姓名';
      // updateAnalysisStatus(analysisStatus, resumeName, false, false, true);

      // 使用流式API处理
      const response = await fetch(`${baseUrl}/api/evaluate-resume-common`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          resume: resumeContent,
          settings: settings
        })
      });

      if (!response.ok) {
        const error = await response.text();
        // updateAnalysisStatus(analysisStatus, `API请求失败: ${error}`, true, true);
        throw new Error(`API请求失败: ${error}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finalResult = null;

      // 读取流
      async function readStream() {
        const { done, value } = await reader.read();
        if (done) {
          // 流结束，处理buffer中可能剩余的数据
          if (buffer.trim()) {
            try {
              // 尝试解析最后的buffer内容
              const jsonResult = JSON.parse(buffer);
              if (jsonResult.type === 'result') {
                finalResult = jsonResult.content;
                // updateAnalysisStatus(analysisStatus, `分析完成，评分: ${finalResult.score}`, true);
              } else if (jsonResult.type === 'error') {
                // updateAnalysisStatus(analysisStatus, `错误: ${jsonResult.content}`, true, true);
                throw new Error(jsonResult.content);
              }
            } catch (e) {
              console.error('解析最后的JSON失败:', e, buffer);
              // 如果最后的buffer不是有效的JSON，但finalResult已经存在，继续处理
              if (!finalResult) {
                // updateAnalysisStatus(analysisStatus, '解析结果失败', true, true);
                throw new Error('解析结果失败');
              }
            }
          }

          if (!finalResult) {
            // updateAnalysisStatus(analysisStatus, '未收到有效结果', true, true);
            throw new Error('未收到有效结果');
          }

          const shouldAutoShare = await window.resumeManager.getAutoShareSetting();
          const scoreThreshold = await window.resumeManager.getUserScoreThreshold();

          let shareLink = null, shareCardImage = null;
          try {
            const captureUnqualified2 = await getCaptureUnqualifiedCardSetting();
            if (finalResult.score >= scoreThreshold || captureUnqualified2) {
              shareCardImage = (await window.resumeManager.captureCardOnly())?.shareCardImage || null;
            }
            if (shouldAutoShare && finalResult.score >= scoreThreshold) shareLink = (await window.resumeManager.generateShareLink(document))?.shareLink || null;
          } catch(e) {}
          // 接口返回的score已经是计算好的总分（baseScore + additions）
          // 直接使用接口返回的score，无需再次累加
          const score = finalResult.score;
          // 注意：baseScore可能在 finalResult.baseScore 或 finalResult.details.baseScore
          const baseScore = finalResult.baseScore ?? finalResult.details?.baseScore;
          const additions = finalResult.details?.additions || [];

          console.log('评分详情:', {
            baseScore,
            additionsScores: additions.map(item => item.score),
            totalScore: score
          });

          // 构建评估结果并保存 - 添加思考过程
          const evaluation = {
            score: score,
            details: {
              baseScore,
              additions,
              totalScore: score
            },
            comments: finalResult.comments || '',
            suggestion: finalResult.suggestion || '',
            thinkingProcess: thinkingContent || '' // 保存思考过程
          };

          // 合并API返回的candidateMeta数据，更新基本信息
          if (finalResult.candidateMeta) {
            if (finalResult.candidateMeta.name) resumeContent.name = finalResult.candidateMeta.name;
            if (finalResult.candidateMeta.age) resumeContent.age = finalResult.candidateMeta.age;
            if (finalResult.candidateMeta.gender) resumeContent.gender = finalResult.candidateMeta.gender;
            if (finalResult.candidateMeta.education) resumeContent.education = finalResult.candidateMeta.education;
            if (finalResult.candidateMeta.experience) resumeContent.experience = finalResult.candidateMeta.experience;
            if (finalResult.candidateMeta.currentTitle) resumeContent.currentTitle = finalResult.candidateMeta.currentTitle;
            if (finalResult.candidateMeta.currentCompany) resumeContent.currentCompany = finalResult.candidateMeta.currentCompany;
          }


          // 将结果添加到分析结果数组
          window.resumeManager.analysisResults.push({
            ...resumeContent,
            evaluation,
            shareLink,
            shareCardImage,
            timestamp: new Date().toISOString(),
            position: {
              resumeId: resumeContent.resumeId
            },
            prompt_name: prompt_name
          });

          console.log('新增分析结果:', {
            name: resumeContent.name,
            score: totalScore,
            timestamp: new Date().toISOString()
          });

          // 保存结果并更新显示
          await saveAnalysisResults();
          updateResultsDisplay();

          return score;
        }

        // 处理接收到的数据块
        const chunk = decoder.decode(value, { stream: true });
        buffer += chunk;

        // 按行分割并处理每一行
        const lines = buffer.split('\n');
        // 保留最后一行（可能不完整）
        buffer = lines.pop() || '';

        // 处理完整的行
        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            // 需要移除这个检查，因为服务器可能没有以 data: 前缀发送数据
            // if (!line.startsWith('data:')) continue;

            let content = line;
            // 如果有 data: 前缀，则去掉
            if (line.startsWith('data:')) {
              content = line.substring(5).trim();
            }

            // 尝试解析JSON
            try {
              const jsonData = JSON.parse(content);

              if (jsonData.type === 'thinking') {
                // 处理思考过程
                // updateAnalysisStatus(analysisStatus, jsonData.content);
              }
              else if (jsonData.type === 'result') {
                // 保存最终结果
                finalResult = jsonData.content;
                // updateAnalysisStatus(analysisStatus, `分析完成，评分: ${finalResult.score}`);
              }
              else if (jsonData.type === 'error') {
                // 处理错误
                // updateAnalysisStatus(analysisStatus, `错误: ${jsonResult.content}`, false, true);
              }
              else {
                // 处理未知类型的消息
                console.log('收到未知类型的消息:', jsonData);
                // updateAnalysisStatus(analysisStatus, `消息: ${JSON.stringify(jsonData)}`);
              }
            } catch (e) {
              // 如果不是有效的JSON，当作普通文本处理
              console.log('非JSON格式的数据:', content);
              // updateAnalysisStatus(analysisStatus, content);
            }
          } catch (e) {
            console.warn('处理流数据行时出错:', e);
          }
        }

        // 继续读取
        return readStream();
      }

      return await readStream();
    } else {
      // 原有的非流式API处理逻辑

      // 创建一个超时Promise，使用90秒作为最大超时时间
      const timeout = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('API请求超时')), 90000);
      });

      console.log('no qwq prompt', prompt); // 使用 prompt 变量

      // 创建API请求Promise
      const fetchPromise = fetch(`${baseUrl}/api/evaluate-resume-common`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          resume: resumeContent,
          settings: settings
        })
      });

      // 使用Promise.race来处理超时
      let response;
      try {
        response = await Promise.race([fetchPromise, timeout]);
      } catch (error) {
        // 如果是超时或其他错误，等待随机时间后抛出
        await new Promise(resolve => setTimeout(resolve, getRandomDelay()));

        const errorMessage = error.message === 'API请求超时'
          ? '评估请求超时，请稍后重试'
          : '网络连接错误，请检查网络设置';

        showError(errorMessage);
        throw new Error(errorMessage);
      }

      if (!response.ok) {
        // API调用失败，等待随机时间后抛出
        await new Promise(resolve => setTimeout(resolve, getRandomDelay()));

        if (response.status === 403) {
          console.error('API密钥验证失败：403错误');
          showError('API调用次数已用完，请充值后继续使用');
          stopAnalysis();
          throw new Error('API_QUOTA_EXCEEDED');
        }

        let errorMessage = '';
        try {
          const errorData = await response.json();
          errorMessage = errorData.message || `API请求失败: ${response.status}`;
        } catch (e) {
          errorMessage = '解析错误响应失败';
        }

        showError(errorMessage);
        throw new Error(errorMessage);
      }

      const result = await response.json();

      // 接口返回的score已经是计算好的总分（baseScore + additions）
      // 直接使用接口返回的score，无需再次累加
      const score = result.score;

      let shareLink = null, shareCardImage = null;
      try {
        const scoreThreshold = await window.resumeManager.getUserScoreThreshold();
        const captureUnqualified3 = await getCaptureUnqualifiedCardSetting();
        if (score >= scoreThreshold || captureUnqualified3) {
          shareCardImage = (await window.resumeManager.captureCardOnly())?.shareCardImage || null;
        }
        const shouldAutoShare = await window.resumeManager.getAutoShareSetting();
        if (shouldAutoShare && score >= scoreThreshold) shareLink = (await window.resumeManager.generateShareLink(document))?.shareLink || null;
      } catch(e) {}

      console.log('评分详情:', {
        baseScore: result.details?.baseScore,
        additionsScores: result.details?.additions?.map(item => item.score),
        totalScore: score
      });

      // 构建评估结果
      const evaluation = {
        score: score, // 使用接口返回的分数
        details: {
          ...result.details,
          totalScore: score
        },
        comments: result.details.additions.map(item => `${item.rule}: ${item.reason}`).join('\n'),
        suggestion: result.suggestion

      };

      console.log('评分详情:', {
        baseScore: result.details.baseScore,
        additionsScores: result.details.additions.map(item => item.score),
        totalScore
      });

      // 合并API返回的candidateMeta数据，更新基本信息
      if (result.candidateMeta) {
        if (result.candidateMeta.name) resumeContent.name = result.candidateMeta.name;
        if (result.candidateMeta.age) resumeContent.age = result.candidateMeta.age;
        if (result.candidateMeta.gender) resumeContent.gender = result.candidateMeta.gender;
        if (result.candidateMeta.education) resumeContent.education = result.candidateMeta.education;
        if (result.candidateMeta.experience) resumeContent.experience = result.candidateMeta.experience;
        if (result.candidateMeta.currentTitle) resumeContent.currentTitle = result.candidateMeta.currentTitle;
        if (result.candidateMeta.currentCompany) resumeContent.currentCompany = result.candidateMeta.currentCompany;
      }

      // 将结果添加到分析结果数组
      window.resumeManager.analysisResults.push({
        ...resumeContent,
        evaluation,
        shareLink,
        shareCardImage,
        timestamp: new Date().toISOString(),
        position: {
          resumeId: resumeContent.resumeId
        },
        prompt_name: prompt_name
      });

      console.log('新增分析结果:', {
        name: resumeContent.name,
        score: score,
        timestamp: new Date().toISOString()
      });

      // 保存结果并更新显示
      await saveAnalysisResults();
      updateResultsDisplay();

      return score;
    }
  } catch (error) {
    console.error('评估简历时发生错误:', error);
    throw error;
  }
}

// 添加getRandomDelay函数，用于生成随机延迟时间
function getRandomDelay(min = 1000, max = 3000) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// 创建分析状态显示元素
function createAnalysisStatusElement() {
  // 检查是否已存在
  let statusElement = document.getElementById('ai-analysis-status');
  if (statusElement) {
    // 不清空内容，保留现有内容
    return statusElement;
  }

  // 创建新的状态元素
  statusElement = document.createElement('div');
  statusElement.id = 'ai-analysis-status';
  statusElement.className = 'ai-analysis-status';

  // 设置样式 - 增强可见度
  statusElement.style.position = 'fixed';
  statusElement.style.bottom = '20px';
  statusElement.style.left = '20px'; // 从right改为left
  statusElement.style.maxWidth = '400px';
  statusElement.style.minWidth = '300px';
  statusElement.style.padding = '15px';
  statusElement.style.backgroundColor = 'rgba(0, 0, 0, 0.85)';
  statusElement.style.color = '#fff';
  statusElement.style.borderRadius = '8px';
  statusElement.style.boxShadow = '0 4px 20px rgba(0, 0, 0, 0.3)';
  statusElement.style.zIndex = '10000';
  statusElement.style.fontSize = '13px';
  statusElement.style.lineHeight = '1.5';
  statusElement.style.maxHeight = '300px';
  statusElement.style.overflowY = 'auto';
  statusElement.style.transition = 'all 0.3s ease';
  statusElement.style.backdropFilter = 'blur(5px)';
  statusElement.style.border = '1px solid rgba(255, 255, 255, 0.1)';

  // 添加标题栏，包含标题和关闭按钮
  const header = document.createElement('div');
  header.style.display = 'flex';
  header.style.justifyContent = 'space-between';
  header.style.alignItems = 'center';
  header.style.borderBottom = '1px solid rgba(255, 255, 255, 0.2)';
  header.style.marginBottom = '10px';
  header.style.paddingBottom = '5px';

  // 添加标题
  const title = document.createElement('span');
  title.style.fontWeight = 'bold';
  title.textContent = 'AI 分析思考过程';
  header.appendChild(title);

  // 添加清空按钮
  const clearButton = document.createElement('button');
  clearButton.innerHTML = '清空';
  clearButton.style.background = 'none';
  clearButton.style.border = 'none';
  clearButton.style.color = '#fff';
  clearButton.style.fontSize = '12px';
  clearButton.style.cursor = 'pointer';
  clearButton.style.padding = '0 5px';
  clearButton.style.marginRight = '5px';
  clearButton.title = '清空所有思考记录';

  // 添加清空按钮的事件处理
  clearButton.addEventListener('click', function () {
    thinkingContent = '';
    const thinkingContainer = statusElement.querySelector('#thinking-container');
    if (thinkingContainer) {
      thinkingContainer.innerHTML = '';
    }
  });

  header.appendChild(clearButton);

  // 添加关闭按钮
  const closeButton = document.createElement('button');
  closeButton.innerHTML = '×';
  closeButton.style.background = 'none';
  closeButton.style.border = 'none';
  closeButton.style.color = '#fff';
  closeButton.style.fontSize = '18px';
  closeButton.style.cursor = 'pointer';
  closeButton.style.padding = '0 5px';
  closeButton.style.lineHeight = '1';
  closeButton.title = '关闭思考过程窗口';

  // 添加关闭按钮的事件处理
  closeButton.addEventListener('click', function () {
    if (statusElement.parentNode) {
      statusElement.parentNode.removeChild(statusElement);
    }
  });

  header.appendChild(closeButton);
  statusElement.appendChild(header);

  // 添加思考过程的容器
  const thinkingContainer = document.createElement('div');
  thinkingContainer.id = 'thinking-container';
  thinkingContainer.className = 'thinking-container';
  thinkingContainer.style.marginBottom = '10px';
  statusElement.appendChild(thinkingContainer);

  // 添加结果容器
  const resultContainer = document.createElement('div');
  resultContainer.id = 'result-container';
  resultContainer.className = 'result-container';
  statusElement.appendChild(resultContainer);

  document.body.appendChild(statusElement);

  // 添加拖动和最小化功能
  enhanceAnalysisStatusElement(statusElement);

  return statusElement;
}

// 添加拖动和最小化功能的初始设置
function enhanceAnalysisStatusElement(statusElement) {
  if (!statusElement) return;

  // 添加可拖动功能
  let isDragging = false;
  let dragOffsetX, dragOffsetY;

  // 获取标题栏作为拖动区域
  const header = statusElement.querySelector('div:first-child');
  if (!header) return;

  // 添加拖动提示
  header.style.cursor = 'move';
  header.title = '按住拖动';

  // 添加最小化/最大化按钮
  const toggleButton = document.createElement('button');
  toggleButton.innerHTML = '−';
  toggleButton.style.background = 'none';
  toggleButton.style.border = 'none';
  toggleButton.style.color = '#fff';
  toggleButton.style.fontSize = '18px';
  toggleButton.style.cursor = 'pointer';
  toggleButton.style.padding = '0 5px';
  toggleButton.style.marginRight = '5px';
  toggleButton.style.lineHeight = '1';
  toggleButton.title = '最小化';

  // 插入到标题栏，在标题和关闭按钮之间
  const closeButton = header.querySelector('button');
  if (closeButton) {
    header.insertBefore(toggleButton, closeButton);
  } else {
    header.appendChild(toggleButton);
  }

  // 最小化/最大化切换功能
  let isMinimized = false;
  const thinkingContainer = statusElement.querySelector('#thinking-container');
  const resultContainer = statusElement.querySelector('#result-container');

  toggleButton.addEventListener('click', function () {
    if (isMinimized) {
      // 最大化
      if (thinkingContainer) thinkingContainer.style.display = 'block';
      if (resultContainer) resultContainer.style.display = 'block';
      statusElement.style.maxHeight = '300px';
      toggleButton.innerHTML = '−';
      toggleButton.title = '最小化';
      isMinimized = false;
    } else {
      // 最小化
      if (thinkingContainer) thinkingContainer.style.display = 'none';
      if (resultContainer) resultContainer.style.display = 'none';
      statusElement.style.maxHeight = 'auto';
      statusElement.style.height = 'auto';
      toggleButton.innerHTML = '+';
      toggleButton.title = '最大化';
      isMinimized = true;
    }
  });

  // 拖动开始
  header.addEventListener('mousedown', function (e) {
    isDragging = true;
    dragOffsetX = e.clientX - statusElement.offsetLeft;
    dragOffsetY = e.clientY - statusElement.offsetTop;
    e.preventDefault();
  });

  // 拖动过程
  document.addEventListener('mousemove', function (e) {
    if (!isDragging) return;

    // 计算新位置
    const newLeft = e.clientX - dragOffsetX;
    const newTop = e.clientY - dragOffsetY;

    // 确保不超出屏幕
    const maxLeft = window.innerWidth - statusElement.offsetWidth;
    const maxTop = window.innerHeight - statusElement.offsetHeight;

    statusElement.style.left = Math.max(0, Math.min(newLeft, maxLeft)) + 'px';
    statusElement.style.top = Math.max(0, Math.min(newTop, maxTop)) + 'px';
    statusElement.style.bottom = 'auto'; // 取消底部定位
  });

  // 拖动结束
  document.addEventListener('mouseup', function () {
    isDragging = false;
  });

  return statusElement;
}

// 更新分析状态函数，不再完全重置内容
function updateAnalysisStatus(element, message, isComplete = false, isError = false, isNewResume = false) {
  if (!element) return;

  const thinkingContainer = element.querySelector('#thinking-container');
  if (thinkingContainer) {
    // 使用 DocumentFragment 减少 DOM 操作
    const fragment = document.createDocumentFragment();
    const thinkingElement = document.createElement('pre');
    thinkingElement.className = 'status-thinking typing-content';
    thinkingElement.style.whiteSpace = 'pre-wrap';
    thinkingElement.textContent = message;
    fragment.appendChild(thinkingElement);

    // 一次性更新 DOM
    thinkingContainer.appendChild(fragment);

    // 限制容器中的子元素数量
    while (thinkingContainer.children.length > 100) {
      thinkingContainer.removeChild(thinkingContainer.firstChild);
    }
  }
}

// 显示错误提示
function showError(message) {
  const errorContainer = document.getElementById('errorContainer');
  const errorMessage = document.getElementById('errorMessage');

  if (errorContainer && errorMessage) {
    errorMessage.textContent = message;
    errorContainer.classList.add('show');

    // 5秒后自动隐藏
    setTimeout(() => {
      errorContainer.classList.remove('show');
    }, 5000);
  } else {
    console.error('错误提示容器未找到，错误信息：', message);
  }
}

// 简历操作相关函数
async function closeResume(doc = document) {
  console.log('关闭简历对话框');
  // ★ 收集所有可搜的文档（主文档 + 传入doc + 所有子iframe），
  //    确保推荐页弹窗在深层 iframe 里也能被关掉
  var allDocs = [document];
  if (doc && doc !== document) allDocs.push(doc);
  // 递归收集所有子 iframe 文档
  function collectDocs(root, depth) {
    if (!root || !root.querySelectorAll || depth > 4) return;
    try {
      var ifs = root.querySelectorAll('iframe');
      for (var i = 0; i < ifs.length; i++) {
        try {
          var fd = ifs[i].contentDocument;
          if (fd && allDocs.indexOf(fd) === -1) { allDocs.push(fd); collectDocs(fd, depth + 1); }
        } catch(e) {}
      }
    } catch(e) {}
  }
  collectDocs(document, 0);
  collectDocs(doc !== document ? doc : null, 0);

  for (var d = 0; d < allDocs.length; d++) {
    var dd = allDocs[d];
    if (!dd || !dd.querySelector) continue;
    var btn = dd.querySelector('.boss-popup__wrapper .close') ||
      dd.querySelector('.boss-popup__wrapper .icon-close') ||
      dd.querySelector('.boss-popup__wrapper .iboss-close') ||
      dd.querySelector('.boss-popup__close') ||
      dd.querySelector('.dialog-close') ||
      dd.querySelector('.new-resume-online-main-ui .close-btn') ||
      dd.querySelector('.resume-common-wrap .close');
    if (btn && btn.offsetParent) { btn.click(); await new Promise(r => setTimeout(r, 500)); console.log('已关闭简历弹窗'); return; }
  }
  console.log('未找到可关闭的弹窗');
}

async function favoriteResume(doc = document) {
  try {
    console.log('尝试收藏简历');

    // 首先检查是否已收藏
    const isFavorited = await isResumeFavorited(doc);
    if (isFavorited) {
      console.log('简历已收藏，跳过收藏');
      return true;
    }

    // 查找收藏按钮（class + 文字兜底）
    let favoriteButton = doc.querySelector('.boss-dialog__wrapper.dialog-lib-resume .favorite-btn') ||
      doc.querySelector(".boss-dialog__wrapper .favorite-btn") ||
      doc.querySelector("div.attachment-resume-top-ui > div.attachment-resume-top-content > div:nth-child(2) > span") ||
      doc.querySelector("div.pull-left > div.like-icon-and-text > div.icon-like > div") ||
      doc.querySelector("div.pull-left > div > div.like-icon");
    // 按文字"收藏"查找（新版 UI）
    if (!favoriteButton) {
      favoriteButton = Array.from(doc.querySelectorAll('span, i, div, button')).find(el => {
        const t = (el.textContent || '').trim();
        return t === '收藏' && el.offsetParent && !el.querySelector('*');
      });
    }

    // 如果找到按钮且未被激活，点击它
    if (favoriteButton && !favoriteButton.classList.contains('active')) {
      favoriteButton.click();
      console.log('已点击收藏按钮');
      await new Promise(resolve => setTimeout(resolve, 500));
      return true;
    } else if (!favoriteButton) {
      // DOM按钮未找到，尝试Canvas模拟点击方案
      console.log('未找到收藏按钮，尝试Canvas模拟点击...');

      // 查找简历Canvas
      const resumeIframe = doc.querySelector('iframe[src*="/c-resume/"]');
      if (resumeIframe) {
        try {
          const iframeDoc = resumeIframe.contentDocument || resumeIframe.contentWindow.document;
          const canvas = iframeDoc.querySelector('canvas');

          if (canvas) {
            // 收藏按钮在浏览器视口中的固定坐标（经过多次测试验证）
            // 按钮在视口中的位置是固定的，不随窗口大小变化
            const clientX = 757;
            const clientY = 65;

            console.log(`[收藏] 固定视口坐标: (${clientX}, ${clientY})`);

            // 关键：需要在 body 和 canvas 上同时触发点击事件
            // 先在 document.body 上触发
            const bodyEvent = new MouseEvent('click', {
              clientX: clientX,
              clientY: clientY,
              bubbles: true,
              cancelable: true,
              view: window,
              which: 1,
              button: 0
            });
            document.body.dispatchEvent(bodyEvent);

            // 等待一小后，在 canvas 上也触发
            await new Promise(resolve => setTimeout(resolve, 100));

            const canvasEvent = new MouseEvent('click', {
              clientX: clientX,
              clientY: clientY,
              bubbles: true,
              cancelable: true,
              view: iframeDoc.defaultView,
              which: 1,
              button: 0
            });
            canvas.dispatchEvent(canvasEvent);
            console.log('[收藏] 已在body和canvas上触发点击');

            await new Promise(resolve => setTimeout(resolve, 500));

            // 检查是否收藏成功
            const afterFavorited = await isResumeFavorited(doc);
            if (afterFavorited) {
              console.log('Canvas模拟点击收藏成功');
              return true;
            } else {
              console.log('Canvas模拟点击可能未成功');
              return false;
            }
          }
        } catch (e) {
          console.error('Canvas操作失败:', e);
        }
      }

      console.log('收藏失败');
      return false;
    } else {
      console.log('收藏按钮已激活，无需再次点击');
      return true;
    }
  } catch (error) {
    console.error('收藏简历时发生错误:', error);
    // 返回false但不抛出异常，这样不会中断整个分析流程
    return false;
  }
}

async function sendGreeting(doc = document, resumeId = '') {
  console.log('尝试发送联系Ta消息');
  try {
    const candidateDocs = [];
    // 传入的 doc 可能是 iframe 文档、顶层 document 或 element
    if (doc) {
      if (doc.nodeType === 1 && doc.ownerDocument) {
        candidateDocs.push(doc.ownerDocument);
      } else if (doc.querySelector) {
        candidateDocs.push(doc);
      }
    }

    // 额外尝试简历详情 iframe 的 document（/web/frame/c-resume/）
    try {
      const topDoc = window.document;
      const resumeFrame = topDoc.querySelector('iframe[src*="/web/frame/c-resume/"]');
      const resumeDoc = resumeFrame?.contentDocument;
      if (resumeDoc) candidateDocs.push(resumeDoc);

      // 额外尝试 recommendFrame 的 document（推荐牛人页面详情弹窗/列表）
      const recommendFrame = topDoc.querySelector('iframe[name="recommendFrame"]');
      const recommendDoc = recommendFrame?.contentDocument;
      if (recommendDoc) candidateDocs.push(recommendDoc);
    } catch (e) {
      console.warn('获取 recommendFrame 文档失败:', e);
    }

    // 去重
    const uniqueDocs = Array.from(new Set(candidateDocs));

    const pickVisible = (nodes) => {
      let first = null;
      for (const el of nodes) {
        if (!el || el.nodeType !== 1) continue;
        if (!first) first = el;
        const view = el.ownerDocument?.defaultView || window;
        const styles = view.getComputedStyle(el);
        const visible = styles.display !== 'none' &&
          styles.visibility !== 'hidden' &&
          parseFloat(styles.opacity) > 0 &&
          el.offsetWidth > 0 &&
          el.offsetHeight > 0;
        if (visible) return el;
      }
      // 如果都不可见，退回第一个（有些场景下按钮在弹窗打开时仍可点击）
      return first || null;
    };

    const findGreetButtonInDoc = (d) => {
      // 最高优先级：畅聊卡按钮（有唯一 ka 属性 “resume_anonymous_usePropCardChat”）
      const cardBtn = pickVisible(d.querySelectorAll('[ka*=”usePropCardChat”], .prop-card-chat, button.btn-greet.prop-card-chat'));
      if (cardBtn) return cardBtn;

      // 优先：简历 iframe 外层容器中的”联系Ta”（详情弹窗按钮常在 iframe 外）
      const resumeFrame = d.querySelector('iframe[src*=”/web/frame/c-resume/”]');
      if (resumeFrame) {
        const containerSelectors = [
          '.boss-dialog__wrapper',
          '.boss-popup__wrapper',
          '.boss-popup__content',
          '.resume-detail-wrap',
          '.resume-middle-wrap',
          '.resume-layout-wrap',
          '.dialog-container'
        ].join(', ');
        let container = resumeFrame.closest?.(containerSelectors) || resumeFrame.parentElement;
        let current = container;
        for (let i = 0; current && i < 6; i += 1) {
          const frameButtons = Array.from(current.querySelectorAll('button, a, [role=”button”], span, div, [ka*=”usePropCardChat”]')).filter(b => {
            const t = (b.innerText || '').trim();
            return t.length > 0 && t.length < 24 && /联系\s*Ta|搜索畅聊卡|畅聊卡/.test(t);
          });
          const picked = pickVisible(frameButtons);
          if (picked) return picked;
          current = current.parentElement;
        }
      }

      // 优先：简历详情 iframe 内的”联系Ta”/”搜索畅聊卡”
      const detailButtons = Array.from(d.querySelectorAll('button, a, [role=”button”], span, div, [ka*=”usePropCardChat”]')).filter(b => {
        const t = (b.innerText || '').trim();
        return t.length > 0 && t.length < 24 && /联系\s*Ta|搜索畅聊卡|畅聊卡/.test(t);
      });
      const detailPicked = pickVisible(detailButtons);
      if (detailPicked) return detailPicked;

      // 优先：详情弹窗内的联系Ta按钮
      const dialogRoot = d.querySelector('.boss-dialog__wrapper, .boss-popup__wrapper.boss-dialog, .boss-dialog__wrapper.dialog-lib-resume');
      if (dialogRoot) {
        const dialogButtons = dialogRoot.querySelectorAll('.btn-greet, .greet-btn, .btn-sure-v2.btn-greet, button.btn-greet, [ka*=”usePropCardChat”], .prop-card-chat');
        const picked = pickVisible(dialogButtons);
        if (picked) return picked;
      }

      // 其次：列表卡片上的联系Ta按钮
      const listButtons = d.querySelectorAll(
        '.button-chat-wrap .btn-greet, .button-list-wrap .btn-greet, .btn-greet, div.button-list-wrap > div > span > div > button, div.resume-footer-wrap > div > div.btns > div > button'
      );
      return pickVisible(listButtons);
    };

    let greetButton = null;
    let greetDoc = null;
    for (const d of uniqueDocs) {
      const btn = findGreetButtonInDoc(d);
      if (btn) {
        greetButton = btn;
        greetDoc = d;
        break;
      }
    }

    if (greetButton) {
      // 确保按钮可见且可点击
      if (!greetButton || greetButton.nodeType !== 1) {
        console.log('联系Ta按钮不是一个有效的HTML元素，跳过处理');
        return false;
      }

      greetButton.click();
      console.log('已点击联系Ta按钮，类名:', greetButton.className);
      await new Promise(resolve => setTimeout(resolve, 1200)); // 等待弹窗出现

      // 畅聊卡场景：点击后可能直接弹"使用成功/已为您发起沟通"，点"关闭"（不点"查看对话"避免跳转）
      const successDocs = [greetDoc, document];
      try {
        const rf = document.querySelector('iframe[src*="/web/frame/c-resume/"]');
        if (rf?.contentDocument) successDocs.push(rf.contentDocument);
      } catch (e) {}
      for (const dd of successDocs) {
        if (!dd || !dd.querySelectorAll) continue;
        const boxes = Array.from(dd.querySelectorAll('.boss-dialog__wrapper, .boss-popup__wrapper, [class*="dialog"], [class*="popup"]'));
        const box = boxes.find(b => /使用成功|已为您发起沟通|索要简历/.test(b.innerText || ''));
        if (box) {
          const closeBtn = Array.from(box.querySelectorAll('button, .btn, span, i, [class*="close"]'))
            .find(b => /^关闭$/.test((b.innerText || '').trim()) || /close/i.test(b.className || ''));
          if (closeBtn) closeBtn.click();
          console.log('畅聊卡使用成功，已关闭弹窗');
          showPanelMsg('畅聊卡已发起沟通');
          await new Promise(r => setTimeout(r, 400));
          return true;
        }
      }

      // 查找发送按钮 - 兼容多种弹窗结构
      const sendButton =
        // 确认按钮 (推荐牛人页面)
        greetDoc?.querySelector('.confirm-btn') ||
        // 发送按钮
        greetDoc?.querySelector('.dialog-chat-quick-reply .send-btn') ||
        greetDoc?.querySelector('.dialog-chat-quick-reply button[type="submit"]') ||
        greetDoc?.querySelector('.boss-dialog__wrapper .send-btn') ||
        greetDoc?.querySelector('.boss-dialog__wrapper button[type="submit"]') ||
        greetDoc?.querySelector('.greet-dialog-wrap .btn-sure') ||
        greetDoc?.querySelector('.btn-sure-v2');

      if (sendButton) {
        sendButton.click();
        console.log('已发送联系Ta消息，发送按钮类名:', sendButton.className);
        await new Promise(resolve => setTimeout(resolve, 500));
        return true;
      } else {
        console.log('未找到发送按钮，可能已直接发送或不需要二次确认');
        return true;
      }
    } else {
      console.log('未找到联系Ta按钮');
      // 调试：列出所有按钮
      const allButtons = Array.from((doc && doc.querySelectorAll ? doc.querySelectorAll('button') : document.querySelectorAll('button'))).map(b => ({
        text: b.innerText.trim(),
        className: b.className
      }));
      console.log('页面中的按钮:', allButtons);
      return false;
    }
  } catch (error) {
    console.error('发送联系Ta消息时出错:', error);
    return false;
  }
}

// 兜底：在列表页根据简历ID尝试联系Ta
async function sendGreetingFromList(doc = document, resumeId = '') {
  try {
    const rootDoc = (doc && doc.querySelector) ? doc : document;
    let listDoc = rootDoc;

    // 优先尝试推荐列表 iframe
    try {
      const recommendFrame = document.querySelector('iframe[name="recommendFrame"]');
      if (recommendFrame?.contentDocument) {
        listDoc = recommendFrame.contentDocument;
      }
    } catch (e) {
      console.warn('获取 recommendFrame 文档失败:', e);
    }

    const pickVisible = (nodes) => {
      let first = null;
      for (const el of nodes) {
        if (!el || el.nodeType !== 1) continue;
        if (!first) first = el;
        const view = el.ownerDocument?.defaultView || window;
        const styles = view.getComputedStyle(el);
        const visible = styles.display !== 'none' &&
          styles.visibility !== 'hidden' &&
          parseFloat(styles.opacity) > 0 &&
          el.offsetWidth > 0 &&
          el.offsetHeight > 0;
        if (visible) return el;
      }
      return first || null;
    };

    let greetBtn = null;
    if (resumeId) {
      const card = listDoc.querySelector(`[data-geek='${resumeId}'], [data-geekid='${resumeId}'], [data-expect='${resumeId}']`);
      if (card) {
        greetBtn = pickVisible(card.querySelectorAll('.btn-greet, button.btn-greet, .button-chat-wrap .btn-greet'));
      }
    }

    if (!greetBtn) {
      greetBtn = pickVisible(listDoc.querySelectorAll('.btn-greet, button.btn-greet, .button-chat-wrap .btn-greet'));
    }

    if (greetBtn) {
      greetBtn.click();
      console.log('列表页兜底联系Ta已点击:', greetBtn.className);
      await new Promise(resolve => setTimeout(resolve, 500));
      return true;
    }
  } catch (e) {
    console.warn('列表页兜底联系Ta失败:', e);
  }
  return false;
}

// 已分析简历ID管理
async function saveAnalyzedResumeId(resumeId) {
  console.log('保存已分析的简历ID:', resumeId);
  analyzedResumeIds.add(resumeId);

  // 更新 analysisResults 中对应结果的 resumeId（以防万一）
  const latestResult = window.resumeManager.analysisResults[window.resumeManager.analysisResults.length - 1];
  if (latestResult && !latestResult.resumeId) {
    latestResult.resumeId = resumeId;
  }

  await Promise.all([
    // 保存已分析的ID集合
    new Promise(resolve => {
      chrome.storage.local.set({
        'analyzedResumeIds': Array.from(analyzedResumeIds)
      }, resolve);
    }),
    // 保存更新后的分析结果
    saveAnalysisResults()
  ]);
}

async function loadAnalyzedResumeIds() {
  console.log('加载已分析的简历ID');
  return new Promise(resolve => {
    chrome.storage.local.get(['analyzedResumeIds'], (result) => {
      if (result.analyzedResumeIds) {
        analyzedResumeIds = new Set(result.analyzedResumeIds);
      }
      resolve();
    });
  });
}

// 用户设置相关函数
function getUserScoreThreshold() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(['scoreThreshold'], (result) => {
      resolve(result.scoreThreshold || 80);
    });
  });
}

function getAutoFavoriteSetting() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(['autoFavorite'], (result) => {
      // 默认为true，即默认自动收藏
      resolve(result.autoFavorite !== undefined ? result.autoFavorite : true);
    });
  });
}

function getAutoGreetSetting() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(['autoGreet'], (result) => {
      // 默认为false，即默认不自动联系Ta
      resolve(result.autoGreet !== undefined ? result.autoGreet : false);
    });
  });
}

function getAutoShareSetting() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(['autoShare'], (result) => {
      resolve(result.autoShare !== undefined ? result.autoShare : false);
    });
  });
}

function getCaptureUnqualifiedCardSetting() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(['captureUnqualifiedCard'], (result) => {
      // 默认 true（始终截取分享卡片），false=未达标不截取
      resolve(result.captureUnqualifiedCard !== undefined ? result.captureUnqualifiedCard : true);
    });
  });
}

// 获取用户设置的Prompt
function getUserPrompt() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['promptTemplates', 'selectedPromptIndex'], (result) => {
      console.log('获取到的 promptTemplates:', result.promptTemplates);
      console.log('获取到的 selectedPromptIndex:', result.selectedPromptIndex);

      const templates = result.promptTemplates || [{
        name: '默认模板',
        content: `请根据以下标准评估这份简历（默认0分）：

基础分（60分）：
1. 工作经历中有ToB公司经验（+20分）
2. 简历中提到AI相关技能或经验（+10分）
3. 有独立文案、视频剪辑制作能力或相关工具使用经验（+10分）
4. 有线上、线下活动运营经验（+10分）
5. 有大型互联网公司工作经验（+10分）

加分项（最多40分）：
1. 学历为本科及以上（+15分）
2. 最近5年工作稳定性：
   - 3家以内公司（+10分）
   - 3-5家公司（+5分）
   - 5家以上公司（-5分）
3. 有相关行业经验（+15分）：
   - 网络安全/信息安全行业
   - 企业服务行业
   - 人工智能行业

请详细说明每项得分原因，并给出改进建议。`
      }];
      const selectedIndex = result.selectedPromptIndex || 0;

      // 添加日志
      console.log('选择的模板:', templates[selectedIndex]);

      resolve(templates[selectedIndex]);
    });
  });
}

function getApiKey() {
  return Promise.resolve('');
}


// 添加等待元素出现的辅助函数
function waitForElement(selector, timeout = 10000) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(selector)) {
      return resolve(document.querySelector(selector));
    }

    const observer = new MutationObserver((mutations) => {
      if (document.querySelector(selector)) {
        observer.disconnect();
        resolve(document.querySelector(selector));
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    setTimeout(() => {
      observer.disconnect();
      reject(new Error(`等待元素 ${selector} 超时`));
    }, timeout);
  });
}

async function retry(fn, maxAttempts = 3, delay = 1000) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}

async function clickElement(element, view) {
  if (element && typeof element.click === 'function') {
    // 滚动到屏幕中央
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    
    // 添加闪烁效果
    element.style.transition = 'box-shadow 0.3s ease';
    element.style.boxShadow = '0 0 0 4px #3B82F6, 0 0 20px rgba(59, 130, 246, 0.5)';
    element.style.zIndex = '9999';
    element.style.position = 'relative';
    
    setTimeout(() => {
      element.style.boxShadow = 'none';
      element.style.zIndex = '';
      element.style.position = '';
    }, 500);
    
    // 规避 CSP 报错：如果是 javascript: 链接，先移除 href 属性再点击
    const href = element.getAttribute('href');
    if (href && href.startsWith('javascript:')) {
      element.removeAttribute('href');
      element.click();
      element.setAttribute('href', href);
    } else {
      element.click();
    }
    
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

// 添加检查简历是否已收藏的函数
async function isResumeFavorited(doc = document) {
  console.log('检查简历是否已收藏');
  const favoriteButton = doc.querySelector('.boss-dialog__wrapper.dialog-lib-resume .favorite-btn') ||
    doc.querySelector("div.attachment-resume-top-ui > div.attachment-resume-top-content > div:nth-child(2) > span") ||
    doc.querySelector(".boss-dialog__wrapper .favorite-btn") ||
    doc.querySelector("div.communication.icon-coop-forward.shareReport > div > div > div.pull-left > div > div.like-text") || //新牛人
    doc.querySelector("div.communication.icon-coop-forward.shareReport > div > div > div.pull-left > div.like-icon-and-text > div.btn-text") ||// 推荐牛人
    doc.querySelector("div.resume-section.geek-base-info-wrap > div.section-content > div.name-flex > div.operate > div.interested.tooltip.tooltip-dark.tooltip-top.already-interested") // 搜索牛人

  if (!favoriteButton) {
    console.log('未找到收藏按钮');
    return false;
  }

  // 检查是否已收藏（通过按钮的active类或其他标识），添加null检查
  const isFavorited = favoriteButton.classList.contains('active') ||
    favoriteButton.classList.contains('favorite-btn-active') ||
    (favoriteButton.textContent && favoriteButton.textContent.includes('已收藏')) ||
    (favoriteButton.ariaLabel && favoriteButton.ariaLabel.includes('取消收藏'));

  console.log('简历收藏状态:', isFavorited);
  return isFavorited;
}

// 关闭页面所有残留分享弹窗（含子iframe，推荐→搜索切换时防止串卡）
async function closeAllShareBoxes() {
  try {
    var docs = [document];
    (function collect(root, depth) {
      if (!root || !root.querySelectorAll || depth > 4) return;
      try {
        var ifs = root.querySelectorAll('iframe');
        for (var i = 0; i < ifs.length; i++) {
          try { var fd = ifs[i].contentDocument; if (fd && docs.indexOf(fd) === -1) { docs.push(fd); collect(fd, depth + 1); } } catch(e) {}
        }
      } catch(e) {}
    })(document, 0);

    var closed = 0;
    var sel = '.c-share-box .iboss-close, .c-share-box .boss-popup__close, .c-share-box .dialog-close, .c-share-box .close, .c-share-box .icon-close';
    for (var d = 0; d < docs.length; d++) {
      var dd = docs[d];
      if (!dd || !dd.querySelectorAll) continue;
      var btns = dd.querySelectorAll(sel);
      for (var i = 0; i < btns.length; i++) {
        if (btns[i].offsetParent !== null) { btns[i].click(); closed++; }
      }
    }
    if (closed > 0) await new Promise(function(r) { setTimeout(r, 400); });
    // ★ 点关闭后，强制把仍残留在 DOM 的 .c-share-box 整个移除（BOSS复用元素→旧图残留的根因）
    var removed = 0;
    for (var d2 = 0; d2 < docs.length; d2++) {
      var dd2 = docs[d2];
      if (!dd2 || !dd2.querySelectorAll) continue;
      var boxes = dd2.querySelectorAll('.c-share-box');
      for (var j = 0; j < boxes.length; j++) {
        try { boxes[j].parentNode && boxes[j].parentNode.removeChild(boxes[j]); removed++; } catch(e) {}
      }
    }
    if (closed > 0 || removed > 0) console.log('清理旧分享弹窗: 关闭' + closed + ' 移除' + removed);
  } catch(e) {}
}

// 处理搜索页面的简历分析
async function handleSearchPageAnalysis(button) {
  console.log('开始处理搜索页面的简历分析');

  var searchFrame = document.querySelector('iframe[name="searchFrame"]');
  if (!searchFrame) {
    showError('找不到搜索iframe，无法开始分析。');
    throw new Error('找不到搜索 iframe');
  }
  var iframeDoc = searchFrame.contentDocument || searchFrame.contentWindow.document;
  console.log('已获取 iframe 文档');

  await waitForElementInIframe(iframeDoc, '#is-gray-batch-chat .card-list');
  console.log('简历列表已加载');

  // ★ 关闭所有残留弹窗 + 分享弹窗（防止推荐页→搜索页切换时串卡）
  await closeAllShareBoxes();
  await forceCloseResumeDialog([document, iframeDoc], 3);

  // 读取"过滤已读简历"设置，动态构建卡片选择器
  var filterRead = await new Promise(function(r) { chrome.storage.sync.get(['filterRead'], function(res) { r(res.filterRead !== undefined ? res.filterRead : true); }); });
  var cardSelector = '#is-gray-batch-chat .card-list > li.geek-info-card' + (filterRead ? ':not(.has-read)' : '');
  console.log('卡片选择器:', cardSelector, '(过滤已读:', filterRead, ')');

  const processedIds = new Set();
  let previousCardCount = 0;
  let sameCardCountTimes = 0;
  let dialogTimeoutCheck;

  let consecutiveScrollsWithoutNewProcessing = 0; // 新增：连续滚动但未处理新简历的计数器
  const MAX_CONSECUTIVE_SCROLLS_WITHOUT_PROCESSING = 3; // 新增：最大允许的连续空滚动次数

  while (isAnalyzing) {
    // 检测付费墙弹窗
    if (detectPaywallPopup(document) || detectPaywallPopup(iframeDoc)) {
      console.log('检测到付费墙弹窗，停止分析');
      showError('遇到付费墙（权益不足），请检查您的BOSS直聘账号权限');
      isAnalyzing = false;
      break;
    }

    const resumeCards = iframeDoc.querySelectorAll(cardSelector);
    console.log(`当前视口发现 ${resumeCards.length} 个简历卡片。`);

    if (resumeCards.length === 0 && previousCardCount === 0) {
      console.log('未发现任何简历卡片，可能页面结构已更改或加载失败。');
      showError('在搜索页面未找到简历卡片，请检查页面是否正确加载。');
      isAnalyzing = false;
      break;
    }

    // ★ 当过滤已读后卡片数为0时，尝试滚动加载更多（而非直接当作"无变化"计数）
    if (resumeCards.length === 0 && previousCardCount > 0 && filterRead) {
      console.log('当前视口所有卡片均为已读，滚动加载更多...');
      await autoScroll(iframeDoc);
      await new Promise(resolve => setTimeout(resolve, 3000));
      previousCardCount = 0; // 重置以便下轮重新判断
      sameCardCountTimes = 0;
      continue;
    }
    if (resumeCards.length === previousCardCount) {
      sameCardCountTimes++;
      if (sameCardCountTimes >= 3) {
        console.log(`连续 ${sameCardCountTimes} 次获取到相同数量的卡片 (${resumeCards.length}) 且无新简历处理，可能已到达底部或加载异常，终止分析。`);
        isAnalyzing = false; // 确保停止
        break;
      }
    } else {
      previousCardCount = resumeCards.length;
      sameCardCountTimes = 0;
    }

    let newResumeActuallyProcessedInThisPass = false; // 用于判断本轮是否有简历被 *实际处理*
    let allCurrentCardsSkippedOrProcessed = true; // 假设当前所有卡片都会被跳过或已处理

    for (const card of resumeCards) {
      if (!isAnalyzing) {
        console.log('分析过程被中断 (循环内部)。');
        return;
      }

      // 检测付费墙弹窗
      if (detectPaywallPopup(document) || detectPaywallPopup(searchFrame?.contentDocument)) {
        console.log('检测到付费墙弹窗，停止分析');
        showError('遇到付费墙（权益不足），请检查您的BOSS直聘账号权限');
        isAnalyzing = false;
        return;
      }

      // ★ 每日浏览限制：已达上限则停止
      const dc = await getDailyCounts();
      if (dc.browse >= DAILY_BROWSE_LIMIT) {
        showPanelMsg('今日浏览'+DAILY_BROWSE_LIMIT+'份已满，停止');
        isAnalyzing = false;
        return;
      }

      const resumeId = card.getAttribute('data-expect') ||
        card.querySelector('a[ka="search_click_open_resume"]')?.getAttribute('data-expect');

      if (!resumeId) {
        console.warn('无法获取简历ID，跳过此卡片。卡片HTML片段:', card.outerHTML ? card.outerHTML.substring(0, 300) : "N/A");
        continue;
      }

      if (processedIds.has(resumeId)) {
        // console.log(`跳过当前会话已处理的简历 ${resumeId}`); // 此日志级别可能过高，可按需开启
        continue;
      }

      const isAnalyzed = await checkResumeAnalyzed(resumeId);
      if (isAnalyzed) {
        console.log(`跳过历史记录中已分析的简历 ${resumeId} (来自 checkResumeAnalyzed)`);
        processedIds.add(resumeId); // 也添加到当前会话，避免重复检查
        continue;
      }

      // 如果执行到这里，说明这个简历是新的，且之前未被处理过
      allCurrentCardsSkippedOrProcessed = false; // 发现一个需要处理的卡片
      processedIds.add(resumeId); // 先标记为本轮尝试处理，避免因异步导致重复打开

      try {
        console.log(`准备处理新简历 ${resumeId}...`);

        await closeAllResumeDialogs(document);
        await closeInterferingPopups(document);
        await closeInterferingPopups(document);

        const clickableLink = card.querySelector('a[ka="search_click_open_resume"]');
        if (clickableLink) {
          if (!isAnalyzing) return;

          // 检查是否为搜索页面的c-resume iframe（使用Canvas渲染）
          // 如果已经打开了弹窗，检测是否存在
          const existingResumeIframe = document.querySelector('iframe[src*="/c-resume/"]');
          const isCanvasResume = !!existingResumeIframe;

          // 点击简历链接
          await window.resumeManager.clickElement(clickableLink, searchFrame.contentWindow);
          console.log(`已点击简历 ${resumeId} 的链接`);

          // 如果不是Canvas渲染的简历，需要等待弹窗加载
          if (!isCanvasResume) {
            try {
              await waitForResumeDetailReady(document, 12000, resumeId);
              console.log(`简历 ${resumeId} 对话框已加载`);
            } catch (error) {
              if (error.message === '用户中断操作') return;
              console.error(`等待简历 ${resumeId} 对话框加载失败:`, error);
              await window.resumeManager.closeResume(document);
              continue;
            }
          } else {
            console.log('检测到搜索页面简历使用Canvas渲染，跳过等待弹窗');
            // 等待一小段时间让Canvas渲染完成
            await new Promise(resolve => setTimeout(resolve, 2000));
          }

          if (!isAnalyzing) return;

          // 检查是否为搜索页面的c-resume iframe（使用Canvas渲染）
          const resumeIframe = document.querySelector('iframe[src*="/c-resume/"]');
          let resumeContent;

          if (resumeIframe) {
            // 搜索页面的简历使用Canvas渲染，直接使用截图AI识别
            console.log('检测到搜索页面简历，使用截图AI识别提取...');
            // ★ 从卡片 DOM 抓姓名（准确，不受 OCR 影响）
            var _cardName = '';
            var _cnEl = card.querySelector('.card-inner .name-wrap .name, .geek-info-card .name, .card-inner .name');
            if (_cnEl) _cardName = _cnEl.textContent.trim();
            // 创建一个空的简历内容对象，添加error属性以触发AI识别 fallback
            resumeContent = {
              resumeId,
              fullText: '',
              vueData: null,
              extractionMethod: 'search-page-ocr',
              error: 'Search page resume uses Canvas, will use AI识别',
              name: _cardName,
              gender: '',
              age: null,
              experience: '',
              education: '',
              jobStatus: '',
              expectInfo: { location: '', position: '', salary: '' },
              workExperiences: [],
              projectExperiences: [],
              educationInfo: { school: '', major: '', degree: '', period: '' },
              selfDescription: '',
              timestamp: new Date().toISOString()
            };
          } else {
            // 非Canvas渲染，使用普通提取方法
            resumeContent = await window.resumeManager.extractFullResumeContent(document, resumeId);
          }

          console.log(`已提取简历 ${resumeId} 的内容, 方法: ${resumeContent.extractionMethod}`);
          if (!isAnalyzing) return;

          try {
            // ★ 评估前检查试用次数，用完立即停止
            var trialRem2 = await checkTrialRemaining();
            if (trialRem2 <= 0) { showPanelMsg('次数已用完'); isAnalyzing = false; return; }
            console.log(`开始AI评估简历 ${resumeId}`);
            const score = await window.resumeManager.evaluateResume(resumeContent, document);
            console.log(`简历 ${resumeId} 评估完成，分数:`, score);
            incDailyBrowse(); window.consumeTrial && window.consumeTrial();
            newResumeActuallyProcessedInThisPass = true; // 标记有简历被成功评估
            consecutiveScrollsWithoutNewProcessing = 0; // 重置连续空滚动计数器

            if (!isAnalyzing) return;

            const threshold = await window.resumeManager.getUserScoreThreshold();
            if (score >= threshold) {
              console.log(`简历 ${resumeId} 分数 (${score}) 达标 (阈值 ${threshold})`);
              if (!isAnalyzing) return;

              const shouldAutoFavorite = await window.resumeManager.getAutoFavoriteSetting();
              if (shouldAutoFavorite) {
                console.log(`执行自动收藏简历 ${resumeId}`);
                await window.resumeManager.favoriteResume(document);
              }

              const shouldAutoGreet = await window.resumeManager.getAutoGreetSetting();
              if (shouldAutoGreet) {
                console.log(`执行自动联系Ta (简历 ${resumeId})`);
                const greetOk = await window.resumeManager.sendGreeting(document, resumeId);
                if (!greetOk) {
                  console.log('详情页联系Ta失败，尝试列表页兜底');
                  await window.resumeManager.sendGreetingFromList(iframeDoc, resumeId);
                }
              }

              // ★ 自动转发至邮箱 已在评估函数内部完成，此处不重复调用
            }

            await window.resumeManager.saveAnalyzedResumeId(resumeId);
            console.log(`已保存简历 ${resumeId} 的分析记录`);

          } catch (evalError) {
            console.error(`简历 ${resumeId} AI评估失败:`, evalError);
          }

          if (!isAnalyzing) return;

          await new Promise(resolve => setTimeout(resolve, isAnalyzing ? 500 : 100));
          if (!isAnalyzing) return;

          await window.resumeManager.closeResume(document);
          console.log(`已关闭简历 ${resumeId} 的弹窗`);

          await new Promise(resolve => setTimeout(resolve, isAnalyzing ? 2000 : 100));
        }
      } catch (error) {
        console.error(`处理简历 ${resumeId} 时发生主错误:`, error);
        if (isAnalyzing) {
          await window.resumeManager.closeResume(document);
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
      if (!isAnalyzing) return;
    } // 结束 for (const card of resumeCards)

    // 如果在当前视口的卡片中，所有卡片都被跳过了（即没有一个是新的、未分析的）
    if (allCurrentCardsSkippedOrProcessed && resumeCards.length > 0) {
      console.log(`当前视口所有 ${resumeCards.length} 个简历均被跳过 (已分析或ID无效)。`);
      consecutiveScrollsWithoutNewProcessing++;
      console.log(`连续空滚动次数: ${consecutiveScrollsWithoutNewProcessing}/${MAX_CONSECUTIVE_SCROLLS_WITHOUT_PROCESSING}`);

      if (consecutiveScrollsWithoutNewProcessing >= MAX_CONSECUTIVE_SCROLLS_WITHOUT_PROCESSING) {
        console.error(`已连续 ${MAX_CONSECUTIVE_SCROLLS_WITHOUT_PROCESSING} 次滚动后未找到可处理的新简历。分析可能因ID问题或历史记录问题卡住。将停止分析。`);
        showError(`分析似乎卡住（连续 ${MAX_CONSECUTIVE_SCROLLS_WITHOUT_PROCESSING} 次滚动后未处理新简历）。已自动停止。请检查控制台日志。`);
        isAnalyzing = false;
        break;
      }

      // 准备滚动加载更多
      console.log('准备滚动加载更多简历...');
      await autoScroll(iframeDoc);
      await new Promise(resolve => setTimeout(resolve, 3000));

      const newCardsAfterScroll = iframeDoc.querySelectorAll(cardSelector);
      if (newCardsAfterScroll.length === resumeCards.length && !newResumeActuallyProcessedInThisPass) {
        // 检查 previousCardCount 而不是 resumeCards.length，因为 resumeCards.length 是滚动前的数量
        console.log('滚动后卡片数量未增加，且本轮未处理新简历。可能已到达底部。');
        await autoScroll(iframeDoc); // 再尝试滚动一次
        await new Promise(resolve => setTimeout(resolve, 3000));

        const finalCheck = iframeDoc.querySelectorAll(cardSelector);
        if (finalCheck.length === newCardsAfterScroll.length) {
          console.log('二次滚动后卡片数量仍未增加，确认已到达底部，结束分析。');
          isAnalyzing = false;
          break;
        }
      }
    } else if (!allCurrentCardsSkippedOrProcessed) {
      // 如果在当前视口中找到了需要处理的卡片（即使它们后来处理失败）
      // 这不计为"空滚动"，因为我们至少尝试了。
      // 如果确实有简历被成功处理 (newResumeActuallyProcessedInThisPass is true), 计数器已在上面重置。
      // 如果尝试处理但都失败了，我们也不应该立即停止，除非重复多次。
      console.log('当前视口找到可处理的简历，或已处理简历。');
      if (!newResumeActuallyProcessedInThisPass && resumeCards.length > 0) {
        console.log("虽然找到了可尝试处理的简历，但本轮实际没有成功处理任何新简历。");
        // 这里可以考虑是否也增加consecutiveScrollsWithoutNewProcessing，如果连续多次尝试但都失败。
        // 但目前逻辑是只要有尝试就不算"空"滚动。
      }
    } else if (resumeCards.length === 0 && isAnalyzing) {
      console.log('当前视口无简历卡片，但分析仍在进行中。可能是临时状态，等待下一轮。');
      await new Promise(resolve => setTimeout(resolve, 3000)); // 等待一下看看是否加载
    }


  } // 结束 while (isAnalyzing)

  if (button) { // 确保 button 对象存在
    if (!isAnalyzing && consecutiveScrollsWithoutNewProcessing < MAX_CONSECUTIVE_SCROLLS_WITHOUT_PROCESSING) { // 正常完成或手动停止
      button.classList.remove('processing');
      button.classList.add('success');
      button.innerHTML = `
        <svg class="button-icon" viewBox="0 0 24 24" width="16" height="16">
          <path fill="currentColor" d="M9,20.42L2.79,14.21L5.62,11.38L9,14.77L18.88,4.88L21.71,7.71L9,20.42Z"/>
        </svg>
        分析完成
      `;
    } else if (!isAnalyzing && consecutiveScrollsWithoutNewProcessing >= MAX_CONSECUTIVE_SCROLLS_WITHOUT_PROCESSING) { // 因卡住而停止
      button.classList.remove('processing');
      button.classList.add('error'); // Or some other indicator for "stopped due to issue"
      button.textContent = '分析卡住已停止';
    }
  }

  console.log(`搜索页面简历分析结束。分析状态: ${isAnalyzing}, processedIds 数量: ${processedIds.size}, 连续空滚动次数: ${consecutiveScrollsWithoutNewProcessing}`);
}


// ★ 检测 Boss 频率限制 toast，自动等待恢复
async function detectAndWaitRateLimit() {
  try {
    var toast = document.querySelector('.boss-toast .icon-toast-error');
    var text = toast && toast.parentElement ? (toast.parentElement.textContent || '') : '';
    if (/查看太频繁|操作频繁|稍后重试|过于频繁/.test(text)) {
      // 出现限流 → 等 40-90 秒（真人等待时间）
      var wait = 40000 + Math.random() * 50000;
      console.warn('[限流] 检测到"查看太频繁"，等待', Math.round(wait/1000), '秒...');
      showPanelMsg('⏳ Boss限流，等待' + Math.round(wait/1000) + '秒...');
      await new Promise(r => setTimeout(r, wait));
      return true;
    }
  } catch(e) {}
  return false;
}

// 处理聊天页面的简历分析
async function handleChatPageAnalysis(button) {
  console.log('开始处理聊天页面的简历分析');

  // 等待用户列表容器加载
  const userContainer = await waitForElement('.chat-user .user-container');
  console.log('用户列表容器已加载');

  // 记录已处理的简历ID，避免重复处理
  const processedIds = new Set();
  let previousItemCount = 0;
  let sameItemCountTimes = 0;

  // 初始清理所有可能存在的弹窗
  await forceCloseResumeDialog([document], 5);

  // 设置防止长时间卡住的定时器
  let dialogTimeoutCheck;

  while (isAnalyzing) {
    // ★ 每日浏览限制
    var dc2 = await getDailyCounts();
    if (dc2.browse >= DAILY_BROWSE_LIMIT) {
      showPanelMsg('今日浏览'+DAILY_BROWSE_LIMIT+'份已满，停止');
      isAnalyzing = false; return;
    }
    // 检测付费墙弹窗
    if (detectPaywallPopup(document)) {
      console.log('检测到付费墙弹窗，停止分析');
      showError('遇到付费墙（权益不足），请检查您的BOSS直聘账号权限');
      isAnalyzing = false;
      break;
    }

    // 清除上一个超时检查
    if (dialogTimeoutCheck) clearTimeout(dialogTimeoutCheck);

    // 设置新的超时检查
    dialogTimeoutCheck = setTimeout(async () => {
      if (isAnalyzing) {
        console.log('执行定期检查，查看是否有未关闭的弹窗...');
        await forceCloseResumeDialog([document], 3);
      }
    }, 60000); // 每60秒检查一次

    // 获取所有用户列表项（真实结构：.user-list.b-scroll-stable > .geek-item-wrap > .geek-item[data-id]）
    var allUserItems = Array.from(document.querySelectorAll('.chat-user .user-container .user-list .geek-item, .user-list.b-scroll-stable .geek-item'));
    console.log('找到用户列表项数量:', allUserItems.length);

    // ★ 读取"过滤已读简历"设置，过滤已读项（沟通页已读标记是 .status-read）
    var filterRead = await new Promise(function(r) { chrome.storage.sync.get(['filterRead'], function(res) { r(res.filterRead !== undefined ? res.filterRead : true); }); });
    var userItems = filterRead
      ? allUserItems.filter(function(item) { return !item.querySelector('.status-read') && !item.classList.contains('has-read') && !item.classList.contains('has-viewed'); })
      : allUserItems;
    console.log('过滤已读后剩余:', userItems.length, '(过滤已读:', filterRead, ')');

    // 计算本轮有多少"未处理过"的项（真正待做的）
    var pendingItems = userItems.filter(function(item) {
      var rid = (item.getAttribute('data-id') || (item.getAttribute('id')||'').replace(/^_/,'')).split('-')[0];
      return rid && !processedIds.has(rid);
    });
    console.log('本轮待处理:', pendingItems.length);

    // 本轮无待处理项 → 直接滚动加载更多（不计入"卡住"）
    if (pendingItems.length === 0) {
      var sc0 = document.querySelector('.user-list.b-scroll-stable') || document.querySelector('.chat-user .user-container');
      var beforeLen = allUserItems.length;
      console.log('本轮无新简历，滚动加载更多...');
      await autoScroll(sc0);
      await new Promise(function(r){ setTimeout(r, 3000); });
      var afterItems = document.querySelectorAll('.user-list .geek-item, .user-list.b-scroll-stable .geek-item');
      if (afterItems.length === beforeLen) {
        sameItemCountTimes++;
        if (sameItemCountTimes >= 3) { console.log('滚动后列表无增长，已到底部，结束'); break; }
      } else {
        sameItemCountTimes = 0;
      }
      continue;
    }
    sameItemCountTimes = 0;

    let newResumeFound = false;
    let allCurrentItemsProcessed = true;
    let processedInCurrentBatch = 0;

    // 逐个处理用户列表项
    for (const item of userItems) {
      if (!isAnalyzing) {
        console.log('分析过程被中断');
        return;
      }

      // 获取简历ID（真实结构：data-id="53854458-0" 或 id="_53854458-0"）
      var rawId = item.getAttribute('data-id') || (item.getAttribute('id') || '').replace(/^_/, '');
      const resumeId = rawId ? rawId.split('-')[0] : '';

      // 检查这份简历是否已经分析过
      if (!resumeId) {
        console.log('无法获取简历ID，跳过');
        continue;
      }

      // 检查是否在当前会话中已处理过
      if (processedIds.has(resumeId)) {
        console.log(`跳过当前会话已处理的简历 ${resumeId}`);
        continue;
      }

      // 先将ID添加到已处理集合，防止异步处理过程中重复处理
      processedIds.add(resumeId);

      // 检查是否在历史记录中已分析过
      const isAnalyzed = await checkResumeAnalyzed(resumeId);
      if (isAnalyzed) {
        console.log(`跳过历史记录中已分析的简历 ${resumeId}`);
        continue;
      }

      try {
        console.log(`正在处理简历 ${resumeId}...`);
        newResumeFound = true;

        // ★ 先检查次数，用完直接跳过（不开弹窗，不浪费操作）
        var trialRemCard = await checkTrialRemaining();
        if (trialRemCard <= 0) { showPanelMsg('次数已用完'); isAnalyzing = false; return; }

        // 在打开新简历前，强力关闭所有残留弹窗（验证真的关掉，防止堆叠）
        await forceCloseResumeDialog([document], 5);

        // 点击列表项打开对话（优先点 item 本身，兜底用 id 选择器）
        var clickTarget = item.querySelector('.geek-item-top') || item;
        if (clickTarget) { clickTarget.click(); }
        else { var byId = document.querySelector('#_' + rawId) || document.querySelector(`#_${resumeId}-0`); if (byId) byId.click(); }
        await new Promise(resolve => setTimeout(resolve, 500));

        // 等待对话框出现
        const conversationBox = await waitForElement('.chat-conversation', 5000);
        if (!conversationBox) {
          throw new Error('点击后未能加载对话框');
        }
        console.log('已点击用户列表项，对话框已加载');

        // 等待基本信息区域加载
        const baseInfoNameElement = await waitForElement('.base-info-single-top-detail .base-info-item.name-contet > span > span > span');
        console.log('基本信息区域已加载');

        if (!isAnalyzing) return;

        // 从聊天界面提取基本信息
        const basicInfo = {};
        try {
          // 提取姓名
          basicInfo.name = baseInfoNameElement?.textContent?.trim() || '';

          // 提取性别
          const genderElement = document.querySelector('.base-info-single-top-detail .base-info-item:nth-child(2) span');
          if (genderElement) {
            const genderText = genderElement.textContent.trim();
            if (genderText.includes('男')) {
              basicInfo.gender = '男';
            } else if (genderText.includes('女')) {
              basicInfo.gender = '女';
            } else {
              basicInfo.gender = '';
            }
          }

          // 提取年龄
          const ageElement = document.querySelector('.base-info-single-top-detail .base-info-item:nth-child(2) span');
          if (ageElement) {
            const ageMatch = ageElement.textContent.match(/(\d+)岁/);
            if (ageMatch) {
              basicInfo.age = parseInt(ageMatch[1]);
            } else {
              basicInfo.age = null;
            }
          }

          // 提取工作经验
          const experienceElement = document.querySelector('.base-info-single-top-detail .base-info-item:nth-child(3) span');
          if (experienceElement) {
            basicInfo.experience = experienceElement.textContent.trim();
          } else {
            basicInfo.experience = '';
          }

          // 提取教育信息
          const educationElement = document.querySelector('.base-info-single-top-detail .base-info-item:nth-child(4) span');
          if (educationElement) {
            basicInfo.education = educationElement.textContent.trim();

            // 尝试提取学校和专业
            const eduInfo = {};
            const eduText = educationElement.textContent.trim();
            const eduParts = eduText.split('·');
            if (eduParts.length >= 1) {
              eduInfo.school = eduParts[0].trim();
            }
            if (eduParts.length >= 2) {
              eduInfo.major = eduParts[1].trim();
            }
            eduInfo.degree = basicInfo.education.includes('本科') ? '本科' :
              basicInfo.education.includes('硕士') ? '硕士' :
                basicInfo.education.includes('博士') ? '博士' : '';
            eduInfo.period = '';

            basicInfo.educationInfo = eduInfo;
          } else {
            basicInfo.education = '';
            basicInfo.educationInfo = { school: '', major: '', degree: '', period: '' };
          }

          // 提取求职状态
          const jobStatusElement = document.querySelector('.base-info-single-top-detail .base-info-item:nth-child(5) span');
          if (jobStatusElement) {
            basicInfo.jobStatus = jobStatusElement.textContent.trim();
          } else {
            basicInfo.jobStatus = '';
          }

          // 提取期望职位信息
          const expectElement = document.querySelector('.base-info-single-top-detail .base-info-item:nth-child(6) span');
          if (expectElement) {
            const expectText = expectElement.textContent.trim();
            const expectParts = expectText.split('·');

            basicInfo.expectInfo = {
              location: expectParts.length >= 1 ? expectParts[0].trim() : '',
              position: expectParts.length >= 2 ? expectParts[1].trim() : '',
              salary: expectParts.length >= 3 ? expectParts[2].trim() : ''
            };
          } else {
            basicInfo.expectInfo = { location: '', position: '', salary: '' };
          }

          // 初始化其他字段
          basicInfo.workExperiences = [];
          basicInfo.projectExperiences = [];
          basicInfo.selfDescription = '';
          basicInfo.resumeId = resumeId;

          console.log('已从聊天界面提取基本信息:', basicInfo);
        } catch (e) {
          console.warn('从聊天界面提取基本信息时出错:', e);
        }

        // 点击姓名打开简历详情
        await window.resumeManager.clickElement(baseInfoNameElement);
        console.log('已点击姓名打开简历详情');

        // 等待简历弹窗加载
        try {
          await waitForResumeDetailReady(document, 12000, resumeId);
          console.log('简历对话框已加载');
        } catch (error) {
          if (error.message === '用户中断操作') {
            return;
          }
          throw error;
        }

        if (!isAnalyzing) return;

        // 获取简历详细内容
        const detailedInfo = await window.resumeManager.extractChatPageResumeContent(document, resumeId);
        console.log('已提取简历详细内容');

        // 合并基本信息和详细信息
        const resumeContent = {
          ...basicInfo,
          ...detailedInfo,
          // 保留最有价值的信息，避免被默认值覆盖
          name: (basicInfo.name && basicInfo.name !== '未知') ? basicInfo.name :
            (detailedInfo.name && detailedInfo.name !== '未知') ? detailedInfo.name : '未知',
          gender: (detailedInfo.gender && detailedInfo.gender !== '') ? detailedInfo.gender :
            (basicInfo.gender && basicInfo.gender !== '') ? basicInfo.gender : '',
          age: (detailedInfo.age && detailedInfo.age !== null) ? detailedInfo.age :
            (basicInfo.age && basicInfo.age !== null) ? basicInfo.age : null,
          experience: detailedInfo.experience || basicInfo.experience || '',
          education: detailedInfo.education || basicInfo.education || '',
          jobStatus: detailedInfo.jobStatus || basicInfo.jobStatus || '',
          expectInfo: {
            location: detailedInfo.expectInfo?.location || basicInfo.expectInfo?.location || '',
            position: detailedInfo.expectInfo?.position || basicInfo.expectInfo?.position || '',
            salary: detailedInfo.expectInfo?.salary || basicInfo.expectInfo?.salary || ''
          },
          workExperiences: (detailedInfo.workExperiences && detailedInfo.workExperiences.length > 0) ?
            detailedInfo.workExperiences :
            (basicInfo.workExperiences && basicInfo.workExperiences.length > 0) ?
              basicInfo.workExperiences : [],
          educationInfo: (detailedInfo.educationInfo && detailedInfo.educationInfo.school) ?
            detailedInfo.educationInfo :
            (basicInfo.educationInfo && basicInfo.educationInfo.school) ?
              basicInfo.educationInfo : { school: '', major: '', degree: '', period: '' },
          selfDescription: detailedInfo.selfDescription || basicInfo.selfDescription || '',
          resumeId: resumeId
        };

        console.log('合并基本信息和详细信息完成');
        console.log('合并后的简历内容:', resumeContent);

        if (!isAnalyzing) return;

        // 调用AI评估
        try {
          // ★ 评估前检查试用次数
          var trialRem3 = await checkTrialRemaining();
          if (trialRem3 <= 0) { showPanelMsg('次数已用完'); isAnalyzing = false; return; }
          console.log('开始AI评估');
          const score = await window.resumeManager.evaluateResume(resumeContent, document);
          console.log('评估完成，分数:', score);
          incDailyBrowse(); window.consumeTrial && window.consumeTrial();
          if (!isAnalyzing) return;

          // 如果分数达标，根据设置决定是否自动收藏和联系Ta
          const threshold = await window.resumeManager.getUserScoreThreshold();
          if (score >= threshold) {
            console.log('分数达标');
            if (!isAnalyzing) return;

            // 检查是否需要自动收藏
            const shouldAutoFavorite = await window.resumeManager.getAutoFavoriteSetting();
            if (shouldAutoFavorite) {
              console.log('执行自动收藏');
              try {
                const favoriteResult = await window.resumeManager.favoriteResume();
                console.log('收藏结果:', favoriteResult ? '成功' : '失败');
              } catch (error) {
                console.error('自动收藏过程出错，但继续执行后续流程:', error);
              }
            }

            // 检查是否需要自动联系Ta
            const shouldAutoGreet = await window.resumeManager.getAutoGreetSetting();
            if (shouldAutoGreet) {
              console.log('执行自动联系Ta');
              const greetOk = await window.resumeManager.sendGreeting(document, resumeId);
              if (!greetOk) {
                console.log('详情页联系Ta失败，尝试列表页兜底');
                await window.resumeManager.sendGreetingFromList(document, resumeId);
              }
            }

            // ★ 自动转发至邮箱 已在评估函数内部完成，此处不重复调用
          }

          // 保存已分析的简历ID
          await window.resumeManager.saveAnalyzedResumeId(resumeId);
          processedIds.add(resumeId); // 添加到当前会话的已处理集合中
          processedInCurrentBatch++;
          console.log(`已保存分析记录，当前批次已处理 ${processedInCurrentBatch} 份简历`);

        } catch (error) {
          console.error('AI评估失败:', error);
          await forceCloseResumeDialog([document], 5);
          // 次数用完 → 直接停止，不在循环里反复开关弹窗
          if ((error.message || '').includes('次数已用完')) {
            showPanelMsg('次数已用完');
            isAnalyzing = false; return;
          }
          continue;
        }

        // 沟通页处理完立刻强力关弹窗（验证真的关掉），避免堆叠
        await forceCloseResumeDialog([document], 5);
        console.log('已关闭简历弹窗');
        if (!isAnalyzing) return;
        await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 300));

        // 等待处理下一份简历
        await new Promise(resolve => setTimeout(resolve, 2500 + Math.random() * 2000));

      } catch (error) {
        console.error(`处理简历 ${resumeId} 时出错:`, error);
        allCurrentItemsProcessed = false;
        if (isAnalyzing) {
          await forceCloseResumeDialog([document], 5);
          await new Promise(resolve => setTimeout(resolve, 3000 + Math.random() * 2000));
        }
        if (!isAnalyzing) return;
      }
    }

    // 清除超时检查
    if (dialogTimeoutCheck) clearTimeout(dialogTimeoutCheck);

    // 处理完当前视口后滚动加载更多（除非出错中断）
    if (allCurrentItemsProcessed) {
      console.log(`当前视口已处理完成（累计${processedIds.size}份），滚动加载更多...`);
      var scrollContainer = document.querySelector('.user-list.b-scroll-stable') || document.querySelector('.chat-user .user-container') || document.querySelector('.user-container');
      await autoScroll(scrollContainer);

      // 等待新内容加载
      await new Promise(resolve => setTimeout(resolve, 3000));

      // 检查是否有新的简历加载
      const newItems = document.querySelectorAll('.user-list .geek-item, .user-list.b-scroll-stable .geek-item');
      if (newItems.length === allUserItems.length && !newResumeFound) {
        console.log('没有新的简历加载，可能已到达底部');
        // 再尝试滚动一次确认
        await autoScroll(scrollContainer);
        await new Promise(resolve => setTimeout(resolve, 3000));

        const finalCheck = document.querySelectorAll('.user-list .geek-item, .user-list.b-scroll-stable .geek-item');
        if (finalCheck.length === newItems.length) {
          console.log('确认已到达底部，结束分析');
          break;
        }
      }
    } else {
      console.log('当前页面还有未处理的简历，继续处理...');
    }
  }

  if (isAnalyzing) {
    button.classList.remove('processing');
    button.classList.add('success');
    button.innerHTML = `
      <svg class="button-icon" viewBox="0 0 24 24" width="16" height="16">
        <path fill="currentColor" d="M9,20.42L2.79,14.21L5.62,11.38L9,14.77L18.88,4.88L21.71,7.71L9,20.42Z"/>
      </svg>
      分析完成
    `;
  }

  console.log(`聊天页面简历分析完成，本次共处理 ${processedIds.size} 份简历`);
}

async function closeAllShareBoxes() {
  try {
    var _docs = [document];
    (function _coll(root, depth) {
      if (!root || !root.querySelectorAll || depth > 4) return;
      try { var _ifs = root.querySelectorAll("iframe"); for (var _i = 0; _i < _ifs.length; _i++) { try { var _fd = _ifs[_i].contentDocument; if (_fd && _docs.indexOf(_fd)===-1) { _docs.push(_fd); _coll(_fd,depth+1); } } catch(e) {} } } catch(e) {}
    })(document, 0);
    for (var _d = 0; _d < _docs.length; _d++) {
      var _dd = _docs[_d]; if (!_dd || !_dd.querySelectorAll) continue;
      var _btns = _dd.querySelectorAll(".c-share-box .iboss-close, .c-share-box .boss-popup__close, .c-share-box .close, .c-share-box .icon-close");
      for (var _i2 = 0; _i2 < _btns.length; _i2++) { if (_btns[_i2].offsetParent!==null) _btns[_i2].click(); }
      var _bxs = _dd.querySelectorAll(".c-share-box");
      for (var _j = 0; _j < _bxs.length; _j++) { try { _bxs[_j].parentNode && _bxs[_j].parentNode.removeChild(_bxs[_j]); } catch(e) {} }
    }
  } catch(e) {}
}

// ==================== 通信页自动求简历/下载附件 ====================
// 独立功能：遍历未读对话 → 附件简历可下则下载，否则求简历可点则点击
// ==================== 下载简历附件 ====================
async function handleChatResumeDownload() {
  console.log('[下载] 开始');
  var dls = 0, skips = 0;
  var setS = function(t) { showPanelMsg(t); };
  var sleep = function(ms) { return new Promise(function(r) { setTimeout(r, ms); }); };
  var processed = new Set();
  try { await waitForElement('.geek-item[data-id]', 8000); } catch(e) { setS('未找到聊天列表'); return; }
  var prevCnt = 0, sameCnt = 0;
  while (isAnalyzing) {
    var items = document.querySelectorAll('.geek-item[data-id]');
    if (items.length === prevCnt) { if (++sameCnt >= 3) break; } else { prevCnt = items.length; sameCnt = 0; }
    for (var i = 0; i < items.length; i++) {
      if (!isAnalyzing) return;
      var it = items[i], did = it.getAttribute('data-id');
      if (!did || processed.has(did)) continue;
      processed.add(did);
      var nm = (it.querySelector('.geek-name')?.textContent||'').trim()||did;
      try {
        it.click(); await sleep(1200);
        try { await waitForElement('.resume-btn-content', 5000); } catch(e) {}
        await sleep(500);
        var fb = document.querySelector('.resume-btn-file');
        if (!fb || fb.classList.contains('disabled')) { skips++; setS('跳过'+nm+' | 下'+dls+' 跳'+skips); continue; }
        fb.click(); await sleep(3000);
        var url = '';
        for (var t = 0; t < 10 && !url; t++) {
          var box = document.querySelector('.resume-recommend,.attachment-view,.dialog-wrap,[class*=dialog]');
          if (box) {
            var fr = box.querySelector('iframe.attachment-iframe,iframe[src*=bzl],iframe[src*=pdf-viewer]');
            if (fr) {
              url = fr.getAttribute('src')||'';
              var m = url.match(/[?&]url=([^&]+)/);
              if (m) url = decodeURIComponent(m[1]);
              if (url && url.indexOf('http')!==0) url = (url.indexOf('//')===0?'https:':'')+url;
            }
          }
          await sleep(500);
        }
        if (url) {
          var dlR = null;
          var onDl = function(m) { if (m.action==='downloadComplete') dlR = m; };
          chrome.runtime.onMessage.addListener(onDl);
          chrome.runtime.sendMessage({action:'startDownload',url:url});
          var cloudUrl = '';
          if (!('$$IS_PAID$$' === 'true')) {
            try {
              var b = await fetch(url).then(function(r){ return r.blob(); });
              var fd = new FormData(); fd.append('file', b, nm+'.pdf');
              var up = await fetch('http://192.168.5.235:8088/anonymous/upload', {method:'POST', body:fd});
              var upJson = await up.json();
              cloudUrl = upJson.data || upJson.url || '';
              if (cloudUrl && cloudUrl.indexOf('http')!==0) cloudUrl = 'http://192.168.5.235:8088'+(cloudUrl.indexOf('/')===0?'':'/')+cloudUrl;
            } catch(e) { console.warn('[下载] 上传云失败:', e.message); }
          }
          for (var w = 0; w < 30 && !dlR; w++) await sleep(500);
          chrome.runtime.onMessage.removeListener(onDl);
          dls++;
          var fn = dlR ? dlR.fileName : 'resume.pdf';
          if (fn || cloudUrl) {
            var recs = (await new Promise(function(r){ chrome.storage.local.get('dl_records', r); })).dl_records || [];
            recs.unshift({name: nm, file: fn, cloud: cloudUrl, time: new Date().toISOString()});
            if (recs.length > 200) recs.length = 200;
            await new Promise(function(r){ chrome.storage.local.set({dl_records: recs}, r); });
          }
          setS('下载: '+(fn||'?')+(cloudUrl?' ☁已上传':'')+' | 下'+dls+' 跳'+skips);
        } else { skips++; setS('跳过'+nm+'(无URL) | 下'+dls+' 跳'+skips); }
        var cb = document.querySelector('.resume-recommend .close-btn,.attachment-view .close-btn,.close-btn');
        if (cb) { cb.click(); await sleep(500); }
      } catch(e) { console.warn('[下载]', nm, e.message); }
      await sleep(2000 + Math.random() * 2000);
    }
    var sc = document.querySelector('.user-list.b-scroll-stable,.chat-user .user-container');
    if (sc) { sc.scrollTop = sc.scrollHeight; await sleep(2500); }
  }
  setS('下载完成 | 下'+dls+' 跳'+skips);
}

async function handleChatResumeCollection() {
  console.log('[求简历] 开始沟通页采集');
  var status = document.getElementById('collectStatus');
  var setStatus = function(t) { if (status) status.textContent = t; showPanelMsg(t); };

  // 沟通页专用的堆叠弹窗定位（对话详情工具栏在主文档，可能有多个残留，取激活的）
  function _stkZ(el) { var z=0,p=el; while(p&&p!==document.body){ var zi=parseInt(getComputedStyle(p).zIndex,10); if(!isNaN(zi))z=Math.max(z,zi); p=p.parentElement; } return z; }
  function _pickActive(sel) { var els=Array.from(document.querySelectorAll(sel)).filter(function(e){var r=e.getBoundingClientRect();return r.width>10&&r.height>10&&e.offsetParent!==null}); if(!els.length)return null; els.sort(function(a,b){return _stkZ(a)-_stkZ(b)}); return els[els.length-1]; }
  var sleep = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };

  // 1. 切换到"未读"筛选
  try {
    var filterSpans = Array.from(document.querySelectorAll('.chat-message-filter span, .chat-message-filter-right span, .chat-label-top span'));
    var unread = filterSpans.find(function(s){ return (s.textContent||'').trim() === '未读'; });
    if (unread && !unread.classList.contains('active')) {
      unread.click();
      console.log('[求简历] 已切到未读筛选');
      await sleep(1500);
    } else {
      console.log('[求简历] 未读筛选:', unread ? '已是未读' : '未找到筛选按钮');
    }
  } catch(e) { console.warn('[求简历] 切未读失败:', e.message); }

  // 2. 等聊天列表
  try { await waitForElement('.chat-user .user-container, .geek-item', 8000); }
  catch(e) { setStatus('未找到聊天列表'); return; }

  var processed = new Set();
  var downloaded = 0, requested = 0, skipped = 0;
  var previousCount = 0, sameCountTimes = 0;

  while (isAnalyzing) {
    // 每日分享额度检查
    var dc = await getDailyCounts();
    if (dc.share >= DAILY_SHARE_LIMIT) {
      setStatus('今日分享额度('+DAILY_SHARE_LIMIT+')已满，停止');
      break;
    }

    // 未读对话列表项（.geek-item[data-id]）
    var items = Array.from(document.querySelectorAll('.geek-item[data-id]'));
    if (items.length === previousCount) {
      if (++sameCountTimes >= 3) { console.log('[求简历] 列表无新增，结束'); break; }
    } else { previousCount = items.length; sameCountTimes = 0; }

    var newHandled = false;
    for (var i = 0; i < items.length; i++) {
      if (!isAnalyzing) { console.log('[求简历] 已中断'); return; }
      var item = items[i];
      var dataId = item.getAttribute('data-id');
      if (!dataId || processed.has(dataId)) continue;
      processed.add(dataId);
      newHandled = true;

      var name = (item.querySelector('.geek-name')?.textContent || '').trim() || dataId;

      try {
        // 点开对话
        item.click();
        await sleep(1200);
        // 等对话详情/工具栏出现
        try { await waitForElement('.resume-btn-content, .operate-exchange-left, .chat-conversation', 5000); } catch(e) {}
        await sleep(400);

        // ★ 求简历：不下载附件，直接请求：.operate-btn 文字含"求简历" 且无 disabled
        var reqBtn = Array.from(document.querySelectorAll('.operate-btn')).filter(function(b){
          return (b.textContent||'').indexOf('求简历') >= 0 && b.offsetParent !== null;
        });
        // 取激活弹窗内的
        var reqActive = reqBtn.sort(function(a,b){return _stkZ(a)-_stkZ(b)}).pop();
        var reqAvail = reqActive && !reqActive.classList.contains('disabled');

        if (reqAvail) {
          reqActive.click();
          await sleep(800);
          // ★ 确认弹窗：搜 chat-tooltip / exchange-tooltip / popover / dialog 等多种容器
          var confirmed = false;
          var querySel = '.chat-tooltip-custom, .exchange-tooltip, .operate-exchange-right, .operate-exchange-left, .dialog-container, [class*="popover"], [class*="popup"]';
          var boxes = Array.from(document.querySelectorAll(querySel));
          for (var b = 0; b < boxes.length; b++) {
            var text = boxes[b].textContent || '';
            if (text.length > 200) continue;
            if (!/确定|确认|索取简历/.test(text)) continue;
            // 在这个框里找"确定/确认"按钮
            var okBtn = Array.from(boxes[b].querySelectorAll('button, span, a, div')).find(function(x){
              var t=(x.textContent||'').trim(); return (t==='确定'||t==='确认'||t==='是') && x.offsetParent!==null && !x.querySelector('*');
            });
            if (okBtn) { okBtn.click(); confirmed = true; break; }
          }
          await sleep(800);
          requested++;
          incDailyShare();
          setStatus('求简历'+name+(confirmed?'':'(未确认)')+' | 已下载'+downloaded+' 求'+requested+' 跳'+skipped);
          console.log('[求简历] 求简历:', name, confirmed ? '已确认' : '未找到确认按钮');
          continue;
        }

        // 都不可用
        skipped++;
        setStatus('跳过'+name+' | 已下载'+downloaded+' 求'+requested+' 跳'+skipped);
        console.log('[求简历] 跳过(附件+求简历均灰):', name);
      } catch (e) {
        console.warn('[求简历] 处理', name, '出错:', e.message);
      }

      // 随机延时防检测
      await sleep(600 + Math.random() * 500);
    }

    // 本轮无新处理 → 滚动加载更多
    if (!newHandled) {
      var listWrap = document.querySelector('.chat-user .user-container') || document.querySelector('.geek-list-wrap');
      if (listWrap) {
        listWrap.scrollTop = listWrap.scrollHeight;
        await sleep(2000);
      } else break;
    }
  }

  setStatus('完成：下载'+downloaded+' 求简历'+requested+' 跳过'+skipped);
  console.log('[求简历] 结束 下载'+downloaded+' 求'+requested+' 跳'+skipped);
}

async function extractChatPageResumeContent(doc, resumeId) {
  try {
    // 等待简历详情加载完成（最多等待10秒）
    const startTime = Date.now();
    let resumeDetail = null;

    while (!resumeDetail && Date.now() - startTime < 10000) {
      // 从主文档中查找简历详情
      try {
        resumeDetail = doc.querySelector("div.resume-box");
      } catch (e) {
        console.warn('查找简历详情元素时出错:', e);
      }

      if (!resumeDetail) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    if (!resumeDetail) {
      console.warn('无法获取简历数据，返回空对象');
      return {
        resumeId,
        name: '',
        gender: '',
        age: null,
        experience: '',
        education: '',
        jobStatus: '',
        expectInfo: { location: '', position: '', salary: '' },
        workExperiences: [],
        projectExperiences: [],
        educationInfo: { school: '', major: '', degree: '', period: '' },
        selfDescription: '',
        timestamp: new Date().toISOString()
      };
    }

    console.log('找到简历详情元素');

    // 提取基本信息
    let baseInfo = {};
    try {
      baseInfo = {
        name: (resumeDetail.querySelector('.item-base-info .geek-name')?.textContent?.trim() || ''),
        gender: (resumeDetail.querySelector('.item-base-info .iboss-icon_man') ||
          resumeDetail.querySelector('[class^="iboss-icon_man"]')) ? '男' :
          (resumeDetail.querySelector('.item-base-info .iboss-icon_women') ||
            resumeDetail.querySelector('[class^="iboss-icon_women"]')) ? '女' : '',
        isElite: !!resumeDetail.querySelector('img.elite'),
        activeStatus: resumeDetail.querySelector('.item-base-info .text-orange')?.textContent?.trim() ||
          resumeDetail.querySelector('.item-base-info .active-status')?.textContent?.trim() || ''
      };
      console.log('提取基本信息成功:', baseInfo);
    } catch (e) {
      console.warn('提取基本信息时出错:', e);
      baseInfo = {
        name: '',
        gender: '',
        isElite: false,
        activeStatus: ''
      };
    }

    // 提取标签信息
    let labels = [];
    try {
      labels = Array.from(resumeDetail.querySelectorAll('.info-labels .label-text') || [])
        .map(span => span?.textContent?.trim() || '')
        .filter(Boolean);
      console.log('提取到标签信息:', labels);
    } catch (e) {
      console.warn('提取标签信息时出错:', e);
    }

    // 解析标签信息
    let age = '', experience = '', education = '', jobStatus = '';
    try {
      if (labels.length >= 1) age = labels[0];
      if (labels.length >= 2) experience = labels[1];
      if (labels.length >= 3) education = labels[2];
      if (labels.length >= 4) jobStatus = labels[3];
    } catch (error) {
      console.warn('解析标签信息失败:', error);
    }

    // 提取自我描述
    let selfDescription = '';
    try {
      selfDescription = resumeDetail.querySelector('.text.selfDescription')?.textContent?.trim() || '';
      console.log('提取自我描述成功:', selfDescription.substring(0, 50) + '...');
    } catch (e) {
      console.warn('提取自我描述时出错:', e);
    }

    // 提取期望职位信息
    let expectInfo = { location: '', position: '', salary: '' };
    try {
      const expectWrap = resumeDetail.querySelector('.geek-expect-wrap .join-text-wrap');
      if (expectWrap) {
        const spans = expectWrap.querySelectorAll('span.join-text') || [];
        if (spans.length >= 1) expectInfo.location = spans[0]?.textContent?.trim() || '';
        if (spans.length >= 2) expectInfo.position = spans[1]?.textContent?.trim() || '';
        if (spans.length >= 4) expectInfo.salary = spans[3]?.textContent?.trim() || '';
      }
      console.log('提取期望职位信息成功:', expectInfo);
    } catch (error) {
      console.warn('提取期望职位信息失败:', error);
    }

    // 提取工作经历
    let workExperiences = [];
    try {
      // 找到工作经历部分
      const workSection = Array.from(resumeDetail.querySelectorAll('.resume-item')).find(item =>
        item.querySelector('h3.title')?.textContent?.trim() === '工作经历'
      );

      if (workSection) {
        const historyItems = workSection.querySelectorAll('.history-list .history-item') || [];
        workExperiences = Array.from(historyItems).map(item => {
          try {
            // 提取公司名称
            const companyElement = item.querySelector('.history-item-title .name span:first-child');
            const company = companyElement?.textContent?.trim() || '';

            // 提取职位
            const positionElement = item.querySelector('.history-item-title .name span:nth-child(3)');
            const position = positionElement?.textContent?.trim() || '';

            // 提取部门
            const departmentElement = item.querySelector('.history-item-title .name span:last-child');
            const department = departmentElement?.textContent?.trim() || '';

            // 提取工作时间
            const period = item.querySelector('.period')?.textContent?.trim() || '';

            // 提取工作内容 - 修复后的代码
            let content = '';
            const contentElement = item.querySelector('.item-text div[data-high-light="true"].text');
            if (contentElement) {
              content = contentElement.textContent.trim();
            }

            // 提取技能标签
            const skills = Array.from(item.querySelectorAll('.item-text .tags span') || [])
              .map(tag => tag?.textContent?.trim() || '')
              .filter(Boolean);

            return {
              company,
              position,
              department,
              period,
              content,
              skills
            };
          } catch (e) {
            console.warn('提取单个工作经历时出错:', e);
            return {
              company: '',
              position: '',
              department: '',
              period: '',
              content: '',
              skills: []
            };
          }
        });
      }
      console.log(`提取工作经历成功，共${workExperiences.length}条`);
    } catch (error) {
      console.warn('提取工作经历失败:', error);
    }

    // 提取项目经验
    let projectExperiences = [];
    try {
      // 找到项目经验部分
      const projectSection = Array.from(resumeDetail.querySelectorAll('.resume-item')).find(item =>
        item.querySelector('h3.title')?.textContent?.trim() === '项目经验'
      );

      if (projectSection) {
        const historyItems = projectSection.querySelectorAll('.history-list .history-item') || [];
        projectExperiences = Array.from(historyItems).map(item => {
          try {
            // 提取项目名称和角色
            const nameElement = item.querySelector('.history-item-title .name');
            const nameText = nameElement?.textContent?.trim() || '';
            const nameParts = nameText.split(/\s*<em.*?vline.*?em>\s*|\s*·\s*/);

            const name = nameParts[0]?.trim() || '';
            const role = nameParts[1]?.trim() || '';

            // 提取项目时间
            const period = item.querySelector('.period')?.textContent?.trim() || '';

            // 提取项目内容
            const contentElement = item.querySelector('.text.project-content') ||
              item.querySelector('.item-text .text');
            const content = contentElement?.textContent?.trim() || '';

            return {
              name,
              role,
              period,
              content
            };
          } catch (e) {
            console.warn('提取单个项目经验时出错:', e);
            return {
              name: '',
              role: '',
              period: '',
              content: ''
            };
          }
        });
      }
      console.log(`提取项目经验成功，共${projectExperiences.length}条`);
    } catch (error) {
      console.warn('提取项目经验失败:', error);
    }

    // 提取教育经历
    let educationInfo = { school: '', major: '', degree: '', period: '' };
    try {
      // 找到教育经历部分
      const educationSection = Array.from(resumeDetail.querySelectorAll('.resume-item')).find(item =>
        item.querySelector('h3.title')?.textContent?.trim() === '教育经历'
      );

      if (educationSection) {
        const educationItem = educationSection.querySelector('.history-item');
        if (educationItem) {
          const schoolElement = educationItem.querySelector('.name b');
          const majorElement = educationItem.querySelector('.major');
          const degreeElement = educationItem.querySelector('.name');
          const periodElement = educationItem.querySelector('.period');

          educationInfo = {
            school: schoolElement?.textContent?.trim() || '',
            major: majorElement?.textContent?.trim() || '',
            degree: degreeElement?.textContent?.includes('本科') ? '本科' :
              degreeElement?.textContent?.includes('硕士') ? '硕士' :
                degreeElement?.textContent?.includes('博士') ? '博士' : '',
            period: periodElement?.textContent?.trim() || ''
          };
        }
      }
      console.log('提取教育经历成功:', educationInfo);
    } catch (error) {
      console.warn('提取教育经历失败:', error);
    }

    // 尝试解析年龄为数字
    let ageNum = null;
    try {
      if (age) {
        const ageMatch = age.match(/(\d+)/);
        if (ageMatch) {
          ageNum = parseInt(ageMatch[1]);
        }
      }
    } catch (e) {
      console.warn('解析年龄为数字时出错:', e);
    }

    // 提取岗位经验
    let positionExperiences = [];
    try {
      const stationSection = resumeDetail.querySelector('.resume-item.resume-station');
      if (stationSection) {
        positionExperiences = Array.from(stationSection.querySelectorAll('.tags span'))
          .map(span => span?.textContent?.trim() || '')
          .filter(Boolean);
      }
      console.log('提取岗位经验成功:', positionExperiences);
    } catch (e) {
      console.warn('提取岗位经验时出错:', e);
    }

    // 提取关键词
    let keywords = [];
    try {
      const keywordsSection = Array.from(resumeDetail.querySelectorAll('.resume-item')).find(item =>
        item.querySelector('h3.title')?.textContent?.trim() === '关键词'
      );

      if (keywordsSection) {
        keywords = Array.from(keywordsSection.querySelectorAll('.keywords'))
          .map(span => span?.textContent?.trim() || '')
          .filter(Boolean);
      }
      console.log(`提取关键词成功，共${keywords.length}个`);
    } catch (e) {
      console.warn('提取关键词时出错:', e);
    }

    // 提取资格证书
    let certificates = [];
    try {
      const certificateSection = Array.from(resumeDetail.querySelectorAll('.resume-item')).find(item =>
        item.querySelector('h3.title')?.textContent?.trim() === '资格证书'
      );

      if (certificateSection) {
        certificates = Array.from(certificateSection.querySelectorAll('li'))
          .map(li => li?.textContent?.trim() || '')
          .filter(Boolean);
      }
      console.log(`提取资格证书成功，共${certificates.length}个`);
    } catch (e) {
      console.warn('提取资格证书时出错:', e);
    }

    const content = {
      resumeId,
      ...baseInfo,
      age: ageNum,
      experience,
      education,
      jobStatus,
      expectInfo,
      workExperiences,
      projectExperiences,
      educationInfo,
      selfDescription,
      positionExperiences,
      keywords,
      certificates,
      timestamp: new Date().toISOString()
    };

    console.log('成功提取简历内容');
    return content;
  } catch (error) {
    console.error('提取简历内容时发生错误:', error);
    // 即使发生错误，也返回一个包含基本信息的对象
    return {
      resumeId,
      name: '',
      gender: '',
      age: null,
      experience: '',
      education: '',
      jobStatus: '',
      expectInfo: { location: '', position: '', salary: '' },
      workExperiences: [],
      projectExperiences: [],
      educationInfo: { school: '', major: '', degree: '', period: '' },
      selfDescription: '',
      timestamp: new Date().toISOString(),
      error: error.message
    };
  }
}



// 处理推荐页面的简历分析
async function handleRecommendPageAnalysis(button) {
  console.log('开始处理推荐页面的简历分析');
  // 获取 iframe 内的文档
  const recommendFrame = document.querySelector('iframe[name="recommendFrame"]');
  if (!recommendFrame) {
    throw new Error('找不到推荐 iframe');
  }
  const iframeDoc = recommendFrame.contentDocument || recommendFrame.contentWindow.document;
  console.log('已获取 iframe 文档');

  // 等待简历列表加载完成
  await waitForAnyCardList(iframeDoc);
  console.log('简历列表已加载');

  // 初始清理所有可能存在的弹窗 + 分享弹窗
  await closeAllShareBoxes();
  await forceCloseResumeDialog([document, iframeDoc], 5);

  // 记录已处理的简历ID，避免重复处理
  const processedIds = new Set();
  let previousCardCount = 0;
  let sameCardCountTimes = 0;

  // 设置防止长时间卡住的定时器
  let dialogTimeoutCheck;

  while (isAnalyzing) {

    // 检测付费墙弹窗
    if (detectPaywallPopup(document) || detectPaywallPopup(iframeDoc)) {
      console.log('检测到付费墙弹窗，停止分析');
      showError('遇到付费墙（权益不足），请检查您的BOSS直聘账号权限');
      isAnalyzing = false;
      break;
    }

    // 获取当前可见的简历卡片，并标记来源
    const recommendListRoot = iframeDoc.querySelector("#recommend-list");
    if (!recommendListRoot) {
      console.warn('未找到 #recommend-list，等待下一轮重试');
      await new Promise(resolve => setTimeout(resolve, 1000));
      continue;
    }

    // 仅保留“可识别出 resumeId 的主卡片”，避免把 similar-geek 等嵌套块当成候选人主卡处理
    const cardItemCards = Array.from(recommendListRoot.querySelectorAll('.card-item')).filter(card => {
      const directInner = card.querySelector(':scope > .card-inner') || card.querySelector(':scope > .new-geek-wrap');
      const candidateInner = directInner || card.querySelector('.card-inner') || card.querySelector('.new-geek-wrap');
      if (!candidateInner) return false;
      const candidateResumeId = candidateInner.getAttribute('data-geek') || candidateInner.getAttribute('data-geekid');
      return Boolean(candidateResumeId);
    });

    const cardInnerCards = Array.from(recommendListRoot.querySelectorAll('.card-inner, .new-geek-wrap')).filter(inner => {
      const candidateResumeId = inner.getAttribute('data-geek') || inner.getAttribute('data-geekid');
      return Boolean(candidateResumeId);
    });

    // 标记卡片来源
    let cardSource = '';
    let resumeCards;

    if (cardItemCards.length > 0) {
      resumeCards = cardItemCards;
      cardSource = 'recommend-geek-card-item';
      console.log('找到recommend-geek-card-item类型的简历卡片数量:', resumeCards.length);
    } else {
      resumeCards = cardInnerCards;
      cardSource = 'new-geek-card-inner';
      console.log('找到new-geek-card-inner类型的简历卡片数量:', resumeCards.length);
    }

    // 后续可以根据cardSource值判断处理流程
    console.log('简历卡片来源:', cardSource);

    // ★ 过滤已读简历（推荐牛人页面也生效）
    //    推荐页已读标记是 has-viewed（不是 has-read），沟通页是 has-read
    var filterRead = await new Promise(function(r) { chrome.storage.sync.get(['filterRead'], function(res) { r(res.filterRead !== undefined ? res.filterRead : true); }); });
    if (filterRead) {
      resumeCards = resumeCards.filter(function(card) {
        if (card.classList.contains('has-read') || card.classList.contains('has-viewed')) return false;
        if (card.querySelector('.has-read, .has-viewed')) return false;
        if (card.querySelector('[style*="grayscale"]')) return false;
        var inner = card.querySelector('.card-inner') || card.querySelector('.new-geek-wrap');
        if (inner && (inner.classList.contains('has-read') || inner.classList.contains('has-viewed'))) return false;
        return true;
      });
      console.log('过滤已读后剩余:', resumeCards.length, '(过滤已读: 是)');
    }

    // 检测是否连续多次获取到相同数量的卡片但未处理新简历
    if (resumeCards.length === previousCardCount) {
      sameCardCountTimes++;
      if (sameCardCountTimes >= 3) {
        console.log('连续多次获取到相同数量的卡片且无新简历，可能已到达底部或加载异常，终止分析');
        break;
      }
    } else {
      previousCardCount = resumeCards.length;
      sameCardCountTimes = 0;
    }

    let newResumeFound = false;
    let allCurrentCardsProcessed = true;
    let processedInCurrentBatch = 0;
    let resumeId = null;
    let basicInfo = null;
    let cardInner = null;

    // 逐个处理简历卡片
    for (const card of resumeCards) {
      if (!isAnalyzing) {
        console.log('分析过程被中断');
        return;
      }

      // 检测付费墙弹窗
      if (detectPaywallPopup(document) || detectPaywallPopup(iframeDoc)) {
        console.log('检测到付费墙弹窗，停止分析');
        showError('遇到付费墙（权益不足），请检查您的BOSS直聘账号权限');
        isAnalyzing = false;
        return;
      }

      console.log('开始处理简历卡片');
      console.log(card);

      if (cardSource === 'recommend-geek-card-item') {

        // 获取简历ID（优先取当前卡片的直接子节点，避免命中嵌套相似推荐块）
        cardInner = card.querySelector(':scope > .card-inner') ||
          card.querySelector(':scope > .new-geek-wrap') ||
          card.querySelector('.card-inner') ||
          card.querySelector('.new-geek-wrap');
        if (!cardInner) {
          console.log('无法获取卡片内容，跳过');
          continue;
        }
        // 从卡片中提取基本信息
        basicInfo = window.resumeManager.extractCardInnerInfo(cardInner);
        resumeId = basicInfo.resumeId;
      }


      if (cardSource === 'new-geek-card-inner') {
        // 获取简历基本信息
        basicInfo = window.resumeManager.extractNewGeekCardInfo(card);
        resumeId = basicInfo.resumeId;
        cardInner = card;
      }

      if (!resumeId) {
        console.log('无法获取新版卡片简历ID，跳过');
        continue;
      }

      // 二次校验：无效卡片直接跳过，避免触发页面内部非法参数报错
      if (!cardInner || (!cardInner.getAttribute('data-geek') && !cardInner.getAttribute('data-geekid'))) {
        console.log(`卡片缺少有效 data-geek/data-geekid，跳过 ${resumeId}`);
        continue;
      }

      // 检查这份简历是否已经分析过
      if (processedIds.has(resumeId)) {
        console.log(`跳过当前会话已处理的简历 ${resumeId}`);
        continue;
      }

      // 先将ID添加到已处理集合，防止异步处理过程中重复处理
      processedIds.add(resumeId);

      // 检查是否在历史记录中已分析过
      const isAnalyzed = await checkResumeAnalyzed(resumeId);
      if (isAnalyzed) {
        console.log(`跳过历史记录中已分析的简历 ${resumeId}`);
        continue;
      }

      try {
        console.log(`正在处理简历 ${resumeId}...`);
        newResumeFound = true;
        allCurrentCardsProcessed = false;

        // 在打开新简历前，先强力关闭所有可能残留的简历弹窗（验证真的关掉）
        await window.resumeManager.forceCloseResumeDialog([document, iframeDoc], 5);
        await closeInterferingPopups(document);
        await closeInterferingPopups(iframeDoc);

        // 额外等待确保之前的对话框完全关闭
        await new Promise(resolve => setTimeout(resolve, 500));

        // 点击卡片打开简历
        await window.resumeManager.clickElement(cardInner);
        console.log('已点击简历卡片');

        // 短暂等待后检测是否有付费墙弹窗
        await new Promise(resolve => setTimeout(resolve, 500));
        if (detectPaywallPopup(document) || detectPaywallPopup(iframeDoc)) {
          console.log('检测到付费墙弹窗，停止分析');
          showError('遇到付费墙（权益不足），请检查您的BOSS直聘账号权限');
          isAnalyzing = false;
          button.classList.remove('processing');
          button.classList.add('error');
          button.innerHTML = `
            <svg class="button-icon" viewBox="0 0 24 24" width="16" height="16">
              <path fill="currentColor" d="M12,2C17.53,2 22,6.47 22,12C22,17.53 17.53,22 12,22C6.47,22 2,17.53 2,12C2,6.47 6.47,2 12,2M15.59,7L12,10.59L8.41,7L7,8.41L10.59,12L7,15.59L8.41,17L12,13.41L15.59,17L17,15.59L13.41,12L17,8.41L15.59,7Z"/>
            </svg>
            已停止
          `;
          return;
        }

        // 等待对话框加载
        try {
          await waitForResumeDetailReady(iframeDoc, 12000, resumeId);
          console.log('简历对话框已加载');
        } catch (error) {
          if (error.message === '用户中断操作') {
            return;
          }
          throw error;
        }

        if (!isAnalyzing) return;

        // 获取简历详细内容
        if (cardSource === 'recommend-geek-card-item') {
          detailedInfo = await window.resumeManager.extractRecommendPageResumeContent(iframeDoc, resumeId);
        } else {
          detailedInfo = await window.resumeManager.extractNewRecommendPageResumeContent(iframeDoc, resumeId);
        }
        console.log('已提取简历详细内容');

        // 合并基本信息和详细信息
        const resumeContent = {
          ...basicInfo,
          ...detailedInfo,
          // 保留最有价值的信息，避免被默认值覆盖
          name: (basicInfo.name && basicInfo.name !== '未知') ? basicInfo.name :
            (detailedInfo.name && detailedInfo.name !== '未知') ? detailedInfo.name : '未知',
          gender: (basicInfo.gender && basicInfo.gender !== '未知') ? basicInfo.gender :
            (detailedInfo.gender && detailedInfo.gender !== '未知') ? detailedInfo.gender : '未知',
          age: (basicInfo.age && basicInfo.age !== null) ? basicInfo.age :
            (detailedInfo.age && detailedInfo.age !== null) ? detailedInfo.age : null,
          experience: basicInfo.experience || detailedInfo.experience || '',
          education: basicInfo.education || detailedInfo.education || '',
          currentTitle: basicInfo.currentTitle || detailedInfo.currentTitle || '',
          currentCompany: basicInfo.currentCompany || detailedInfo.currentCompany || '',
          jobStatus: basicInfo.jobStatus || detailedInfo.jobStatus || '',
          expectInfo: {
            location: detailedInfo.expectInfo?.location || basicInfo.expectInfo?.location || '',
            position: detailedInfo.expectInfo?.position || basicInfo.expectInfo?.position || '',
            salary: detailedInfo.expectInfo?.salary || basicInfo.expectInfo?.salary || ''
          },
          workExperiences: (detailedInfo.workExperiences && detailedInfo.workExperiences.length > 0) ?
            detailedInfo.workExperiences :
            (basicInfo.workExperiences && basicInfo.workExperiences.length > 0) ?
              basicInfo.workExperiences : [],
          educationInfo: (detailedInfo.educationInfo && detailedInfo.educationInfo.school) ?
            detailedInfo.educationInfo :
            (basicInfo.educationInfo && basicInfo.educationInfo.school) ?
              basicInfo.educationInfo : { school: '', major: '', degree: '', period: '' },
          selfDescription: detailedInfo.selfDescription || basicInfo.selfDescription || '',
          resumeId: resumeId
        };

        console.log('合并基本信息和详细信息完成');
        console.log(resumeContent);

        if (!isAnalyzing) return;

        // 调用AI评估
        try {
          // ★ 评估前检查试用次数
          var trialRem4 = await checkTrialRemaining();
          if (trialRem4 <= 0) { showPanelMsg('次数已用完'); isAnalyzing = false; return; }
          console.log('开始AI评估');
          // 使用 iframe 文档作为评估上下文，避免将 iframe 元素本身传入
          const score = await window.resumeManager.evaluateResume(resumeContent, iframeDoc);
          console.log('评估完成，分数:', score);
          incDailyBrowse(); window.consumeTrial && window.consumeTrial();
          if (!isAnalyzing) return;

          // 如果分数达标，根据设置决定是否自动收藏和联系Ta
          const threshold = await window.resumeManager.getUserScoreThreshold();
          if (score >= threshold) {
            console.log('分数达标');
            if (!isAnalyzing) return;

            // 检查是否需要自动收藏
            const shouldAutoFavorite = await window.resumeManager.getAutoFavoriteSetting();
            if (shouldAutoFavorite) {
              console.log('执行自动收藏');
              try {
                const favoriteResult = await window.resumeManager.favoriteResume(iframeDoc);
                console.log('收藏结果:', favoriteResult ? '成功' : '失败');
              } catch (error) {
                console.error('自动收藏过程出错，但继续执行后续流程:', error);
              }
            }

            // 检查是否需要自动联系Ta
            const shouldAutoGreet = await window.resumeManager.getAutoGreetSetting();
            if (shouldAutoGreet) {
              console.log('执行自动联系Ta');
              const greetOk = await window.resumeManager.sendGreeting(document, resumeId);
              if (!greetOk) {
                console.log('详情页联系Ta失败，尝试列表页兜底');
                await window.resumeManager.sendGreetingFromList(iframeDoc, resumeId);
              }
            }

            // ★ 自动转发至邮箱 已在评估函数内部通过 generateShareLink 完成，此处不重复调用
          }

          // 保存已分析的简历ID到 storage
          await new Promise((resolve) => {
            chrome.storage.local.get(['analyzedResumeIds'], (result) => {
              const analyzedIds = new Set(result.analyzedResumeIds || []);
              analyzedIds.add(resumeId);
              chrome.storage.local.set({
                'analyzedResumeIds': Array.from(analyzedIds)
              }, resolve);
            });
          });

          processedIds.add(resumeId); // 添加到当前会话的已处理集合中
          processedInCurrentBatch++;
          console.log(`已保存分析记录，当前批次已处理 ${processedInCurrentBatch} 份简历`);

        } catch (error) {
          console.error('AI评估失败:', error);
          // 确保关闭简历弹窗，即使评估失败
          await window.resumeManager.closeResume(iframeDoc);
          await closeAllResumeDialogs(document);
          await closeAllResumeDialogs(iframeDoc);
          continue;
        }

        // 等待2秒后关闭简历弹窗
        await new Promise(resolve => setTimeout(resolve, 2000));
        if (!isAnalyzing) return;

        // ★ 强力关闭并验证：必须真的关掉当前 frame 弹窗，才能打开下一个
        await window.resumeManager.forceCloseResumeDialog([document, iframeDoc], 5);
        console.log('已关闭简历弹窗');
        if (!isAnalyzing) return;

        // 等待处理下一份简历
        await new Promise(resolve => setTimeout(resolve, 2500 + Math.random() * 2000));
      } catch (error) {
        console.error(`处理简历 ${resumeId} 时出错:`, error);
        allCurrentCardsProcessed = false;
        if (isAnalyzing) {
          await window.resumeManager.closeResume();
          await new Promise(resolve => setTimeout(resolve, 3000 + Math.random() * 2000));
        }
        if (!isAnalyzing) return;
      }
    }

    // 清除超时检查
    if (dialogTimeoutCheck) clearTimeout(dialogTimeoutCheck);

    // 检查是否需要加载更多
    if (allCurrentCardsProcessed) {
      console.log(`当前页面所有简历已处理完成（共${processedIds.size}份），准备滚动加载更多...`);
      await autoScroll(iframeDoc);

      // 等待新内容加载
      await new Promise(resolve => setTimeout(resolve, 3000)); // 延长等待时间

      // 检查是否有新的简历加载
      let newCards;
      if (cardSource === 'recommend-geek-card-item') {
        newCards = iframeDoc.querySelector("#recommend-list").querySelectorAll('.card-item');
      } else {
        newCards = iframeDoc.querySelector("#recommend-list").querySelectorAll('.card-inner');
      }

      // 计算新加载的卡片数量
      const newCardsCount = newCards.length - resumeCards.length;
      console.log(`检测到${newCardsCount}个新加载的简历卡片`);

      // 如果有新卡片，且数量达到或超过15个，直接处理而不继续滚动
      if (newCardsCount >= 15) {
        console.log(`新加载的卡片数量(${newCardsCount})已达到15个，开始处理...`);
        continue; // 返回循环开始，处理新卡片
      }

      // 如果有新卡片但少于15个，也继续处理
      if (newCardsCount > 0 && newCardsCount < 15) {
        console.log(`新加载了${newCardsCount}个简历卡片，开始处理...`);
        continue; // 返回循环开始，处理新卡片
      }

      if (newCards.length === resumeCards.length && !newResumeFound) {
        console.log('没有新的简历加载，可能已到达底部');
        // 再尝试滚动一次，确认是否真的到底了
        await autoScroll(iframeDoc);
        await new Promise(resolve => setTimeout(resolve, 3000));

        // 再次使用相同的逻辑检查新卡片
        let finalCheck;
        if (cardSource === 'recommend-geek-card-item') {
          finalCheck = iframeDoc.querySelector("#recommend-list").querySelectorAll('.card-item');
        } else {
          finalCheck = iframeDoc.querySelector("#recommend-list").querySelectorAll('.card-inner');
        }

        if (finalCheck.length === newCards.length) {
          console.log('确认已到达底部，结束分析');
          break;
        }
      }
    } else {
      console.log('当前页面还有未处理的简历，继续处理...');
    }
  }

  if (isAnalyzing) {
    button.classList.remove('processing');
    button.classList.add('success');
    button.innerHTML = `
      <svg class="button-icon" viewBox="0 0 24 24" width="16" height="16">
        <path fill="currentColor" d="M9,20.42L2.79,14.21L5.62,11.38L9,14.77L18.88,4.88L21.71,7.71L9,20.42Z"/>
      </svg>
      分析完成
    `;
  }

  console.log(`推荐页面简历分析完成，本次共处理 ${processedIds.size} 份简历`);
}

// 从推荐列表中的 cardInner 元素中提取基本信息
function extractCardInnerInfo(cardInner) {
  try {
    console.log('从卡片中提取基本信息');

    if (!cardInner) {
      throw new Error('卡片元素为空');
    }

    // 获取简历ID
    const resumeId = cardInner.getAttribute('data-geek') || cardInner.getAttribute('data-geekid');

    // 获取姓名
    const nameElement = cardInner.querySelector('.col-2 .name-wrap .name');
    const name = nameElement ? nameElement.textContent.trim() : '未知姓名';

    // 获取活跃状态
    const activeElement = cardInner.querySelector('.col-2 .name-wrap .active-text');
    const activeStatus = activeElement ? activeElement.textContent.trim() : '';

    // 获取薪资
    const salaryElement = cardInner.querySelector('.col-1 .salary-wrap');
    const salary = salaryElement ? salaryElement.textContent.trim() : '';

    // 获取性别
    const genderElement = cardInner.querySelector('.col-1 .gender');
    const gender = genderElement ?
      (genderElement.classList.contains('iboss-icon_man') ? '男' :
        genderElement.classList.contains('iboss-icon_women') ? '女' : '未知') : '未知';

    // 获取基本信息（年龄、工作经验、学历、求职状态）
    const baseInfoElement = cardInner.querySelector('.col-2 .base-info');
    let age = null, experience = '', education = '', jobStatus = '';

    if (baseInfoElement) {
      const baseInfoText = baseInfoElement.textContent.trim();
      const baseInfoParts = baseInfoText.split(/\s*[^\d\w\u4e00-\u9fa5]+\s*/); // 按非数字、字母、汉字的字符分割

      // 提取年龄
      const ageMatch = baseInfoParts[0] ? baseInfoParts[0].match(/(\d+)岁/) : null;
      age = ageMatch ? parseInt(ageMatch[1]) : null;

      // 提取工作经验
      experience = baseInfoParts[1] || '';

      // 提取学历
      education = baseInfoParts[2] || '';

      // 提取求职状态
      jobStatus = baseInfoParts[3] || '';
    }

    // 获取期望信息
    const expectElement = cardInner.querySelector('.col-2 .row-flex .content');
    let expectLocation = '', expectPosition = '';

    if (expectElement) {
      const expectText = expectElement.textContent.trim();
      const expectParts = expectText.split(/\s*[^\d\w\u4e00-\u9fa5]+\s*/);
      expectLocation = expectParts[0] || '';
      expectPosition = expectParts[1] || '';
    }

    // 获取个人优势
    const advantageElement = cardInner.querySelector('.col-2 .geek-desc .content');
    const advantage = advantageElement ? advantageElement.textContent.trim() : '';

    // 获取标签
    const tagElements = cardInner.querySelectorAll('.col-2 .tags .tag-item');
    const tags = Array.from(tagElements).map(tag => tag.textContent.trim());

    // 获取工作经历
    const workItems = cardInner.querySelectorAll('.col-3 .work-exps .timeline-item');
    const workExperiences = Array.from(workItems).map(item => {
      const timeElement = item.querySelector('.time');
      const contentElement = item.querySelector('.content');

      if (!timeElement || !contentElement) return null;

      const timeText = timeElement.textContent.trim();
      const contentText = contentElement.textContent.trim();

      // 提取时间段
      const timeParts = timeText.split(/\s*[^\d\w\u4e00-\u9fa5\.]+\s*/);
      const startTime = timeParts[0] || '';
      const endTime = timeParts[1] || '';

      // 提取公司和职位
      const contentParts = contentText.split(/\s*[^\d\w\u4e00-\u9fa5]+\s*/);
      const company = contentParts[0] || '';
      const position = contentParts[1] || '';

      return {
        company,
        position,
        period: `${startTime}-${endTime}`,
        startTime,
        endTime
      };
    }).filter(item => item !== null);

    // 获取教育经历
    const eduItems = cardInner.querySelectorAll('.col-3 .edu-exps .timeline-item');
    const educationExperiences = Array.from(eduItems).map(item => {
      const timeElement = item.querySelector('.time');
      const contentElement = item.querySelector('.content');

      if (!timeElement || !contentElement) return null;

      const timeText = timeElement.textContent.trim();
      const contentText = contentElement.textContent.trim();

      // 提取时间段
      const timeParts = timeText.split(/\s*[^\d\w\u4e00-\u9fa5\.]+\s*/);
      const startTime = timeParts[0] || '';
      const endTime = timeParts[1] || '';

      // 提取学校、专业和学历
      const contentParts = contentText.split(/\s*[^\d\w\u4e00-\u9fa5]+\s*/);
      const school = contentParts[0] || '';
      const major = contentParts[1] || '';
      const degree = contentParts[2] || '';

      return {
        school,
        major,
        degree,
        period: `${startTime}-${endTime}`,
        startTime,
        endTime
      };
    }).filter(item => item !== null);

    // 构建结果对象
    const result = {
      resumeId,
      name,
      gender,
      activeStatus,
      salary,
      age,
      experience,
      education,
      jobStatus,
      expectInfo: {
        location: expectLocation,
        position: expectPosition
      },
      advantage,
      tags,
      workExperiences,
      educationInfo: educationExperiences.length > 0 ? educationExperiences[0] : {},
      educationExperiences,
      timestamp: new Date().toISOString()
    };

    console.log('提取的卡片基本信息：', result);
    return result;

  } catch (error) {
    console.error('提取卡片基本信息时出错:', error);
    return {
      resumeId: cardInner ? (cardInner.getAttribute('data-geek') || cardInner.getAttribute('data-geekid')) : null,
      name: '提取失败',
      error: error.message,
      timestamp: new Date().toISOString()
    };
  }
}

async function extractRecommendPageResumeContent(doc, resumeId) {
  try {
    // 等待简历详情加载完成（最多等待10秒）
    const startTime = Date.now();
    let resumeDetail = null;

    while (!resumeDetail && Date.now() - startTime < 10000) {
      try {
        resumeDetail = doc.querySelector(".resume-detail-wrap");
      } catch (e) {
        console.warn('查找简历详情元素时出错:', e);
      }

      if (!resumeDetail) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    let result = {
      resumeId,
      name: '',
      gender: '',
      age: null,
      experience: '',
      education: '',
      jobStatus: '',
      expectInfo: { location: '', position: '', salary: '', industry: '' },
      workExperiences: [],
      projectExperiences: [],
      educationInfo: { school: '', major: '', degree: '', period: '', experience: '' },
      selfDescription: '',
      extractionMethod: 'recommend-initial',
      timestamp: new Date().toISOString()
    };

    if (!resumeDetail) {
      console.warn('无法获取简历数据，返回空对象');
      return result;
    }

    // 对话框节点出现后，继续等待简历内容真正就绪，避免过早进入提取导致拿到空数据
    const readyStartTime = Date.now();
    let detailReady = false;
    while (Date.now() - readyStartTime < 6000) {
      const hasResumeIframe = !!doc.querySelector('iframe[src*="/web/frame/c-resume/"]');
      const hasMeaningfulDom =
        !!resumeDetail.querySelector('.info-labels .label-text') ||
        !!resumeDetail.querySelector('.geek-expect-wrap .join-text-wrap span') ||
        !!resumeDetail.querySelector('.geek-work-experience-wrap .work-wrap') ||
        !!resumeDetail.querySelector('.geek-education-experience-wrap .edu-wrap');

      if (hasResumeIframe || hasMeaningfulDom) {
        detailReady = true;
        break;
      }

      await new Promise(resolve => setTimeout(resolve, 200));
    }

    if (!detailReady) {
      console.warn('简历详情可能尚未完全渲染，继续尝试提取（可能回退到DOM空结果）');
    }

    // 推荐页内容提取统一走 DOM，评估阶段统一走截图 AI识别
    console.log('推荐页详情提取使用 DOM（评估阶段将使用截图 AI识别）');

    // 提取基本信息
    let baseInfo = {};

    try {
      baseInfo = {
        name: (''),
        gender: '',
        isElite: !!resumeDetail.querySelector('img.elite'),
        activeStatus: resumeDetail.querySelector('.text-orange, .active-status')?.textContent?.trim() || ''
      };
      const genderMale = resumeDetail.querySelector('[class^="iboss-icon_man"]'); // 以iboss-icon_man开头的类
      const genderFemale = resumeDetail.querySelector('[class^="iboss-icon_women"]'); // 以iboss-icon_women开头的类
      const gender = genderMale ? '男' : (genderFemale ? '女' : '');
      baseInfo.gender = gender;

      // 提取自我描述（从基本信息部分提取）
      const descElement = resumeDetail.querySelector('.geek-base-info-wrap .geek-desc');
      if (descElement) {
        baseInfo.selfDescription = descElement.textContent.trim();
      }

      console.log('提取基本信息成功:', baseInfo);
    } catch (e) {
      console.warn('提取基本信息时出错:', e);
      baseInfo = {
        name: '',
        gender: '',
        isElite: false,
        activeStatus: '',
        selfDescription: ''
      };
    }

    // 提取岗位经验
    let experience = '';
    try {
      const positionExpElement = resumeDetail.querySelector('.geek-position-experience-wrap .tags .tag');
      if (positionExpElement) {
        const expText = positionExpElement.textContent.trim();
        const expMatch = expText.match(/(\d+)年(\d+)个月/);
        if (expMatch) {
          experience = `${expMatch[1]}年${expMatch[2]}个月`;
        }
      }
    } catch (e) {
      console.warn('提取岗位经验时出错:', e);
    }

    // 提取期望职位信息
    let expectInfo = { location: '', position: '', salary: '', industry: '' };
    try {
      const expectWrap = resumeDetail.querySelector('.geek-expect-wrap .join-text-wrap');
      if (expectWrap) {
        const spans = Array.from(expectWrap.querySelectorAll('span')).map(span => span.textContent.trim());
        if (spans.length >= 1) expectInfo.location = spans[0];
        if (spans.length >= 2) expectInfo.position = spans[1];
        if (spans.length >= 3) expectInfo.industry = spans[2];
        if (spans.length >= 4) expectInfo.salary = spans[3];
      }
      console.log('提取期望职位信息成功:', expectInfo);
    } catch (error) {
      console.warn('提取期望职位信息失败:', error);
    }

    // 提取工作经历
    let workExperiences = [];
    try {
      const workSection = resumeDetail.querySelector('.geek-work-experience-wrap');
      if (workSection) {
        const workWraps = workSection.querySelectorAll('.work-wrap');
        workExperiences = Array.from(workWraps).map(work => {
          try {
            const companyName = work.querySelector('.company-name-wrap .company-name, .company-name-wrap .name')?.textContent?.trim() || '';
            const position = work.querySelector('.company-name-wrap .position span:first-child')?.textContent?.trim() || '';
            const department = work.querySelector('.company-name-wrap .position span:last-child')?.textContent?.trim().replace(' · ', '') || '';
            const period = work.querySelector('.period')?.textContent?.trim() || '';
            const content = work.querySelector('.item-content')?.textContent?.trim() || '';
            const isInternship = !!work.querySelector('.practice-tag');

            // 提取技能标签
            const skills = Array.from(work.querySelectorAll('.tags .tag') || [])
              .map(tag => tag?.textContent?.trim())
              .filter(Boolean);

            return {
              company: companyName,
              position,
              department,
              period,
              content,
              isInternship,
              skills
            };
          } catch (e) {
            console.warn('提取单个工作经历时出错:', e);
            return null;
          }
        }).filter(Boolean);
      }
      console.log(`提取工作经历成功，共${workExperiences.length}条`);
    } catch (error) {
      console.warn('提取工作经历失败:', error);
    }

    // 提取项目经验
    let projectExperiences = [];
    try {
      const projectSection = resumeDetail.querySelector('.geek-project-experience-wrap');
      if (projectSection) {
        const projectWraps = projectSection.querySelectorAll('.project-wrap');
        projectExperiences = Array.from(projectWraps).map(project => {
          try {
            const nameWrap = project.querySelector('.name.join-text-wrap');
            const spans = nameWrap ? Array.from(nameWrap.querySelectorAll('span')).map(span => span.textContent.trim()) : [];

            const name = spans[0] || '';
            const role = spans[1] || '';
            const period = project.querySelector('.period')?.textContent?.trim() || '';

            // 提取业绩和内容
            const performance = project.querySelector('.item-wrap:nth-child(2) .item-content')?.textContent?.trim() || '';
            const content = project.querySelector('.item-wrap:nth-child(3) .item-content')?.textContent?.trim() || '';

            return {
              name,
              role,
              period,
              performance,
              content
            };
          } catch (e) {
            console.warn('提取单个项目经验时出错:', e);
            return null;
          }
        }).filter(Boolean);
      }
      console.log(`提取项目经验成功，共${projectExperiences.length}条`);
    } catch (error) {
      console.warn('提取项目经验失败:', error);
    }

    // 提取教育经历
    let educationInfo = { school: '', major: '', degree: '', period: '', experience: '' };
    try {
      const educationSection = resumeDetail.querySelector('.geek-education-experience-wrap');
      if (educationSection) {
        const eduWrap = educationSection.querySelector('.edu-wrap');
        if (eduWrap) {
          const schoolName = eduWrap.querySelector('.school-name')?.textContent?.trim() || '';
          const major = eduWrap.querySelector('.major')?.textContent?.trim() || '';
          const degree = eduWrap.querySelector('.school-name-wrap span:nth-child(5)')?.textContent?.trim() || '';
          const period = eduWrap.querySelector('.period')?.textContent?.trim() || '';
          const experience = eduWrap.querySelector('.text-item .title + div')?.textContent?.trim() || '';

          educationInfo = {
            school: schoolName,
            major,
            degree,
            period,
            experience
          };
        }
      }
      console.log('提取教育经历成功:', educationInfo);
    } catch (error) {
      console.warn('提取教育经历失败:', error);
    }

    const content = {
      resumeId,
      ...baseInfo,
      experience,
      education: educationInfo.degree || '',
      jobStatus: baseInfo.activeStatus || '',
      expectInfo,
      workExperiences,
      projectExperiences,
      educationInfo,
      selfDescription: baseInfo.selfDescription || '',
      extractionMethod: 'dom-fallback',
      timestamp: new Date().toISOString()
    };

    // DOM 回退内容过空时，标记为提取异常，强制后续评估流程直接走视觉识别（截图+AI识别）
    const hasStructuredData =
      !!content.name ||
      !!content.expectInfo?.position ||
      !!content.expectInfo?.salary ||
      (Array.isArray(content.workExperiences) && content.workExperiences.length > 0) ||
      (Array.isArray(content.projectExperiences) && content.projectExperiences.length > 0) ||
      !!content.educationInfo?.school ||
      !!content.selfDescription;
    if (!hasStructuredData) {
      content.error = 'recommend-detail-empty-after-dom-fallback';
      console.warn('DOM提取结果过空，标记为异常，后续将强制触发视觉识别');
    }

    console.log('成功提取简历内容:', content);
    return content;
  } catch (error) {
    console.error('提取简历内容时发生错误:', error);
    // 即使发生错误，也返回一个包含基本信息的对象
    return {
      resumeId,
      name: '',
      gender: '',
      age: null,
      experience: '',
      education: '',
      jobStatus: '',
      expectInfo: { location: '', position: '', salary: '', industry: '' },
      workExperiences: [],
      projectExperiences: [],
      educationInfo: { school: '', major: '', degree: '', period: '', experience: '' },
      selfDescription: '',
      timestamp: new Date().toISOString(),
      error: error.message
    };
  }
}

// 在处理简历之前，先从 storage 中读取已分析的简历 ID
async function checkResumeAnalyzed(resumeId) {
  return new Promise((resolve) => {
    chrome.storage.local.get(['analyzedResumeIds'], (result) => {
      const analyzedIds = new Set(result.analyzedResumeIds || []);
      resolve(analyzedIds.has(resumeId));
    });
  });
}

async function extractRecommendPageResumeContentCommon(doc) {
  console.log('extractRecommendPageResumeContentCommon');
  const resumeDetail = doc.querySelector(".resume-detail-wrap");
  if (!resumeDetail) {
    console.warn('未找到简历详情元素');
    return null;
  }
  return resumeDetail;
}

async function extractChatPageResumeContentCommon(doc) {
  console.log('extractChatPageResumeContentCommon');
  const resumeDetail = doc.querySelector("div.resume-box");
  if (!resumeDetail) {
    console.warn('未找到简历详情元素');
    return null;
  }
  return resumeDetail;
}

async function extractSearchPageResumeContentCommon(doc) {
  console.log('extractSearchPageResumeContentCommon');
  const resumeDetail = doc.querySelector("div.resume-layout-wrap > div > div.resume-center-side > div");
  if (!resumeDetail) {
    console.warn('未找到简历详情元素');
    return null;
  }
  return resumeDetail;
}

// 关闭所有弹窗（递归搜主文档+所有子iframe，推荐页弹窗在深层iframe内）
async function closeAllResumeDialogs(doc = document) {
  console.log('关闭所有简历弹窗...');
  // 收集所有文档（主文档 + 传入doc + 各自的子iframe，递归5层）
  var allDocs = [document];
  if (doc && doc !== document) allDocs.push(doc);
  function collectDocs(root, depth) {
    if (!root || !root.querySelectorAll || depth > 5) return;
    try {
      var ifs = root.querySelectorAll('iframe');
      for (var i = 0; i < ifs.length; i++) {
        try {
          var fd = ifs[i].contentDocument;
          if (fd && allDocs.indexOf(fd) === -1) { allDocs.push(fd); collectDocs(fd, depth + 1); }
        } catch(e) {}
      }
    } catch(e) {}
  }
  collectDocs(document, 0);
  if (doc && doc !== document) collectDocs(doc, 0);

  var closed = 0;
  for (var d = 0; d < allDocs.length; d++) {
    var dd = allDocs[d];
    if (!dd || !dd.querySelectorAll) continue;
    var btns = dd.querySelectorAll(
      '.boss-dialog__wrapper.dialog-lib-resume .dialog-close, ' +
      '.boss-dialog__wrapper .dialog-close, ' +
      '.boss-dialog__wrapper .boss-popup__close, ' +
      '.boss-popup__close, ' +
      '.boss-popup__wrapper .iboss-close, ' +
      '.boss-popup__wrapper .close, ' +
      '.new-resume-online-main-ui .close-btn, ' +
      '.resume-common-wrap .close'
    );
    for (var b = 0; b < btns.length; b++) {
      if (btns[b].offsetParent) { btns[b].click(); closed++; }
    }
  }
  if (closed > 0) {
    await new Promise(function(r) { setTimeout(r, 600); });
    console.log('已关闭 ' + closed + ' 个弹窗');
  }
}

// ★ 强力关闭简历弹窗并验证真的关掉了
//   （只关真正的简历弹窗容器内的 close 按钮，不碰推荐列表卡片的 .iboss-close）
async function forceCloseResumeDialog(docs, maxRounds) {
  maxRounds = maxRounds || 5;
  // 收集所有相关文档（含子 iframe）
  var allDocs = [];
  function collect(root, depth) {
    if (!root || !root.querySelectorAll || depth > 5 || allDocs.indexOf(root) !== -1) return;
    allDocs.push(root);
    try {
      var ifs = root.querySelectorAll('iframe');
      for (var i = 0; i < ifs.length; i++) {
        try { var fd = ifs[i].contentDocument; if (fd) collect(fd, depth + 1); } catch(e) {}
      }
    } catch(e) {}
  }
  var seedList = Array.isArray(docs) ? docs : [docs || document];
  seedList.push(document);
  for (var s = 0; s < seedList.length; s++) collect(seedList[s], 0);

  // 找包含简历内容的弹窗容器
  function getResumeDialogs(dd) {
    if (!dd || !dd.querySelectorAll) return [];
    var all = dd.querySelectorAll('.boss-dialog__wrapper.dialog-lib-resume, .resume-common-dialog, .boss-dialog__wrapper, .boss-popup__wrapper');
    return Array.from(all).filter(function(el) {
      return el.querySelector && el.querySelector('.resume-detail-wrap, .resume-center-side, iframe[src*="c-resume"]');
    });
  }

  for (var round = 0; round < maxRounds; round++) {
    var anyOpen = false;
    for (var d = 0; d < allDocs.length; d++) {
      var dd = allDocs[d];
      var dlgs = getResumeDialogs(dd);
      if (dlgs.length === 0) continue;
      anyOpen = true;
      for (var j = 0; j < dlgs.length; j++) {
        // 只点弹窗容器内部的关闭按钮（限定在 container 范围内搜索，避免误杀推荐卡片的 .iboss-close）
        var container = dlgs[j];
        var btn = container.querySelector('.dialog-close, .boss-popup__close, .boss-popup__wrapper .iboss-close, .boss-popup__wrapper .close, .iboss-close, .new-resume-online-main-ui .close-btn, .resume-common-wrap .close');
        if (btn && btn.offsetParent !== null) { try { btn.click(); } catch(e) {} }
        // ESC 兜底
        try { container.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true })); } catch(e) {}
      }
    }
    if (!anyOpen) { console.log('✓ 无简历弹窗'); return true; }
    await new Promise(function(r) { setTimeout(r, 500); });
  }
  // 最后一轮后检查
  for (var dd2 = 0; dd2 < allDocs.length; dd2++) {
    if (getResumeDialogs(allDocs[dd2]).length > 0) {
      console.log('⚠️ 弹窗仍未完全关闭'); return false;
    }
  }
  return true;
}

function isElementVisible(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

// ★ 从已打开的简历弹窗 iframe URL 提取 geek ID（全局唯一人员 ID）
function getOpenedGeekId(doc) {
  try {
    var d = doc || document;
    var iframe = Array.from(d.querySelectorAll('iframe[src*="/web/frame/c-resume/"]')).find(function(f) { return isElementVisible(f); });
    if (!iframe) {
      try {
        var allIfs = d.querySelectorAll("iframe");
        for (var i = 0; i < allIfs.length; i++) {
          try { var fd = allIfs[i].contentDocument; if (fd) { iframe = Array.from(fd.querySelectorAll('iframe[src*="/web/frame/c-resume/"]')).find(function(f) { return isElementVisible(f); }); if (iframe) break; } } catch(e) {}
        }
      } catch(e) {}
    }
    if (iframe) {
      var src = iframe.getAttribute("src") || "";
      var m = src.match(/[?&]geekId=([^&]+)/) || src.match(/[?&]geekid=([^&]+)/i);
      if (m && m[1]) return decodeURIComponent(m[1]);
    }
  } catch(e) {}
  return "";
}

function getOpenedResumeId(doc = document) {
  try {
    const resumeIframe = Array.from(doc.querySelectorAll('iframe[src*="/web/frame/c-resume/"]'))
      .find(frame => isElementVisible(frame));
    if (resumeIframe) {
      const src = resumeIframe.getAttribute('src') || '';
      const match = src.match(/[?&]resumeId=([^&]+)/);
      if (match && match[1]) return decodeURIComponent(match[1]);
    }
  } catch (error) {
    console.warn('提取当前已打开简历ID失败:', error);
  }
  return '';
}

/**
 * 检测简历弹窗是否已打开并就绪
 * @param {Document} doc - 文档对象
 * @param {string} targetResumeId - 目标简历ID（可选）
 * @returns {boolean} 弹窗是否就绪
 */
function isResumeDialogReady(doc = document, targetResumeId = '') {
  try {
    // 1. 查找可见的简历iframe（Canvas渲染的简历会加载到iframe中）
    const visibleResumeIframe = Array.from(doc.querySelectorAll('iframe[src*="/web/frame/c-resume/"]'))
      .find(frame => isElementVisible(frame));
    const hasResumeIframe = !!visibleResumeIframe;

    // 2. 查找简历内容容器
    const resumeWrap = doc.querySelector('.resume-detail-wrap, .resume-layout-wrap, .resume-box');
    // 检查内容容器是否有实际内容（DOM渲染的简历会有内容，Canvas渲染的简历innerText很短）
    const hasResumeContent = !!(resumeWrap && isElementVisible(resumeWrap) && (resumeWrap.innerText || '').trim().length > 20);

    // 3. 查找简历弹窗对话框（含沟通页 .new-chat-resume-dialog / .resume-container，推荐页 .resume-detail-wrap）
    const resumeDialog = doc.querySelector(
      '.boss-dialog__wrapper.dialog-lib-resume, .boss-dialog__wrapper.resume-common-dialog.search-resume, .dialog-lib-resume, ' +
      '.new-chat-resume-dialog-main-ui, .resume-common-dialog, .resume-detail-chat, .resume-detail-wrap, .boss-popup__wrapper.boss-dialog'
    );
    const hasResumeDialog = !!(resumeDialog && isElementVisible(resumeDialog));

    // 4. 判断弹窗是否就绪（任一条件满足即可）
    const baseReady = hasResumeIframe || hasResumeContent || hasResumeDialog;
    if (!baseReady) return false;

    // 5. 如果没有指定目标简历ID，只要弹窗存在就返回true
    if (!targetResumeId) return true;

    // 6. 尝试从URL中提取resumeId进行匹配
    const openedResumeId = getOpenedResumeId(doc);
    if (openedResumeId) {
      return openedResumeId === targetResumeId;
    }

    // 7. 如果无法从URL提取resumeId（搜索页面Canvas简历的情况）
    // 检测是否为Canvas简历：iframe存在但innerText很短（因为内容在Canvas里）
    const isCanvasResume = hasResumeIframe && !hasResumeContent;

    if (isCanvasResume) {
      // Canvas简历：URL中没有resumeId参数，只要弹窗存在且可见就认为打开成功
      // 这是因为搜索页面的Canvas简历URL类似 /web/frame/c-resume/?source=search，没有resumeId参数
      console.log('[isResumeDialogReady] 检测到Canvas简历，只要弹窗存在即认为就绪');
      return hasResumeDialog;
    }

    // 8. 非Canvas页面：需要同时满足有内容和弹窗才认为就绪
    return hasResumeContent && hasResumeDialog;
  } catch (error) {
    console.warn('检测简历弹窗就绪状态失败:', error);
    return false;
  }
}

// 检测付费墙弹窗（权益不足等）
function detectPaywallPopup(doc = document) {
  try {
    // 查找包含"查看权益不足"的弹窗
    const paywallDialogs = doc.querySelectorAll('.business-block-wrap, .business-v2-wrap, .business-v4-city-wrap');
    for (const dialog of paywallDialogs) {
      const dialogText = dialog.innerText || '';
      if (dialogText.includes('查看权益不足') || dialogText.includes('权益不足')) {
        console.log('检测到付费墙弹窗（权益不足），需要停止分析');
        return true;
      }
    }

    // 也检查其他可能的付费弹窗
    const allDialogs = doc.querySelectorAll('.boss-dialog__wrapper, .dialog-container, .boss-popup__wrapper');
    for (const dialog of allDialogs) {
      const dialogText = (dialog.innerText || '').trim();
      // 检查是否是付费相关弹窗
      if (/查看权益不足|购买.*VIP|开通会员|立即付费/.test(dialogText)) {
        // 确认不是普通关闭按钮的简单弹窗
        const hasPayContent = dialog.querySelector('.pre-order-info, .pay-qrcode, .business-block-content');
        if (hasPayContent) {
          console.log('检测到付费墙弹窗，需要停止分析');
          return true;
        }
      }
    }

    return false;
  } catch (error) {
    console.warn('检测付费墙弹窗失败:', error);
    return false;
  }
}

async function closeInterferingPopups(doc = document) {
  try {
    const dialogs = Array.from(doc.querySelectorAll('.boss-dialog__wrapper, .dialog-container, .boss-popup__wrapper'));
    let closedCount = 0;
    for (const dialog of dialogs) {
      const isResumeDialog = !!dialog.querySelector('.resume-detail-wrap, .resume-layout-wrap, iframe[src*="/web/frame/c-resume/"]')
        || dialog.classList.contains('dialog-lib-resume')
        || dialog.className.includes('search-resume');
      if (isResumeDialog) continue;

      const closeBtn = dialog.querySelector('.dialog-close, .boss-popup__close, .icon-close, .btn-close, [aria-label="关闭"]');
      const dialogText = (dialog.innerText || '').trim();
      const isRightsDialog = /权益不足|开聊权益|解锁|开通会员|购买权益/.test(dialogText);
      if (closeBtn && typeof closeBtn.click === 'function') {
        closeBtn.click();
        closedCount++;
        await new Promise(resolve => setTimeout(resolve, 80));
      } else if (isRightsDialog) {
        // 某些权益弹窗无显式关闭按钮，尝试 Esc 关闭
        dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        closedCount++;
        await new Promise(resolve => setTimeout(resolve, 80));
      }
    }
    if (closedCount > 0) {
      console.log(`已关闭 ${closedCount} 个干扰弹窗`);
    }
  } catch (error) {
    console.warn('清理干扰弹窗时出错:', error);
  }
}

async function waitForResumeDetailReady(doc = document, timeout = 12000, targetResumeId = '') {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    if (!isAnalyzing) throw new Error('用户中断操作');

    // 持续清理非简历弹窗，避免遮挡导致截到列表页
    await closeInterferingPopups(doc);

    if (isResumeDialogReady(doc, targetResumeId)) {
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('等待简历详情弹窗超时');
}

// 向页面添加样式
function injectAnalysisStyles() {
  if (document.getElementById('ai-analysis-styles')) return;

  const style = document.createElement('style');
  style.id = 'ai-analysis-styles';
  style.textContent = `
    .ai-analysis-status {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
      animation: fadeIn 0.3s ease;
      backdrop-filter: blur(5px);
      transition: all 0.3s ease;
    }
    
    .ai-analysis-status div, .ai-analysis-status pre {
      margin-bottom: 6px;
      word-break: break-word;
      position: relative;
    }
    
    .ai-analysis-status button {
      opacity: 0.7;
      transition: opacity 0.2s;
    }
    
    .ai-analysis-status button:hover {
      opacity: 1;
    }
    
    .thinking-container {
      border-left: 3px solid #4a90e2;
      padding-left: 10px;
      background-color: rgba(74, 144, 226, 0.1);
      border-radius: 0 4px 4px 0;
      margin-bottom: 15px;
      max-height: 200px;
      overflow-y: auto;
    }
    
    .status-complete {
      animation: pulse 1s ease;
      font-weight: bold;
      border-top: 1px solid rgba(255, 255, 255, 0.2);
      padding-top: 8px;
      margin-top: 8px;
    }
    
    .status-error {
      animation: shake 0.5s ease;
      color: #ff6b6b !important;
      border-top: 1px solid rgba(255, 107, 107, 0.3);
      padding-top: 8px;
      margin-top: 8px;
    }
    
    .status-thinking {
      color: #e6e6e6;
      font-size: 13px;
      line-height: 1.6;
      white-space: pre-wrap;
    }
    
    .typing-content {
      position: relative;
      display: block;
    }
    
    .typing-content::after {
      content: '|';
      position: absolute;
      right: -2px;
      animation: blink-caret 0.75s step-end infinite;
    }
    
    /* 添加分隔线样式 */
    .resume-separator {
      height: 1px;
      background: linear-gradient(to right, transparent, rgba(255, 255, 255, 0.3), transparent);
      margin: 12px 0;
    }
    
    /* 添加最小化/最大化动画 */
    .ai-analysis-status.minimized {
      height: auto !important;
      max-height: 40px !important;
      overflow: hidden;
    }
    
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }
    
    @keyframes fadeInLeft {
      from { opacity: 0; transform: translateX(-10px); }
      to { opacity: 1; transform: translateX(0); }
    }
    
    @keyframes pulse {
      0% { transform: scale(1); }
      50% { transform: scale(1.05); }
      100% { transform: scale(1); }
    }
    
    @keyframes shake {
      0%, 100% { transform: translateX(0); }
      20%, 60% { transform: translateX(-5px); }
      40%, 80% { transform: translateX(5px); }
    }
    
    @keyframes blink-caret {
      from, to { color: transparent; }
      50% { color: #4a90e2; }
    }
  `;

  document.head.appendChild(style);
}

// 修改初始化代码，添加样式注入
// 这段代码应该放在页面加载或者扩展初始化的地方
function initializeResumeAnalysis() {
  // 注入样式
  injectAnalysisStyles();

  // 其他初始化代码...
}

// 在文件结尾调用初始化
document.addEventListener('DOMContentLoaded', initializeResumeAnalysis);

// 确保初始化被调用
initializeResumeAnalysis();

// 下载HTML结果函数
function downloadResults() {
  console.log('开始下载HTML结果');
  chrome.storage.sync.get(['scoreThreshold'], ({ scoreThreshold = 80 }) => {
    // 对分析结果进行排序（按分数从高到低）
    const sortedResults = [...window.resumeManager.analysisResults].sort((a, b) => {
      const scoreA = a.evaluation?.score || 0;
      const scoreB = b.evaluation?.score || 0;
      return scoreB - scoreA;
    });

    // 准备HTML内容
    const htmlContent = sortedResults.map(result => {
      const latestWork = result.workExperiences?.[0] || {};
      const score = result.evaluation?.score || 0;
      const isQualified = score >= scoreThreshold;

      return `
        <div class="resume-item">
          <div class="resume-header">
            <div class="resume-name">${result.name || '未知'}</div>
            <div class="resume-gender">${result.gender || '未知'}</div>
            <div class="resume-age">${result.age || '未知'}</div>
            <div class="resume-experience">${result.experience || '未知'}</div>
            <div class="resume-education">${result.education || '未知'}</div>
            <div class="resume-job-status">${result.jobStatus || '未知'}</div>
          </div>
          <div class="resume-expect">
            <div class="resume-expect-location">${result.expectInfo?.location || '未知'}</div>
            <div class="resume-expect-position">${result.expectInfo?.position || '未知'}</div>
            <div class="resume-expect-salary">${result.expectInfo?.salary || '未知'}</div>
          </div>
          <div class="resume-latest-work">
            <div class="resume-latest-company">${latestWork.company || '未知'}</div>
            <div class="resume-latest-position">${latestWork.position || '未知'}</div>
          </div>
          <div class="resume-evaluation">
            <div class="resume-score">${score}</div>
            <div class="resume-is-qualified">${isQualified ? '是' : '否'}</div>
            <div class="resume-suggestion">${result.evaluation?.suggestion || '无'}</div>
          </div>
          <div class="resume-share">
            <a href="${result.shareLink || '#'}" target="_blank">${result.shareLink || '无'}</a>
          </div>
          <div class="resume-timestamp">${new Date(result.timestamp).toLocaleString()}</div>
          <div class="resume-thinking-process">${result.evaluation?.thinkingProcess || '无记录'}</div>
        </div>
        <div class="resume-separator"></div>
      `;
    }).join('');

    // 生成HTML文件
    const blob = new Blob([htmlContent], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `AI简历分析结果_${new Date().toLocaleDateString()}.html`;

    console.log('触发HTML下载');
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });
}

// 确保生成唯一的简历ID
function generateUniqueResumeId(resumeData) {
  // 使用多个字段组合生成唯一标识
  const nameStr = resumeData.name || '';
  const genderStr = resumeData.gender || '';
  const expStr = resumeData.experience || '';
  const eduStr = resumeData.education || '';

  // 使用部分工作经历信息增加唯一性
  let workStr = '';
  if (resumeData.workExperiences && resumeData.workExperiences.length > 0) {
    const latestWork = resumeData.workExperiences[0];
    workStr = `${latestWork.company || ''}_${latestWork.position || ''}`;
  }

  // 结合时间戳创建唯一ID
  const uniqueStr = `${nameStr}_${genderStr}_${expStr}_${eduStr}_${workStr}_${Date.now()}`;
  return btoa(encodeURIComponent(uniqueStr)).replace(/[^a-zA-Z0-9]/g, '');
}

// 检查是否为重复简历
function isDuplicateResume(newResume) {
  // 已分析的结果
  const existingResults = window.resumeManager.analysisResults || [];

  for (const existingResume of existingResults) {
    // 比对关键字段
    if (
      newResume.name === existingResume.name &&
      newResume.gender === existingResume.gender &&
      newResume.experience === existingResume.experience &&
      newResume.education === existingResume.education
    ) {
      // 进一步比对工作经历第一项
      const newWork = newResume.workExperiences?.[0] || {};
      const existingWork = existingResume.workExperiences?.[0] || {};

      if (newWork.company === existingWork.company &&
        newWork.position === existingWork.position) {
        console.log('检测到重复简历:', newResume.name);
        return true;
      }
    }
  }

  return false;
}

// 等待任意一个卡片列表出现
async function waitForAnyCardList(iframeDoc, maxWaitTime = 10000) {
  console.log('等待任意卡片列表加载...');
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitTime) {
    // 检查两种可能的卡片列表选择器
    const cardList = iframeDoc.querySelector('#recommend-list .card-list');
    const recommendCardList = iframeDoc.querySelector('#recommend-list .recommend-card-list');

    if (cardList || recommendCardList) {
      const foundElement = cardList || recommendCardList;
      console.log('找到卡片列表:', foundElement.className);
      return foundElement;
    }

    // 等待100ms后再次检查
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  console.warn('等待卡片列表超时');
  throw new Error('等待卡片列表超时 - 未找到 .card-list 或 .recommend-card-list');
}

// 提取新版卡片(.new-geek-wrap)内的基本信息
function extractNewGeekCardInfo(cardInner) {
  try {
    console.log('提取新版简历卡片信息');

    if (!cardInner || !cardInner.classList.contains('new-geek-wrap')) {
      console.warn('传入的元素不是有效的新版简历卡片');
      return { resumeId: null };
    }

    // 获取卡片中的基本数据
    const result = {
      // 从data-geek属性提取唯一ID
      resumeId: cardInner.getAttribute('data-geek') || null,

      // 姓名
      name: cardInner.querySelector('.name')?.textContent?.trim() || '未知',

      // 性别 (查找男性或女性图标)
      gender: cardInner.querySelector('.iboss-icon_man') ? '男' :
        cardInner.querySelector('.iboss-icon_women') ? '女' : '未知',

      // 活跃状态
      activeStatus: cardInner.querySelector('.active-text')?.textContent?.trim() || '',

      // 薪资期望
      salary: cardInner.querySelector('.salary-wrap')?.textContent?.trim() || '',

      // 从第一行基本信息中提取年龄、工作经验、学历和求职状态
      baseInfo: {},

      // 期望信息
      expectInfo: {
        location: '',
        position: '',
        salary: ''
      },

      // 当前/最近工作
      currentWork: {
        company: '',
        position: '',
        period: ''
      },

      // 工作经历列表
      workHistory: [],

      // 教育经历
      education: {
        school: '',
        major: '',
        degree: '',
        period: ''
      }
    };

    // 解析基本信息行(年龄、工作经验、学历、求职状态)
    const baseInfoText = cardInner.querySelector('.base-info')?.textContent?.trim() || '';
    const baseInfoParts = baseInfoText.split(/·|\s*-\s*|\s+/).filter(item => item && item !== '离职' && !item.includes('line'));

    if (baseInfoParts.length >= 1) result.age = baseInfoParts[0];
    if (baseInfoParts.length >= 2) result.experience = baseInfoParts[1];
    if (baseInfoParts.length >= 3) result.education = baseInfoParts[2];
    if (baseInfoParts.length >= 4) result.jobStatus = baseInfoParts.slice(3).join('-');

    // 解析期望信息
    const expectRow = cardInner.querySelector('.row-flex');
    if (expectRow) {
      const expectContent = expectRow.querySelector('.content')?.textContent?.trim() || '';
      const expectParts = expectContent.split(/·|\s+/).filter(item => item && !item.includes('dot'));

      if (expectParts.length >= 1) result.expectInfo.location = expectParts[0];
      if (expectParts.length >= 2) result.expectInfo.position = expectParts[1];

      // 已经从卡片顶部获取了薪资期望
      result.expectInfo.salary = result.salary;
    }

    // 解析当前工作信息
    const latelyWork = cardInner.querySelector('.lately-work');
    if (latelyWork) {
      const workContent = latelyWork.querySelector('.content')?.textContent?.trim() || '';
      const workParts = workContent.split(/·|\s+/).filter(item => item && !item.includes('dot'));

      if (workParts.length >= 1) result.currentWork.company = workParts[0];
      if (workParts.length >= 2) result.currentWork.position = workParts[1];

      // 尝试获取时间段
      const timeItems = cardInner.querySelectorAll('.work-exps .timeline-item');
      if (timeItems && timeItems.length > 0) {
        const firstTimeItem = timeItems[0];
        result.currentWork.period = firstTimeItem.querySelector('.time')?.textContent?.trim() || '';
      }
    }

    // 解析工作经历
    const workItems = cardInner.querySelectorAll('.work-exps .timeline-item');
    if (workItems && workItems.length > 0) {
      Array.from(workItems).forEach(item => {
        const timePeriod = item.querySelector('.time')?.textContent?.trim() || '';
        const contentText = item.querySelector('.content')?.textContent?.trim() || '';
        const contentParts = contentText.split(/·|\s+/).filter(item => item && !item.includes('dot'));

        const workItem = {
          period: timePeriod,
          company: contentParts[0] || '',
          position: contentParts[1] || ''
        };

        result.workHistory.push(workItem);
      });
    }

    // 解析教育经历
    const eduItems = cardInner.querySelectorAll('.edu-exps .timeline-item');
    if (eduItems && eduItems.length > 0) {
      const firstEduItem = eduItems[0];
      const timePeriod = firstEduItem.querySelector('.time')?.textContent?.trim() || '';
      const contentText = firstEduItem.querySelector('.content')?.textContent?.trim() || '';
      const contentParts = contentText.split(/·|\s+/).filter(item => item && !item.includes('dot'));

      if (contentParts.length >= 1) result.education.school = contentParts[0] || '';
      if (contentParts.length >= 2) result.education.major = contentParts[1] || '';
      if (contentParts.length >= 3) result.education.degree = contentParts[2] || '';
      result.education.period = timePeriod;
    }

    // 如果没有提取到resumeId，生成一个基于可用信息的ID
    if (!result.resumeId) {
      const idBase = `${result.name}_${result.gender}_${result.experience}_${result.education}_${result.currentWork.company}`;
      result.resumeId = window.btoa(encodeURIComponent(idBase)).replace(/[^a-zA-Z0-9]/g, '');
    }

    console.log('提取的新版简历卡片信息:', result);
    return result;

  } catch (error) {
    console.error('提取新版简历卡片信息出错:', error);
    return { resumeId: null };
  }
}

async function extractNewRecommendPageResumeContent(doc, resumeId) {
  try {
    // 等待简历详情加载完成（最多等待10秒）
    const startTime = Date.now();
    let resumeDetail = null;

    while (!resumeDetail && Date.now() - startTime < 10000) {
      try {
        resumeDetail = doc.querySelector(".resume-item-content");
      } catch (e) {
        console.warn('查找简历详情元素时出错:', e);
      }

      if (!resumeDetail) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    if (!resumeDetail) {
      console.warn('无法获取简历数据，返回空对象');
      return {
        resumeId,
        name: '',
        gender: '',
        age: null,
        experience: '',
        education: '',
        jobStatus: '',
        expectInfo: { location: '', position: '', salary: '', industry: '' },
        workExperiences: [],
        projectExperiences: [],
        educationInfo: { school: '', major: '', degree: '', period: '', experience: '' },
        selfDescription: '',
        timestamp: new Date().toISOString()
      };
    }

    // 提取基本信息
    let baseInfo = {};
    try {
      const baseInfoItem = resumeDetail.querySelector('.resume-item.item-base');
      if (baseInfoItem) {
        // 提取姓名和性别
        const nameElement = baseInfoItem.querySelector('.geek-name');
        const name = nameElement ? nameElement.textContent.trim() : '';

        // 判断性别
        const genderMale = baseInfoItem.querySelector('[class^="iboss-icon_man"]'); // 以iboss-icon_man开头的类
        const genderFemale = baseInfoItem.querySelector('[class^="iboss-icon_women"]'); // 以iboss-icon_women开头的类
        const gender = genderMale ? '男' : (genderFemale ? '女' : '');

        // 提取活跃状态
        const activeElement = baseInfoItem.querySelector('.text-orange');
        const activeStatus = activeElement ? activeElement.textContent.trim() : '';

        // 提取自我描述
        const descElement = baseInfoItem.querySelector('.text.selfDescription');
        const selfDescription = descElement ? descElement.textContent.trim() : '';

        baseInfo = {
          name,
          gender,
          isElite: false, // 在新DOM中可能需要查找精英标识
          activeStatus,
          selfDescription
        };

        console.log('提取基本信息成功:', baseInfo);
      }
    } catch (e) {
      console.warn('提取基本信息时出错:', e);
      baseInfo = {
        name: '',
        gender: '',
        isElite: false,
        activeStatus: '',
        selfDescription: ''
      };
    }

    // 提取年龄、经验、学历、求职状态
    let age = null, experience = '', education = '', jobStatus = '';
    try {
      const infoLabels = resumeDetail.querySelectorAll('.info-labels .label-text');
      if (infoLabels && infoLabels.length > 0) {
        for (let i = 0; i < infoLabels.length; i++) {
          const labelText = infoLabels[i].textContent.trim();

          // 提取年龄
          if (i === 0 && labelText.includes('岁')) {
            const ageMatch = labelText.match(/(\d+)岁/);
            if (ageMatch) {
              age = parseInt(ageMatch[1]);
            }
          }

          // 提取工作经验
          if (i === 1) {
            experience = labelText.trim();
          }

          // 提取学历
          if (i === 2) {
            education = labelText.trim();
          }

          // 提取求职状态
          if (i === 3) {
            jobStatus = labelText.trim();
          }
        }
      }
    } catch (e) {
      console.warn('提取标签信息时出错:', e);
    }

    // 提取岗位经验
    let positionExperience = '';
    try {
      const stationItem = resumeDetail.querySelector('.resume-item.resume-station');
      if (stationItem) {
        const expTag = stationItem.querySelector('.tags span');
        if (expTag) {
          positionExperience = expTag.textContent.trim();
        }
      }
    } catch (e) {
      console.warn('提取岗位经验时出错:', e);
    }

    // 提取期望职位信息
    let expectInfo = { location: '', position: '', salary: '', industry: '' };
    try {
      const expectItem = Array.from(resumeDetail.querySelectorAll('.resume-item')).find(
        item => item.querySelector('h3.title') && item.querySelector('h3.title').textContent.trim() === '期望职位'
      );

      if (expectItem) {
        const expectLabels = expectItem.querySelectorAll('.info-labels .label-text');
        if (expectLabels.length >= 1) expectInfo.location = expectLabels[0].textContent.trim();
        if (expectLabels.length >= 2) expectInfo.position = expectLabels[1].textContent.trim();
        if (expectLabels.length >= 3) expectInfo.industry = expectLabels[2].textContent.trim();
        if (expectLabels.length >= 4) expectInfo.salary = expectLabels[3].textContent.trim();
      }
      console.log('提取期望职位信息成功:', expectInfo);
    } catch (error) {
      console.warn('提取期望职位信息失败:', error);
    }

    // 提取工作经历
    let workExperiences = [];
    try {
      const workItem = Array.from(resumeDetail.querySelectorAll('.resume-item')).find(
        item => item.querySelector('h3.title') && item.querySelector('h3.title').textContent.trim() === '工作经历'
      );

      if (workItem) {
        const historyItems = workItem.querySelectorAll('.history-item');
        workExperiences = Array.from(historyItems).map(item => {
          try {
            // 获取工作时间段
            const period = item.querySelector('.period')?.textContent?.trim() || '';

            // 获取公司名称和职位
            const nameElement = item.querySelector('h4.name');
            let company = '', position = '', department = '';

            if (nameElement) {
              const companyElement = nameElement.querySelector('.helper-text');
              if (companyElement) {
                company = companyElement.textContent.trim();
              }

              // 获取职位信息
              const positionSpan = nameElement.querySelector('span');
              if (positionSpan) {
                position = positionSpan.textContent.trim();
              }
            }

            // 获取工作内容描述
            const contentElement = item.querySelector('.item-text .text');
            const content = contentElement ? contentElement.textContent.trim() : '';

            // 获取技能标签
            const tagElements = item.querySelectorAll('.tags span');
            const skills = Array.from(tagElements).map(tag => tag.textContent.trim()).filter(Boolean);

            // 判断是否为实习经历
            const isInternship = false; // 新DOM中可能需要其他方式判断

            return {
              company,
              position,
              department,
              period,
              content,
              isInternship,
              skills
            };
          } catch (e) {
            console.warn('提取单个工作经历时出错:', e);
            return null;
          }
        }).filter(Boolean);
      }
      console.log(`提取工作经历成功，共${workExperiences.length}条`);
    } catch (error) {
      console.warn('提取工作经历失败:', error);
    }

    // 提取教育经历
    let educationInfo = { school: '', major: '', degree: '', period: '', experience: '' };
    try {
      const eduItem = Array.from(resumeDetail.querySelectorAll('.resume-item')).find(
        item => item.querySelector('h3.title') && item.querySelector('h3.title').textContent.trim() === '教育经历'
      );

      if (eduItem) {
        const historyItem = eduItem.querySelector('.history-item');
        if (historyItem) {
          // 获取学习时间段
          const periodElement = historyItem.querySelector('.period');
          const period = periodElement ? periodElement.textContent.trim() : '';

          // 获取学校、专业和学位
          const schoolNameElement = historyItem.querySelector('.school-info .name b');
          const school = schoolNameElement ? schoolNameElement.textContent.trim() : '';

          const majorElement = historyItem.querySelector('.school-info .name .major');
          const major = majorElement ? majorElement.textContent.trim() : '';

          // 获取学位
          const degreeText = historyItem.querySelector('.school-info .name')?.textContent || '';
          let degree = '';
          if (degreeText.includes('本科')) {
            degree = '本科';
          } else if (degreeText.includes('硕士')) {
            degree = '硕士';
          } else if (degreeText.includes('博士')) {
            degree = '博士';
          } else if (degreeText.includes('专科')) {
            degree = '专科';
          }

          // 获取在校经历
          const expContent = historyItem.querySelector('.school-item .content');
          const experience = expContent ? expContent.textContent.trim() : '';

          educationInfo = {
            school,
            major,
            degree,
            period,
            experience
          };
        }
      }
      console.log('提取教育经历成功:', educationInfo);
    } catch (error) {
      console.warn('提取教育经历失败:', error);
    }

    // 提取社团经历（作为项目经验的一部分）
    let projectExperiences = [];
    try {
      const clubSection = resumeDetail.querySelector('.resume-section.geek-club-experience-wrap');
      if (clubSection) {
        const clubWraps = clubSection.querySelectorAll('.club-wrap');
        projectExperiences = Array.from(clubWraps).map(club => {
          try {
            const nameWrap = club.querySelector('.name-wrap');
            let name = '', role = '';

            if (nameWrap) {
              const nameText = nameWrap.querySelector('.name')?.textContent || '';
              const nameParts = nameText.split(/\s*\n\s*/).map(p => p.trim()).filter(Boolean);
              if (nameParts.length >= 1) name = nameParts[0];
              if (nameParts.length >= 2) role = nameParts[1];
            }

            const period = nameWrap?.querySelector('.period')?.textContent?.trim() || '';
            const content = club.querySelector('.item-content')?.textContent?.trim() || '';

            return {
              name,
              role,
              period,
              content,
              performance: '' // 社团经历中通常没有业绩描述
            };
          } catch (e) {
            console.warn('提取单个社团经历时出错:', e);
            return null;
          }
        }).filter(Boolean);
      }
      console.log(`提取社团经历成功，共${projectExperiences.length}条`);
    } catch (error) {
      console.warn('提取社团经历失败:', error);
    }

    // 组装最终结果
    const content = {
      resumeId,
      ...baseInfo,
      age,
      experience: positionExperience || experience,
      education: educationInfo.degree || education,
      jobStatus,
      expectInfo,
      workExperiences,
      projectExperiences,
      educationInfo,
      selfDescription: baseInfo.selfDescription || '',
      timestamp: new Date().toISOString()
    };

    console.log('成功提取简历内容:', content);
    return content;
  } catch (error) {
    console.error('提取简历内容时发生错误:', error);
    // 即使发生错误，也返回一个包含基本信息的对象
    return {
      resumeId,
      name: '',
      gender: '',
      age: null,
      experience: '',
      education: '',
      jobStatus: '',
      expectInfo: { location: '', position: '', salary: '', industry: '' },
      workExperiences: [],
      projectExperiences: [],
      educationInfo: { school: '', major: '', degree: '', period: '', experience: '' },
      selfDescription: '',
      timestamp: new Date().toISOString(),
      error: error.message
    };
  }
}

// 已废弃：统一采用截图 AI识别，不再执行 Canvas 文本提取链路
async function extractResumeCanvas() {
  return '';
}
// 截图并裁剪简历区域
async function captureAndCropResume(iframeRect, resumeRect) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({
      action: 'captureVisibleTab'
    }, response => {
      if (!response || !response.success) {
        return reject(new Error('截图失败'));
      }

      // 创建一个新的图像对象
      const img = new Image();
      img.onload = function () {
        try {
          // 创建Canvas用于裁剪
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d');

          // 计算简历在整个页面中的位置
          const x = iframeRect.left + resumeRect.left;
          const y = iframeRect.top + resumeRect.top;
          const width = resumeRect.width;
          const height = resumeRect.height;

          // 设置Canvas尺寸
          canvas.width = width;
          canvas.height = height;

          // 裁剪图像
          ctx.drawImage(img, x, y, width, height, 0, 0, width, height);

          // 获取裁剪后的图像数据
          const croppedDataURL = canvas.toDataURL('image/png');
          resolve(croppedDataURL);
        } catch (e) {
          reject(e);
        }
      };

      img.onerror = function () {
        reject(new Error('加载截图失败'));
      };

      // 设置图像源
      img.src = response.imageData;
    });
  });
}

/**
 * 视觉识别主体函数 (Vision Fallback)
 * 支持发送多张截图以覆盖完整简历内容
 */
async function performVisionExtraction(doc, resumeId, apiMode, customApiConfig = null) {
  console.log('[Vision] 使用 AI识别 识别');
  try {
    const imageList = await captureFullResumeScreenshot(doc);
    if (!imageList || imageList.length === 0) throw new Error('无法生成简历截图');
    return await callOfficialOcrService(imageList);
  } catch (error) {
    console.error('[Vision] 识别失败:', error);
    throw error;
  }
}

/**
 * 使用 Chrome 扩展 API 截取整个页面（绕过 tainted canvas 限制）
 */
async function captureVisibleTab() {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action: 'captureVisibleTab' }, response => {
      if (response && response.success) {
        resolve(response.imageData);
      } else {
        reject(new Error(response?.error || '截图失败'));
      }
    });
  });
}

/**
 * 直接截取整个可见区域（绕过 tainted canvas）
 * 这个函数使用 chrome.tabs.captureVisibleTab API，可以绕过 iframe 的 tainted canvas 限制
 */
async function captureFullPageScreenshot() {
  console.log('[Vision] 使用扩展 API 截取整个页面...');
  
  try {
    const dataUrl = await captureVisibleTab();
    if (!dataUrl) {
      throw new Error('未获取到截图数据');
    }
    console.log('[Vision] 页面截图成功，数据长度:', dataUrl.length);
    return dataUrl;
  } catch (e) {
    console.error('[Vision] 页面截图失败:', e);
    return null;
  }
}

/**
 * 截取多段简历截图以覆盖全量内容
 */
async function captureFullResumeScreenshot(doc) {
  console.log('[Vision] 准备截取全量长图...');

  // 兼容多种 doc 形态：Document / Window / iframe 元素
  try {
    if (doc && doc.tagName === 'IFRAME' && doc.contentDocument) {
      // 传入的是 iframe 元素，使用其文档
      doc = doc.contentDocument;
    } else if (doc && doc.document && !doc.querySelector) {
      // 传入的是 window 对象，使用其 document
      doc = doc.document;
    }
  } catch (e) {
    console.warn('[Vision] 规范化文档对象失败，回退到顶层 document:', e);
    doc = document;
  }

  if (!doc || typeof doc.querySelector !== 'function') {
    doc = document;
  }

  // 支持多层 iframe 的滚动容器查找（限制递归深度防止极端嵌套）
  // 优先搜传入的 doc（推荐/沟通页传的是 iframeDoc）+ 主文档的 iframe 递归
  function findScrollContainer(rootDoc, depth = 0) {
    if (!rootDoc || depth > 3) return null;
    // 首次调用时也搜 doc（传入的文档）+ 主文档的 iframe
    if (depth === 0) {
      // 先搜当前 doc 内部
      var found = findScrollContainer(doc, 4);
      if (found) return found;
      // 再搜主文档内部（覆盖搜索页弹窗）
      found = findScrollContainer(document, 4);
      if (found) return found;
    }

    const selectors = [
      '.resume-detail-wrap',
      '.resume-detail-chat',
      '.resume-common-wrap',
      '.resume-center-side',
      '.resume-detail-main',
      '.resume-content',
      '.resume-detail-content',
      '.iframe-resume-detail'
    ];

    for (const selector of selectors) {
      const el = rootDoc.querySelector(selector);
      if (el) return el;
    }

    const iframes = rootDoc.querySelectorAll('iframe');
    for (const iframe of iframes) {
      try {
        const iframeDoc = iframe.contentDocument || (iframe.contentWindow && iframe.contentWindow.document);
        if (!iframeDoc) continue;
        const found = findScrollContainer(iframeDoc, depth + 1);
        if (found) return found;
      } catch (e) {
        console.warn('[Vision] 访问 iframe 时出错，跳过该节点:', e);
      }
    }

    return null;
  }

  // 查找简历滚动容器
  const scrollContainer = findScrollContainer(doc);

  if (!scrollContainer) {
    console.warn('[Vision] 未找到简历滚动容器，尝试直接截取页面');
    try {
      const screenshot = await captureFullPageScreenshot();
      if (screenshot) {
        console.log('[Vision] 截图成功');
        return [screenshot];
      }
    } catch (e) {
      console.error('[Vision] 截屏失败:', e);
    }
    return [];
  }

  // ===== 真实滚动截图 + 按内容坐标无缝拼接（修正 DPR / 重叠 / 滚不动）=====
  const dpr = window.devicePixelRatio || 1;   // Windows 缩放下 captureVisibleTab 是物理像素
  const winH = window.innerHeight;
  const winW = window.innerWidth;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ★ Boss 是堆叠弹窗（关一个显示上一个），DOM 里同时有多个简历弹窗！
  // 必须定位"当前激活"的那个（z-index 最高 / DOM 最靠后的可见弹窗），所有元素都从它里面取
  function stackZ(el) {
    let z = 0, p = el;
    while (p && p !== document.body) { const zi = parseInt(getComputedStyle(p).zIndex, 10); if (!isNaN(zi)) z = Math.max(z, zi); p = p.parentElement; }
    return z;
  }
  function pickActive(selector, root) {
    var searchRoot = root || doc || document;
    const els = Array.from(searchRoot.querySelectorAll(selector))
      .filter(el => { const r = el.getBoundingClientRect(); return r.width > 50 && r.height > 50; });
    if (!els.length) return null;
    els.sort((a, b) => stackZ(a) - stackZ(b)); // z-index 升序，最后一个=最上层
    return els[els.length - 1];
  }

  const activeDialog = pickActive('.dialog-lib-resume')
    || pickActive('.lib-standard-resume')
    || pickActive('.resume-common-wrap')
    || doc || document;
  const sc = pickActive('.resume-detail-wrap', activeDialog)
    || activeDialog.querySelector('.resume-detail-wrap')
    || scrollContainer;
  const iframe = (sc.querySelector && sc.querySelector('iframe'))
    || activeDialog.querySelector('.resume-detail-wrap iframe')
    || activeDialog.querySelector('iframe');
  const activeCenterSide = pickActive('.resume-center-side', activeDialog)
    || activeDialog.querySelector('.resume-center-side');

  if (!iframe) {
    console.warn('[Vision] 无 iframe，单张兜底');
    const fp = await captureVisibleTab();
    return fp ? [fp] : [];
  }

  const iframeRect = () => iframe.getBoundingClientRect();

  // ★ 多份简历切换时：先复位滚动容器 + 等 iframe 高度渲染稳定，再算裁剪坐标（否则第2份起坐标错乱）
  const scReset = activeCenterSide;
  if (scReset) {
    scReset.scrollTop = 0;
    scReset.dispatchEvent(new Event('scroll', { bubbles: true }));
    scReset.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true, cancelable: true }));
  }
  // 轮询等 iframe 高度稳定（新简历刚打开时高度会从 0 → 真实值；Boss 复用 DOM 时高度不变，靠 contentDocument ready 兜底）
  let _h = -1, _stable = 0;
  for (let i = 0; i < 25; i++) {
    const h = iframe.offsetHeight || 0;
    if (h > 100 && h === _h) { if (++_stable >= 2) break; } else { _h = h; _stable = 0; }
    await sleep(140);
  }
  // ★ 关键：等 iframe 内容真正加载完成（Boss 复用同一个 iframe DOM 时 offsetHeight 不变，readyState 才可靠）
  for (let i = 0; i < 20; i++) {
    try {
      if (iframe.contentDocument && iframe.contentDocument.readyState === 'complete') break;
    } catch(e) { break; /* 跨域，不等了 */ }
    await sleep(200);
  }
  await sleep(400); // 再等 Vue/canvas 首屏渲染完成

  // 隐藏干扰浮层（"近14天你首次看到该牛人"提示条等 DOM 浮层），避免遮挡简历被 AI识别 误读；finally 还原
  const hiddenBanners = [];
  try {
    const scope = (activeDialog && activeDialog.querySelectorAll) ? activeDialog : document;
    scope.querySelectorAll('div, span, p, a').forEach(el => {
      if (el.querySelector && el.querySelector('*')) return; // 只处理叶子节点，避免隐藏大容器
      const t = (el.innerText || el.textContent || '').trim();
      if (t && t.length < 40 && /首次看到该牛人|赶紧联系\s*TA|近\d+天你首次|使用成功/.test(t)) {
        hiddenBanners.push([el, el.style.visibility]);
        el.style.visibility = 'hidden';
      }
    });
  } catch (e) {}
  if (hiddenBanners.length) await sleep(120);

  // iframe.style.height = 简历真实高度（如 710px），仅作参考
  let resumeHeight = 0;
  if (iframe.style.height) { const m = iframe.style.height.match(/([\d.]+)px/); if (m) resumeHeight = parseFloat(m[1]); }
  if (!resumeHeight) resumeHeight = iframe.offsetHeight || iframeRect().height;

  // 初始裁剪区（仅用于日志和近似值，实际截图在 shotFixed() 里动态重算）
  const _r0 = iframeRect();
  const _cropX = Math.max(0, Math.floor(_r0.left));
  const _cropW = Math.min(Math.ceil(_r0.width), winW - _cropX);
  const _cropTop = Math.max(0, Math.floor(_r0.top));
  const _visibleH = Math.max(0, Math.min(winH, Math.floor(_r0.bottom)) - _cropTop);
  console.log(`[Vision] 简历高:${resumeHeight} dpr:${dpr} winH:${winH} cropX:${_cropX} cropW:${_cropW}`);

  // 选滚动源：已知 .resume-center-side 是 overflow:auto 滚动容器（CSS 确认），用激活弹窗内的那个
  function pickScroller() {
    const known = activeCenterSide;
    if (known && (known.scrollHeight - known.clientHeight) > 20) return known;
    const cands = [sc];
    let p = iframe.parentElement, d = 0;
    while (p && d < 8 && p !== document.body && p !== document.documentElement) {
      if (cands.indexOf(p) < 0) cands.push(p);
      p = p.parentElement; d++;
    }
    let best = known || null, bestRange = 20; // 至少能滚 20px
    for (const c of cands) {
      if (!c || c === document.body || c === document.documentElement) continue;
      const range = c.scrollHeight - c.clientHeight;
      if (range > bestRange) { bestRange = range; best = c; }
    }
    return best;
  }

  // 指纹：取裁剪图中段一小段，判断内容是否变化（识别到底/没滚动）
  function fingerprint(u) { const h = u.length >> 1; return u.slice(h, h + 160); }

  // ★ 每次截图前重新计算裁剪区——裁剪到 resume-center-side（只含简历内容，过滤右侧栏）
  async function shotFixed() {
    // 在传入的 doc + 主文档中搜 resume-center-side（推荐页在子 iframe 内）
    var docRoots = [doc, document];
    var curActive = null;
    for (var di = 0; di < docRoots.length; di++) {
      var d2 = docRoots[di];
      if (!d2 || !d2.querySelector) continue;
      curActive = d2.querySelector('.resume-center-side');
      if (curActive) break;
      // 递归搜子 iframe
      try {
        var ifs2 = d2.querySelectorAll('iframe');
        for (var fj = 0; fj < ifs2.length; fj++) {
          try {
            var fd3 = ifs2[fj].contentDocument;
            if (fd3) { curActive = fd3.querySelector('.resume-center-side'); if (curActive) break; }
          } catch(e) {}
        }
      } catch(e) {}
      if (curActive) break;
    }
    // 兜底：用初始 iframe
    if (!curActive) curActive = iframe;
    // ★ 累加所有祖先 iframe 偏移 → 换算为顶层窗口绝对坐标
    //   (.resume-center-side 在子 iframe 内，其 rect 是子 iframe 视口坐标，
    //    captureVisibleTab 截的是顶层窗口，必须对齐坐标系，否则裁剪框会左上偏移)
    var r = (function(el) {
      var rc = el.getBoundingClientRect();
      var left = rc.left, top = rc.top, w = rc.width, h = rc.height;
      try {
        var win = el.ownerDocument && el.ownerDocument.defaultView;
        var guard = 0;
        while (win && win.frameElement && guard < 6) {
          var fr = win.frameElement.getBoundingClientRect();
          left += fr.left; top += fr.top;
          if (win === win.parent) break;
          win = win.parent; guard++;
        }
      } catch(e) {}
      return { left: left, top: top, width: w, height: h, right: left + w, bottom: top + h };
    })(curActive);
    if (r.width < 50 || r.height < 50) return null; // 区域不可见
    var ct = Math.max(0, Math.floor(r.top));
    var ch = Math.max(0, Math.min(winH, Math.floor(r.bottom)) - ct);
    if (ch < 30) return null;
    var cw = Math.min(Math.ceil(r.width), winW - Math.max(0, Math.floor(r.left)));
    var cx = Math.max(0, Math.floor(r.left));
    var fp = await captureVisibleTab();
    if (!fp) return null;
    return await cropImage(fp,
      Math.round(cx * dpr), Math.round(ct * dpr),
      Math.round(cw * dpr), Math.round(ch * dpr));
  }

  const originalScrollTop = sc.scrollTop;
  try {
    const scroller = pickScroller();
    const maxScroll = scroller ? (scroller.scrollHeight - scroller.clientHeight) : 0;
    const scrollerName = scroller ? (scroller.className || scroller.tagName) : '无';
    console.log('[Vision] 滚动容器:', scrollerName, 'maxScroll:', Math.round(maxScroll));
    DEBUG && showPanelMsg('截屏:'+scrollerName+' 范围'+Math.round(maxScroll)+'px');

    const slices = [];   // {contentY0(=scrollTop), sliceH, dataUrl}

    if (!scroller || maxScroll < 20 || _visibleH < 30) {
      // 无需/无法滚动：单张
      const u = await shotFixed();
      if (u) slices.push({ contentY0: 0, sliceH: _visibleH, dataUrl: u });
    } else {
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      // WheelEvent 确保触发 canvas 重绘（真实滚动内容但不被检测——原生事件）
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 1, bubbles: true, cancelable: true }));
      await sleep(450);
      const step = Math.max(80, _visibleH - 50);   // 50px 重叠防割裂
      let lastFinger = '', pos = 0, guard = 0;
      while (guard++ < 30) {
        scroller.scrollTop = pos;
        scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
        scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: pos }));
        await sleep(550 + Math.random() * 200); // 525-750ms 随机延时
        const realPos = scroller.scrollTop;   // clamp 后真实滚动量 = 内容偏移
        const u = await shotFixed();
        if (u) {
          const fg = fingerprint(u);
          if (fg !== lastFinger) {
            slices.push({ contentY0: realPos, sliceH: _visibleH, dataUrl: u });
            lastFinger = fg;
            DEBUG && showPanelMsg('截屏'+slices.length+'/'+Math.ceil(maxScroll/step+1)+' scrollTop='+Math.round(realPos));
            console.log(`[Vision] 切片${slices.length} scrollTop=${Math.round(realPos)}`);
          } else {
            console.log('[Vision] 内容未变，到底 scrollTop=' + Math.round(realPos));
            break;
          }
        }
        if (realPos >= maxScroll - 2) { console.log('[Vision] 到底 scrollTop=' + Math.round(realPos)); break; }
        pos = realPos + step;
      }
    }

    if (slices.length === 0) return [];
    if (slices.length === 1) {
      // 单屏：原图即 AI识别 图，简单缩一下作为展示图
      var singleUrl = slices[0].dataUrl;
      var singleDisp = await compressForDisplay(singleUrl);
      return [{ ocrPng: singleUrl, displayImage: singleDisp || singleUrl }];
    }

    const merged = await stitchSlices(slices, _cropW, resumeHeight, dpr);
    console.log('[Vision] 拼接' + slices.length + '张为1张长图');
    DEBUG && showPanelMsg('拼接完成 ' + slices.length + '屏→1张长图');
    var _finalResults = merged ? [merged] : slices.map(s => ({ ocrPng: s.dataUrl, displayImage: s.dataUrl }));
    for (var _fi = 0; _fi < _finalResults.length; _fi++) { _finalResults[_fi].ocrPng = await removeAvatarFromImage(_finalResults[_fi].ocrPng); }
    return _finalResults;
  } catch (e) {
    console.error('[Vision] 滚动截图失败:', e);
    const fp = await captureVisibleTab();
    return fp ? [fp] : [];
  } finally {
    // 还原浮层可见性
    hiddenBanners.forEach(([el, v]) => { try { el.style.visibility = v || ''; } catch (e) {} });
    // 还原：既有 sc（detail-wrap），也有当前激活弹窗的 scroller（center-side）
    sc.scrollTop = originalScrollTop;
    sc.dispatchEvent(new Event('scroll', { bubbles: true }));
    const scl = activeCenterSide;
    if (scl && scl.scrollTop > 0) {
      scl.scrollTop = 0;
      scl.dispatchEvent(new Event('scroll', { bubbles: true }));
      scl.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true, cancelable: true }));
    }
  }
}

// 按内容坐标把切片拼成一张无缝长图（物理像素，重叠区自动覆盖对齐）
async function removeAvatarFromImage(dataUrl) {
  if (!dataUrl) return dataUrl;
  try {
    var _avtImg = new Image();
    await new Promise(function(r) { _avtImg.onload=r; _avtImg.src=dataUrl; });
    var _avtC = document.createElement("canvas"); _avtC.width = _avtImg.width; _avtC.height = _avtImg.height;
    var _avtCx = _avtC.getContext("2d");
    _avtCx.drawImage(_avtImg, 0, 0);
    _avtCx.fillStyle = "#ffffff";
    _avtCx.fillRect(0, 0, Math.min(100, _avtImg.width), Math.min(100, _avtImg.height));
    return _avtC.toDataURL("image/png");
  } catch(e) { return dataUrl; }
}

async function stitchSlices(slices, cropWcss, resumeHeightCss, dpr) {
  try {
    const loaded = await Promise.all(slices.map(s => new Promise(res => {
      const im = new Image(); im.onload = () => res({ im, s }); im.onerror = () => res(null); im.src = s.dataUrl;
    })));
    const valid = loaded.filter(Boolean);
    if (valid.length === 0) return null;
    let maxBottom = 0;
    valid.forEach(({ s }) => { maxBottom = Math.max(maxBottom, s.contentY0 + s.sliceH); });
    // ★ 画布高度钳制到简历真实高度（iframe.style.height），避免最后一屏把简历末尾以下的黑色空白拼进来
    const contentH = (resumeHeightCss && resumeHeightCss > 100) ? Math.min(resumeHeightCss, maxBottom + 4) : maxBottom;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(cropWcss * dpr);
    canvas.height = Math.round(contentH * dpr);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    valid.forEach(({ im, s }) => {
      const y = Math.round(s.contentY0 * dpr);
      const avail = canvas.height - y;           // 到画布底还剩多少
      if (avail <= 0) return;
      const drawH = Math.min(im.height, avail);  // 裁掉超出简历真实高度的黑边
      ctx.drawImage(im, 0, 0, im.width, drawH, 0, y, im.width, drawH);
    });
    // AI识别 用无损 PNG；展示用压缩小 JPEG（避免大图在 IndexedDB/HTML 显示失败）
    var ocrPng = canvas.toDataURL('image/png');
    var displayW = Math.min(canvas.width, 900);
    var displayScale = displayW / canvas.width;
    var dc = document.createElement('canvas'); dc.width = displayW; dc.height = Math.round(canvas.height * displayScale);
    dc.getContext('2d').drawImage(canvas, 0, 0, dc.width, dc.height);
    var displayJpg = dc.toDataURL('image/jpeg', 0.78);
    return { ocrPng: ocrPng, displayImage: displayJpg };
  } catch (e) { console.warn('[Vision] 拼接失败:', e.message); return null; }
}

// 压缩为展示/下载用的小图（简化版，用于已有 dataUrl）
async function compressForDisplay(dataUrl, maxW, quality) {
  maxW = maxW || 900; quality = quality || 0.82;
  if (!dataUrl) return dataUrl;
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const scale = img.width > maxW ? maxW / img.width : 1;
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      } catch (e) { resolve(dataUrl); }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

// DPR 修正的元素裁剪（兼容旧调用，如分享卡片截取）
async function captureAndCropRect(el) {
  try {
    const fullPage = await captureVisibleTab();
    if (!fullPage) return null;
    if (el) {
      const dpr = window.devicePixelRatio || 1;
      const rect = el.getBoundingClientRect();
      const cropX = Math.max(0, Math.floor(rect.left));
      const cropW = Math.min(Math.ceil(rect.width), window.innerWidth - cropX);
      const cropY = Math.max(0, Math.floor(rect.top));
      const cropH = Math.min(Math.ceil(rect.bottom), window.innerHeight) - cropY;
      if (cropW > 50 && cropH > 50) {
        return await cropImage(fullPage,
          Math.round(cropX * dpr), Math.round(cropY * dpr),
          Math.round(cropW * dpr), Math.round(cropH * dpr));
      }
    }
    return fullPage;
  } catch(e) { console.warn('[Vision] 裁剪失败:', e.message); return null; }
}

// ★ 智能分片 AI识别：图片 >2000px 高度时，在空白行处切开逐片识别，避免 AI识别 降采样
async function smartSplitOcr(b64, maxH) {
  maxH = maxH || 2000;
  return new Promise((resolve, reject) => {
    var img = new Image();
    img.onload = async function() {
      try {
        var w = img.width, h = img.height;
        if (h <= maxH) {
          // 高度合适，直接 AI识别
          var txt = await ocrOne(b64);
          return resolve(txt);
        }

        // 图片太高 → 画到 canvas 读取像素找空白分割行
        var cv = document.createElement('canvas'); cv.width = w; cv.height = h;
        var cx = cv.getContext('2d');
        cx.drawImage(img, 0, 0);
        var pixels = cx.getImageData(0, 0, w, h).data;

        // 扫描每行的"非白像素"数量，找出空白带
        var rowScores = new Uint32Array(h); // 每行非白像素数 = 该行"有内容"程度
        var sampleStep = Math.max(1, Math.floor(w / 200)); // 采样加速：每行只检查200个点
        for (var y = 0; y < h; y++) {
          var nonWhite = 0;
          var rowOff = y * w * 4;
          for (var x = 0; x < w; x += sampleStep) {
            var i = rowOff + x * 4;
            if (pixels[i] < 240 || pixels[i+1] < 240 || pixels[i+2] < 240) nonWhite++;
          }
          rowScores[y] = nonWhite;
        }

        // 找连续空白行区域（nonWhite < 阈值 → 空白行）
        var threshold = Math.max(2, Math.floor(w / sampleStep * 0.03)); // 3% 以下像素有颜色
        var blanks = []; // {y0, y1, height}
        var start = -1;
        for (var yy = 0; yy < h; yy++) {
          if (rowScores[yy] < threshold) {
            if (start < 0) start = yy;
          } else {
            if (start >= 0 && yy - start >= 15) { blanks.push({ y0: start, y1: yy, height: yy - start }); }
            start = -1;
          }
        }
        if (start >= 0 && h - start >= 15) blanks.push({ y0: start, y1: h, height: h - start });

        // 选切割点：在最大的几个空白带中间切开
        blanks.sort((a,b) => b.height - a.height);
        var targetChunks = Math.ceil(h / maxH);
        var splitYs = [];
        var used = new Set();
        for (var b = 0; b < blanks.length && splitYs.length < targetChunks - 1; b++) {
          var midY = Math.floor((blanks[b].y0 + blanks[b].y1) / 2);
          // 确保分割点不在已选区域附近（至少隔 200px）
          var tooClose = false;
          for (var s = 0; s < splitYs.length; s++) {
            if (Math.abs(splitYs[s] - midY) < 200) { tooClose = true; break; }
          }
          if (!tooClose) splitYs.push(midY);
        }
        splitYs.sort((a,b) => a - b);
        console.log('[SmartSplit] 高'+h+'px→'+(splitYs.length+1)+'片 切点:', splitYs.map(function(y){return Math.round(y);}).join(','));

        // 按切割点逐片 AI识别
        var chunks = [];
        var prevY = 0;
        for (var c = 0; c <= splitYs.length; c++) {
          var chunkH = (c < splitYs.length ? splitYs[c] : h) - prevY;
          if (chunkH < 30) { prevY = splitYs[c]; continue; }
          var chunkCv = document.createElement('canvas'); chunkCv.width = w; chunkCv.height = chunkH;
          chunkCv.getContext('2d').drawImage(img, 0, prevY, w, chunkH, 0, 0, w, chunkH);
          var chunkB64 = chunkCv.toDataURL('image/png').split('base64,')[1];
          var chunkText = await ocrOne(chunkB64);
          chunkText = (chunkText || '').replace(/^[a-zA-Z0-9\s]+(?=[一-鿿])/, '');
          chunks.push(chunkText);
          console.log('[SmartSplit] 块'+(c+1)+'/'+(splitYs.length+1)+' y='+prevY+'-'+(prevY+chunkH)+' AI识别:'+chunkText.length+'字');
          prevY = splitYs[c];
        }
        resolve(chunks.join('\n'));
      } catch(e) { reject(e); }
    };
    img.onerror = () => reject(new Error('图片加载失败'));
    img.src = 'data:image/png;base64,' + b64;
  });
}

// 单次 AI识别 调用
function ocrOne(b64) {
  return new Promise((resolve, reject) => {
    protectSendMessage({ action: 'paddleLocal', b64: b64 }, response => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else if (response && response.ok) resolve(response.text);
      else reject(new Error(response?.error || 'AI识别失败'));
    });
  });
}

/**
 * 调用 AI识别 服务 (支持批量多图)
 */
async function callOfficialOcrService(imageList) {
  // ★ 调AI识别前检查试用次数
  var tr5 = await checkTrialRemaining();
  if (tr5 <= 0) throw new Error('次数已用完');
  const rawImages = (imageList && imageList.length > 0) ? imageList : [await captureVisibleTab()];
  if (!rawImages || rawImages.length === 0) throw new Error('无法获取截图');

  try {
    // captureFullResumeScreenshot 返回 [{ocrPng, displayImage}]
    var item = rawImages[0];
    var isNewFormat = item && typeof item === 'object' && item.ocrPng;
    var ocrDataUrl = isNewFormat ? item.ocrPng : item;
    var b64 = ocrDataUrl.includes('base64,') ? ocrDataUrl.split('base64,')[1] : ocrDataUrl;
    // 展示存储用 displayImage（已压缩），旧格式兜底 compressForDisplay
    var resumeImage = isNewFormat ? item.displayImage : await compressForDisplay(ocrDataUrl);

    // ★ 智能分片 AI识别：图片高度 >2000px 时在空白行处切开逐片识别，避免 AI识别 降采样
    var rawText = await smartSplitOcr(b64);

    var len = rawText.length;
    console.log('[AI识别] 原文:', len, '字');
    if (len < 50) throw new Error('AI识别文字太少(' + len + '字)');
    DEBUG && showPanelMsg('AI识别:' + len + '字, AI分析解析中...');

    // 2. AI分析 JSON 结构化解析（通过后端代理，API key 在服务端）
    var dsData = await deepseekRequest({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: `Parse resume AI识别 text into json. Output ONLY valid JSON, no markdown.

AI识别 format: Name**tags\\nAge Experience Education Status\\n...description...\\n期望职位\\nCity | Position | Industry | Salary\\n工作经历\\nCompany1\\nTitle1\\nPeriod1\\nDesc1

NOTE: AI识别 text order may be scrambled and may contain UI banners/tooltips (e.g. "近14天你首次看到该牛人赶紧联系TA吧"). Extract each field by its label/pattern, NOT by line position. Ignore all noise phrases listed below.

Extraction rules:
	- name: the person's name. If the full name appears (e.g. 李在明), use it directly. If the name is masked (1-3 chars + "**", e.g. 李**女士), extract that. Do NOT output "Name**" UI label text. Search whole text — it may not be on the first line.
- age: number before "岁"
- experience: number + "年"
- education: 大专/本科/硕士/博士/中专/高中
- expectCity/expectPosition/expectSalary: split "期望职位" next line by "|"
- currentCompany: first company under 工作经历
- currentTitle: first title under 工作经历
- workExperiences: array of {company,title,period,description} from 工作经历 section
- projectExperiences: array of {name,period,description} from 项目经验 section
- educationInfo: {school,major,degree,period} from 教育经历 section
- skills: skills list from 专业技能 section
- Ignore: 热搜 刚刚活跃 本月活跃 今日活跃 在线 离线 随时到岗 查看全部 继续沟通 搜索畅聊卡 立即沟通 近14天你首次看到该牛人 赶紧联系TA吧 首次看到该牛人 使用成功

{"name":"苗**","age":24,"experience":"3年","education":"大专","expectCity":"日照","expectPosition":"国内电商运营","expectSalary":"6-7K","currentCompany":"山东瞬擎文化传媒服务有限公司","currentTitle":"国内电商运营","workExperiences":[{"company":"山东瞬擎文化传媒服务有限公司","title":"国内电商运营","period":"2025.05-2025.11","description":"..."}],"projectExperiences":[{"name":"ERP系统","period":"2024.03-2024.08","description":"..."}],"educationInfo":{"school":"青岛农业大学","major":"通信工程","degree":"本科","period":"2017-2021"},"skills":"Java,SpringBoot,MySQL,Redis"}` },
        { role: 'user', content: rawText }
      ],
      temperature: 0,
      response_format: { type: 'json_object' }
    });
    var dsContent = dsData.choices?.[0]?.message?.content || '';

    // 3. AI分析 JSON 解析
    var extracted = {};
    try { extracted = JSON.parse(dsContent.trim()); } catch(e) { console.log('[AI分析] JSON解析失败'); }

    var name = extracted.name || '';
    var age = typeof extracted.age === 'number' ? extracted.age : parseInt(extracted.age) || null;

    showPanelMsg('AI识别:' + (name||'?') + ' ' + (age||'?') + '岁 ' + (extracted.currentCompany||''));
    return JSON.stringify({
      name: name, age: age,
      gender: extracted.gender || '', education: extracted.education || '',
      experience: extracted.experience || '', currentCompany: extracted.currentCompany || '',
      currentTitle: extracted.currentTitle || '', expectCity: extracted.expectCity || '',
      expectPosition: extracted.expectPosition || '', expectSalary: extracted.expectSalary || '',
      resumeImage: resumeImage,
      workExperiences: extracted.workExperiences || [],
      projectExperiences: extracted.projectExperiences || [],
      educationInfo: extracted.educationInfo || {},
      skills: extracted.skills || '',
      fullText: rawText,
      dsParsed: dsContent
    }, null, 2);
  } catch(e) {
    console.error('[AI识别]', e);
    showPanelMsg('AI识别失败:' + (e.message||'').substring(0,40));
    throw new Error('AI识别失败: ' + (e.message || ''));
  }
}

async function callOfficialResumeEvalService(resumeContent, settings, apiKey, baseUrl) {
  const config = { model: 'deepseek-chat', systemPrompt: settings?.prompt || '' };
  console.log('[EVAL] AI分析 文本评估...');
  const result = await callCustomApi(resumeContent, config);
  return { evaluation: { score: result.score, isQualified: result.score >= 80, suggestion: result.suggestion || '', details: { baseScore: result.score, additions: [], totalScore: result.score } }, shareLink: result.shareLink || null, shareCardImage: result.shareCardImage || null };
}

// 简化截图函数 - 直接截整页，不裁剪
async function capturePageAndCropIframe() {
  try {
    const fullPage = await captureVisibleTab();
    if (!fullPage) return null;

    // 裁剪到简历弹窗区域（页面中央的 dialog）
    // Canvas 简历弹窗（新版）——搜主文档 + iframe
    let dialog = document.querySelector('.resume-center-side, .boss-dialog__wrapper, .boss-popup__wrapper, .dialog-lib-resume');
    if (!dialog) {
      const ifs = document.querySelectorAll('iframe');
      for (const f of ifs) {
        try { dialog = f.contentDocument?.querySelector('.resume-center-side, .boss-dialog__wrapper, .boss-popup__wrapper'); if (dialog) break; } catch(e) {}
      }
    }
    if (dialog) {
      const rect = dialog.getBoundingClientRect();
      if (rect.width > 100 && rect.height > 100) {
        return await cropImage(fullPage, rect.x, rect.y, rect.width, rect.height);
      }
    }

    // 兜底：整页
    return fullPage;
  } catch (e) {
    console.warn('[Vision] 截图裁剪失败:', e.message);
  }
  return null;
}

// Canvas 裁剪图片
function cropImage(dataUrl, x, y, w, h) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, x, y, w, h, 0, 0, w, h);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => reject(new Error('裁剪失败'));
    img.src = dataUrl;
  });
}

// 强制在iframe中注入处理WebAssembly错误的代码
async function handleWebAssemblyError(iframeDoc) {
  try {
    const script = iframeDoc.createElement('script');
    script.textContent = `
      // 捕获并处理WebAssembly错误
      window.addEventListener('error', function(e) {
        if (e.message && e.message.includes('WebAssembly')) {
          console.log('捕获到WebAssembly错误，尝试修复...');
          
          // 等待一段时间后尝试重新初始化
          setTimeout(() => {
            // 触发可能重新初始化WebAssembly的操作
            const event = new Event('resize');
            window.dispatchEvent(event);
          }, 1000);
        }
      });
    `;
    iframeDoc.head.appendChild(script);
    console.log('已注入WebAssembly错误处理代码');
  } catch (e) {
    console.error('注入错误处理代码失败:', e);
  }
}


// 添加此函数来注入Canvas捕获脚本
async function injectCanvasCaptureScript(iframeDoc) {
  try {
    console.log('开始注入Canvas捕获脚本...');

    // 创建脚本元素
    const script = iframeDoc.createElement('script');
    script.textContent = `
    (function() {
      'use strict';
    
      console.log("Canvas Capture Extension: Content script injected.");
    
      const drawingOperations = []; // 存储 Canvas 绘图操作的数组
      const methodsToHook = [
        'fillRect', 'strokeRect', 'fillText', 'strokeText', 'beginPath', 
        'moveTo', 'lineTo', 'closePath', 'fill', 'stroke', 'drawImage', 'clearRect',
        // ...其他方法...
      ];
    
      // 检查 CanvasRenderingContext2D 是否存在
      if (typeof CanvasRenderingContext2D !== 'undefined') {
        methodsToHook.forEach(methodName => {
          if (CanvasRenderingContext2D.prototype[methodName]) {
            const originalMethod = CanvasRenderingContext2D.prototype[methodName];
    
            CanvasRenderingContext2D.prototype[methodName] = function(...args) {
              // 特别注意fillText方法，它包含显示的文本
              if (methodName === 'fillText' || methodName === 'strokeText') {
                console.log('Canvas文本内容:', args[0], '位置:', args[1], args[2]);
              }
              
              drawingOperations.push({
                method: methodName,
                arguments: Array.from(args)
              });
    
              return originalMethod.apply(this, args);
            };
          }
        });
      }
    
      // 将捕获的操作暴露到window对象
      window.getCanvasOperations = function() {
        return drawingOperations;
      };
      
      // 添加提取文本内容的函数
      window.extractCanvasText = function() {
        const textContent = [];
        drawingOperations.forEach(op => {
          if (op.method === 'fillText' || op.method === 'strokeText') {
            if (op.arguments[0] && typeof op.arguments[0] === 'string') {
              textContent.push({
                text: op.arguments[0],
                x: op.arguments[1],
                y: op.arguments[2]
              });
            }
          }
        });
        return textContent;
      };
    
      console.log("Canvas捕获脚本注入完成。使用window.extractCanvasText()获取文本内容。");
    })();
    `;

    // 将脚本添加到iframe文档中
    iframeDoc.head.appendChild(script);
    console.log('Canvas捕获脚本注入成功');

    // 等待脚本执行完成
    await new Promise(resolve => setTimeout(resolve, 1000));

    return true;
  } catch (e) {
    console.error('注入Canvas捕获脚本时出错:', e);
    return false;
  }
}

// 添加函数来获取Canvas中的文本内容
async function extractTextFromCanvasOperations(iframe) {
  try {
    const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
    const canvas = iframeDoc.querySelector('canvas');

    if (!canvas) {
      console.warn('未找到Canvas元素');
      return null;
    }

    // 确保extractCanvasText函数存在
    if (typeof iframe.contentWindow.extractCanvasText !== 'function') {
      console.warn('extractCanvasText函数未找到，可能脚本注入失败');
      return null;
    }

    // 清理之前的操作记录
    if (typeof iframe.contentWindow.clearCanvasTextOperations === 'function') {
      iframe.contentWindow.clearCanvasTextOperations();
    }

    // 等待一段时间确保Canvas完全渲染
    await new Promise(resolve => setTimeout(resolve, 500));

    // 提取文本操作
    const textOperations = iframe.contentWindow.extractCanvasText(canvas);

    if (!textOperations || textOperations.length === 0) {
      console.warn('未找到任何文本操作');
      return null;
    }

    console.log(`找到 ${textOperations.length} 个文本操作`);

    // 按y坐标分组
    const groupedText = groupTextByPosition(textOperations);

    // 格式化文本内容
    const formattedText = formatTextContent(groupedText);

    if (formattedText) {
      console.log(`提取的文本长度: ${formattedText.length}`);
      return formattedText;
    }

    return null;
  } catch (error) {
    console.error('从Canvas操作提取文本失败:', error);
    return null;
  }
}

function groupTextByPosition(textOperations) {
  // 按y坐标分组，允许5像素的误差
  const groups = {};
  const tolerance = 5;

  textOperations.forEach(op => {
    const y = Math.round(op.y / tolerance) * tolerance;
    if (!groups[y]) {
      groups[y] = [];
    }
    groups[y].push(op);
  });

  // 对每个组内的文本按x坐标排序
  Object.values(groups).forEach(group => {
    group.sort((a, b) => a.x - b.x);
  });

  return groups;
}

function formatTextContent(groupedText) {
  try {
    // 获取所有y坐标并排序
    const yPositions = Object.keys(groupedText).map(Number).sort((a, b) => a - b);

    // 合并文本，处理行间距
    let lastY = null;
    let result = '';

    yPositions.forEach(y => {
      const line = groupedText[y].map(op => op.text).join(' ').trim();
      if (!line) return;

      if (lastY !== null) {
        // 如果行间距大于50像素，添加额外的换行
        const gap = y - lastY;
        if (gap > 50) {
          result += '\n\n';
        } else {
          result += '\n';
        }
      }

      result += line;
      lastY = y;
    });

    return result.trim();
  } catch (error) {
    console.error('格式化文本内容时出错:', error);
    return null;
  }
}

// 获取元素的xpath
function getXPath(element) {
  // 首先尝试查找包含data-jid的a标签
  const link = element.querySelector('a[data-jid]');
  if (link) {
    const jid = link.getAttribute('data-jid');
    // 使用data-jid属性构建XPath
    return `//a[@data-jid='${jid}']`;
  }

  // 如果找不到data-jid，则返回null
  console.warn('未找到data-jid属性，无法生成唯一XPath');
  return null;
}

// 注入增强的Canvas捕获脚本
async function injectEnhancedCanvasCaptureScript(iframeDoc) {
  try {
    console.log('开始注入增强的Canvas捕获脚本...');

    // 创建并注入脚本
    const script = iframeDoc.createElement('script');
    script.textContent = `
      (function() {
        // 存储原始的Canvas方法
        const originalGetContext = HTMLCanvasElement.prototype.getContext;
        const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
        
        // 重写getContext方法
        HTMLCanvasElement.prototype.getContext = function() {
          const context = originalGetContext.apply(this, arguments);
          if (context && !this.enhanced) {
            this.enhanced = true;
            
            // 存储所有文本操作
            if (!window.canvasTextOperations) {
              window.canvasTextOperations = [];
            }
            
            // 拦截fillText和strokeText
            const originalFillText = context.fillText;
            const originalStrokeText = context.strokeText;
            
            context.fillText = function(text, x, y) {
              window.canvasTextOperations.push({
                text,
                x,
                y,
                type: 'fillText',
                style: {
                  font: this.font,
                  fillStyle: this.fillStyle
                }
              });
              return originalFillText.apply(this, arguments);
            };
            
            context.strokeText = function(text, x, y) {
              window.canvasTextOperations.push({
                text,
                x,
                y,
                type: 'strokeText',
                style: {
                  font: this.font,
                  strokeStyle: this.strokeStyle
                }
              });
              return originalStrokeText.apply(this, arguments);
            };
          }
          return context;
        };
        
        // 添加提取文本的方法
        window.extractCanvasText = function(canvas) {
          if (!canvas) {
            console.error('Canvas元素未找到');
            return null;
          }
          
          // 尝试强制重绘以捕获所有文本
          const ctx = canvas.getContext('2d');
          if (ctx) {
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            ctx.putImageData(imageData, 0, 0);
          }
          
          // 返回捕获的文本操作
          return window.canvasTextOperations || [];
        };
        
        // 添加清理方法
        window.clearCanvasTextOperations = function() {
          window.canvasTextOperations = [];
        };
        
        // 处理WebAssembly MIME类型问题
        const originalFetch = window.fetch;
        window.fetch = async function(...args) {
          const response = await originalFetch.apply(this, args);
          if (args[0] && args[0].endsWith('.wasm')) {
            // 创建新的Response对象，设置正确的MIME类型
            return new Response(response.body, {
              headers: {
                'Content-Type': 'application/wasm',
                ...response.headers
              }
            });
          }
          return response;
        };
      })();
    `;

    // 注入脚本
    iframeDoc.head.appendChild(script);

    // 等待脚本执行
    await new Promise(resolve => setTimeout(resolve, 1000));

    // 验证脚本注入
    const canvasElements = iframeDoc.getElementsByTagName('canvas');
    for (const canvas of canvasElements) {
      canvas.setAttribute('crossorigin', 'anonymous');

      // 尝试预加载图像内容
      const ctx = canvas.getContext('2d');
      if (ctx) {
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        ctx.putImageData(imageData, 0, 0);
      }
    }

    console.log('增强的Canvas捕获脚本注入成功');
    return true;
  } catch (error) {
    console.error('注入增强的Canvas捕获脚本失败:', error);
    return false;
  }
}

// 优化从Canvas操作中提取文本的函数
async function extractTextFromCanvasOperations(iframe) {
  try {
    const iframeWin = iframe.contentWindow;

    // 检查extractCanvasText函数是否已注入
    if (typeof iframeWin.extractCanvasText !== 'function') {
      console.warn('extractCanvasText函数未找到，可能脚本注入失败');
      return null;
    }

    // 调用iframe中的函数获取文本内容
    const textItems = await new Promise(resolve => {
      setTimeout(() => {
        const items = iframeWin.extractCanvasText();
        resolve(items);
      }, 500); // 给予一些时间让Canvas完全渲染
    });

    if (!textItems || textItems.length === 0) {
      console.warn('未找到Canvas文本内容');
      return null;
    }

    console.log('从Canvas操作中提取的文本项数量:', textItems.length);

    // 将文本项按位置排序并分组
    const groupedText = groupTextByPosition(textItems);

    // 合并文本内容
    const fullText = formatTextContent(groupedText);

    console.log('提取的完整文本长度:', fullText.length);
    return fullText;
  } catch (e) {
    console.error('从Canvas提取文本失败:', e);
    return null;
  }
}

// 新增：按位置对文本进行分组
function groupTextByPosition(textItems) {
  // 按y坐标分组（考虑一定的误差范围）
  const yThreshold = 5; // y坐标误差范围
  const groups = {};

  textItems.forEach(item => {
    // 找到最接近的y坐标组
    const y = Math.round(item.y / yThreshold) * yThreshold;
    if (!groups[y]) {
      groups[y] = [];
    }
    groups[y].push(item);
  });

  // 对每个组内的文本按x坐标排序
  Object.values(groups).forEach(group => {
    group.sort((a, b) => a.x - b.x);
  });

  return groups;
}

// 新增：格式化文本内容
function formatTextContent(groupedText) {
  // 按y坐标排序
  const sortedY = Object.keys(groupedText).sort((a, b) => Number(a) - Number(b));

  let formattedText = '';
  let lastY = null;

  sortedY.forEach(y => {
    const group = groupedText[y];

    // 计算当前行与上一行的距离
    if (lastY !== null) {
      const yDiff = Number(y) - Number(lastY);
      // 如果行间距较大，添加额外的换行
      if (yDiff > 20) {
        formattedText += '\n';
      }
    }

    // 合并同一行的文本
    const lineText = group.map(item => item.text.trim())
      .filter(text => text) // 过滤空文本
      .join(' ');

    if (lineText) {
      formattedText += (formattedText ? '\n' : '') + lineText;
    }

    lastY = y;
  });

  return formattedText;
}

// Canvas 中继/消息监听链路已移除：统一使用截图 AI识别
