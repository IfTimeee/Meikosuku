// D:\Projects\SillyTavern-CompressedSave\src\core\storage.js
export class StorageManager {
    constructor(storageKey = 'MeikoPlugin.settings.v1') {
        this.storageKey = storageKey;
    }

    load() {
        try {
            const raw = localStorage.getItem(this.storageKey);
            return raw ? JSON.parse(raw) : {};
        } catch (e) {
            console.error('[MeikoCore] 读取设置失败：', e);
            return {};
        }
    }

    save(data) {
        try {
            localStorage.setItem(this.storageKey, JSON.stringify(data));
        } catch (e) {
            console.error('[MeikoCore] 保存设置失败：', e);
        }
    }
}
