// API配置
window.API_CONFIG = {
  development: {
    baseUrl: 'http://localhost:8787',
  },
  production: {
    baseUrl: 'https://api.hrassistent.online',
  }
};

// 不再需要导入语句，因为所有变量和函数都是全局的

// UI和初始化相关的代码
console.log('content.js 已加载');

// 全局状态变量
let isAnalyzing = false;
let isScrolling = false;
let lastScrollPosition = 0;
let scrollStuckCount = 0;
const MAX_SCROLL_STUCK = 3;

// 添加全局锁
let analysisLock = false;

// 工作中文案
const workingMessages = [
  'AI正在打工中...',
  'AI正在筛选简历...',
  'AI正在加班加点中...',
  'AI正在冲刺...',
  'AI火力全开中...'
];

// 初始化tabId
let tabId = null;

// 获取当前标签页ID并添加错误处理
chrome.runtime.sendMessage({ type: 'GET_TAB_ID' }, (response) => {
  if (chrome.runtime.lastError) {
    console.error('获取tabId时发生错误:', chrome.runtime.lastError);
    return;
  }
  
  if (response && response.tabId) {
    tabId = response.tabId;
    window.tabId = tabId;
    console.log('成功获取tabId:', tabId);
  } else {
    console.error('获取tabId失败: 响应无效', response);
  }
});

// 导出获取tabId的方法
window.getTabId = () => tabId;

// 添加初始化标志和结果持久化标志
let isInitialized = false;
let isResultsPersisted = false;
let isObserverSetup = false;

// 添加结果缓存
let lastResults = null;
let lastScoreThreshold = null;

// 定义一个全局唯一ID，用于标识容器
const CONTAINER_ID = 'hr-panel-unique';
let observer = null;
let initializationTimeout = null;

// 添加闪动效果的CSS
const flashStyle = `
@keyframes highlight-border {
  0% { border: 2px solid #1890ff; box-shadow: 0 0 8px #1890ff; }
  50% { border: 2px solid transparent; box-shadow: none; }
  100% { border: 2px solid #1890ff; box-shadow: 0 0 8px #1890ff; }
}

.highlight-element {
  animation: highlight-border 1s ease-in-out 3;
}`;

// 添加样式到页面
const styleElement = document.createElement('style');
styleElement.textContent = flashStyle;
document.head.appendChild(styleElement);

// 简化的初始化函数
async function init() {
  console.log('初始化开始，当前路径:', window.location.pathname);
  
  // 检查是否是目标页面
  const isValidPage = window.location.pathname.includes('/web/chat/search') || 
                     window.location.pathname.includes('/web/chat/index') ||
                     window.location.pathname.includes('/web/chat/recommend');
  
  if (!isValidPage) {
    console.log('不是目标页面，跳过初始化');
    return;
  }

  try {
    // 如果已经存在容器，直接返回
    const existingContainer = document.getElementById(CONTAINER_ID);
    if (existingContainer) {
      console.log('容器已存在，跳过创建');
      return existingContainer;
    }

    // 移除所有旧的AI助手容器（基于类名）
    const oldContainers = document.querySelectorAll('.hr-panel:not(#' + CONTAINER_ID + ')');
    oldContainers.forEach(container => {
      console.log('移除旧的AI助手容器');
      container.remove();
    });

    // 检查是否已加载样式表
    if (!document.querySelector('link[href*="styles.css"]')) {
      console.log('添加样式表');
      const styleLink = document.createElement('link');
      styleLink.rel = 'stylesheet';
      styleLink.href = chrome.runtime.getURL('styles.css');
      document.head.appendChild(styleLink);
    }

    // 加载用户配置
    // 确保 API 模式为自定义，并写入默认配置
    const { customApiConfig, _dataVersion } = await chrome.storage.local.get(['customApiConfig', '_dataVersion']);
    if (!customApiConfig || !customApiConfig.model) {
      await chrome.storage.local.set({
        apiMode: 'custom',
        customApiConfig: {
          model: 'deepseek-chat',
          systemPrompt: ''
        }
      });
    } else {
      await chrome.storage.local.set({ apiMode: 'custom' });
    }

    // 清理旧版本不兼容数据（V2 升级）
    if (_dataVersion !== 2) {
      console.log('检测到版本升级，清理旧数据...');
      await window.ResumeDB.clear();
      await chrome.storage.local.set({ _dataVersion: 2 });
    }

    await new Promise((resolve) => {
      chrome.storage.sync.get(['apiKey', 'scoreThreshold', 'prompt', 'apiEnvironment'], (result) => {
        window.resumeManager.currentConfig = {
          apiKey: result.apiKey || '',
          scoreThreshold: result.scoreThreshold || 80,
          apiEnvironment: result.apiEnvironment || 'production'
        };
        resolve();
      });
    });
    console.log('配置已加载到resumeManager');

    // 创建UI
    console.log('开始添加AI按钮');
    const container = addAIButton();
    container.id = CONTAINER_ID;  // 添加唯一ID
    
    // 加载分析结果
    console.log('开始加载分析结果');
    await window.resumeManager.loadAnalysisResults();
    
    // 显示结果
    console.log('更新结果显示');
    await updateResultsDisplay();
    
    console.log('开始添加键盘快捷键');
    addKeyboardShortcuts();

    // ====== Pro 版：支付激活检查 ======
    if ('$$IS_PAID$$' === 'true') {
      await checkProActivation();
      setInterval(checkProActivation, 300000); // 每5分钟提醒
    }

    // 设置事件监听
    setupEventListeners(container);

    console.log('初始化完成');
    return container;
  } catch (error) {
    console.error('初始化过程出错:', error);
  }
}

// 简化的观察器逻辑
function setupObserver() {
  // 如果已存在观察器，先断开连接
  if (observer) {
    observer.disconnect();
    observer = null;
  }

  // 创建新的观察器
  observer = new MutationObserver(() => {
    // 清除之前的超时
    if (initializationTimeout) {
      clearTimeout(initializationTimeout);
    }

    // 设置新的超时，延迟处理DOM变化
    initializationTimeout = setTimeout(async () => {
      const container = document.getElementById(CONTAINER_ID);
      
      if (!container) {
        // 容器不存在，重新初始化
        console.log('检测到AI助手容器不存在，重新初始化');
        await init();
      } else {
        // 容器存在，检查结果列表
        const resultsList = container.querySelector('.results-list');
        
        // 减少日志刷屏：只有首次检测到为空时才 log
        if ((!resultsList || resultsList.children.length === 0) && !window._resultsListEmptyLogged) {
          console.log('检测到结果列表为空');
          window._resultsListEmptyLogged = true;
          setTimeout(() => { window._resultsListEmptyLogged = false; }, 5000); // 5秒冷却
          await updateResultsDisplay();
        }
      }
    }, 1000);
  });

  // 观察body的变化
  observer.observe(document.body, {
    childList: true,
    subtree: true
  });

  console.log('观察器设置完成');
}

// 简化页面加载逻辑
if (document.readyState === 'loading') {
  console.log('页面正在加载，等待 DOMContentLoaded');
  document.addEventListener('DOMContentLoaded', () => {
    console.log('DOMContentLoaded 触发');
    init().then(() => setupObserver());
  });
} else {
  console.log('页面已加载完成，直接初始化');
  init().then(() => setupObserver());
}

// 修改添加按钮函数
function addAIButton() {
  // 如果已经存在，直接返回
  const existingContainer = document.getElementById(CONTAINER_ID);
  if (existingContainer) {
    return existingContainer;
  }

  const iconUrl = chrome.runtime.getURL('images/icon.png');
  console.log('使用图标URL:', iconUrl);

  const container = document.createElement('div');
  container.className = 'hr-panel';
  container.id = CONTAINER_ID;  // 添加唯一ID
  container.innerHTML = window.templates.container(iconUrl);
  document.body.appendChild(container);
  console.log('已添加AI助手容器');

  // 添加折叠按钮事件监听
  const collapseButton = container.querySelector('.collapse-button');
  if (collapseButton && !collapseButton.hasClickListener) {
    collapseButton.hasClickListener = true;
    collapseButton.addEventListener('click', (e) => {
      e.stopPropagation(); // 阻止事件冒泡
      const isCollapsed = container.classList.toggle('collapsed');
      console.log('切换收缩状态:', isCollapsed);
    });
  }

  // 添加错误关闭按钮事件监听
  const errorCloseBtn = container.querySelector('.error-container .close-btn');
  if (errorCloseBtn) {
    errorCloseBtn.addEventListener('click', () => {
      const errorContainer = container.querySelector('.error-container');
      if (errorContainer) {
        errorContainer.classList.remove('show');
      }
    });
  }

  return container;
}

