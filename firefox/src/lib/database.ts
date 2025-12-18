// WikiColumn - IndexedDB Database Wrapper

import type {
  TableRecord,
  WikidataItem,
  WikidataProperty,
  Claim,
  LabelCacheEntry,
} from './types';

const LOG_LEVEL = 0;

const DB_NAME = 'WikiColumnDB';
const DB_VERSION = 2;

// Cache TTL: 24 hours in milliseconds
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const STORES = {
  TABLES: 'tables',
  ITEMS: 'items',
  PROPERTIES: 'properties',
  CLAIMS: 'claims',
  LABEL_CACHE: 'labelCache',
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

        // Label cache store: SPARQL query results by label (v2)
        if (!db.objectStoreNames.contains(STORES.LABEL_CACHE)) {
          db.createObjectStore(STORES.LABEL_CACHE, { keyPath: 'label' });
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

  /**
   * Check if a cached item is still fresh (within TTL)
   */
  private isFresh(cachedAt: number | undefined): boolean {
    if (!cachedAt) return false;
    return Date.now() - cachedAt < CACHE_TTL_MS;
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
    const itemWithTimestamp = { ...item, cachedAt: Date.now() };
    return new Promise((resolve, reject) => {
      const request = store.put(itemWithTimestamp);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async saveItems(items: WikidataItem[]): Promise<void> {
    const db = await this.init();
    const transaction = db.transaction(STORES.ITEMS, 'readwrite');
    const store = transaction.objectStore(STORES.ITEMS);
    const now = Date.now();

    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);

      for (const item of items) {
        store.put({ ...item, cachedAt: now });
      }
    });
  }

  async getFreshItem(qid: string): Promise<WikidataItem | undefined> {
    const store = await this.getStore(STORES.ITEMS);
    return new Promise((resolve, reject) => {
      const request = store.get(qid);
      request.onsuccess = () => {
        const result = request.result as WikidataItem | undefined;
        if (result && this.isFresh(result.cachedAt)) {
          resolve(result);
        } else {
          resolve(undefined);
        }
      };
      request.onerror = () => reject(request.error);
    });
  }

  async getFreshItems(qids: string[]): Promise<{ fresh: Map<string, WikidataItem>; stale: string[] }> {
    const store = await this.getStore(STORES.ITEMS);
    const fresh = new Map<string, WikidataItem>();
    const stale: string[] = [];

    const promises = qids.map(
      (qid) =>
        new Promise<void>((resolve, reject) => {
          const request = store.get(qid);
          request.onsuccess = () => {
            const result = request.result as WikidataItem | undefined;
            if (result && this.isFresh(result.cachedAt)) {
              fresh.set(qid, result);
            } else {
              stale.push(qid);
            }
            resolve();
          };
          request.onerror = () => reject(request.error);
        })
    );

    await Promise.all(promises);
    return { fresh, stale };
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
    const propertyWithTimestamp = { ...property, cachedAt: Date.now() };
    return new Promise((resolve, reject) => {
      // Use add to INSERT OR IGNORE behavior (won't overwrite existing)
      const request = store.get(property.pid);
      request.onsuccess = () => {
        if (!request.result) {
          const putRequest = store.put(propertyWithTimestamp);
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
    const now = Date.now();

    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);

      for (const property of properties) {
        // Check if exists first (INSERT OR IGNORE)
        if (LOG_LEVEL > 2) console.log(`WikiColumn: Saving to cache property ${property.pid}`);
        store.put({ ...property, cachedAt: now });
      }
    });
  }

  async getFreshProperty(pid: string): Promise<WikidataProperty | undefined> {
    const store = await this.getStore(STORES.PROPERTIES);
    return new Promise((resolve, reject) => {
      const request = store.get(pid);
      request.onsuccess = () => {
        const result = request.result as WikidataProperty | undefined;
        if (result && this.isFresh(result.cachedAt)) {
          resolve(result);
        } else {
          resolve(undefined);
        }
      };
      request.onerror = () => reject(request.error);
    });
  }

  async getFreshProperties(pids: string[]): Promise<{ fresh: Map<string, WikidataProperty>; stale: string[] }> {
    const store = await this.getStore(STORES.PROPERTIES);
    const fresh = new Map<string, WikidataProperty>();
    const stale: string[] = [];

    const promises = pids.map(
      (pid) =>
        new Promise<void>((resolve, reject) => {
          const request = store.get(pid);
          request.onsuccess = () => {
            const result = request.result as WikidataProperty | undefined;
            if (result && this.isFresh(result.cachedAt)) {
              fresh.set(pid, result);
            } else {
              stale.push(pid);
            }
            resolve();
          };
          request.onerror = () => reject(request.error);
        })
    );

    await Promise.all(promises);
    return { fresh, stale };
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

  async getAllProperties(): Promise<WikidataProperty[]> {
    const store = await this.getStore(STORES.PROPERTIES);
    return new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  async getPropertiesSortedByUsage(): Promise<WikidataProperty[]> {
    const properties = await this.getAllProperties();
    return properties.sort((a, b) => (b.usage || 0) - (a.usage || 0));
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

  async incrementPropertyUsage(pid: string): Promise<void> {
    const store = await this.getStore(STORES.PROPERTIES, 'readwrite');
    return new Promise((resolve, reject) => {
      const getRequest = store.get(pid);
      getRequest.onsuccess = () => {
        if (getRequest.result) {
          const property = getRequest.result as WikidataProperty;
          property.usage = (property.usage || 0) + 1;
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
    const claimWithTimestamp = { ...claim, cachedAt: Date.now() };
    return new Promise((resolve, reject) => {
      const request = store.put(claimWithTimestamp);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async saveClaims(claims: Claim[]): Promise<void> {
    const db = await this.init();
    const transaction = db.transaction(STORES.CLAIMS, 'readwrite');
    const store = transaction.objectStore(STORES.CLAIMS);
    const now = Date.now();

    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);

      for (const claim of claims) {
        store.put({ ...claim, cachedAt: now });
      }
    });
  }

  async getFreshClaimsByQid(qid: string): Promise<{ fresh: Claim[]; isStale: boolean }> {
    const store = await this.getStore(STORES.CLAIMS);
    const index = store.index('qid');
    return new Promise((resolve, reject) => {
      const request = index.getAll(qid);
      request.onsuccess = () => {
        const claims = (request.result || []) as Claim[];
        // If any claim is stale, consider all stale for this QID
        const isStale = claims.length === 0 || claims.some(c => !this.isFresh(c.cachedAt));
        if (isStale) {
          resolve({ fresh: [], isStale: true });
        } else {
          resolve({ fresh: claims, isStale: false });
        }
      };
      request.onerror = () => reject(request.error);
    });
  }

  async getFreshClaimsByQids(qids: string[]): Promise<{ fresh: Map<string, Claim[]>; stale: string[] }> {
    const fresh = new Map<string, Claim[]>();
    const stale: string[] = [];

    for (const qid of qids) {
      const result = await this.getFreshClaimsByQid(qid);
      if (result.isStale) {
        stale.push(qid);
      } else {
        fresh.set(qid, result.fresh);
      }
    }

    return { fresh, stale };
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
  // Label Cache (SPARQL query results)
  // ============================================================================

  async saveLabelCache(entry: LabelCacheEntry): Promise<void> {
    const store = await this.getStore(STORES.LABEL_CACHE, 'readwrite');
    const entryWithTimestamp = { ...entry, cachedAt: Date.now() };
    return new Promise((resolve, reject) => {
      const request = store.put(entryWithTimestamp);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async saveLabelCacheEntries(entries: LabelCacheEntry[]): Promise<void> {
    const db = await this.init();
    const transaction = db.transaction(STORES.LABEL_CACHE, 'readwrite');
    const store = transaction.objectStore(STORES.LABEL_CACHE);
    const now = Date.now();

    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);

      for (const entry of entries) {
        store.put({ ...entry, cachedAt: now });
      }
    });
  }

  async getFreshLabelCache(label: string): Promise<LabelCacheEntry | undefined> {
    const store = await this.getStore(STORES.LABEL_CACHE);
    return new Promise((resolve, reject) => {
      const request = store.get(label);
      request.onsuccess = () => {
        const result = request.result as LabelCacheEntry | undefined;
        if (result && this.isFresh(result.cachedAt)) {
          resolve(result);
        } else {
          resolve(undefined);
        }
      };
      request.onerror = () => reject(request.error);
    });
  }

  async getFreshLabelCaches(labels: string[]): Promise<{ fresh: Map<string, LabelCacheEntry>; stale: string[] }> {
    const store = await this.getStore(STORES.LABEL_CACHE);
    const fresh = new Map<string, LabelCacheEntry>();
    const stale: string[] = [];

    const promises = labels.map(
      (label) =>
        new Promise<void>((resolve, reject) => {
          const request = store.get(label);
          request.onsuccess = () => {
            const result = request.result as LabelCacheEntry | undefined;
            if (result && this.isFresh(result.cachedAt)) {
              fresh.set(label, result);
            } else {
              stale.push(label);
            }
            resolve();
          };
          request.onerror = () => reject(request.error);
        })
    );

    await Promise.all(promises);
    return { fresh, stale };
  }

  // ============================================================================
  // Utility
  // ============================================================================

  async clear(): Promise<void> {
    const db = await this.init();
    const storeNames = [STORES.TABLES, STORES.ITEMS, STORES.PROPERTIES, STORES.CLAIMS, STORES.LABEL_CACHE];

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
