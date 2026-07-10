// IndexedDB 简历数据库（替代 chrome.storage.local 存分析结果）
(function() {
  const DB_NAME = 'hr_resume_db';
  const DB_VERSION = 1;
  const STORE = 'results';

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function(e) {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'resumeId' });
          store.createIndex('timestamp', 'timestamp', { unique: false });
          store.createIndex('score', 'evaluation.score', { unique: false });
        }
      };
      req.onsuccess = function(e) { resolve(e.target.result); };
      req.onerror = function() { reject(req.error); };
    });
  }

  window.ResumeDB = {
    // 保存一条结果（有则更新）
    async save(result) {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        // 压缩图片：超过 500KB 的图裁剪质量
        if (result.resumeImage && result.resumeImage.length > 500000) {
          result.resumeImageSmall = result.resumeImage; // 原图保留
          result.resumeImage = result.resumeImage.substring(0, 500000); // 限制存储大小
        }
        store.put(result);
        tx.oncomplete = function() { resolve(); };
        tx.onerror = function() { reject(tx.error); };
      });
    },

    // 加载所有结果（按时间倒序）
    async loadAll() {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const store = tx.objectStore(STORE);
        const req = store.getAll();
        req.onsuccess = function() {
          var rows = req.result || [];
          rows.sort(function(a, b) { return new Date(b.timestamp) - new Date(a.timestamp); });
          resolve(rows);
        };
        req.onerror = function() { reject(req.error); };
      });
    },

    // 按 resumeId 查一条
    async get(resumeId) {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const store = tx.objectStore(STORE);
        const req = store.get(resumeId);
        req.onsuccess = function() { resolve(req.result || null); };
        req.onerror = function() { reject(req.error); };
      });
    },

    // 清空
    async clear() {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        store.clear();
        tx.oncomplete = function() { resolve(); };
        tx.onerror = function() { reject(tx.error); };
      });
    },

    // 已分析过的 resumeId 集合
    async addAnalyzedId(resumeId) {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        store.put({ resumeId: resumeId, analyzed: true, timestamp: new Date().toISOString() });
        tx.oncomplete = function() { resolve(); };
        tx.onerror = function() { reject(tx.error); };
      });
    },

    async isAnalyzed(resumeId) {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const store = tx.objectStore(STORE);
        const req = store.get(resumeId);
        req.onsuccess = function() { resolve(!!req.result); };
        req.onerror = function() { reject(req.error); };
      });
    }
  };
})();