// 设置事件监听函数
function setupEventListeners(container) {
  console.log('开始设置事件监听');
  
  // 获取需要的元素
  const collapseButton = container.querySelector('.collapse-button');
  const pinButton = container.querySelector('.pin-button');
  const header = container.querySelector('.hr-panel-header');
  const aiButton = container.querySelector('.hr-action-btn');
  const downloadHtmlButton = container.querySelector('.action-button:nth-child(1)');
  const downloadExcelButton = container.querySelector('.action-button:nth-child(2)');
  const downloadResumesButton = container.querySelector('#downloadResumesBtn');
  const backupBtn = container.querySelector('#backupBtn');
  const restoreBtn = container.querySelector('#restoreBtn');
  const clearButton = Array.from(container.querySelectorAll('.action-button')).find(b => b.textContent.includes('清空'));
  const filterCheckbox = container.querySelector('.qualified-filter');
  const dateFilterSelect = container.querySelector('.date-filter');

  // 防止重复添加事件监听器
  if (aiButton && !aiButton.hasClickListener) {
    console.log('添加AI按钮事件监听');
    aiButton.hasClickListener = true;
    
    aiButton.addEventListener('click', (e) => {
      // 阻止事件冒泡，防止其他元素的点击事件影响此按钮
      e.stopPropagation();
      
      // 获取事件源信息，用于调试
      console.log('AI按钮被点击', {
        target: e.target.tagName,
        currentTarget: e.currentTarget.tagName,
        srcElement: e.srcElement?.tagName,
        path: e.composedPath?.() || []
      });
      
      // 获取按钮的当前文本内容（去除所有HTML标签和空白）
      const buttonText = aiButton.innerText.trim();
      console.log('按钮当前文本:', buttonText);
      
      if (isAnalyzing) {
        console.log('停止分析');
        stopAnalysis();
      } else if (buttonText === 'AI读简历') {
        // 只有当按钮文本为"AI读简历"时才开始分析
        console.log('开始分析 - 按钮文本匹配');
        startAIAnalysis();
      } else {
        console.log('按钮文本不匹配，不执行分析:', buttonText);
      }
    });
  }

  // 下载HTML结果按钮事件
  if (downloadHtmlButton && !downloadHtmlButton.hasClickListener) {
    console.log('添加下载HTML按钮事件监听');
    downloadHtmlButton.hasClickListener = true;
    downloadHtmlButton.addEventListener('click', () => {
      console.log('下载HTML按钮被点击');
      downloadResults();
    });
  }

  // 导出Excel按钮事件
  if (downloadExcelButton && !downloadExcelButton.hasClickListener) {
    console.log('添加导出Excel按钮事件监听');
    downloadExcelButton.hasClickListener = true;
    downloadExcelButton.addEventListener('click', () => {
      console.log('导出Excel按钮被点击');
      window.templates.exportToExcel();
    });
  }

  // 批量下载简历按钮事件
  if (downloadResumesButton && !downloadResumesButton.hasClickListener) {
    console.log('添加下载简历按钮事件监听');
    downloadResumesButton.hasClickListener = true;
    downloadResumesButton.addEventListener('click', () => {
      console.log('下载简历按钮被点击');
      downloadAllResumes();
    });
  }

  // 清空结果按钮事件
  if (clearButton && !clearButton.hasClickListener) {
    console.log('添加清空按钮事件监听');
    clearButton.hasClickListener = true;
    clearButton.addEventListener('click', () => {
      console.log('清空按钮被点击');
      clearResults();
    });
  }

  // 备份数据按钮
  if (backupBtn && !backupBtn.hasClickListener) {
    backupBtn.hasClickListener = true;
    backupBtn.addEventListener('click', () => backupData());
  }

  // 恢复数据按钮
  if (restoreBtn && !restoreBtn.hasClickListener) {
    restoreBtn.hasClickListener = true;
    restoreBtn.addEventListener('click', () => restoreData());
  }

  // Tab 切换（AI读简历 / 求简历）
  const tabs = container.querySelectorAll('.hr-tab');
  tabs.forEach(tab => {
    if (tab.hasClickListener) return;
    tab.hasClickListener = true;
    tab.addEventListener('click', () => {
      const name = tab.getAttribute('data-tab');
      container.querySelectorAll('.hr-tab').forEach(t => {
        const active = t === tab;
        t.classList.toggle('active', active);
        t.style.borderBottomColor = active ? '#06b95d' : 'transparent';
        t.style.color = active ? '#06b95d' : '#666';
        t.style.fontWeight = active ? '500' : 'normal';
      });
      container.querySelectorAll('.hr-tab-panel').forEach(p => {
        p.style.display = p.getAttribute('data-panel') === name ? '' : 'none';
      });
      if (name === 'talent') loadTalentPool('');
    });
  });

  // 求简历按钮（沟通页采集）
  const chatCollectBtn = container.querySelector('#chatCollectBtn');
  if (chatCollectBtn && !chatCollectBtn.hasClickListener) {
    chatCollectBtn.hasClickListener = true;
    // 下载简历按钮
    const chatDownloadBtn = container.querySelector('#chatDownloadBtn');
    if (chatDownloadBtn && !chatDownloadBtn._dlwired) {
      chatDownloadBtn._dlwired = true;
      chatDownloadBtn.addEventListener('click', async () => {
        if (isAnalyzing) { isAnalyzing = false; chatDownloadBtn.textContent = '💾 下载简历附件'; return; }
        if (!window.location.pathname.includes('/web/chat/index')) { alert('请在沟通页面使用'); return; }
        isAnalyzing = true; chatDownloadBtn.textContent = '■ 停止';
        try { await window.resumeManager.handleChatResumeDownload(); }
        catch(e) { console.error(e); }
        finally { isAnalyzing = false; chatDownloadBtn.textContent = '💾 下载简历附件'; }
      });
    }

    chatCollectBtn.addEventListener('click', async () => {
      if (isAnalyzing) {
        // 再次点击 = 停止
        isAnalyzing = false;
        chatCollectBtn.textContent = '▶ 开始求简历';
        chatCollectBtn.style.background = '#06b95d';
        return;
      }
      if (!window.location.pathname.includes('/web/chat/index')) {
        alert('请在「沟通」页面使用此功能\n(打开 Boss 直聘的沟通/消息页)');
        return;
      }
      isAnalyzing = true;
      chatCollectBtn.textContent = '■ 停止';
      chatCollectBtn.style.background = '#ff4d4f';
      try {
        await window.resumeManager.handleChatResumeCollection();
      } catch (e) {
        console.error('求简历流程出错:', e);
      } finally {
        isAnalyzing = false;
        chatCollectBtn.textContent = '▶ 开始求简历';
        chatCollectBtn.style.background = '#06b95d';
      }
    });
  }

  // ★ 简历库
  var talentSearch = container.querySelector('#talentSearch');
  var talentList = container.querySelector('#talentList');
  var talentCount = container.querySelector('#talentCount');
  var talentRefreshBtn = container.querySelector('#talentRefreshBtn');
  var talentClearBtn = container.querySelector('#talentClearBtn');
  async function loadTalentPool(filter) {
    if (!talentList) return;
    try {
      var recs = [];
      try { recs = await window.ResumeDB.loadDownloaded(); } catch(e) {}
      // ★ debug: 打印所有 resumeId
      var _rids = recs.map(function(r){return (r.resumeId||'NOID').substring(0,20);}).join(',');
      debugLog('[简历库] 加载'+recs.length+'条 IDs:'+_rids.substring(0,150));
      if (!filter) filter = ''; var kw = filter.toLowerCase();
      var filtered = recs.filter(function(r){ return !kw || (r.name||'').indexOf(kw)>=0 || (r.file||'').indexOf(kw)>=0 || (r.cloud||'').indexOf(kw)>=0 || (r.position||'').indexOf(kw)>=0 || (r.city||'').indexOf(kw)>=0; });
      var html = '';
      for (var i = 0; i < filtered.length; i++) {
        var r = filtered[i];
        var metaHtml = [];
        if (r.position) metaHtml.push(r.position);
        if (r.city) metaHtml.push(r.city);
        if (r.salary) metaHtml.push(r.salary);
        if (r.experience) metaHtml.push(r.experience);
        html += '<div class="talent-item" data-idx="'+i+'" data-did="'+(r.dataId||'')+'" data-rid="'+(r.resumeId||'')+'" style="background:#fff;border:1px solid #eee;border-radius:8px;padding:10px 12px 10px 12px;margin-bottom:8px;position:relative;">' +
          '<div style="padding-right:20px;"><div style="display:flex;justify-content:space-between;"><strong style="font-size:13px;">'+(r.name||'?')+'</strong><span style="font-size:11px;color:#999;">'+(r.timestamp||'').substring(0,10)+'</span></div>'+
          (metaHtml.length?'<div style="font-size:11px;color:#1677ff;margin-top:2px;">'+metaHtml.join(' | ')+'</div>':'')+
          '<div style="font-size:11px;color:#666;margin-top:2px;">'+(r.file||'')+'</div>'+
          (r.cloud?'<div style="margin-top:3px;"><a href="'+r.cloud+'" target="_blank" style="font-size:11px;color:#1677ff;">☁ 查看云PDF</a></div>':'')+
          '</div>'+
          '<span class="talent-del" data-rid="'+(r.resumeId||'')+'" data-did="'+(r.dataId||'')+'" style="position:absolute;top:8px;right:10px;cursor:pointer;color:#bbb;font-size:16px;font-weight:bold;line-height:1;" title="删除">✕</span>'+
        '</div>';
      }
      var debugInfo = '<div style="font-size:10px;color:#999;text-align:center;padding:2px 0;">[调试] DB:'+recs.length+'条 显示:'+filtered.length+'条'+(filter?' 搜索:'+filter:'')+'</div>';
      talentList.innerHTML = debugInfo + (html || '<div style="text-align:center;color:#999;padding:20px;">暂无下载记录</div>');
      if (talentCount) talentCount.textContent = '共 '+filtered.length+' 条';
      // 绑定删除事件（走 IndexedDB）
      talentList.querySelectorAll('.talent-del').forEach(function(btn) {
        btn.addEventListener('click', async function(e) {
          e.stopPropagation();
          if (!confirm('确认删除此下载记录？')) return;
          var rid = this.getAttribute('data-rid');
          debugLog('[删] rid='+rid);
          var item = this.closest('.talent-item');
          if (item) item.remove();
          var result = await window.ResumeDB.deleteDownloaded(rid);
          debugLog('[删] '+(result&&result.ok?'成功':'失败:'+(result&&result.reason||'?')));
        });
      });
    } catch(e) { console.warn('简历库:', e); }
  }
  if (talentSearch) talentSearch.addEventListener('input', function(){ loadTalentPool(this.value); });
  if (talentRefreshBtn) talentRefreshBtn.addEventListener('click', function(){ loadTalentPool(talentSearch?talentSearch.value:''); });
  if (talentClearBtn) talentClearBtn.addEventListener('click', async function(){
    if (!confirm('确认清空简历库？')) return;
    try { await window.ResumeDB.clearDownloaded(); showPanelMsg('[简历库] 已清空'); }
    catch(e) { showPanelMsg('[简历库] 清空失败: '+(e&&e.message||e)); }
    loadTalentPool('');
  });

  // 拖动相关变量
  let isDragging = false;
  let currentX;
  let currentY;
  let initialX;
  let initialY;
  let xOffset = 0;
  let yOffset = 0;

  // 收缩/展开功能
  if (collapseButton && !collapseButton.hasClickListener) {
    console.log('添加收缩按钮事件监听');
    collapseButton.hasClickListener = true;
    collapseButton.addEventListener('click', (e) => {
      e.stopPropagation(); // 阻止事件冒泡
      const container = document.querySelector('.hr-panel');
      if (container) {
        container.classList.toggle('collapsed');
        console.log('切换收缩状态:', container.classList.contains('collapsed'));
      }
    });
  }

  // 固定/取消固定功能
  if (pinButton && !pinButton.hasClickListener) {
    console.log('添加固定按钮事件监听');
    pinButton.hasClickListener = true;
    pinButton.addEventListener('click', () => {
      container.classList.toggle('pinned');
      pinButton.classList.toggle('active');
      console.log('切换固定状态');
    });
  }

  // 拖动功能
  if (header && !header.hasClickListener) {
    console.log('添加拖动事件监听');
    header.hasClickListener = true;
    header.addEventListener('mousedown', dragStart);
    document.addEventListener('mousemove', drag);
    document.addEventListener('mouseup', dragEnd);
  }

  function dragStart(e) {
    if (!container.classList.contains('pinned')) {
      initialX = e.clientX - xOffset;
      initialY = e.clientY - yOffset;
      if (e.target === header) {
        isDragging = true;
      }
    }
  }

  function drag(e) {
    if (isDragging) {
      e.preventDefault();
      currentX = e.clientX - initialX;
      currentY = e.clientY - initialY;
      xOffset = currentX;
      yOffset = currentY;
      setTranslate(currentX, currentY, container);
    }
  }

  function dragEnd(e) {
    initialX = currentX;
    initialY = currentY;
    isDragging = false;
  }

  function setTranslate(xPos, yPos, el) {
    el.style.transform = `translate3d(${xPos}px, ${yPos}px, 0)`;
  }

  // 添加鼠标靠近边缘自动展开功能
  let expandTimeout;
  document.addEventListener('mousemove', (e) => {
    if (container.classList.contains('collapsed') && !container.classList.contains('pinned')) {
      const threshold = 50; // 距离边缘多少像素触发
      if (e.clientX >= window.innerWidth - threshold) {
        clearTimeout(expandTimeout);
        container.classList.remove('collapsed');
      } else {
        expandTimeout = setTimeout(() => {
          container.classList.add('collapsed');
        }, 300);
      }
    }
  });

  // 添加过滤器事件监听
  if (filterCheckbox && !filterCheckbox.hasClickListener) {
    console.log('添加过滤器事件监听');
    filterCheckbox.hasClickListener = true;
    filterCheckbox.addEventListener('change', () => {
      console.log('过滤器状态改变:', filterCheckbox.checked);
      updateResultsDisplay();
    });
  }

  // 日期筛选器事件
  if (dateFilterSelect && !dateFilterSelect.hasClickListener) {
    console.log('添加日期筛选事件监听');
    dateFilterSelect.hasClickListener = true;
    dateFilterSelect.addEventListener('change', () => {
      console.log('日期筛选改变:', dateFilterSelect.value);
      updateResultsDisplay();
    });
  }

  console.log('事件监听设置完成');
}

