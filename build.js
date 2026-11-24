const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');

// ★ 构建目标：free = 内部免费版(默认) | paid = 商店收费版
// 用法: node build.js         → 免费版
//       node build.js paid    → 收费版
const BUILD_TARGET = (process.argv.length >= 3 && process.argv[2] === 'paid') ? 'paid' : 'free';
const isPaid = BUILD_TARGET === 'paid';

// 占位符 → 实际值替换映射
const replacements = {
  '$$BACKEND_URL$$': isPaid ? 'https://score.rzcf.com:4433/score/score-api/boss' : 'http://192.168.5.235:8866',
  '$$IS_PAID$$': isPaid ? 'true' : 'false',
  '$$CREDITS_REQUIRED$$': isPaid ? 'true' : 'false',
  '$$APP_NAME$$': isPaid ? 'BOSS直聘AI助手' : 'BOSS直聘助手',
};
function applyReplacements(code) {
  let result = code;
  for (const [placeholder, value] of Object.entries(replacements)) {
    result = result.split(placeholder).join(value);
  }
  return result;
}

// ===== DOM 特征伪装：每次构建随机化注入宿主页面的自定义标识符 =====
// 只覆盖高特征名（hr-*/ai-*/*-unique/面板自有 id），不动通用 class（如 .cancel/.close-btn），
// 避免误伤对宿主页面元素的查询。JS/CSS/HTML 全量同步替换。
const UI_MASK_LIST = [
  'ai-resume-container-unique', 'ai-analysis-status', 'ai-analysis-styles',
  'hr-dialog-overlay', 'hr-panel-header', 'hr-panel-unique', 'hr-action-btn',
  'hr-tab-panel', 'hr-results', 'highlight-element', 'highlight-style',
  'hr-dialog', 'hr-panel', 'hr-tab',
  'collectStatus', 'save-template', 'downloadResumesBtn'
];
function makeUiMaskPairs() {
  const used = new Set();
  const map = {};
  for (const name of UI_MASK_LIST) {
    let n;
    do { n = 'css-' + Math.random().toString(36).slice(2, 8); } while (used.has(n));
    used.add(n);
    map[name] = n;
  }
  // 长名优先，避免前缀误伤（如 hr-panel 吃掉 hr-panel-header）
  return Object.keys(map).sort((a, b) => b.length - a.length).map(k => [k, map[k]]);
}
const uiMaskPairs = makeUiMaskPairs();
let uiMaskHits = 0;
function applyUiMask(code) {
  let out = code;
  for (const [orig, masked] of uiMaskPairs) {
    const parts = out.split(orig);
    if (parts.length > 1) {
      uiMaskHits += parts.length - 1;
      out = parts.join(masked);
    }
  }
  return out;
}

const srcDir = __dirname;
const outDir = path.join(srcDir, 'dist');

if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);

console.log(`=== BUILD_TARGET: ${BUILD_TARGET} (${isPaid ? 'pro' : 'free'}) ===`);
console.log('  BACKEND_URL =', replacements['$$BACKEND_URL$$']);
console.log('  CREDITS_REQUIRED =', replacements['$$CREDITS_REQUIRED$$']);

const jsFiles = [
  'background.js',
  'db.js',
  'content.js',
  'popup.js',
  'prompts.js',
  'resume.js',
  'templates.js'
];

const staticFiles = [
  'manifest.json',
  'popup.html',
  'privace.html',
  'styles.css'
];

const imgDir = 'images';

