const DB = 'mundi-survivors-research-v1';
const MAX_PENDING = 512;
const MAX_RUN_BYTES = 96 * 1024 * 1024;
const STORE_TIMEOUT = 4000;
const encoder = new TextEncoder();

function historyEntry({run_id, manifest, result}) {
  return {run_id, created_at: manifest.created_at, model: manifest.model.kind, visual_profile: manifest.visual?.profile ?? 'none-v1',
    seed: manifest.config.seed, reason: result?.reason ?? null};
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 4);
    const timer = setTimeout(() => reject(Error('研究存储打开超时')), STORE_TIMEOUT);
    request.onupgradeneeded = ({oldVersion}) => {
      const db = request.result;
      db.createObjectStore('nodes', {keyPath: 'node_id'});
      if (oldVersion < 3) db.createObjectStore('videos');
      if (oldVersion >= 2) return;
      const history = db.createObjectStore('history', {keyPath: 'run_id'});
      history.createIndex('created_at', 'created_at');
      if (!oldVersion) {
        db.createObjectStore('runs', {keyPath: 'run_id'});
        db.createObjectStore('events', {keyPath: ['run_id', 'seq']});
      } else {
        const cursor = request.transaction.objectStore('runs').openCursor();
        cursor.onsuccess = () => {
          const row = cursor.result;
          if (!row) return;
          history.put(historyEntry(row.value));
          row.continue();
        };
      }
    };
    request.onerror = () => {
      clearTimeout(timer);
      reject(request.error);
    };
    request.onsuccess = () => {
      clearTimeout(timer);
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
  });
}

function transaction(db, stores, mode, work) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    const timer = setTimeout(() => {
      try { tx.abort(); } catch {}
      reject(Error('研究存储事务超时'));
    }, STORE_TIMEOUT);
    tx.onabort = () => {
      clearTimeout(timer);
      reject(tx.error ?? Error('研究存储事务已中止'));
    };
    let request;
    tx.oncomplete = () => {
      clearTimeout(timer);
      resolve(request?.result);
    };
    try { request = work(tx); }
    catch (error) {
      clearTimeout(timer);
      tx.abort();
      reject(error);
    }
  });
}

export async function openEvidence() {
  const db = await openDatabase();
  const put = value => transaction(db, ['runs', 'history'], 'readwrite', tx => {
    tx.objectStore('runs').put(value);
    tx.objectStore('history').put(historyEntry(value));
  });
  async function readEvents(id) {
    const keyRange = IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);
    const events = await transaction(db, 'events', 'readonly', tx => tx.objectStore('events').getAll(keyRange));
    return events.map(({content}) => JSON.parse(content));
  }
  return {
    async start(run, onFailure) {
      await put(run);
      let queue = [];
      let pending;
      let failure;
      let seq = 0;
      let bytes = 0;
      let timer;
      let closed = false;
      const fail = error => {
        if (failure) return;
        failure = error;
        onFailure(error);
      };
      const write = () => {
        clearTimeout(timer);
        timer = undefined;
        if (pending || !queue.length) return pending;
        const entries = queue;
        queue = [];
        pending = transaction(db, 'events', 'readwrite', tx => {
          const store = tx.objectStore('events');
          for (const entry of entries) store.add(entry);
        }).catch(fail).finally(() => {
          pending = undefined;
          if (queue.length) schedule();
        });
        return pending;
      };
      const schedule = () => { timer ??= setTimeout(write, 150); };
      return {
        add(event) {
          if (closed || failure) return;
          try {
            const content = JSON.stringify(event);
            bytes += encoder.encode(content).length;
            if (queue.length >= MAX_PENDING || bytes > MAX_RUN_BYTES) throw Error('实验记录达到单局存储上限');
            queue.push({run_id: run.run_id, seq: ++seq, content});
            if (queue.length >= 64) write();
            else schedule();
          } catch (error) { fail(error); }
        },
        flush: write,
        async finish(completion, summarize) {
          closed = true;
          while (pending || queue.length) await (pending ?? write());
          const saved = {...run, ...completion, evidence_bytes: bytes, evidence_complete: !failure && Boolean(completion.evidence_complete),
            evidence_fault: failure?.message ?? completion.evidence_fault ?? null};
          try {
            Object.assign(saved, summarize(saved, await readEvents(run.run_id)));
          } catch (error) {
            saved.evidence_complete = false;
            saved.evidence_fault ??= error.message;
          }
          try { await put(saved); }
          catch (error) {
            fail(error);
            saved.evidence_complete = false;
            saved.evidence_fault = error.message;
          }
          return saved;
        }
      };
    },
    async list() {
      const rows = [];
      await transaction(db, 'history', 'readonly', tx => {
        const request = tx.objectStore('history').index('created_at').openCursor(null, 'prev');
        request.onsuccess = () => {
          if (!request.result || rows.length >= 50) return;
          rows.push(request.result.value);
          request.result.continue();
        };
      });
      return rows;
    },
    node: id => transaction(db, 'nodes', 'readonly', tx => tx.objectStore('nodes').get(id)),
    nodes: () => transaction(db, 'nodes', 'readonly', tx => tx.objectStore('nodes').getAll()),
    saveNode: node => transaction(db, 'nodes', 'readwrite', tx => tx.objectStore('nodes').put(node)),
    run: id => transaction(db, 'runs', 'readonly', tx => tx.objectStore('runs').get(id)),
    events: readEvents,
    humanVideo: () => transaction(db, 'videos', 'readonly', tx => tx.objectStore('videos').get('latest-human')),
    saveHumanVideo: video => transaction(db, 'videos', 'readwrite', tx => tx.objectStore('videos').put(video, 'latest-human'))
  };
}

export async function hashJSON(value) {
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}
