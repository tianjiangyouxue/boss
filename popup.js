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
    if (captureUnqualifiedCardCheckbox) captureUnqualifiedCardCheckbox.checked = result.captureUnqualifiedCard !== undefined ? result.captureUnqualifiedCard : true;
    const filterReadCheckbox = document.getElementById('filterRead');
    if (filterReadCheckbox) filterReadCheckbox.checked = result.filterRead !== undefined ? result.filterRead : true;
    await chrome.storage.sync.set({ scoreThreshold: result.scoreThreshold || 80, forwardEmail: forwardEmailInput.value, autoFavorite: autoFavoriteCheckbox.checked, autoGreet: autoGreetCheckbox.checked, autoShare: autoShareCheckbox.checked, captureUnqualifiedCard: result.captureUnqualifiedCard !== undefined ? result.captureUnqualifiedCard : true, filterRead: result.filterRead !== undefined ? result.filterRead : true });
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
    var settings = { scoreThreshold: parseInt(scoreThresholdInput.value, 10), forwardEmail: forwardEmailInput.value.trim(), autoFavorite: autoFavoriteCheckbox.checked, autoGreet: autoGreetCheckbox.checked, autoShare: autoShareCheckbox.checked, captureUnqualifiedCard: captureUnqualifiedCardCheckbox ? captureUnqualifiedCardCheckbox.checked : true, filterRead: filterReadCheckbox ? filterReadCheckbox.checked : true };
    if (isNaN(settings.scoreThreshold) || settings.scoreThreshold < 0 || settings.scoreThreshold > 100) { showStatus('评分阈值必须在0-100之间', 'error'); return; }
    try { await chrome.storage.sync.set(settings); await saveConfig(); showStatus('设置已保存', 'success'); } catch (error) { showStatus('保存失败：' + error.message, 'error'); }
  });

  function showStatus(msg, type) { statusDiv.textContent = msg; statusDiv.className = 'status ' + type; setTimeout(() => statusDiv.className = 'status', 3000); }

  const closeBtn = document.querySelector('.error-container .close-btn');
  if (closeBtn) closeBtn.addEventListener('click', () => { const el = document.getElementById('errorContainer'); if (el) el.classList.remove('show'); });

  try { await loadConfig(); await loadSettings(); } catch (e) { console.error('初始化失败:', e); }
});