// 修改更新结果显示函数
async function updateResultsDisplay() {
  const container = document.getElementById(CONTAINER_ID);
  if (!container) {
    console.log('未找到AI助手容器，跳过更新显示');
    return;
  }
  
  // 获取当前结果
  const currentResults = window.resumeManager.analysisResults || [];
  console.log('当前结果数量:', currentResults.length);
  // 加载已下载简历列表，用于标记"已下载"
  var dlRecs = [];
  try { dlRecs = await window.ResumeDB.loadDownloaded(); } catch(e) {}
  var dlNames = new Set();
  var dlCloudMap = {};
  for (var dr = 0; dr < dlRecs.length; dr++) {
    if (dlRecs[dr].name) dlNames.add(dlRecs[dr].name);
    if (dlRecs[dr].name && dlRecs[dr].cloud) dlCloudMap[dlRecs[dr].name] = dlRecs[dr].cloud;
  }

  // 获取当前阈值
  const { scoreThreshold = 80 } = await new Promise(resolve => {
    chrome.storage.sync.get(['scoreThreshold'], resolve);
  });

  // 获取过滤器状态
  const filterCheckbox = container.querySelector('.qualified-filter');
  const showOnlyQualified = filterCheckbox?.checked || false;
  const dateSelect = container.querySelector('.date-filter');
  const dateFilter = dateSelect ? dateSelect.value : 'all';
  console.log('过滤器状态:', showOnlyQualified ? '仅显示达标' : '显示全部', '日期:', dateFilter);
  
  // 日期过滤函数
  function inDateRange(ts) {
    if (dateFilter === 'all') return true;
    var d = new Date(ts);
    var now = new Date();
    var todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (dateFilter === 'today') return d >= todayStart;
    if (dateFilter === 'yesterday') {
      var yest = new Date(todayStart); yest.setDate(yest.getDate() - 1);
      return d >= yest && d < todayStart;
    }
    if (dateFilter === '7days') { var d7 = new Date(todayStart); d7.setDate(d7.getDate() - 7); return d >= d7; }
    if (dateFilter === '30days') { var d30 = new Date(todayStart); d30.setDate(d30.getDate() - 30); return d >= d30; }
    return true;
  }

  // 更新结果数量
  const resultsCount = container.querySelector('.results-count');
  if (resultsCount) {
    var dateFilteredCount = currentResults.filter(function(r) { return inDateRange(r.timestamp); }).length;
    var qualifiedCount = currentResults.filter(function(r) { return (r.evaluation?.score || 0) >= scoreThreshold && inDateRange(r.timestamp); }).length;
    resultsCount.textContent = showOnlyQualified
      ? `已显示 ${qualifiedCount} / ${dateFilteredCount} 份达标简历`
      : `已分析 ${dateFilteredCount} 份简历`;
  }
  
  // 获取或创建结果列表容器
  let resultsListContainer = container.querySelector('.results-list');
  if (!resultsListContainer) {
    console.log('创建新的结果列表容器');
    resultsListContainer = document.createElement('div');
    resultsListContainer.className = 'results-list';
    
    const resultsContainer = container.querySelector('.hr-results');
    if (resultsContainer) {
      resultsContainer.appendChild(resultsListContainer);
    }
  }

  // 清空旧的结果
  resultsListContainer.innerHTML = '';
  
  // 按时间倒序显示结果（新→旧），显式按 timestamp 排序，不依赖数组原始顺序
  currentResults.slice().sort(function(a, b) {
    return new Date(b.timestamp || 0) - new Date(a.timestamp || 0);
  }).forEach(result => {
    const score = result.evaluation?.score || 0;
    const isQualified = score >= scoreThreshold;

    // 日期过滤
    if (!inDateRange(result.timestamp)) return;
    // 如果启用了过滤器且简历不达标，则跳过
    if (showOnlyQualified && !isQualified) {
      return;
    }

    const resultItem = document.createElement('div');
    resultItem.className = 'result-item';
    
    const latestWork = result.workExperiences?.[0] || {};
    
    // 创建基本信息区域
    const basicInfo = document.createElement('div');
    basicInfo.className = 'result-basic-info';
    
    // 左侧信息
    const basicInfoLeft = document.createElement('div');
    basicInfoLeft.className = 'basic-info-left';
    var isDownloaded = dlNames.has(result.name);
    var cloudUrl = dlCloudMap[result.name] || '';
    basicInfoLeft.innerHTML = `
      <span class="candidate-name">${result.name || '未知'}${isDownloaded ? ' <span style="font-size:10px;color:#52c41a;border:1px solid #52c41a;border-radius:3px;padding:0 4px;margin-left:4px;">已下载</span>' : ''}${cloudUrl ? ' <a href="'+cloudUrl+'" target="_blank" style="font-size:10px;color:#1677ff;margin-left:4px;">☁PDF</a>' : ''}</span>
      <span class="candidate-info">
        ${result.age ? result.age + '岁' : ''} ·
        ${result.currentCompany || latestWork.company || '未知公司'}
      </span>
    `;
    
    // 右侧信息
    const basicInfoRight = document.createElement('div');
    basicInfoRight.className = 'basic-info-right';
    basicInfoRight.innerHTML = `
      <span class="score ${score >= scoreThreshold ? 'score-pass' : 'score-fail'}">${score}分</span>
      ${result.position ? `
        <button class="locate-button" title="定位到简历位置">
          <svg viewBox="0 0 24 24" width="14" height="14">
            <path fill="currentColor" d="M12 11.5A2.5 2.5 0 0 1 9.5 9 2.5 2.5 0 0 1 12 6.5 2.5 2.5 0 0 1 14.5 9a2.5 2.5 0 0 1-2.5 2.5M12 2a7 7 0 0 0-7 7c0 5.25 7 13 7 13s7-7.75 7-13a7 7 0 0 0-7-7z"/>
          </svg>
        </button>` : ''}
      <button class="download-resume-btn" title="下载简历文本">
        <svg viewBox="0 0 24 24" width="14" height="14">
          <path fill="currentColor" d="M5,20H19V18H5M19,9H15V3H9V9H5L12,16L19,9Z"/>
        </svg>
      </button>
      <svg class="expand-icon" viewBox="0 0 24 24" width="14" height="14">
        <path fill="currentColor" d="M7.41,8.58L12,13.17L16.59,8.58L18,10L12,16L6,10L7.41,8.58Z" />
      </svg>
    `;
    
    basicInfo.appendChild(basicInfoLeft);
    basicInfo.appendChild(basicInfoRight);
    resultItem.appendChild(basicInfo);
    
    // 创建详细信息区域
    const details = document.createElement('div');
    details.className = 'result-details';
    details.style.display = 'none';
    details.innerHTML = `
      ${result.evaluation?.suggestion ? `
        <div class="result-suggestion">${result.evaluation.suggestion}</div>` : ''}
      ${result.evaluation ? `
        <div class="result-score-details">
          <h4>评分明细：</h4>
          <div class="base-score">
            <span class="detail-key">基础分：</span>
            <span class="detail-value">${result.evaluation.details?.baseScore || 0}</span>
          </div>
          ${result.evaluation.details?.additions ? `
            <div class="additions-list">
              <div class="detail-key">评分标准：</div>
              <ul>
                ${Array.isArray(result.evaluation.details.additions) ? 
                  result.evaluation.details.additions.map(addition => `
                    <li class="addition-item">
                      <div class="score-rule">
                        <span class="rule-name">${addition.rule}</span>
                        <span class="score-value ${addition.score > 0 ? 'positive' : ''}">${addition.score}分</span>
                      </div>
                      <div class="score-reason">${addition.reason}</div>
                    </li>
                  `).join('') : 
                  `<li class="addition-item">无评分明细</li>`
                }
              </ul>
            </div>
          ` : ''}
        </div>` : ''}
      ${result.resumeImage ? `<div class="result-screenshot"><div class="detail-key">简历截图：</div><img src="${result.resumeImage}" class="resume-thumb" style="max-width:100%;border:1px solid #eee;border-radius:4px;margin-top:4px;cursor:zoom-in;" title="点击查看大图"/></div>` : ''}
      ${result.shareCardImage ? `<div class="result-screenshot"><div class="detail-key">分享卡片：</div><img src="${result.shareCardImage}" class="resume-thumb" style="max-width:100%;border:1px solid #eee;border-radius:4px;margin-top:4px;cursor:zoom-in;" title="点击查看大图"/></div>` : ''}
      <div class="timestamp">分析时间：${new Date(result.timestamp).toLocaleString()}</div>
    `;
    resultItem.appendChild(details);

    // 缩略图点击 → 全屏大图
    details.querySelectorAll('.resume-thumb').forEach(thumb => {
      thumb.addEventListener('click', (e) => {
        e.stopPropagation();
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:2147483647;display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:20px;cursor:zoom-out;';
        const big = document.createElement('img');
        big.src = thumb.src;
        big.style.cssText = 'max-width:90%;height:auto;border-radius:4px;';
        overlay.appendChild(big);
        overlay.addEventListener('click', () => overlay.remove());
        document.body.appendChild(overlay);
      });
    });

    // 为定位按钮添加独立的点击事件
    const locateButton = basicInfoRight.querySelector('.locate-button');
    if (locateButton) {
      locateButton.addEventListener('click', async (e) => {
        e.stopPropagation(); // 阻止事件冒泡
        
        // 获取所有iframe
        const iframes = Array.from(document.querySelectorAll('iframe'));
        let targetElement = null;
        let targetIframe = null;

        // 首先尝试从result中获取resumeId
        const resumeId = result.position?.resumeId;
        if (!resumeId) {
          console.warn('简历数据中缺少resumeId信息');
          return;
        }

        // 遍历所有iframe寻找目标元素
        for (const iframe of iframes) {
          try {
            if (iframe.contentDocument) {
              // 使用data-expect属性查找元素
              const element = iframe.contentDocument.querySelector(`a[data-expect='${resumeId}']`) ||
              iframe.contentDocument.querySelector(`div[data-geekid='${resumeId}']`) ||
              iframe.contentDocument.querySelector(`div[data-geek='${resumeId}']`) ||
              iframe.contentDocument.querySelector(`div[data-id='${resumeId}-0']`)
              
              
              if (element) {
                console.log('找到目标元素，resumeId:', resumeId);
                targetElement = element;
                targetIframe = iframe;
                break;
              } else {
                console.log('在当前iframe中未找到resumeId为', resumeId, '的元素');
              }
            }
          } catch (error) {
            console.log('在当前iframe中查找元素失败:', error);
            continue;
          }
        }

        const highlightStyle = `
          @keyframes highlight-border {
            0% {
              outline: 2px solid #1890ff;
              box-shadow: 0 0 8px #1890ff;
              background-color: rgba(24, 144, 255, 0.1);
            }
            50% {
              outline: 2px solid transparent;
              box-shadow: none;
              background-color: transparent;
            }
            100% {
              outline: 2px solid #1890ff;
              box-shadow: 0 0 8px #1890ff;
              background-color: rgba(24, 144, 255, 0.1);
            }
          }
          .highlight-element {
            animation: highlight-border 1s ease-in-out 3 !important;
            position: relative !important;
            z-index: 10000 !important;
          }
        `;
        
        // 首先尝试在 targetIframe 中查找，如果找不到则在主文档中查找
        const foundElement = targetIframe?.contentDocument?.querySelector(`a[data-expect='${resumeId}']`) ||
                           targetIframe?.contentDocument?.querySelector(`div[data-geekid='${resumeId}']`) ||
                           targetIframe?.contentDocument?.querySelector(`div[data-geek='${resumeId}']`) ||
                           targetIframe?.contentDocument?.querySelector(`div[data-id='${resumeId}-0']`) ||
                           document.querySelector(`a[data-expect='${resumeId}']`) ||
                           document.querySelector(`div[data-geekid='${resumeId}']`) ||
                           document.querySelector(`div[data-geek='${resumeId}']`) ||
                           document.querySelector(`div[data-id='${resumeId}-0']`);
        const targetDoc = targetIframe?.contentDocument || document;
        
        if (!foundElement) {
          console.log('未找到目标元素:', `a[data-expect='${resumeId}']`, `div[data-geekid='${resumeId}']`, `div[data-geek='${resumeId}']`, `div[data-id='${resumeId}-0']`);
          return;
        }
        
        // 检查是否已存在样式元素
        let styleElement = targetDoc.querySelector('#highlight-style');
        if (!styleElement) {
          styleElement = targetDoc.createElement('style');
          styleElement.id = 'highlight-style';
          targetDoc.head.appendChild(styleElement);
        }
        styleElement.textContent = highlightStyle;
        
        // 移除其他元素的高亮效果
        const highlightedElements = targetDoc.querySelectorAll('.highlight-element');
        highlightedElements.forEach(el => el.classList.remove('highlight-element'));
        
        // 滚动到元素位置
        foundElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
        
        // 添加高亮效果
        foundElement.classList.add('highlight-element');
        
        // 3秒后移除高亮效果
        setTimeout(() => {
          foundElement.classList.remove('highlight-element');
        }, 3000);
      });
    }
    
    // 为下载简历按钮添加独立的点击事件
    const downloadBtn = basicInfoRight.querySelector('.download-resume-btn');
    if (downloadBtn) {
      downloadBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        downloadSingleResume(result);
      });
    }

    // 添加展开/折叠点击事件
    basicInfo.addEventListener('click', function(e) {
      // 如果点击的是定位按钮或下载按钮，不处理折叠逻辑
      if (e.target.closest('.locate-button') || e.target.closest('.download-resume-btn')) {
        return;
      }
      
      // 展开/折叠详细信息
      const details = this.nextElementSibling;
      const expandIcon = this.querySelector('.expand-icon');
      if (details.style.display === 'none') {
        details.style.display = 'block';
        expandIcon.style.transform = 'rotate(180deg)';
      } else {
        details.style.display = 'none';
        expandIcon.style.transform = 'rotate(0)';
      }
    });
    
    resultsListContainer.appendChild(resultItem);
  });

  // 自动滚动到顶部，确保最新结果可见（最新简历倒序排在列表顶部）
  if (resultsListContainer.children.length > 0) {
    setTimeout(() => {
      resultsListContainer.scrollTop = 0;
    }, 100);
  }

  console.log('结果显示更新完成，共', currentResults.length, '条');
}