const options = {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.5,
  stringArray: true,
  stringArrayEncoding: ['base64'],
  stringArrayThreshold: 0.8,
  renameGlobals: false,
  renameProperties: false,
  disableConsoleOutput: true,
  debugProtection: false,
  selfDefending: false,
  splitStrings: true,
  splitStringsChunkLength: 10,
  target: 'browser',
  reservedNames: ['^chrome$', '^window$', '^document$', '^templates$', '^resumeManager$', '^ResumeDB$', '^SYSTEM_PROMPT_TEMPLATES$', '^API_CONFIG$', '^CONTAINER_ID$', '^showPanelMsg$', '^debugLog$', '^debugLogClear$', '^callCustomApi$', '^callOfficialOcrService$', '^callOfficialResumeEvalService$', '^performVisionExtraction$', '^captureVisibleTab$', '^captureFullResumeScreenshot$', '^stitchSlices$', '^getApiEndpoint$', '^getApiKey$', '^getModel$', '^saveAnalysisResults$', '^updateResultsDisplay$', '^loadAnalysisResults$', '^extractFullResumeContent$', '^generateShareLink$', '^downloadSingleResume$', '^downloadAllResumes$', '^formatResumeText$', '^downloadResults$', '^clearResults$', '^autoDownloadIfEnabled$', '^deepseekRequest$', '^loadDownloaded$', '^saveDownloaded$', '^deleteDownloaded$', '^clearDownloaded$', '^handleChatResumeDownload$', '^handleChatResumeCollection$', '^protectSendMessage$'],
  reservedStrings: ['AI读简历', '仅显示达标简历', '下载HTML', '导出Excel', '清空结果', '保存设置', '立即开始']
};

console.log('Obfuscating...');
let totalOrig = 0, totalObf = 0;

for (const file of jsFiles) {
  const srcPath = path.join(srcDir, file);
  if (!fs.existsSync(srcPath)) { console.log('  SKIP', file, '(not found)'); continue; }

  var code = fs.readFileSync(srcPath, 'utf8');
  // 生产版本：关闭调试日志显示（源码 DEBUG=true → 打包后 DEBUG=false）
  code = code.replace('const DEBUG = true', 'const DEBUG = false');
  // ★ 占位符替换（BUILD_TARGET 差异）
  code = applyReplacements(code);
  // ★ DOM 特征伪装
  code = applyUiMask(code);
  const origSize = code.length;
  totalOrig += origSize;

  // background.js 是 Service Worker，不能用 window/dom 混淆
  if (file === 'background.js') {
    fs.writeFileSync(path.join(outDir, file), code); // 写入已替换占位符的版本
    totalObf += origSize;
    console.log(`  ${file}: ${(origSize/1024).toFixed(0)}KB (copy, no obfuscate)`);
    continue;
  }

  const fileOpts = { ...options };
  if (file === 'templates.js') {
    fileOpts.renameGlobals = false;
    fileOpts.selfDefending = false;
  }

  const result = JavaScriptObfuscator.obfuscate(code, fileOpts);
  const obfuscated = result.getObfuscatedCode();
  const obfSize = obfuscated.length;
  totalObf += obfSize;

  fs.writeFileSync(path.join(outDir, file), obfuscated);
  console.log(`  ${file}: ${(origSize/1024).toFixed(0)}KB → ${(obfSize/1024).toFixed(0)}KB`);
}

// Copy static files (apply replacements for HTML/CSS/JSON)
for (const file of staticFiles) {
  const src = path.join(srcDir, file);
  if (!fs.existsSync(src)) continue;
  if (/\.(html|css|json)$/i.test(file)) {
    var sc = fs.readFileSync(src, 'utf8');
    sc = applyReplacements(sc);
    sc = applyUiMask(sc);
    fs.writeFileSync(path.join(outDir, file), sc);
  } else {
    fs.copyFileSync(src, path.join(outDir, file));
  }
}

// Copy images
const imgSrc = path.join(srcDir, imgDir);
const imgDst = path.join(outDir, imgDir);
if (!fs.existsSync(imgDst)) fs.mkdirSync(imgDst);
fs.readdirSync(imgSrc).forEach(f => fs.copyFileSync(path.join(imgSrc, f), path.join(imgDst, f)));

// ★ free 恢复原始 Logo
if (!isPaid && fs.existsSync(path.join(srcDir, imgDir, 'icon_internal.png'))) {
  fs.copyFileSync(path.join(srcDir, imgDir, 'icon_internal.png'), path.join(outDir, imgDir, 'icon.png'));
  console.log('  Logo: free原图标');
}

console.log(`  DOM mask: ${uiMaskPairs.length} names, ${uiMaskHits} replacements (randomized per build)`);

console.log(`\nDone! ${(totalOrig/1024).toFixed(0)}KB → ${(totalObf/1024).toFixed(0)}KB (${isPaid?'pro':'free'})`);
console.log(`Output: ${outDir}`);
