// D:\Projects\SillyTavern-CompressedSave\src\modules\tokenGate\index.js
export default {
    id: 'tokenGate',
    name: 'token计算优化',
    icon: '⚡',
    version: '0.1.0-preview',
    description: '针对预设条目分块哈希缓存、空闲防抖与 Token 调度优化，消除界面卡顿。',
    defaultSettings: {
        enabled: false,       // 默认先关闭，等第二阶段正式联调上线
        debounceMs: 150,      // 防抖窗口
        useChunkCache: true,  // 细粒度分块缓存
        cacheMaxEntries: 1000 // 最大缓存项
    },

    init(context) {
        this.context = context;
        const { logger } = context;
        logger.info('token计算优化 模块已就绪喵~');
    },

    renderUI(container) {
        const s = this.context.settings;
        const card = document.createElement('div');
        card.className = 'meiko-module-card inline-drawer';
        card.id = 'meiko_tokengate_card';

        card.innerHTML = `
            <div class="inline-drawer-toggle inline-drawer-header meiko-drawer-header">
                <div class="meiko-card-title">
                    <span class="meiko-icon">${this.icon}</span>
                    <b>${this.name}</b>
                    <span class="meiko-badge meiko-badge-dev">筹备中喵~</span>
                </div>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content meiko-drawer-content">
                <div class="meiko-card-desc" style="margin-bottom: 10px;">${this.description}</div>
                <div class="cs-row">
                    <label class="checkbox_label" for="tg_enabled" style="flex:1;">
                        <input id="tg_enabled" type="checkbox" ${s.enabled ? 'checked' : ''} disabled>
                        <span>启用优化 (即将上线)</span>
                    </label>
                    <label class="checkbox_label" for="tg_chunk" style="flex:1;">
                        <input id="tg_chunk" type="checkbox" ${s.useChunkCache ? 'checked' : ''} disabled>
                        <span>预设条目分块哈希缓存</span>
                    </label>
                </div>
                <div class="cs-row">
                    <label for="tg_debounce" class="cs-field" style="flex:1;">
                        <small>UI 防抖窗口（毫秒）：</small>
                        <input id="tg_debounce" type="number" class="text_pole" value="${s.debounceMs}" min="50" step="50" disabled>
                    </label>
                    <label for="tg_cache_max" class="cs-field" style="flex:1;">
                        <small>最大缓存条目数：</small>
                        <input id="tg_cache_max" type="number" class="text_pole" value="${s.cacheMaxEntries}" min="100" step="100" disabled>
                    </label>
                </div>
                <small style="opacity:0.75;display:block;margin-top:6px;">
                    🐾 架构插槽已接入百宝箱总线，正在适配酒馆预设与 Token 优化链路...
                </small>
            </div>
        `;

        container.appendChild(card);
    },

    destroy() {
        // 清理钩子
    }
};