// 强制刷新结果显示（解决缓存不一致问题）
async function forceRefreshDisplay() {
  await window.resumeManager.loadAnalysisResults();
  await updateResultsDisplay();
}

// 修改下载结果函数
// 取当前面板筛选条件下的结果（日期+达标），挂 window 供 templates.js 复用
function getFilteredResults(scoreThreshold) {
window.getFilteredResults = getFilteredResults;
  if (scoreThreshold === undefined) scoreThreshold = 80;
  var results = window.resumeManager.analysisResults || [];
  if (!results.length) return [];
  var container = document.getElementById(CONTAINER_ID);
  var showQualified = container?.querySelector('.qualified-filter')?.checked || false;
  var dateVal = container?.querySelector('.date-filter')?.value || 'today';

  function inDate(ts) {
    if (dateVal === 'all') return true;
    var d = new Date(ts), now = new Date();
    var ts0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (dateVal === 'today') return d >= ts0;
    if (dateVal === 'yesterday') { var y = new Date(ts0); y.setDate(y.getDate()-1); return d >= y && d < ts0; }
    if (dateVal === '7days') { var d7 = new Date(ts0); d7.setDate(d7.getDate()-7); return d >= d7; }
    if (dateVal === '30days') { var d30 = new Date(ts0); d30.setDate(d30.getDate()-30); return d >= d30; }
    return true;
  }

  return results.filter(function(r) {
    if (!inDate(r.timestamp)) return false;
    if (showQualified && (r.evaluation?.score || 0) < scoreThreshold) return false;
    return true;
  });
}

