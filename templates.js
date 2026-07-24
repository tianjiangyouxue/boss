// HTML模板
const templates = {
  // 主容器模板
  container: (iconUrl) => `
    <div class="hr-panel-header">
      <div class="header-left">
        <img class="header-icon" src="${iconUrl}" width="20" height="20" alt="BOSS直聘助手">
        <h3 style="margin: 0; font-size: 14px;">BOSS直聘助手</h3>
      </div>
      <div class="header-right">
        <div class="collapse-button" title="收缩/展开面板">
          <svg fill="#000000" width="14px" height="14px" viewBox="0 0 1920 1920" xmlns="http://www.w3.org/2000/svg">
              <path d="M876.612 1043.388v710.171H761.27v-513.28L81.663 1920 0 1838.337l679.72-679.606H166.442v-115.343h710.171ZM1838.394 0l81.548 81.548-679.605 679.72h513.28v115.344h-710.172V166.441h115.344v513.164L1838.394 0Z" fill-rule="evenodd"/>
          </svg>
        </div>
        <div class="pin-button" title="固定/取消固定面板">
          <svg viewBox="0 0 24 24" width="14" height="14">
            <path fill="currentColor" d="M16,12V4H17V2H7V4H8V12L6,14V16H11.2V22H12.8V16H18V14L16,12Z" />
          </svg>
        </div>
      </div>
    </div>
    <div id="errorContainer" class="error-container">
      <span id="errorMessage"></span>
      <span class="close-btn">✕</span>
    </div>
    <div class="hr-tabs" style="display:flex; border-bottom:1px solid #eee; background:#fafafa;">
      <button class="hr-tab active" data-tab="analyze" style="flex:1; padding:8px 0; border:none; background:none; cursor:pointer; font-size:12px; border-bottom:2px solid #06b95d; color:#06b95d; font-weight:500;">🔍 AI读简历</button>
      <button class="hr-tab" data-tab="collect" style="flex:1; padding:8px 0; border:none; background:none; cursor:pointer; font-size:12px; border-bottom:2px solid transparent; color:#666;">📩 求简历</button>
      <button class="hr-tab" data-tab="talent" style="flex:1; padding:8px 0; border:none; background:none; cursor:pointer; font-size:12px; border-bottom:2px solid transparent; color:#666;">👤 人才库</button>
    </div>
    <div class="hr-tab-panel" data-panel="analyze">
    <div class="hr-results">
      <div class="results-header">
        <span class="results-count">已分析 0 份简历</span>
        <button class="hr-action-btn" title="点击开始自动读取简历，再次点击可停止 (快捷键: Esc)">
          <svg class="button-icon" viewBox="0 0 24 24" width="14" height="14">
            <path fill="currentColor" d="M13 24q-2.5 0-4.75-0.95t-3.875-2.575q-1.625-1.625-2.575-3.875t-0.95-4.75q0-2.5 0.95-4.75t2.575-3.875q1.625-1.625 3.875-2.575t4.75-0.95q2.5 0 4.75 0.95t3.875 2.575q1.625 1.625 2.575 3.875t0.95 4.75q0 2.5-0.95 4.75t-2.575 3.875q-1.625 1.625-3.875 2.575t-4.75 0.95zM13 22q2.075 0 3.9-0.788t3.175-2.137q1.35-1.35 2.137-3.175t0.788-3.9q0-2.075-0.788-3.9t-2.137-3.175q-1.35-1.35-3.175-2.137t-3.9-0.788q-2.075 0-3.9 0.788t-3.175 2.137q-1.35 1.35-2.138 3.175t-0.787 3.9q0 2.075 0.787 3.9t2.138 3.175q1.35 1.35 3.175 2.137t3.9 0.788zM13 18q-1.65 0-2.825-1.175t-1.175-2.825q0-1.65 1.175-2.825t2.825-1.175q1.65 0 2.825 1.175t1.175 2.825q0 1.65-1.175 2.825t-2.825 1.175zM13 16q0.825 0 1.413-0.588t0.587-1.412q0-0.825-0.587-1.413t-1.413-0.587q-0.825 0-1.412 0.587t-0.588 1.413q0 0.825 0.588 1.412t1.412 0.588z"/>
          </svg>
          AI读简历
        </button>
      </div>
      <div class="filter-container">
        <label class="filter-label" style="padding-left: 20px;">
          <input type="checkbox" class="qualified-filter" style="margin-right: 20px;" />
          仅达标简历
        </label>
        <select class="date-filter" style="margin-left: 12px; padding: 2px 6px; border: 1px solid #d9d9d9; border-radius: 4px; font-size: 12px;">
          <option value="today">今天</option>
          <option value="yesterday">昨天</option>
          <option value="7days">近7天</option>
          <option value="30days">近30天</option>
          <option value="all">全部</option>
        </select>
      </div>
      <div class="results-container">
        <div class="results-list"></div>
      </div>
      <div class="results-actions">
        <button class="action-button">下载HTML</button>
        <button class="action-button">导出Excel</button>
        <button class="action-button" id="downloadResumesBtn">💾 下载简历</button>
        <button class="action-button" id="backupBtn">📦 备份</button>
        <button class="action-button" id="restoreBtn">📥 恢复</button>
        <button class="action-button">清空结果</button>
      </div>
    </div>
    </div>
    <div class="hr-tab-panel" data-panel="collect" style="display:none; padding:16px;">
      <div style="font-size:12px; color:#666; line-height:1.6; margin-bottom:14px; background:#f5f7fa; padding:10px 12px; border-radius:6px; border-left:3px solid #06b95d;">
        自动遍历沟通页<b>未读</b>对话：<br>
        • 附件简历可下载 → 自动下载<br>
        • 附件简历灰色、求简历可点 → 自动求简历<br>
        • 都不可用 → 跳过下一个<br>
        <span style="color:#faad14;">仅在沟通页(chat/index)可用，计入每日分享额度</span>
      </div>
      <button class="collect-start-btn" id="chatCollectBtn" style="width:100%; padding:10px; background:#06b95d; color:#fff; border:none; border-radius:6px; cursor:pointer; font-size:14px; font-weight:500;">▶ 开始求简历</button>
      <button class="collect-start-btn" id="chatDownloadBtn" style="width:100%; padding:10px; background:#1677ff; color:#fff; border:none; border-radius:6px; cursor:pointer; font-size:14px; font-weight:500; margin-top:8px;">💾 下载简历附件</button>
      <div class="collect-status" id="collectStatus" style="margin-top:12px; font-size:13px; color:#333; text-align:center; line-height:1.8;"></div>
    </div>
    <div class="hr-tab-panel" data-panel="talent" style="display:none; padding:12px;">
      <div style="margin-bottom:10px; display:flex; gap:6px;">
        <input type="text" id="talentSearch" placeholder="搜索..." style="flex:1; padding:6px 10px; border:1px solid #d9d9d9; border-radius:6px; font-size:12px; outline:none;">
        <button id="talentRefreshBtn" style="padding:6px 12px; background:#06b95d; color:#fff; border:none; border-radius:6px; cursor:pointer; font-size:12px;">刷新</button>
      </div>
      <div id="talentList" style="max-height:450px; overflow-y:auto; font-size:12px;"></div>
      <div id="talentCount" style="text-align:center; color:#999; font-size:11px; margin-top:8px;"></div>
    </div>
  `,

  // 简历结果项模板
  resultItem: (result, scoreThreshold) => {
    const score = result.evaluation?.score || 0;
    const scoreClass = score >= scoreThreshold ? 'score-pass' : 'score-fail';
    const latestCompany = result.workExperiences?.[0]?.company || '未知公司';
    
    return `
      <div class="result-item">
        <div class="result-basic-info">
          <div class="basic-info-left">
            <span class="candidate-name">${result.name || '未知姓名'}</span>
            <span class="candidate-info">${result.age ? result.age + '岁' : '年龄未知'} · ${latestCompany}</span>
          </div>
          <div class="basic-info-right">
            <span class="score ${scoreClass}">${score}分</span>
            <svg class="expand-icon" viewBox="0 0 24 24" width="14" height="14">
              <path fill="currentColor" d="M7.41,8.58L12,13.17L16.59,8.58L18,10L12,16L6,10L7.41,8.58Z" />
            </svg>
          </div>
        </div>
        <div class="result-details" style="display: none;">
          ${result.evaluation?.details ? templates.scoreDetails(result.evaluation.details) : ''}
          ${result.evaluation?.suggestion ? `<div class="result-suggestion">${result.evaluation.suggestion}</div>` : ''}
          ${result.shareLink ? templates.shareLink(result.shareLink) : ''}
          <div class="timestamp">分析时间：${new Date(result.timestamp).toLocaleString()}</div>
        </div>
      </div>
    `;
  },

  // 评分详情模板
  scoreDetails: (details) => `
    <div class="score-details">
      ${details.prompt_name ? `
        <div class="score-item prompt-name">
          <div class="score-rule">
            <span class="score-label">使用模板</span>
            <span class="score-value">${details.prompt_name}</span>
          </div>
        </div>
      ` : ''}
      ${details.baseScore !== undefined ? `
        <div class="score-item base-score">
          <div class="score-rule">
            <span class="score-label">基础评分</span>
            <span class="score-value">${details.baseScore}分</span>
          </div>
        </div>
      ` : ''}
      ${details.additions ? details.additions.map(item => `
        <div class="score-item">
          <div class="score-rule">
            <span class="score-label">${item.rule}</span>
            <span class="score-value ${item.score > 0 ? 'positive' : 'negative'}">${item.score > 0 ? '+' : ''}${item.score}分</span>
          </div>
          <div class="score-reason">${item.reason}</div>
        </div>
      `).join('') : ''}
    </div>
  `,

  // 建议模板
  suggestion: (suggestion) => `
    <div class="result-suggestion">${suggestion}</div>
  `,

  // 分享链接模板
  shareLink: (link) => `
    <div class="share-link">
      <div class="share-link-label">分享链接：</div>
      <div>${link}</div>
    </div>
  `,

  // 导出结果模板
  exportTemplate: (data) => `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>BOSS直聘助手 - 分析结果</title>
  <style>
    .export-body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      line-height: 1.6;
      max-width: 1200px;
      margin: 0 auto;
      padding: 20px;
      background: #f5f5f5;
    }

    .export-header {
      text-align: center;
      margin-bottom: 30px;
      padding: 20px;
      background: white;
      border-radius: 8px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
    }

    .export-header h1 {
      color: #1677ff;
      margin: 0;
    }

    .export-header p {
      color: #666;
      margin: 10px 0 0;
    }

    .export-statistics {
      margin-top: 15px;
      padding: 10px;
      background: #f0f7ff;
      border-radius: 4px;
      color: #1677ff;
    }

    .export-resume-list {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(350px, 1fr));
      gap: 20px;
    }

    .export-resume-card {
      background: white;
      border-radius: 8px;
      padding: 20px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
    }

    .export-resume-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 15px;
      padding-bottom: 15px;
      border-bottom: 1px solid #eee;
    }

    .export-candidate-name {
      font-size: 18px;
      font-weight: 500;
      color: #333;
    }

    .export-qualification-tag {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 12px;
      margin-left: 8px;
    }

    .export-qualified {
      background: #f6ffed;
      border: 1px solid #b7eb8f;
      color: #52c41a;
    }

    .export-unqualified {
      background: #fff2f0;
      border: 1px solid #ffccc7;
      color: #ff4d4f;
    }

    .candidate-info {
      color: #666;
      font-size: 13px;
      margin: 10px 0;
    }

    .evaluation-details {
      margin: 15px 0;
    }

    .evaluation-item {
      margin-bottom: 12px;
      padding: 10px;
      background: #fafafa;
      border-radius: 4px;
    }

    .rule-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 4px;
    }

    .rule-name {
      font-weight: 500;
      color: #333;
    }

    .rule-score {
      font-weight: 500;
    }

    .score-positive {
      color: #52c41a;
    }

    .score-negative {
      color: #ff4d4f;
    }

    .rule-reason {
      font-size: 13px;
      color: #666;
    }

    .result-suggestion {
      margin: 15px 0;
      padding: 10px;
      background: #f0f7ff;
      border: 1px solid #bae0ff;
      color: #1677ff;
      border-radius: 4px;
      font-size: 13px;
    }

    .export-thinking-section {
      margin-top: 15px;
      border-top: 1px dashed #e8e8e8;
      padding-top: 15px;
    }

    .export-thinking-label {
      font-size: 14px;
      color: #333;
      font-weight: 500;
      margin-bottom: 8px;
    }

    .export-thinking-toggle {
      background: #f0f7ff;
      border: none;
      color: #1677ff;
      padding: 4px 10px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      margin-left: 10px;
      transition: all 0.3s;
    }

    .export-thinking-content {
      background-color: #f6f8fa;
      padding: 15px;
      border-radius: 5px;
      white-space: pre-wrap;
      font-family: monospace;
      font-size: 13px;
      line-height: 1.5;
      max-height: 200px;
      overflow-y: auto;
      border-left: 3px solid #1890ff;
      display: none;
    }

    .export-thinking-content.show {
      display: block;
    }

    .share-link {
      margin-top: 15px;
      padding: 10px;
      background: #f5f5f5;
      border-radius: 4px;
      font-size: 13px;
    }

    .share-link-label {
      color: #666;
      margin-bottom: 4px;
    }

    .timestamp {
      margin-top: 10px;
      color: #999;
      font-size: 12px;
      text-align: right;
    }

    .score {
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 14px;
      font-weight: 500;
    }

    .score-pass {
      background: #f6ffed;
      border: 1px solid #b7eb8f;
      color: #52c41a;
    }

    .score-fail {
      background: #fff2f0;
      border: 1px solid #ffccc7;
      color: #ff4d4f;
    }

    .template-info {
      margin-top: 8px;
      padding: 8px;
      background: #f0f7ff;
      border-radius: 4px;
      font-size: 13px;
      color: #1677ff;
    }

    .filter-container {
      margin: 10px 15px;
      padding: 8px 12px;
      background: #f8f9fa;
      border-radius: 4px;
      border: 1px solid #e8e8e8;
      display: flex;
      align-items: center;
    }

    .filter-label {
      display: flex;
      align-items: center;
      font-size: 13px;
      color: #333;
      cursor: pointer;
      user-select: none;
      margin: 0;
    }

    .filter-label input[type="checkbox"] {
      margin-right: 8px;
      width: 16px;
      height: 16px;
      cursor: pointer;
      accent-color: #1677ff;
    }

    .filter-label:hover {
      color: #1677ff;
    }

    .results-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin: 10px 15px;
      padding-bottom: 10px;
      border-bottom: 1px solid #e8e8e8;
    }

    .header-right {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .pin-button {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      border-radius: 4px;
      cursor: pointer;
      color: #666;
      transition: all 0.3s;
    }

    .pin-button:hover {
      background: #f0f0f0;
      color: #1677ff;
    }

    .pin-button.active {
      color: #1677ff;
      background: #e6f4ff;
    }

    .filter-container {
      display: flex;
      align-items: center;
      margin: 10px 15px;
      padding: 8px 12px;
      background: #f8f9fa;
      border-radius: 4px;
      border: 1px solid #e8e8e8;
    }

    .filter-label {
      display: flex;
      align-items: center;
      font-size: 13px;
      color: #333;
      cursor: pointer;
      user-select: none;
      margin: 0;
    }

    .filter-label input[type="checkbox"] {
      margin-right: 8px;
      width: 16px;
      height: 16px;
      cursor: pointer;
      accent-color: #1677ff;
    }

    .filter-label:hover {
      color: #1677ff;
    }

    .qualified-filter {
      display: flex;
      align-items: center;
      margin-left: 15px;
      font-size: 13px;
      color: #333;
    }

    .qualified-filter input[type="checkbox"] {
      margin-right: 8px;
      width: 16px;
      height: 16px;
      cursor: pointer;
      accent-color: #1677ff;
    }

    .qualified-filter:hover {
      color: #1677ff;
    }
  </style>
  <script>
    function toggleThinking(id) {
      const content = document.getElementById('thinking-' + id);
      content.classList.toggle('show');
      const button = document.querySelector('[data-id="' + id + '"]');
      button.textContent = content.classList.contains('show') ? '隐藏思考过程' : '查看思考过程';
    }
  </script>
</head>
<body class="export-body">
  <div class="export-header">
    <h1>BOSS直聘助手 - 分析结果</h1>
    <p>生成时间：${new Date().toLocaleString()}</p>
    <p>共分析 ${data.totalCount} 份简历</p>
    <div class="export-statistics">
      达标简历：${data.qualifiedCount} 份
      未达标简历：${data.totalCount - data.qualifiedCount} 份
    </div>
  </div>
  <div class="export-resume-list">
    ${data.sortedResults.map((result, index) => {
      const isQualified = result.evaluation?.score >= data.scoreThreshold;
      const latestCompany = result.workExperiences?.[0]?.company || '未知公司';
      const thinkingProcess = result.evaluation?.thinkingProcess || '';
      
      return `
        <div class="export-resume-card">
          <div class="export-resume-header">
            <div style="display: flex; align-items: center;">
              <span class="export-candidate-name">${result.name || '未知姓名'}</span>
              <span class="export-qualification-tag ${isQualified ? 'export-qualified' : 'export-unqualified'}">
                ${isQualified ? '已达标' : '未达标'}
              </span>
            </div>
            <span class="score ${isQualified ? 'score-pass' : 'score-fail'}">
              ${result.evaluation?.score || 0}分
            </span>
          </div>
          ${result.prompt_name ? `
            <div class="template-info">
              使用模板：${result.prompt_name}
            </div>
          ` : ''}
          <div class="candidate-info">
            <span>${result.age ? result.age + '岁' : '年龄未知'}</span>
            <span> · </span>
            <span>${latestCompany}</span>
          </div>
          <div class="evaluation-details">
            ${result.evaluation?.details.additions.map(item => `
              <div class="evaluation-item">
                <div class="rule-header">
                  <span class="rule-name">${item.rule}</span>
                  <span class="rule-score ${item.score > 0 ? 'score-positive' : 'score-negative'}">
                    ${item.score > 0 ? '+' : ''}${item.score}分
                  </span>
                </div>
                <div class="rule-reason">${item.reason}</div>
              </div>
            `).join('')}
          </div>
          <div class="result-suggestion">${result.evaluation?.suggestion || ''}</div>

          ${result.shareCardImage ? `<div style="margin-top:10px;text-align:center;"><div style="font-size:12px;color:#666;margin-bottom:4px;">分享卡片：</div><img src="${result.shareCardImage}" style="max-width:280px;border:1px solid #eee;border-radius:4px;cursor:zoom-in;" onclick="var o=document.createElement('div');o.style='position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:99999;display:flex;align-items:center;justify-content:center;cursor:zoom-out;';o.innerHTML='<img src=this.src style=max-width:90%;max-height:90%;border-radius:8px;';o.onclick=function(){o.remove()};document.body.appendChild(o)" /></div>` : ''}

          ${result.shareLink ? `
            <div class="share-link">
              <div class="share-link-label">分享链接：</div>
              <div><a href="${result.shareLink}" target="_blank">${result.shareLink}</a></div>
            </div>
          ` : ''}
          <div class="timestamp">分析时间：${new Date(result.timestamp).toLocaleString()}</div>
        </div>
      `;
    }).join('')}
  </div>
</body>
</html>
  `,

  // 添加导出Excel功能
  exportToExcel: function() {
    console.log('开始导出Excel');
    chrome.storage.sync.get(['scoreThreshold'], ({ scoreThreshold = 80 }) => {
      // 用当前筛选条件过滤
      var filterFn = window.getFilteredResults || function() { return window.resumeManager.analysisResults || []; };
      const sortedResults = filterFn(scoreThreshold).sort((a, b) => {
        const scoreA = a.evaluation?.score || 0;
        const scoreB = b.evaluation?.score || 0;
        return scoreB - scoreA;
      });

      // 准备Excel数据
      const rows = [
        // 表头
        [
          '姓名', '年龄', '工作经验', '学历', '当前状态',
          '期望地点', '期望职位', '期望薪资',
          '最近公司', '最近职位',
          '评分', '是否达标', '评价建议',
          '分析时间'
        ]
      ];

      // 添加数据行
      sortedResults.forEach(result => {
        const firstWork = result.workExperiences?.[0] || {};
        const score = result.evaluation?.score || 0;
        const isQualified = score >= scoreThreshold;

        rows.push([
          result.name || '未知',
          result.age != null ? result.age : '未知',
          result.experience || '未知',
          result.education || '未知',
          result.jobStatus || '未知',
          result.expectCity || result.expectInfo?.location || '未知',
          result.expectPosition || result.expectInfo?.position || '未知',
          result.expectSalary || result.expectInfo?.salary || '未知',
          result.currentCompany || firstWork.company || '未知',
          result.currentTitle || firstWork.title || firstWork.position || '未知',
          score.toString(),
          isQualified ? '是' : '否',
          result.evaluation?.suggestion || '无',
          new Date(result.timestamp).toLocaleString()
        ]);
      });

      // 导出 CSV（Excel 打开）
      var csvContent = '﻿' + rows.map(r => r.map(c => '"' + String(c||'').replace(/"/g,'""') + '"').join(',')).join('\n');
      var csvBlob = new Blob([csvContent], { type: 'text/csv;charset=utf-8' });
      var ca = document.createElement('a');
      ca.href = URL.createObjectURL(csvBlob);
      ca.download = 'BOSS助手_' + new Date().toLocaleDateString() + '.csv';
      ca.click();
      console.log('导出完成');
    });
  }
};

// 将模板导出到全局作用域
window.templates = templates; 

// 初始化过滤功能
window.initQualifiedFilter = function() {
  console.log('初始化过滤功能');
  const filterCheckbox = document.querySelector('.qualified-filter');
  
  if (!filterCheckbox) {
    console.log('未找到过滤器复选框');
    return;
  }

  if (!filterCheckbox.hasListener) {
    filterCheckbox.hasListener = true;
    
    // 获取当前过滤状态
    const updateFilter = () => {
      console.log('更新过滤状态');
      chrome.storage.sync.get(['scoreThreshold'], ({ scoreThreshold = 80 }) => {
        const resultItems = document.querySelectorAll('.result-item');
        console.log('找到简历条目数量：', resultItems.length);
        
        resultItems.forEach(item => {
          const scoreElement = item.querySelector('.score');
          if (scoreElement) {
            const scoreText = scoreElement.textContent.replace(/[^0-9]/g, '');
            const score = parseInt(scoreText);
            console.log('简历分数：', score, '阈值：', scoreThreshold);
            
            if (filterCheckbox.checked) {
              item.style.display = score >= scoreThreshold ? '' : 'none';
            } else {
              item.style.display = '';
            }
          }
        });

        // 更新结果计数
        const resultsCount = document.querySelector('.results-count');
        if (resultsCount) {
          const totalCount = resultItems.length;
          const qualifiedCount = Array.from(resultItems).filter(item => {
            const scoreElement = item.querySelector('.score');
            if (scoreElement) {
              const score = parseInt(scoreElement.textContent.replace(/[^0-9]/g, ''));
              return score >= scoreThreshold;
            }
            return false;
          }).length;

          resultsCount.textContent = filterCheckbox.checked 
            ? `已分析 ${totalCount} 份简历，其中 ${qualifiedCount} 份达标` 
            : `已分析 ${totalCount} 份简历`;
        }
      });
    };

    // 监听复选框变化
    filterCheckbox.addEventListener('change', () => {
      console.log('过滤器状态改变:', filterCheckbox.checked);
      updateFilter();
    });

    // 监听新简历添加事件
    const resultsList = document.querySelector('.results-list');
    if (resultsList) {
      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
            console.log('检测到新简历添加');
            updateFilter();
          }
        }
      });

      observer.observe(resultsList, {
        childList: true
      });
    }

    // 初始执行一次过滤
    updateFilter();
  }
};

