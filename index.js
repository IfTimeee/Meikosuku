// D:\Projects\SillyTavern-CompressedSave\index.js
import { StorageManager } from './src/core/storage.js';
import { ModuleRegistry } from './src/core/registry.js';
import saveGateModule from './src/modules/saveGate/index.js';
import tokenGateModule from './src/modules/tokenGate/index.js';

(function () {
    'use strict';

    if (window.__MeikosukuPatched) {
        console.warn('[Meikosuku] 插件核心已加载过，跳过重复初始化喵~');
        return;
    }
    window.__MeikosukuPatched = true;

    const storage = new StorageManager('Meikosuku.settings.v1');
    const registry = new ModuleRegistry(storage);

    // 注册核心模块
    registry.register(saveGateModule);
    registry.register(tokenGateModule);

    // 启动所有模块
    registry.initAll();

    // 暴露全局调试对象
    window.Meikosuku = {
        version: '2.0.0',
        registry,
        modules: {
            saveGate: saveGateModule,
            tokenGate: tokenGateModule,
        },
        forceSave() {
            saveGateModule.forceSave();
        },
        resetStats() {
            saveGateModule.resetStats();
        }
    };
    // 兼容历史命名
    window.Meiko = window.Meikosuku;
    window.CompressedSave = window.Meikosuku;

    console.log('%c[Meikosuku]%c (猫速 ฅ^•ﻌ•^ฅ) v2.0.0 已成功挂载，极速引擎已就绪喵~', 'color:#b46aff;font-weight:bold', '');

    // ================= 统一控制台 UI =================
    function buildUI() {
        const container = document.getElementById('extensions_settings2')
            || document.getElementById('extensions_settings');
        if (!container) {
            setTimeout(buildUI, 500);
            return;
        }
        if (document.getElementById('Meikosuku_panel')) return;

        const panel = document.createElement('div');
        panel.id = 'Meikosuku_panel';
        panel.className = 'CompressedSave-panel meiko-main-panel';

        panel.innerHTML = `
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>🐈 Meikosuku (猫速 ฅ^•ﻌ•^ฅ v2.0.0)</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div class="meiko-hub-intro">
                        <small><b>Meikosuku · 猫速</b> —— 为 SillyTavern 注入猫娘推背感，专治各类史山卡顿与性能毒瘤喵~</small>
                    </div>
                    <div id="meiko_modules_container" class="meiko-modules-list"></div>
                </div>
            </div>
        `;

        container.appendChild(panel);

        const modulesContainer = document.getElementById('meiko_modules_container');
        if (modulesContainer) {
            registry.renderUI(modulesContainer);
        }

        // 注：折叠/展开完全交给酒馆原生的事件委托处理（document 级监听 .inline-drawer-toggle）。
        // 之前在这里手动绑定了点击切换，结果与酒馆原生 handler 各切换一次，
        // 一次点击 = 两次 toggle，表现就是「展开又瞬间收回」喵。已移除，遵从宿主机制。
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', buildUI);
    } else {
        buildUI();
    }
})();
