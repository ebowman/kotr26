/**
 * KOTR 2026 - User Route Store
 * Persists user-uploaded .fit/.gpx files in IndexedDB so the flyover can
 * load them via flyover.html?route=user:<id>. Everything stays in the
 * browser - files are never sent to a server.
 */

const RouteStore = (function() {
    'use strict';

    const DB_NAME = 'kotr-user-routes';
    const DB_VERSION = 1;
    const STORE = 'routes';

    function openDb() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(STORE)) {
                    db.createObjectStore(STORE, { keyPath: 'id' });
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error || new Error('Failed to open route database'));
        });
    }

    function requestToPromise(req) {
        return new Promise((resolve, reject) => {
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error || new Error('Route database request failed'));
        });
    }

    /**
     * Save an uploaded route file.
     * @param {File} file - A .fit or .gpx File from an input or drop event
     * @returns {Promise<string>} id usable as flyover.html?route=user:<id>
     */
    async function saveRoute(file) {
        const buffer = await file.arrayBuffer();
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        const record = {
            id,
            name: file.name.replace(/\.(fit|gpx)$/i, '').replace(/[_-]+/g, ' '),
            fileName: file.name,
            buffer,
            addedAt: Date.now()
        };
        const db = await openDb();
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(record);
        await new Promise((resolve, reject) => {
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error || new Error('Failed to save route'));
        });
        db.close();
        return id;
    }

    /**
     * Fetch a stored route by id. Resolves to null if not found.
     */
    async function getRoute(id) {
        const db = await openDb();
        const result = await requestToPromise(
            db.transaction(STORE, 'readonly').objectStore(STORE).get(id)
        );
        db.close();
        return result || null;
    }

    /**
     * List stored routes (without buffers) newest first.
     */
    async function listRoutes() {
        const db = await openDb();
        const all = await requestToPromise(
            db.transaction(STORE, 'readonly').objectStore(STORE).getAll()
        );
        db.close();
        return all
            .map(({ id, name, fileName, addedAt }) => ({ id, name, fileName, addedAt }))
            .sort((a, b) => b.addedAt - a.addedAt);
    }

    async function deleteRoute(id) {
        const db = await openDb();
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(id);
        await new Promise((resolve, reject) => {
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error || new Error('Failed to delete route'));
        });
        db.close();
    }

    /**
     * Validate a candidate upload. Returns an error message or null if OK.
     */
    function validateFile(file) {
        if (!file) return 'No file selected';
        if (!/\.(fit|gpx)$/i.test(file.name)) return 'Please choose a .fit or .gpx file';
        if (file.size > 25 * 1024 * 1024) return 'File too large (max 25 MB)';
        return null;
    }

    // Public API
    return {
        saveRoute,
        getRoute,
        listRoutes,
        deleteRoute,
        validateFile
    };
})();

// Export for modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = RouteStore;
}