function downloadResults() {
  console.log('开始下载结果');
  chrome.storage.sync.get(['scoreThreshold'], ({ scoreThreshold = 80 }) => {
    var filtered = getFilteredResults(scoreThreshold);
    const sortedResults = filtered.sort((a, b) => {
      const scoreA = a.evaluation?.score || 0;
      const scoreB = b.evaluation?.score || 0;
      return scoreB - scoreA;
    });

    // 计算统计信息
    const totalCount = sortedResults.length;
    const qualifiedCount = sortedResults.filter(r => r.evaluation?.score >= scoreThreshold).length;
    const averageScore = sortedResults.reduce((sum, r) => sum + (r.evaluation?.score || 0), 0) / totalCount;

    console.log('准备生成导出内容', {
      totalCount,
      qualifiedCount,
      averageScore,
      sortedResults
    });

    // 生成 HTML 内容
    const htmlContent = window.templates.exportTemplate({
      totalCount,
      qualifiedCount,
      averageScore,
      sortedResults,
      scoreThreshold
    });

    // 创建下载链接
    const blob = new Blob([htmlContent], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `BOSS直聘助手_${new Date().toLocaleDateString()}.html`;
    
    console.log('触发下载');
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });
}

// 生成单份简历文本
function formatResumeDoc(result) {
  var e = result.evaluation || {};
  var imgTag = result.resumeImage ? '<p><b>简历截图：</b></p><p><img src="'+result.resumeImage+'" width="500" /></p>' : '';
  var cardTag = result.shareCardImage ? '<p><b>分享卡片：</b></p><p><img src="'+result.shareCardImage+'" width="350" /></p>' : '';
  var works = (result.workExperiences||[]).map(function(w,i){return '<tr><td>'+(i+1)+'</td><td>'+(w.company||'')+'</td><td>'+(w.title||'')+'</td><td>'+(w.period||'')+'</td><td>'+(w.description||'')+'</td></tr>';}).join('');
  var projs = (result.projectExperiences||[]).map(function(p,i){return '<tr><td>'+(i+1)+'</td><td>'+(p.name||'')+'</td><td>'+(p.period||'')+'</td><td>'+(p.description||'')+'</td></tr>';}).join('');
  var edu = result.educationInfo || {};
  var ds = {}; try { ds = result.dsParsed ? JSON.parse(result.dsParsed) : {}; } catch(ex) {}
  return '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="UTF-8"><title>'+(result.name||'简历')+'</title>'+
'<style>'+
'body{font-family:SimSun,宋体;font-size:12pt;line-height:1.6;margin:72pt 72pt 72pt 72pt;}'+
'h1{font-size:18pt;text-align:center;border-bottom:2pt solid #1a73e8;padding-bottom:8pt;margin-bottom:16pt;}'+
'h2{font-size:14pt;color:#1a73e8;margin-top:16pt;margin-bottom:8pt;}'+
'table{border-collapse:collapse;width:100%;margin:8pt 0;}'+
'th{background:#1a73e8;color:white;padding:4pt 6pt;text-align:left;font-size:11pt;}'+
'td{border:1pt solid #999;padding:4pt 6pt;font-size:10pt;vertical-align:top;}'+
'.score{font-size:20pt;font-weight:bold;color:#1a73e8;margin:8pt 0;}'+
'.tip{margin:8pt 0;padding:8pt;border:1pt solid #1a73e8;font-size:11pt;}'+
'p{margin:4pt 0;}'+
'</style></head><body>'+
'<h1>BOSS直聘助手 - 简历报告</h1>'+
'<h2>基本信息</h2>'+
'<p><b>姓名：</b>'+(result.name||'?')+'&nbsp;&nbsp;&nbsp;<b>年龄：</b>'+(result.age||'?')+'&nbsp;&nbsp;&nbsp;<b>学历：</b>'+(result.education||'?')+'&nbsp;&nbsp;&nbsp;<b>经验：</b>'+(result.experience||'?')+'</p>'+
'<p><b>公司：</b>'+(result.currentCompany||'?')+'&nbsp;&nbsp;&nbsp;<b>职位：</b>'+(result.currentTitle||'?')+'</p>'+
'<p><b>城市：</b>'+(result.expectCity||'?')+'&nbsp;&nbsp;&nbsp;<b>期望：</b>'+(result.expectPosition||'?')+'&nbsp;&nbsp;&nbsp;<b>薪资：</b>'+(result.expectSalary||'?')+'</p>'+
(imgTag||cardTag?'<h2>附件</h2>'+imgTag+cardTag:'')+
(works?'<h2>工作经历</h2><table><tr><th>#</th><th>公司</th><th>职位</th><th>时间</th><th>描述</th></tr>'+works+'</table>':'')+
(projs?'<h2>项目经验</h2><table><tr><th>#</th><th>项目</th><th>时间</th><th>描述</th></tr>'+projs+'</table>':'')+
(edu.school?'<h2>教育经历</h2><p>'+(edu.school||'')+' | '+(edu.major||'')+' | '+(edu.degree||'')+' | '+(edu.period||'')+'</p>':'')+
(result.skills?'<h2>技能</h2><p>'+result.skills+'</p>':'')+
'<h2>AI 评估</h2><p class="score">'+(e.score||0)+'分</p>'+
(e.suggestion?'<div class="tip"><b>建议：</b>'+e.suggestion+'</div>':'')+
(result.fullText?'<h2>OCR 原文</h2><p style="font-size:9pt;white-space:pre-wrap;">'+result.fullText.replace(/&/g,'&amp;').replace(/</g,'&lt;')+'</p>':'')+
'<p style="text-align:right;color:#999;font-size:9pt;margin-top:24pt;">分析时间：'+new Date(result.timestamp).toLocaleString()+'</p>'+
'</body></html>';
}

function downloadSingleResume(result) {
  var html = formatResumeDoc(result);
  var name = (result.name || '未知').replace(/[*<>:"/\\|?]/g,'');
  var blob = new Blob([html], { type: 'application/msword;charset=utf-8' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '简历_'+name+'_'+new Date().toLocaleDateString()+'.doc';
  a.click();
  console.log('已下载Word: ' + name);
}

// 批量下载简历（遵循面板筛选条件）
async function downloadAllResumes() {
  const { scoreThreshold = 80 } = await new Promise(resolve => {
    chrome.storage.sync.get(['scoreThreshold'], resolve);
  });

  const toDownload = getFilteredResults(scoreThreshold);
  const allCount = (window.resumeManager.analysisResults || []).length;
  var container = document.getElementById(CONTAINER_ID);
  var showQualified = container?.querySelector('.qualified-filter')?.checked || false;
  var dateVal = container?.querySelector('.date-filter')?.value || 'today';
  var dateLabel = dateVal === 'today' ? '今天' : dateVal === 'yesterday' ? '昨天' : dateVal === '7days' ? '近7天' : dateVal === '30days' ? '近30天' : '全部';
  var desc = (showQualified ? '达标' : '') + dateLabel;

  if (toDownload.length === 0) {
    alert(`当前筛选条件下没有简历可下载`);
    return;
  }

  if (confirm(`即将逐份下载 ${toDownload.length} 份${desc}简历（共 ${allCount} 份）。\\n\\n点击"确定"逐份下载，"取消"仅下载合并文件`)) {
    // 逐份下载
    toDownload.forEach((r, i) => {
      setTimeout(() => downloadSingleResume(r), i * 300);
    });
  } else {
    // 合并下载
    downloadResumesAsZip(toDownload);
  }
}

// 合并多份简历为单个 Word 文档（每份 = 单份下载 + 分页符）
function downloadResumesAsZip(results) {
  // 提取 formatResumeDoc 的 body 内容，分页符隔开
  var bodies = results.map(function(r, i) {
    var full = formatResumeDoc(r);
    var bm = full.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    var inner = bm ? bm[1] : full;
    return inner + (i < results.length-1 ? '<br clear="all" style="mso-special-character:line-break;page-break-before:always" />' : '');
  }).join('');

  var sm = formatResumeDoc(results[0]).match(/<style[^>]*>([\s\S]*)<\/style>/i);
  var style = sm ? sm[0] : '';
  var html = '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="UTF-8">' + style + '</head><body>' + bodies + '</body></html>';

  var blob = new Blob([html], { type: 'application/msword;charset=utf-8' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '简历汇总_' + results.length + '份_' + new Date().toLocaleDateString() + '.doc';
  a.click();
}

// 获取用户设置的评分阈值
function getUserScoreThreshold() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(['scoreThreshold'], (result) => {
      resolve(result.scoreThreshold || 80);
    });
  });
}

// 获取当前环境设置
async function getCurrentEnvironment() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(['apiEnvironment'], (result) => {
      resolve(result.apiEnvironment || 'development');
    });
  });
}

// 获取API密钥（优先从 sync 获取，没有则从 local 获取）
async function getApiKey() {
  return new Promise((resolve) => {
    // 先从 sync 获取
    chrome.storage.sync.get(['apiKey'], (syncResult) => {
      if (syncResult.apiKey) {
        console.log('[Debug] 从 storage.sync 获取到 apiKey');
        resolve(syncResult.apiKey);
      } else {
        // 从 local 获取
        chrome.storage.local.get(['apiKey'], (localResult) => {
          console.log('[Debug] 从 storage.local 获取 apiKey:', localResult.apiKey ? '有值' : '空');
          resolve(localResult.apiKey || '');
        });
      }
    });
  });
}

// Pro 版：生成稳定的设备指纹（多维度，删插件后仍一致，用于防换IP绕过）
function getDeviceFingerprint() {
  try {
    var parts = [
      navigator.hardwareConcurrency || 0,
      navigator.deviceMemory || 0,
      screen.width + 'x' + screen.height,
      screen.colorDepth || 0,
      (navigator.platform || ''),
      (navigator.language || ''),
      (Intl.DateTimeFormat().resolvedOptions().timeZone || ''),
      (navigator.maxTouchPoints || 0)
    ];
    var str = 'pro_' + parts.join('|');
    var h = 0;
    for (var i = 0; i < str.length; i++) { h = ((h << 5) - h + str.charCodeAt(i)) | 0; }
    return 'dev_' + (h >>> 0).toString(16);
  } catch(e) { return 'dev_fallback'; }
}
window.getDeviceFingerprint = getDeviceFingerprint;

// Pro 版：试用检查（后端记录次数，前端不存）
async function checkProActivation() {
  if (!('$$IS_PAID$$' === 'true')) return;
  try {
    var actResult = await new Promise(function(r) { chrome.storage.local.get(['pro_activated', 'pro_trial_remaining', 'pro_trial_claimed'], r); });
    var isActivated = actResult.pro_activated;
    var remaining = actResult.pro_trial_remaining;
    var claimed = actResult.pro_trial_claimed;

    // 首次或缓存无数据 → 调后端
    if (!isActivated && (remaining === undefined || !claimed)) {
      try {
        var dev = getDeviceFingerprint();
        // 先注册 trial/claim
        var claimResult = await new Promise(function(resolve, reject) {
          chrome.runtime.sendMessage({ action: 'trialProxy', body: { action: 'claim', device: dev } }, function(r) {
            if (r && r.ok) resolve(r.data); else reject(new Error(r?.error));
          });
        });
        remaining = claimResult.remaining;
        await new Promise(function(r) { chrome.storage.local.set({ 'pro_trial_remaining': remaining, 'pro_trial_claimed': true }, r); });
      } catch(e) {
        // 后端不通 → 用缓存兜底
        console.warn('Trial claim failed:', e.message);
        remaining = remaining !== undefined ? remaining : 10;
      }
    }

    var container = document.getElementById('errorContainer');
    if (container) {
      var msg = container.querySelector('#errorMessage');
      if (msg) {
        if (remaining > 0) {
          msg.innerHTML = '🎁 <b>剩余 ' + remaining + ' 次</b>';
          container.style.background = remaining >= 50 ? '#f6ffed' : '#fff2f0';
          container.style.border = remaining >= 50 ? '1px solid #b7eb8f' : '1px solid #ffccc7';
        } else {
          msg.innerHTML = '⚠️ <b>次数已用完</b>';
          container.style.background = '#fff2f0'; container.style.border = '1px solid #ffccc7';
        }
        container.classList.add('show');
      }
    }
  } catch(e) { console.warn('Pro check:', e.message); }
}

// Pro 版：每次分析消耗1次试用（后端记录，防篡改）
async function consumeTrial() { window.consumeTrial = consumeTrial;
  if (!('$$IS_PAID$$' === 'true')) return;
  try {
    var actResult = await new Promise(function(r) { chrome.storage.local.get(['pro_activated'], r); });
    if (actResult.pro_activated) return;
    // 调后端记录消耗（带设备指纹）
    var data = await new Promise(function(resolve, reject) {
      chrome.runtime.sendMessage({ action: 'trialProxy', body: { action: 'use', activated: false, device: getDeviceFingerprint() } }, function(r) {
        if (r && r.ok) resolve(r.data); else reject(new Error(r?.error));
      });
    });
    // 本地缓存剩余次数
    await new Promise(function(r) { chrome.storage.local.set({ 'pro_trial_remaining': data.remaining }, r); });
    checkProActivation();
  } catch(e) { console.warn('Trial use failed:', e.message); }
}

// 获取剩余积分（试用次数用完且未激活时阻止）
async function getCredit() {
  // 免费版不检查积分
  if (!('$$CREDITS_REQUIRED$$' === 'true')) {
    return 999999;
  }
  // Pro 版：后端查试用状态（次数由服务端控制）
  try {
    var actChk = await new Promise(function(r) { chrome.storage.local.get(['pro_activated', 'pro_trial_remaining'], r); });
    if (actChk.pro_activated) return 999999;
    if ((actChk.pro_trial_remaining || 0) > 0) return 999999;
    // 本地缓存用完 → 同步后端一次
    try {
      var statusData = await new Promise(function(resolve, reject) {
        chrome.runtime.sendMessage({ action: 'trialProxy', body: { action: 'status', activated: false, device: getDeviceFingerprint() } }, function(rr) {
          if (rr && rr.ok) resolve(rr.data); else reject(new Error(rr?.error));
        });
      });
      if (statusData.remaining === -1 || statusData.remaining > 0) {
        await new Promise(function(rr) { chrome.storage.local.set({ 'pro_trial_remaining': statusData.remaining }, rr); });
        return 999999;
      }
    } catch(e) {}
    return 0; // 试用用完或网络异常
  } catch (error) {
    console.error('获取积分出错:', error);
    return 0;
  }
}

// 添加快捷键支持
function addKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      stopAnalysis();
    }
  });
}

