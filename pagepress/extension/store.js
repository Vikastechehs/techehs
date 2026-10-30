(function (root) {
  let database;
  function open() {
    if (database) return database;
    database = new Promise((resolve, reject) => {
      const request = indexedDB.open('pagepress-local', 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('meta');
        request.result.createObjectStore('pages', { keyPath: 'number' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return database;
  }
  async function transaction(names, mode, action) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(names, mode);
      const result = action(tx);
      tx.oncomplete = () => resolve(result?.result);
      tx.onerror = () => reject(tx.error || new Error('Local capture storage failed.'));
      tx.onabort = () => reject(tx.error || new Error('Local capture storage was interrupted.'));
    });
  }
  root.PagePressStore = {
    getJob: () => transaction(['meta'], 'readonly', (tx) => tx.objectStore('meta').get('job')),
    saveJob: (job) => transaction(['meta'], 'readwrite', (tx) => tx.objectStore('meta').put(job, 'job')),
    getPages: () => transaction(['pages'], 'readonly', (tx) => tx.objectStore('pages').getAll()),
    savePage: (page) => transaction(['pages'], 'readwrite', (tx) => tx.objectStore('pages').put(page)),
    reset: (job) => transaction(['meta', 'pages'], 'readwrite', (tx) => { tx.objectStore('pages').clear(); tx.objectStore('meta').put(job, 'job'); }),
    clear: () => transaction(['meta', 'pages'], 'readwrite', (tx) => { tx.objectStore('pages').clear(); tx.objectStore('meta').clear(); })
  };
})(globalThis);
