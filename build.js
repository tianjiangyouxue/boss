const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');

const srcDir = __dirname;
const outDir = path.join(srcDir, 'dist');

if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);

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
  reservedNames: ['^chrome$', '^window$', '^document$', '^templates$', '^resumeManager$', '^SYSTEM_PROMPT_TEMPLATES$', '^API_CONFIG$', '^CONTAINER_ID$', '^showPanelMsg$', '^callCustomApi$', '^callOfficialOcrService$', '^callOfficialResumeEvalService$', '^performVisionExtraction$', '^captureVisibleTab$', '^captureFullResumeScreenshot$', '^stitchSlices$', '^getApiEndpoint$', '^getApiKey$', '^getModel$', '^saveAnalysisResults$', '^updateResultsDisplay$', '^loadAnalysisResults$', '^extractFullResumeContent$', '^generateShareLink$', '^downloadSingleResume$', '^downloadAllResumes$', '^formatResumeText$', '^downloadResults$', '^clearResults$', '^autoDownloadIfEnabled$', '^deepseekRequest$'],
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
  const origSize = code.length;
  totalOrig += origSize;

  // background.js 是 Service Worker，不能用 window/dom 混淆
  if (file === 'background.js') {
    fs.copyFileSync(srcPath, path.join(outDir, file));
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

// Copy static files
for (const file of staticFiles) {
  const src = path.join(srcDir, file);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(outDir, file));
}

// Copy images
const imgSrc = path.join(srcDir, imgDir);
const imgDst = path.join(outDir, imgDir);
if (!fs.existsSync(imgDst)) fs.mkdirSync(imgDst);
fs.readdirSync(imgSrc).forEach(f => fs.copyFileSync(path.join(imgSrc, f), path.join(imgDst, f)));

console.log(`\nDone! ${(totalOrig/1024).toFixed(0)}KB → ${(totalObf/1024).toFixed(0)}KB`);
console.log(`Output: ${outDir}`);
