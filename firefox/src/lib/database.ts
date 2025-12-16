// WikiColumn - IndexedDB Database Wrapper

import type {
  TableRecord,
  WikidataItem,
  WikidataProperty,
  Claim,
} from './types';

const DB_NAME = 'WikiColumnDB';
const DB_VERSION = 1;

const STORES = {
  TABLES: 'tables',
  ITEMS: 'items',
  PROPERTIES: 'properties',
  CLAIMS: 'claims',
} as const;

class WikiColumnDB {
  private db: IDBDatabase | null = null;
  private initPromise: Promise<IDBDatabase> | null = null;

  async init(): Promise<IDBDatabase> {
    if (this.db) return this.db;
    if (this.initPromise) return this.initPromise;

    this.initPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        console.error('Failed to open WikiColumnDB:', request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve(this.db);
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // Tables store: url + xpath as compound key
        if (!db.objectStoreNames.contains(STORES.TABLES)) {
          const tableStore = db.createObjectStore(STORES.TABLES, { keyPath: 'id' });
          tableStore.createIndex('url', 'url', { unique: false });
          tableStore.createIndex('url_xpath', ['url', 'xpath'], { unique: true });
        }

        // Items store: Wikidata entities by QID
        if (!db.objectStoreNames.contains(STORES.ITEMS)) {
          db.createObjectStore(STORES.ITEMS, { keyPath: 'qid' });
        }

        // Properties store: Wikidata properties by PID
        if (!db.objectStoreNames.contains(STORES.PROPERTIES)) {
          const propStore = db.createObjectStore(STORES.PROPERTIES, { keyPath: 'pid' });
          propStore.createIndex('visible', 'visible', { unique: false });
        }

        // Claims store: compound key of qid + pid
        if (!db.objectStoreNames.contains(STORES.CLAIMS)) {
          const claimStore = db.createObjectStore(STORES.CLAIMS, { keyPath: ['qid', 'pid'] });
          claimStore.createIndex('qid', 'qid', { unique: false });
          claimStore.createIndex('pid', 'pid', { unique: false });
        }
      };
    });

    return this.initPromise;
  }

  private async getStore(storeName: string, mode: IDBTransactionMode = 'readonly'): Promise<IDBObjectStore> {
    const db = await this.init();
    const transaction = db.transaction(storeName, mode);
    return transaction.objectStore(storeName);
  }

  // ============================================================================
  // Tables
  // ============================================================================

  async saveTable(table: TableRecord): Promise<void> {
    const store = await this.getStore(STORES.TABLES, 'readwrite');
    return new Promise((resolve, reject) => {
      const request = store.put(table);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async getTable(id: string): Promise<TableRecord | undefined> {
    const store = await this.getStore(STORES.TABLES);
    return new Promise((resolve, reject) => {
      const request = store.get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async getTableByUrlAndXpath(url: string, xpath: string): Promise<TableRecord | undefined> {
    const store = await this.getStore(STORES.TABLES);
    const index = store.index('url_xpath');
    return new Promise((resolve, reject) => {
      const request = index.get([url, xpath]);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async getTablesByUrl(url: string): Promise<TableRecord[]> {
    const store = await this.getStore(STORES.TABLES);
    const index = store.index('url');
    return new Promise((resolve, reject) => {
      const request = index.getAll(url);
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  async deleteTable(id: string): Promise<void> {
    const store = await this.getStore(STORES.TABLES, 'readwrite');
    return new Promise((resolve, reject) => {
      const request = store.delete(id);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  // ============================================================================
  // Wikidata Items
  // ============================================================================

  async saveItem(item: WikidataItem): Promise<void> {
    const store = await this.getStore(STORES.ITEMS, 'readwrite');
    return new Promise((resolve, reject) => {
      const request = store.put(item);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async saveItems(items: WikidataItem[]): Promise<void> {
    const db = await this.init();
    const transaction = db.transaction(STORES.ITEMS, 'readwrite');
    const store = transaction.objectStore(STORES.ITEMS);

    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);

      for (const item of items) {
        store.put(item);
      }
    });
  }

  async getItem(qid: string): Promise<WikidataItem | undefined> {
    const store = await this.getStore(STORES.ITEMS);
    return new Promise((resolve, reject) => {
      const request = store.get(qid);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async getItems(qids: string[]): Promise<Map<string, WikidataItem>> {
    const store = await this.getStore(STORES.ITEMS);
    const results = new Map<string, WikidataItem>();

    const promises = qids.map(
      (qid) =>
        new Promise<void>((resolve, reject) => {
          const request = store.get(qid);
          request.onsuccess = () => {
            if (request.result) {
              results.set(qid, request.result);
            }
            resolve();
          };
          request.onerror = () => reject(request.error);
        })
    );

    await Promise.all(promises);
    return results;
  }

  // ============================================================================
  // Wikidata Properties
  // ============================================================================

  async saveProperty(property: WikidataProperty): Promise<void> {
    const store = await this.getStore(STORES.PROPERTIES, 'readwrite');
    return new Promise((resolve, reject) => {
      // Use add to INSERT OR IGNORE behavior (won't overwrite existing)
      const request = store.get(property.pid);
      request.onsuccess = () => {
        if (!request.result) {
          const putRequest = store.put(property);
          putRequest.onsuccess = () => resolve();
          putRequest.onerror = () => reject(putRequest.error);
        } else {
          resolve(); // Already exists, skip
        }
      };
      request.onerror = () => reject(request.error);
    });
  }

  async saveProperties(properties: WikidataProperty[]): Promise<void> {
    const db = await this.init();
    const transaction = db.transaction(STORES.PROPERTIES, 'readwrite');
    const store = transaction.objectStore(STORES.PROPERTIES);

    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);

      for (const property of properties) {
        // Check if exists first (INSERT OR IGNORE)
        const getReq = store.get(property.pid);
        getReq.onsuccess = () => {
          if (!getReq.result) {
            store.put(property);
          }
        };
      }
    });
  }

  async getProperty(pid: string): Promise<WikidataProperty | undefined> {
    const store = await this.getStore(STORES.PROPERTIES);
    return new Promise((resolve, reject) => {
      const request = store.get(pid);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async getProperties(pids: string[]): Promise<Map<string, WikidataProperty>> {
    const store = await this.getStore(STORES.PROPERTIES);
    const results = new Map<string, WikidataProperty>();

    const promises = pids.map(
      (pid) =>
        new Promise<void>((resolve, reject) => {
          const request = store.get(pid);
          request.onsuccess = () => {
            if (request.result) {
              results.set(pid, request.result);
            }
            resolve();
          };
          request.onerror = () => reject(request.error);
        })
    );

    await Promise.all(promises);
    return results;
  }

  async getAllVisibleProperties(): Promise<WikidataProperty[]> {
    const store = await this.getStore(STORES.PROPERTIES);
    const index = store.index('visible');
    return new Promise((resolve, reject) => {
      const request = index.getAll(true);
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  async updatePropertyVisibility(pid: string, visible: boolean): Promise<void> {
    const store = await this.getStore(STORES.PROPERTIES, 'readwrite');
    return new Promise((resolve, reject) => {
      const getRequest = store.get(pid);
      getRequest.onsuccess = () => {
        if (getRequest.result) {
          const property = getRequest.result as WikidataProperty;
          property.visible = visible;
          const putRequest = store.put(property);
          putRequest.onsuccess = () => resolve();
          putRequest.onerror = () => reject(putRequest.error);
        } else {
          resolve();
        }
      };
      getRequest.onerror = () => reject(getRequest.error);
    });
  }

  // ============================================================================
  // Claims
  // ============================================================================

  async saveClaim(claim: Claim): Promise<void> {
    const store = await this.getStore(STORES.CLAIMS, 'readwrite');
    return new Promise((resolve, reject) => {
      const request = store.put(claim);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async saveClaims(claims: Claim[]): Promise<void> {
    const db = await this.init();
    const transaction = db.transaction(STORES.CLAIMS, 'readwrite');
    const store = transaction.objectStore(STORES.CLAIMS);

    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);

      for (const claim of claims) {
        store.put(claim);
      }
    });
  }

  async getClaimsByQid(qid: string): Promise<Claim[]> {
    const store = await this.getStore(STORES.CLAIMS);
    const index = store.index('qid');
    return new Promise((resolve, reject) => {
      const request = index.getAll(qid);
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  async getClaimsByQids(qids: string[]): Promise<Map<string, Claim[]>> {
    const results = new Map<string, Claim[]>();
    for (const qid of qids) {
      const claims = await this.getClaimsByQid(qid);
      results.set(qid, claims);
    }
    return results;
  }

  async getClaim(qid: string, pid: string): Promise<Claim | undefined> {
    const store = await this.getStore(STORES.CLAIMS);
    return new Promise((resolve, reject) => {
      const request = store.get([qid, pid]);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  // ============================================================================
  // Utility
  // ============================================================================

  async clear(): Promise<void> {
    const db = await this.init();
    const storeNames = [STORES.TABLES, STORES.ITEMS, STORES.PROPERTIES, STORES.CLAIMS];

    for (const storeName of storeNames) {
      const transaction = db.transaction(storeName, 'readwrite');
      const store = transaction.objectStore(storeName);
      await new Promise<void>((resolve, reject) => {
        const request = store.clear();
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    }
  }
}

// Singleton instance
export const db = new WikiColumnDB();
