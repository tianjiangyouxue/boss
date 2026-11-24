document.addEventListener('DOMContentLoaded', async () => {
  const saveButton = document.getElementById('saveSettings');
  const startButton = document.getElementById('startNow');
  const statusDiv = document.getElementById('status');

  const customSystemPromptInput = document.getElementById('customSystemPrompt');
  const promptTemplateSelect = document.getElementById('promptTemplateSelect');

  const scoreThresholdInput = document.getElementById('scoreThreshold');
  const forwardEmailInput = document.getElementById('forwardEmail');
  const autoFavoriteCheckbox = document.getElementById('autoFavorite');
  const autoGreetCheckbox = document.getElementById('autoGreet');
  const autoShareCheckbox = document.getElementById('autoShare');

  // ========== 配置 ==========

  async function loadConfig() {
    const result = await chrome.storage.local.get(['customApiConfig']);
    if (result.customApiConfig) {
      customSystemPromptInput.value = result.customApiConfig.systemPrompt || '';
    } else {
      customSystemPromptInput.value = '';
      await saveConfig();
    }
  }

  async function saveConfig() {
    const config = { model: 'deepseek-chat', systemPrompt: customSystemPromptInput.value.trim() };
    await chrome.storage.local.set({ customApiConfig: config });
  }

  async function loadSettings() {
    const result = await chrome.storage.sync.get(['scoreThreshold', 'forwardEmail', 'autoFavorite', 'autoGreet', 'autoShare', 'captureUnqualifiedCard', 'filterRead']);
    scoreThresholdInput.value = result.scoreThreshold || 80;
    forwardEmailInput.value = result.forwardEmail || '';
    autoFavoriteCheckbox.checked = result.autoFavorite !== undefined ? result.autoFavorite : true;
    autoGreetCheckbox.checked = result.autoGreet !== undefined ? result.autoGreet : false;
    autoShareCheckbox.checked = result.autoShare !== undefined ? result.autoShare : false;
    const captureUnqualifiedCardCheckbox = document.getElementById('captureUnqualifiedCard');
    if (captureUnqualifiedCardCheckbox) captureUnqualifiedCardCheckbox.checked = result.captureUnqualifiedCard !== undefined ? result.captureUnqualifiedCard : false;
    const filterReadCheckbox = document.getElementById('filterRead');
    if (filterReadCheckbox) filterReadCheckbox.checked = result.filterRead !== undefined ? result.filterRead : true;
    await chrome.storage.sync.set({ scoreThreshold: result.scoreThreshold || 80, forwardEmail: forwardEmailInput.value, autoFavorite: autoFavoriteCheckbox.checked, autoGreet: autoGreetCheckbox.checked, autoShare: autoShareCheckbox.checked, captureUnqualifiedCard: result.captureUnqualifiedCard !== undefined ? result.captureUnqualifiedCard : false, filterRead: result.filterRead !== undefined ? result.filterRead : true });
    document.getElementById('forwardEmailRow').style.display = autoShareCheckbox.checked ? 'block' : 'none';
  }

  // ========== 提示词模板 ==========

  promptTemplateSelect.addEventListener('change', () => {
    const key = promptTemplateSelect.value;
    if (key && window.SYSTEM_PROMPT_TEMPLATES && window.SYSTEM_PROMPT_TEMPLATES[key]) {
      customSystemPromptInput.value = window.SYSTEM_PROMPT_TEMPLATES[key].prompt;
    }
    promptTemplateSelect.value = '';
  });

  // 勾选"自动生成转发链接"时显示邮箱输入
  autoShareCheckbox.addEventListener('change', () => {
    document.getElementById('forwardEmailRow').style.display = autoShareCheckbox.checked ? 'block' : 'none';
  });

  customSystemPromptInput.addEventListener('change', saveConfig);

  // ========== 按钮 ==========

  startButton.addEventListener('click', () => chrome.tabs.create({ url: 'https://www.zhipin.com/web/chat/search' }));

  saveButton.addEventListener('click', async () => {
    const captureUnqualifiedCardCheckbox = document.getElementById('captureUnqualifiedCard');
    const filterReadCheckbox = document.getElementById('filterRead');
    var settings = { scoreThreshold: parseInt(scoreThresholdInput.value, 10), forwardEmail: forwardEmailInput.value.trim(), autoFavorite: autoFavoriteCheckbox.checked, autoGreet: autoGreetCheckbox.checked, autoShare: autoShareCheckbox.checked, captureUnqualifiedCard: captureUnqualifiedCardCheckbox ? captureUnqualifiedCardCheckbox.checked : false, filterRead: filterReadCheckbox ? filterReadCheckbox.checked : true };
    if (isNaN(settings.scoreThreshold) || settings.scoreThreshold < 0 || settings.scoreThreshold > 100) { showStatus('评分阈值必须在0-100之间', 'error'); return; }
    try { await chrome.storage.sync.set(settings); await saveConfig(); showStatus('设置已保存', 'success'); } catch (error) { showStatus('保存失败：' + error.message, 'error'); }
  });

  function showStatus(msg, type) { statusDiv.textContent = msg; statusDiv.className = 'status ' + type; setTimeout(() => statusDiv.className = 'status', 3000); }

  const closeBtn = document.querySelector('.error-container .close-btn');
  if (closeBtn) closeBtn.addEventListener('click', () => { const el = document.getElementById('errorContainer'); if (el) el.classList.remove('show'); });

  // Pro 版激活码
  if ('$$IS_PAID$$' === 'true') {
    document.getElementById('proActivation').style.display = '';
    var activateBtn = document.getElementById('activateBtn');
    var activateCode = document.getElementById('activateCode');
    var activateMsg = document.getElementById('activateMsg');

    // 刷新激活/试用状态（查后端 + 本地缓存）
    async function refreshActivation() {
      var result = await chrome.storage.local.get(['pro_activated', 'pro_trial_remaining']);
      var remaining = result.pro_trial_remaining;
      // 尝试同步后端
      try {
        var resp = await new Promise(function(resolve, reject) {
          chrome.runtime.sendMessage({ action: 'trialProxy', body: { action: 'status', activated: result.pro_activated || false } }, function(r) {
            if (r && r.ok) resolve(r.data); else reject(new Error());
          });
        });
        remaining = resp.remaining;
        await chrome.storage.local.set({ 'pro_trial_remaining': remaining });
      } catch(e) {}

      if (remaining > 0) {
        activateMsg.innerHTML = '<span style="color:' + (remaining >= 50 ? '#52c41a' : '#1890ff') + ';">🎁 剩余 ' + remaining + ' 次</span>';
        activateBtn.textContent = '激活'; activateBtn.disabled = false; activateBtn.style.background = '#06b95d';
      } else {
        activateMsg.innerHTML = '<span style="color:#ff4d4f;">⚠️ 次数已用完</span>';
        activateBtn.textContent = '激活'; activateBtn.disabled = false; activateBtn.style.background = '#ff4d4f';
      }
    }
    refreshActivation();

    // 激活码验证（后端核销）
    activateBtn.addEventListener('click', async function() {
      var code = activateCode.value.trim();
      if (!code) { activateMsg.innerHTML = '<span style="color:#ff4d4f;">请输入激活码</span>'; return; }
      activateMsg.innerHTML = '<span style="color:#1890ff;">激活中...</span>';
      try {
        var resp = await new Promise(function(resolve, reject) {
          chrome.runtime.sendMessage({ action: 'trialProxy', body: { action: 'activate', code: code } }, function(r) {
            if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
            if (r && r.ok) resolve(r.data); else reject(new Error((r && r.error) || 'network'));
          });
        });
        if (resp.ok) {
          await chrome.storage.local.set({ 'pro_trial_remaining': resp.remaining });
          refreshActivation();
          activateMsg.innerHTML = '<span style="color:#52c41a;">🎉 激活成功！剩余 ' + resp.remaining + ' 次</span>';
        } else {
          activateMsg.innerHTML = '<span style="color:#ff4d4f;">❌ 激活码无效</span>';
        }
      } catch(e) { activateMsg.innerHTML = '<span style="color:#ff4d4f;">网络异常，请重试(' + (e.message||'').substring(0,20) + ')</span>'; }
    });
  }

  try { await loadConfig(); await loadSettings(); } catch (e) { console.error('初始化失败:', e); }
});