// 修改后的 startAIAnalysis 函数
async function startAIAnalysis() {
  // 如果正在分析中，则停止分析
  if (isAnalyzing) {
    console.log('停止当前分析');
    stopAnalysis();
    return;
  }

  // 防止重复启动
  if (analysisLock) {
    console.log('分析已被锁定，请等待');
    return;
  }

  // 检查配置是否完整
  const config = window.resumeManager.currentConfig;
  if (!config) {
    alert('配置信息未加载，请刷新页面重试');
    return;
  }

  // 异步检查API密钥
  async function checkApiKey() {
    // 免费版跳过密钥校验
    if (!('$$CREDITS_REQUIRED$$' === 'true')) return true;
    try {
      // 检查自定义 API 配置
      let customApiConfig;
      try {
        const result = await chrome.storage.local.get(['customApiConfig']);
        customApiConfig = result.customApiConfig;
      } catch (e) {
        if (e.message?.includes('Extension context invalidated')) {
          alert('插件已更新，请按 F5 刷新 Boss直聘页面后重新使用');
          stopAnalysis();
          return false;
        }
        throw e;
      }

      if (customApiConfig && customApiConfig.model) {
        // DeepSeek 已迁移到后端代理，前端不需要 apiKey
        return true;
      }

      // 配置不存在，写入默认配置
      console.warn('API 配置不完整，写入默认配置');
      try {
        await chrome.storage.local.set({
          apiMode: 'custom',
          customApiConfig: {
            model: 'deepseek-chat',
            systemPrompt: ''
          }
        });
      } catch (e) {
        if (e.message?.includes('Extension context invalidated')) {
          alert('插件已更新，请按 F5 刷新 Boss直聘页面后重新使用');
          stopAnalysis();
          return false;
        }
        throw e;
      }
      return true;
    } catch (error) {
      console.error('检查API密钥时出错:', error);
      alert('插件已更新，请按 F5 刷新 Boss直聘页面后重试');
      return false;
    }
  }

  // 在使用API之前调用此函数
  const keyIsValid = await checkApiKey();
  if (!keyIsValid) {
    return; // 停止后续操作
  }

  // 检查评分阈值
  if (!config.scoreThreshold) {
    alert('请先在扩展设置中配置评分阈值');
    return;
  }

  const button = document.querySelector('.hr-action-btn');
  console.log('开始分析简历');
  isAnalyzing = true;

  try {
    // 收费版：检查积分，不足则阻止
    if ('$$CREDITS_REQUIRED$$' === 'true') {
      const credit = await getCredit();
      if (credit <= 0) {
        alert('积分不足，请先充值');
        stopAnalysis();
        return;
      }
    }

    if (button) {
      button.classList.add('processing');
      button.style.backgroundColor = '#ff4d4f';
      const randomMessage = workingMessages[Math.floor(Math.random() * workingMessages.length)];
      button.innerHTML = `
        <svg class="button-icon spinning" viewBox="0 0 24 24" width="16" height="16">
          <path fill="currentColor" d="M12,4V2A10,10 0 0,0 2,12H4A8,8 0 0,1 12,4Z">
            <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite"/>
          </path>
        </svg>
        AI正在努力工作...
      `;
    }
    
    // 加载已分析的简历ID
    await window.resumeManager.loadAnalyzedResumeIds();
    console.log('已加载分析记录');

    // 根据页面路径选择不同的处理函数
    const path = window.location.pathname;
    
    // 创建一个可取消的Promise
    let runAnalysis;
    
    const analysisPromise = new Promise(async (resolve, reject) => {
      try {
        // 存储当前运行的分析Promise，以便可以检查它是否被中断
        runAnalysis = { resolve, reject };
        
        // 选择并执行相应的处理函数
        if (path.includes('/web/chat/search')) {
          await handleSearchPageAnalysis(button);
        } else if (path.includes('/web/chat/index')) {
          showError('沟通页面暂不支持 AI 读简历，请在「搜索」或「推荐牛人」页面使用');
          isAnalyzing = false;
          stopAnalysis();
          return;
        } else if (path.includes('/web/chat/recommend')) {
          await handleRecommendPageAnalysis(button);
        }
        resolve();
      } catch (error) {
        if (isAnalyzing) { // 只有在分析仍在进行时才报告错误
          console.error('分析过程中发生错误:', error);
          reject(error);
        } else {
          // 分析已停止，这是预期行为
          resolve();
        }
      }
    });
    
    // 监听分析状态变化
    const checkIsAnalyzing = setInterval(() => {
      if (!isAnalyzing && runAnalysis) {
        clearInterval(checkIsAnalyzing);
        // 正常结束当前执行的Promise
        runAnalysis.resolve();
        runAnalysis = null;
      }
    }, 500);
    
    // 等待分析完成或被中断
    await analysisPromise;
    
    // 清理
    clearInterval(checkIsAnalyzing);
    
  } catch (error) {
    console.error('分析过程出错:', error);
    if (isAnalyzing) { // 只有当仍在分析时才显示错误
      alert(error.message);
    }
    stopAnalysis();
  }
}

