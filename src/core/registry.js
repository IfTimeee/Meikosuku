// D:\Projects\SillyTavern-CompressedSave\src\core\registry.js
export class ModuleRegistry {
    constructor(storage, options = {}) {
        this.storage = storage;
        this.options = options;
        this.modules = new Map();
        this.settings = this.storage.load();
    }

    register(moduleDef) {
        if (!moduleDef || !moduleDef.id) {
            throw new Error('[MeikoRegistry] 模块未提供合法 id');
        }
        if (this.modules.has(moduleDef.id)) {
            console.warn(`[MeikoRegistry] 模块 ${moduleDef.id} 已存在，跳过重复注册喵~`);
            return;
        }

        // 初始化/合并该模块持久化设置
        if (!this.settings[moduleDef.id]) {
            this.settings[moduleDef.id] = { ...moduleDef.defaultSettings };
            this.storage.save(this.settings);
        } else {
            this.settings[moduleDef.id] = { ...moduleDef.defaultSettings, ...this.settings[moduleDef.id] };
        }

        this.modules.set(moduleDef.id, moduleDef);
    }

    initAll() {
        for (const [id, mod] of this.modules.entries()) {
            try {
                const context = {
                    core: this,
                    settings: this.settings[id],
                    saveSettings: () => this.storage.save(this.settings),
                    logger: {
                        info: (...args) => console.log(`%c[MeikoCore:${id}]%c`, 'color:#b46aff;font-weight:bold', '', ...args),
                        warn: (...args) => console.warn(`[MeikoCore:${id}]`, ...args),
                        error: (...args) => console.error(`[MeikoCore:${id}]`, ...args),
                    }
                };
                if (typeof mod.init === 'function') {
                    mod.init(context);
                }
            } catch (err) {
                console.error(`[MeikoRegistry] 模块 ${id} 初始化异常：`, err);
            }
        }
    }

    renderUI(container) {
        for (const [id, mod] of this.modules.entries()) {
            if (typeof mod.renderUI === 'function') {
                try {
                    mod.renderUI(container);
                } catch (e) {
                    console.error(`[MeikoRegistry] 渲染模块 ${id} UI 失败：`, e);
                }
            }
        }
    }
}