// 修改展开折叠功能的初始化函数
window.initExpandButtons = function() {
  document.querySelectorAll('.result-item').forEach(item => {
    if (!item.hasListener) {
      item.hasListener = true;
      
      const basicInfo = item.querySelector('.result-basic-info');
      const details = item.querySelector('.result-details');
      const expandIcon = item.querySelector('.expand-icon');
      
      if (basicInfo && details && expandIcon) {
        basicInfo.addEventListener('click', function() {
          if (details.style.display === 'none') {
            details.style.display = 'block';
            expandIcon.style.transform = 'rotate(180deg)';
          } else {
            details.style.display = 'none';
            expandIcon.style.transform = 'rotate(0)';
          }
        });
      }
    }
  });
  
  // 确保过滤功能被初始化
  window.initQualifiedFilter();
}; 

function setupEventListeners(container) {
  console.log('开始设置事件监听');

  // 初始化过滤功能
  window.initQualifiedFilter();

  // 获取按钮元素
  const aiButton = container.querySelector('.hr-action-btn');
  const downloadButton = container.querySelector('.action-button:nth-child(1)');
  const exportButton = container.querySelector('.action-button:nth-child(2)');
  const clearButton = container.querySelector('.action-button:nth-child(3)');
  const pinButton = container.querySelector('.pin-button');
  const header = container.querySelector('.hr-panel-header');

  // 设置拖动相关变量
  let isDragging = false;
  let currentX;
  let currentY;
  let initialX;
  let initialY;
  let xOffset = 0;
  let yOffset = 0;

  // ... existing code ...
} 