// IndexedDB 简历数据库（替代 chrome.storage.local 存分析结果）
(function() {
  const DB_NAME = 'hr_resume_db';
  const DB_VERSION = 3;
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
      req.onerror = function() {
        // 版本不匹配 → 删除旧库重建
        if (req.error && req.error.name === 'VersionError') {
          console.warn('[DB] 版本不匹配，删除旧库重建...');
          indexedDB.deleteDatabase(DB_NAME).then(function() {
            var retryReq = indexedDB.open(DB_NAME, DB_VERSION);
            retryReq.onupgradeneeded = function(ev) {
              var db2 = ev.target.result;
              if (!db2.objectStoreNames.contains(STORE)) {
                var s2 = db2.createObjectStore(STORE, { keyPath: 'resumeId' });
                s2.createIndex('timestamp', 'timestamp', { unique: false });
                s2.createIndex('score', 'evaluation.score', { unique: false });
              }
            };
            retryReq.onsuccess = function(ev) { resolve(ev.target.result); };
            retryReq.onerror = function() { reject(retryReq.error); };
          }).catch(function() { reject(req.error); });
        } else {
          reject(req.error);
        }
      };
    });
  }

  window.ResumeDB = {
    // 保存一条结果（有则更新）
    async save(result) {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        // 兜底 keyPath，防止空 resumeId 抛错
        if (!result.resumeId) result = Object.assign({}, result, { resumeId: 'noid_' + (result.name || 'x') + '_' + (result.timestamp || Date.now()) });
        // 压缩图片：超过 500KB 的图裁剪质量
        if (result.resumeImage && result.resumeImage.length > 500000) {
          result.resumeImageSmall = result.resumeImage; // 原图保留
          result.resumeImage = result.resumeImage.substring(0, 500000); // 限制存储大小
        }
        try { store.put(result); } catch(e) { reject(e); return; }
        tx.oncomplete = function() { resolve(); };
        tx.onerror = function() { reject(tx.error); };
      });
    },

    // 批量保存（全量覆盖，分两段事务避免 clear+put 并发问题）
    async saveAll(results) {
      const db = await openDB();
      // 兜底：保证每条都有非空 resumeId（keyPath），否则 put 抛错会 abort 整个事务
      var safe = [];
      for (var k = 0; k < results.length; k++) {
        var item = results[k];
        if (!item) continue;
        if (!item.resumeId) {
          item = Object.assign({}, item, { resumeId: 'noid_' + (item.name || 'x') + '_' + (item.timestamp || k) });
        }
        safe.push(item);
      }
      // Step 1: 单独事务清空
      await new Promise(function(resolve, reject) {
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).clear();
        tx.oncomplete = resolve;
        tx.onerror = function() { reject(tx.error); };
      });
      // Step 2: 新事务逐条写入
      return new Promise(function(resolve, reject) {
        var tx = db.transaction(STORE, 'readwrite');
        var store = tx.objectStore(STORE);
        for (var i = 0; i < safe.length; i++) {
          var r = safe[i];
          if (r.resumeImage && r.resumeImage.length > 500000) {
            r = Object.assign({}, r, { resumeImageSmall: r.resumeImage, resumeImage: r.resumeImage.substring(0, 500000) });
          }
          try { store.put(r); } catch(e) { console.warn('[DB] 跳过一条:', e.message); }
        }
        tx.oncomplete = function() { console.log('[DB] 全量保存 ' + safe.length + ' 条'); resolve(); };
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
