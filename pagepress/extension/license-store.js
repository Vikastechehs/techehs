/* A separate extension-origin database: clearing document captures keeps the license. */
(function (root) {
  let database;
  function open() {
    if (!database) database = new Promise((resolve, reject) => {
      const request = indexedDB.open('pagepress-license', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('settings');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('Local license storage is unavailable.'));
    });
    return database;
  }
  async function transact(mode, action) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('settings', mode), request = action(tx.objectStore('settings'));
      tx.oncomplete = () => resolve(request?.result);
      tx.onerror = () => reject(tx.error || new Error('Could not save the local license.'));
      tx.onabort = () => reject(tx.error || new Error('Local license storage was interrupted.'));
    });
  }
  root.PagePressLicenseStore = {
    async get(key) { return { [key]: await transact('readonly', (store) => store.get(key)) }; },
    async set(values) { await transact('readwrite', (store) => { for (const [key, value] of Object.entries(values)) store.put(value, key); }); },
    async remove(key) { await transact('readwrite', (store) => store.delete(key)); }
  };
})(globalThis);