// 修改原来的 stopAnalysis 函数
function stopAnalysis() {
  console.log('停止分析流程');
  
  // 先设置标志，中断所有进行中的流程
  isAnalyzing = false;
  analysisLock = false;
  isScrolling = false;
  scrollStuckCount = 0;
  
  // 清除所有可能存在的定时器
  const timers = window.setTimeout(() => {}, 0);
  for (let i = 0; i < timers; i++) {
    window.clearTimeout(i);
  }
  
  // 重置按钮状态
  const button = document.querySelector('.hr-action-btn');
  if (button) {
    button.classList.remove('processing');
    button.classList.remove('success');
    button.style.backgroundColor = '';
    button.innerHTML = `
      <svg class="button-icon" viewBox="0 0 24 24" width="16" height="16">
        <path fill="currentColor" d="M13 24q-2.5 0-4.75-0.95t-3.875-2.575q-1.625-1.625-2.575-3.875t-0.95-4.75q0-2.5 0.95-4.75t2.575-3.875q1.625-1.625 3.875-2.575t4.75-0.95q2.5 0 4.75 0.95t3.875 2.575q1.625 1.625 2.575 3.875t0.95 4.75q0 2.5-0.95 4.75t-2.575 3.875q-1.625 1.625-3.875 2.575t-4.75 0.95zM13 22q2.075 0 3.9-0.788t3.175-2.137q1.35-1.35 2.137-3.175t0.788-3.9q0-2.075-0.788-3.9t-2.137-3.175q-1.35-1.35-3.175-2.137t-3.9-0.788q-2.075 0-3.9 0.788t-3.175 2.137q-1.35 1.35-2.138 3.175t-0.787 3.9q0 2.075 0.787 3.9t2.138 3.175q1.35 1.35 3.175 2.137t3.9 0.788zM13 18q-1.65 0-2.825-1.175t-1.175-2.825q0-1.65 1.175-2.825t2.825-1.175q1.65 0 2.825 1.175t1.175 2.825q0 1.65-1.175 2.825t-2.825 1.175zM13 16q0.825 0 1.413-0.588t0.587-1.412q0-0.825-0.587-1.413t-1.413-0.587q-0.825 0-1.412 0.587t-0.588 1.413q0 0.825 0.588 1.412t1.412 0.588z"/>
      </svg>
      AI读简历
    `;
  }
  
  // 尝试关闭所有可能打开的弹窗
  try {
    if (window.resumeManager && window.resumeManager.closeAllResumeDialogs) {
      window.resumeManager.closeAllResumeDialogs(document);
    }
  } catch (error) {
    console.error('关闭弹窗失败:', error);
  }
  
  console.log('分析已完全停止');
}

// 清空结果函数
function clearResults() {
  console.log('显示清空确认对话框');
  
  // 创建确认对话框
  const dialogContainer = document.createElement('div');
  dialogContainer.className = 'hr-dialog-overlay';
  dialogContainer.innerHTML = `
    <div class="hr-dialog">
      <div class="dialog-header">
        <h3>清空确认</h3>
      </div>
      <div class="dialog-content">
        <p>请选择清空的范围：</p>
        <div class="dialog-options">
          <label class="dialog-option-label">
            <input type="radio" name="clearOption" value="results" class="dialog-radio">
            <div class="dialog-option">
              <div class="option-title">仅清空分析结果</div>
              <div class="option-desc">重新评估时将跳过已评估的简历</div>
            </div>
          </label>
          <label class="dialog-option-label">
            <input type="radio" name="clearOption" value="all" class="dialog-radio">
            <div class="dialog-option">
              <div class="option-title">清空全部记录</div>
              <div class="option-desc">清空分析结果和历史分析记录，所有简历将重新评估</div>
            </div>
          </label>
        </div>
      </div>
      <div class="dialog-footer">
        <button class="dialog-button confirm" disabled>确认清空</button>
        <button class="dialog-button cancel">取消</button>
      </div>
    </div>
  `;

  document.body.appendChild(dialogContainer);

  const showContextInvalidatedTip = () => {
    console.warn('扩展上下文已失效，请刷新页面后重试');
    try {
      alert('插件已更新或重载，当前页面脚本已失效。页面将自动刷新，刷新后请重新点击清空。');
    } catch (e) {
      console.warn('提示用户刷新失败:', e);
    }
    setTimeout(() => {
      try {
        window.location.reload();
      } catch (e) {
        console.warn('自动刷新失败，请手动刷新页面:', e);
      }
    }, 200);
  };

  const safeStorageSet = (payload, onSuccess) => {
    try {
      if (!chrome?.runtime?.id) {
        showContextInvalidatedTip();
        return false;
      }
      chrome.storage.local.set(payload, () => {
        if (chrome.runtime.lastError) {
          console.error('写入 storage 失败:', chrome.runtime.lastError.message);
          if (chrome.runtime.lastError.message && chrome.runtime.lastError.message.includes('Extension context invalidated')) {
            showContextInvalidatedTip();
          }
          return;
        }
        onSuccess();
      });
      return true;
    } catch (error) {
      console.error('调用 storage 接口异常:', error);
      if (String(error).includes('Extension context invalidated')) {
        showContextInvalidatedTip();
      }
      return false;
    }
  };

  // 添加事件监听
  const handleClearAction = (action) => {
    console.log('执行清空操作:', action);
    
    if (action === 'results') {
      // 仅清空分析结果
      window.resumeManager.analysisResults = [];
      safeStorageSet({ 'analysisResults': [] }, () => {
        console.log('分析结果已清空');
        updateResultsDisplay();
      });
    } else if (action === 'all') {
      // 清空所有记录
      window.resumeManager.analysisResults = [];
      window.resumeManager.analyzedResumeIds.clear();
      safeStorageSet({
        'analysisResults': [],
        'analyzedResumeIds': []
      }, () => {
        console.log('所有记录已清空');
        updateResultsDisplay();
      });
    }
    
    // 移除对话框
    document.body.removeChild(dialogContainer);
  };

  // 获取按钮和单选框元素
  const confirmButton = dialogContainer.querySelector('.confirm');
  const radioButtons = dialogContainer.querySelectorAll('input[name="clearOption"]');
  let selectedAction = null;

  // 添加单选框change事件
  radioButtons.forEach(radio => {
    radio.addEventListener('change', (e) => {
      selectedAction = e.target.value;
      confirmButton.disabled = false;
    });
  });

  // 绑定按钮事件
  confirmButton.addEventListener('click', () => {
    if (selectedAction) {
      handleClearAction(selectedAction);
    }
  });
  
  dialogContainer.querySelector('.cancel').addEventListener('click', () => {
    document.body.removeChild(dialogContainer);
  });
}

// ====== 备份/恢复数据 ======
async function backupData() {
  try {
    var data = { version: 1, date: new Date().toISOString(), results: [], settings: {} };
    // IndexedDB 数据
    if (window.ResumeDB && window.ResumeDB.loadAll) {
      data.results = await window.ResumeDB.loadAll();
    } else {
      data.results = window.resumeManager?.analysisResults || [];
    }
    // chrome.storage 设置
    var storage = await new Promise(function(r) { chrome.storage.sync.get(null, r); });
    data.settings = storage;
    var daily = await new Promise(function(r) { chrome.storage.local.get(['dailyCounts','analyzedResumeIds'], r); });
    data.daily = daily;

    var json = JSON.stringify(data, null, 2);
    var blob = new Blob([json], {type:'application/json'});
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'BOSS助手备份_' + new Date().toISOString().slice(0,10) + '.json';
    a.click();
    URL.revokeObjectURL(url);
    alert('备份成功！已下载 ' + data.results.length + ' 份简历数据');
  } catch(e) {
    console.error('备份失败:', e);
    alert('备份失败: ' + e.message);
  }
}

function restoreData() {
  var input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = async function() {
    try {
      var file = input.files[0];
      if (!file) return;
      var text = await new Promise(function(r) { var fr = new FileReader(); fr.onload = function(e) { r(e.target.result); }; fr.readAsText(file); });
      var data = JSON.parse(text);
      if (!data.version || !data.results) { alert('无效的备份文件'); return; }
      if (!confirm('即将恢复 ' + data.results.length + ' 份简历数据，当前数据将被覆盖。确认继续？')) return;

      // 恢复 IndexedDB
      if (window.ResumeDB && window.ResumeDB.clear) {
        await window.ResumeDB.clear();
        for (var i = 0; i < data.results.length; i++) {
          await window.ResumeDB.save(data.results[i]);
        }
      }
      // 恢复内存
      window.resumeManager.analysisResults = data.results;
      if (data.settings) await new Promise(function(r) { chrome.storage.sync.set(data.settings, r); });
      if (data.daily) await new Promise(function(r) { chrome.storage.local.set(data.daily, r); });

      updateResultsDisplay();
      alert('恢复成功！已恢复 ' + data.results.length + ' 份简历数据');
    } catch(e) {
      console.error('恢复失败:', e);
      alert('恢复失败: ' + e.message);
    }
  };
  input.click();
}

// 自动滚动函数
async function autoScroll(doc) {
  return new Promise((resolve) => {
    console.log('开始自动滚动');
    const scrollableElement = doc.documentElement;
    isScrolling = true;
    let scrollTimer = null;
    
    // 递归滚动函数
    function scrollDown() {
      // 如果分析已停止，终止滚动
      if (!isAnalyzing) {
        console.log('检测到分析停止，中断滚动');
        isScrolling = false;
        if (scrollTimer) clearTimeout(scrollTimer);
        resolve();
        return;
      }
      
      // 检查是否已到达底部
      const maxScroll = scrollableElement.scrollHeight - scrollableElement.clientHeight;
      const currentScrollTop = scrollableElement.scrollTop;
      
      // 检测滚动是否被卡住
      if (Math.abs(currentScrollTop - lastScrollPosition) < 5) {
        scrollStuckCount++;
        if (scrollStuckCount >= MAX_SCROLL_STUCK) {
          console.log('滚动被卡住，终止滚动');
          isScrolling = false;
          resolve();
          return;
        }
      } else {
        scrollStuckCount = 0;
      }
      lastScrollPosition = currentScrollTop;
      
      // 如果已经到达底部，结束滚动
      if (currentScrollTop >= maxScroll) {
        console.log('已到达页面底部');
        isScrolling = false;
        resolve();
        return;
      }
      
      // 模拟真人滚动：随机滚动距离和间隔
      const scrollAmount = 300 + Math.floor(Math.random() * 500); // 300-800px
      const scrollDelay = 800 + Math.floor(Math.random() * 700);  // 800-1500ms

      scrollableElement.scrollBy({
        top: scrollAmount,
        behavior: 'smooth'
      });

      if (scrollTimer) clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        if (!isAnalyzing) {
          console.log('延时期间检测到分析停止，中断滚动');
          isScrolling = false;
          resolve();
          return;
        }
        scrollDown();
      }, scrollDelay);
    }
    
    // 开始滚动
    scrollDown();
  });
}

// 等待对话框加载函数
function waitForDialog(doc = document, timeout = 10000) {
  return new Promise((resolve, reject) => {
    console.log('等待对话框加载');
    const startTime = Date.now();
    
    const checkDialog = () => {
      if (!isAnalyzing) {
        reject(new Error('用户中断操作'));
        return;
      }

      const dialog = doc.querySelector('.boss-dialog__wrapper') || doc.querySelector('.resume-detail-wrap') || doc.querySelector('div.boss-popup__content > div > div > div.resume-layout-wrap > div') || doc.querySelector('.dialog-container');
      if (dialog) {
        console.log('对话框已加载');
        resolve(dialog);
        return;
      }

      if (Date.now() - startTime > timeout) {
        reject(new Error('等待对话框超时'));
        return;
      }

      setTimeout(checkDialog, 1000);
    };

    checkDialog();
  });
}

// 等待 iframe 中元素的函数
function waitForElementInIframe(doc, selector, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const observer = new MutationObserver(() => {
      const element = doc.querySelector(selector);
      if (element) {
        observer.disconnect();
        resolve(element);
      }
    });
    
    observer.observe(doc.documentElement, {
      childList: true,
      subtree: true
    });
    
    const element = doc.querySelector(selector);
    if (element) {
      observer.disconnect();
      resolve(element);
    }
    
    setTimeout(() => {
      observer.disconnect();
      reject(new Error(`等待元素 ${selector} 超时`));
    }, timeout);
  });
}

function initializeUI() {
  // 创建并添加样式
  const styleSheet = document.createElement('style');
  styleSheet.textContent = styles;
  document.head.appendChild(styleSheet);

  // 创建主容器
  const container = document.createElement('div');
  container.className = 'hr-panel';
  container.innerHTML = template;
  document.body.appendChild(container);

  // 初始化收缩按钮事件
  const collapseButton = container.querySelector('.collapse-button');
  const collapseIcon = collapseButton.querySelector('.collapse-icon');
  const collapseText = collapseButton.querySelector('.collapse-text');
  const resultsContainer = container.querySelector('.hr-results');
  const actionsContainer = container.querySelector('.results-actions');
  
  collapseButton.addEventListener('click', () => {
    container.classList.toggle('collapsed');
  });

  // 初始化错误容器事件
  const errorContainer = document.getElementById('errorContainer');
  const closeBtn = errorContainer.querySelector('.close-btn');
  closeBtn.addEventListener('click', () => {
    errorContainer.classList.remove('show');
  });

  // 初始化其他UI元素
  initializeAnalysisButton();
  initializePinButton();
  
  return container;
}

// 显示错误信息函数
function showError(message) {
  const errorContainer = document.getElementById('errorContainer');
  const errorMessage = document.getElementById('errorMessage');
  
  if (errorContainer && errorMessage) {
    errorMessage.textContent = message;
    errorContainer.classList.add('show');
  } else {
    console.error('错误提示容器未找到，错误信息：', message);
  }
}

async function handleMessage(request, sender, sendResponse) {
  if (analysisLock) {
    console.log('分析已在进行中，跳过新请求');
    return;
  }

  try {
    analysisLock = true;
    
    // 显示工作状态
    const container = document.querySelector('.hr-panel');
    if (container) {
      container.classList.remove('collapsed');
    }
    
    // 更新工作状态文案
    const messageInterval = setInterval(updateWorkingMessage, 2000);
    
    // 发送分析请求
    const response = await fetch(request.url);
    const data = await response.json();
    
    // 清除工作状态更新
    clearInterval(messageInterval);
    
    // 处理响应
    if (data.success) {
      // 更新结果显示
      const resultsList = document.querySelector('.results-list');
      if (resultsList) {
        resultsList.innerHTML = '分析完成！结果：' + JSON.stringify(data.results);
      }
      sendResponse({ success: true });
    } else {
      showError('分析失败：' + (data.error || '未知错误'));
      sendResponse({ success: false, error: data.error });
    }
  } catch (error) {
    console.error('处理消息时发生错误:', error);
    showError('处理请求时发生错误');
    sendResponse({ success: false, error: error.message });
  } finally {
    analysisLock = false;
  }
}

// 更新工作状态文案
function updateWorkingMessage() {
  const messageElement = document.querySelector('.working-message');
  if (messageElement) {
    const randomIndex = Math.floor(Math.random() * workingMessages.length);
    messageElement.textContent = workingMessages[randomIndex];
  }
}

// 初始化
init();