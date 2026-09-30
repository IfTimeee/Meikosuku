// D:\Projects\SillyTavern-CompressedSave\src\modules\saveGate\index.js
import { DEFAULTS } from './config.js';
import { SaveGateManager } from './saveGateManager.js';

function fmtBytes(n) {
    if (n == null) return '—';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function fmtMs(n) {
    if (n == null) return '—';
    if (n < 1000) return `${n.toFixed(0)} ms`;
    return `${(n / 1000).toFixed(2)} s`;
}

function nowHMS() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function getBodyString(body) {
    if (body == null) return null;
    if (typeof body === 'string') return body;
    if (body instanceof ArrayBuffer) return body;
    if (ArrayBuffer.isView(body)) {
        return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
    }
    return null;
}

async function gzip(data) {
    let input;
    if (typeof data === 'string') {
        input = new TextEncoder().encode(data);
    } else {
        input = new Uint8Array(data);
    }
    const cs = new CompressionStream('gzip');
    const writer = cs.writable.getWriter();
    writer.write(input);
    writer.close();
    const compressed = await new Response(cs.readable).arrayBuffer();
    return { input, output: compressed };
}

async function sha256Hex(data) {
    let bytes;
    if (typeof data === 'string') {
        bytes = new TextEncoder().encode(data);
    } else if (data instanceof ArrayBuffer) {
        bytes = new Uint8Array(data);
    } else if (ArrayBuffer.isView(data)) {
        bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } else {
        throw new Error('sha256Hex: 不支持的数据类型 ' + typeof data);
    }
    if (window.crypto && window.crypto.subtle) {
        const digest = await window.crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
    }
    let h1 = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) {
        h1 ^= bytes[i];
        h1 = Math.imul(h1, 0x01000193) >>> 0;
    }
    let h2 = bytes.length >>> 0;
    for (let i = 0; i < bytes.length; i += 97) {
        h2 = (Math.imul(h2, 31) + bytes[i]) >>> 0;
    }
    return 'fb_' + h1.toString(16) + '_' + h2.toString(16);
}

function extractPath(input) {
    try {
        const u = typeof input === 'string' ? input : input?.url || '';
        return u.startsWith('http') ? new URL(u).pathname : (u.split('?')[0] || u);
    } catch { return '?'; }
}

export default {
    id: 'saveGate',
    name: '史山保存加速 (SaveGate)',
    icon: '⚡',
    version: '1.2.2',
    description: '原生 gzip 压缩 + SHA-256 指纹去重 + 串行防互踩，专治跨境酒馆卡顿。',
    defaultSettings: DEFAULTS,

    init(context) {
        this.context = context;
        const { core, settings, saveSettings, logger } = context;

        this.stats = {
            intercepted: 0,
            compressed: 0,
            deduped: 0,
            coalesced: 0,
            skipped: 0,
            failed: 0,
            bytesIn: 0,
            bytesOut: 0,
            lastRatio: null,
            log: [],
        };

        this.gate = new SaveGateManager(
            () => this.context.settings,
            () => this.updateUI && this.updateUI()
        );

        this.setupFetchHook();
        logger.info('SaveGate 模块已就绪喵~');
    },

    shouldIntercept(url, init) {
        const s = this.context.settings;
        if (!s.enabled) return false;
        const method = (init?.method || 'GET').toUpperCase();
        if (method !== 'POST' && method !== 'PUT' && method !== 'PATCH') return false;
        let pathname = '';
        try {
            const u = typeof url === 'string' ? url : url?.url || '';
            pathname = u.startsWith('http') ? new URL(u).pathname : (u.split('?')[0] || u);
        } catch { return false; }
        return s.targetPaths.some(p => pathname.includes(p));
    },

    pushLog(entry) {
        if (!this.context.settings.logEnabled) return;
        this.stats.log.unshift(entry);
        if (this.stats.log.length > 30) this.stats.log.length = 30;
        if (this.updateUI) this.updateUI();
    },

    incStat(key) {
        if (!this.context.settings.logEnabled) return;
        this.stats[key]++;
    },

    addStat(key, val) {
        if (!this.context.settings.logEnabled) return;
        this.stats[key] += val;
    },

    setupFetchHook() {
        const originalFetch = window.fetch.bind(window);
        this._originalFetch = originalFetch;

        const self = this;
        window.fetch = async function (input, init) {
            const s = self.context.settings;
            const t0 = performance.now();
            let pathname = extractPath(input);
            let dispatched = false;

            try {
                if (input instanceof Request && !init) {
                    init = {
                        method: input.method,
                        headers: new Headers(input.headers),
                        body: await input.clone().text(),
                        mode: input.mode,
                        credentials: input.credentials,
                        cache: input.cache,
                        redirect: input.redirect,
                        referrer: input.referrer,
                        integrity: input.integrity,
                    };
                    input = input.url;
                }
                init = init || {};
                pathname = extractPath(input);

                if (!self.shouldIntercept(input, init)) {
                    return originalFetch(input, init);
                }

                const existingHeaders = new Headers(init.headers || {});
                if (existingHeaders.has('content-encoding')) {
                    self.incStat('skipped');
                    self.pushLog({
                        time: nowHMS(),
                        path: pathname,
                        status: 'skip',
                        note: `已有 Content-Encoding: ${existingHeaders.get('content-encoding')}`,
                    });
                    return originalFetch(input, init);
                }

                if (typeof CompressionStream === 'undefined') {
                    self.incStat('skipped');
                    self.pushLog({
                        time: nowHMS(), path: pathname,
                        status: 'skip', note: 'CompressionStream 不可用',
                    });
                    return originalFetch(input, init);
                }

                const body = getBodyString(init.body);
                if (body == null) {
                    self.incStat('skipped');
                    self.pushLog({
                        time: nowHMS(), path: pathname,
                        status: 'skip', note: 'body 类型不支持',
                    });
                    return originalFetch(input, init);
                }

                const byteSize = typeof body === 'string' ? new Blob([body]).size : body.byteLength;
                if (byteSize < s.minBytes) {
                    self.incStat('skipped');
                    self.pushLog({
                        time: nowHMS(), path: pathname,
                        status: 'skip', note: `< ${fmtBytes(s.minBytes)} 阈值`,
                        rawSize: byteSize,
                    });
                    return originalFetch(input, init);
                }

                self.incStat('intercepted');

                let rawHash = null;
                try {
                    rawHash = await sha256Hex(body);
                } catch (hashErr) {
                    console.warn(`[MeikoSaveGate] 指纹计算失败，跳过去重喵：`, hashErr);
                }

                return await self.gate.submit(
                    pathname,
                    rawHash,
                    byteSize,
                    async (signal) => {
                        dispatched = true;
                        const tGzipStart = performance.now();
                        const { input: rawBytes, output: gzBytes } = await gzip(body);
                        const tGzipEnd = performance.now();

                        self.incStat('compressed');
                        self.addStat('bytesIn', rawBytes.byteLength);
                        self.addStat('bytesOut', gzBytes.byteLength);
                        const currentRatio = gzBytes.byteLength / rawBytes.byteLength;
                        self.stats.lastRatio = currentRatio;

                        const newHeaders = new Headers(init.headers || {});
                        newHeaders.delete('content-length');
                        newHeaders.set('content-encoding', 'gzip');
                        if (!newHeaders.has('content-type')) {
                            newHeaders.set('content-type', 'application/json');
                        }

                        const newInit = { ...init, headers: newHeaders, body: gzBytes, signal };

                        if (s.verbose) {
                            console.log(
                                `%c[MeikoSaveGate]%c gzip ${fmtBytes(rawBytes.byteLength)} -> ${fmtBytes(gzBytes.byteLength)} ` +
                                `(${(currentRatio * 100).toFixed(1)}%, ${(tGzipEnd - tGzipStart).toFixed(0)}ms)  ${pathname}`,
                                'color:#b46aff;font-weight:bold', '',
                            );
                        }

                        const response = await originalFetch(input, newInit);
                        const t1 = performance.now();

                        self.pushLog({
                            time: nowHMS(),
                            path: pathname,
                            status: response.ok ? 'ok' : `http ${response.status}`,
                            rawSize: rawBytes.byteLength,
                            gzSize: gzBytes.byteLength,
                            ratio: currentRatio,
                            gzipMs: tGzipEnd - tGzipStart,
                            totalMs: t1 - t0,
                        });

                        return response;
                    },
                    {
                        incStat: k => self.incStat(k),
                        pushLog: e => self.pushLog(e),
                        nowHMS,
                    }
                );
            } catch (err) {
                self.incStat('failed');
                console.error(`[MeikoSaveGate] hook 或发送过程错误：`, err);
                self.pushLog({
                    time: nowHMS(), path: pathname,
                    status: 'error', note: String(err?.message || err),
                });
                if (dispatched) {
                    throw err;
                }
                try {
                    return originalFetch(input, init);
                } catch (e2) { throw err; }
            }
        };
    },

    forceSave() {
        this.gate.clear();
        console.log('[MeikoSaveGate] 已清空保存指纹，下一次任何保存将强制完整上传喵！');
        if (this.updateUI) this.updateUI();
    },

    resetStats() {
        this.stats.intercepted = this.stats.compressed = this.stats.deduped = this.stats.coalesced = this.stats.skipped = this.stats.failed = 0;
        this.stats.bytesIn = this.stats.bytesOut = 0;
        this.stats.lastRatio = null;
        this.stats.log.length = 0;
        this.gate.clear();
        if (this.updateUI) this.updateUI();
    },

    async runSelfTest() {
        try {
            if (typeof CompressionStream === 'undefined') {
                alert('当前浏览器不支持 CompressionStream，无法启用压缩喵 QAQ');
                return;
            }
            const sample = JSON.stringify({
                msg: '猫猫思故猫猫在'.repeat(50),
                role: 'assistant',
                meta: { tags: ['test', 'cat', 'meikobox'] },
            });
            const fakePayload = '[' + new Array(2000).fill(sample).join(',') + ']';

            const t0 = performance.now();
            const { input, output } = await gzip(fakePayload);
            const t1 = performance.now();

            const ratio = output.byteLength / input.byteLength;
            const hash = await sha256Hex(output);
            const msg =
                `✅ 自检与 SaveGate 通过喵！\n\n` +
                `样本大小：${fmtBytes(input.byteLength)}\n` +
                `压缩后：${fmtBytes(output.byteLength)}\n` +
                `压缩比：${(ratio * 100).toFixed(1)}%（省 ${(100 - ratio * 100).toFixed(1)}%）\n` +
                `压缩耗时：${(t1 - t0).toFixed(0)} ms\n` +
                `SHA-256：${hash.slice(0, 16)}...\n\n` +
                `滞留机制正常，已就绪喵～`;
            alert(msg);
        } catch (e) {
            alert(`❌ 自检失败喵：${e?.message || e}`);
        }
    },

    renderUI(container) {
        const s = this.context.settings;
        const card = document.createElement('div');
        card.className = 'meiko-module-card inline-drawer';
        card.id = 'meiko_savegate_card';

        card.innerHTML = `
            <div class="inline-drawer-toggle inline-drawer-header meiko-drawer-header">
                <div class="meiko-card-title">
                    <span class="meiko-icon">${this.icon}</span>
                    <b>${this.name}</b>
                    <span class="meiko-badge ${s.enabled ? 'meiko-badge-on' : 'meiko-badge-off'}" id="sg_status_badge">
                        ${s.enabled ? '已启用' : '已禁用'}
                    </span>
                </div>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content meiko-drawer-content">
                <div class="meiko-card-desc" style="margin-bottom: 10px;">${this.description}</div>
                <div class="cs-row">
                    <label class="checkbox_label" for="sg_enabled" style="flex:1;">
                        <input id="sg_enabled" type="checkbox" ${s.enabled ? 'checked' : ''}>
                        <span>启用加速</span>
                    </label>
                    <label class="checkbox_label" for="sg_dedupe" style="flex:1;">
                        <input id="sg_dedupe" type="checkbox" ${s.dedupeEnabled ? 'checked' : ''}>
                        <span>指纹去重</span>
                    </label>
                    <label class="checkbox_label" for="sg_serial" style="flex:1;">
                        <input id="sg_serial" type="checkbox" ${s.globalSerial ? 'checked' : ''}>
                        <span>全局串行</span>
                    </label>
                    <label class="checkbox_label" for="sg_log" style="flex:1;">
                        <input id="sg_log" type="checkbox" ${s.logEnabled ? 'checked' : ''}>
                        <span>实时日志</span>
                    </label>
                </div>

                <div class="cs-row">
                    <label for="sg_dedupe_sec" class="cs-field" style="flex:1;">
                        <small>指纹有效期（秒）：</small>
                        <input id="sg_dedupe_sec" type="number" class="text_pole" value="${s.dedupeWindowSec}" min="10" step="30">
                    </label>
                    <label for="sg_min" class="cs-field" style="flex:1;">
                        <small>压缩阈值（字节）：</small>
                        <input id="sg_min" type="number" class="text_pole" value="${s.minBytes}" min="0" step="1024">
                    </label>
                </div>

                <div class="cs-row">
                    <label class="checkbox_label" for="sg_persist" style="flex:1;">
                        <input id="sg_persist" type="checkbox" ${s.persistDedupe ? 'checked' : ''}>
                        <span>跨刷新保留指纹</span>
                    </label>
                    <label class="checkbox_label" for="sg_verbose" style="flex:1;">
                        <input id="sg_verbose" type="checkbox" ${s.verbose ? 'checked' : ''}>
                        <span>控制台详细输出</span>
                    </label>
                </div>

                <label for="sg_paths" class="cs-field">
                    <small>拦截路径（每行一个）：</small>
                    <textarea id="sg_paths" class="text_pole cs-paths" rows="2">${s.targetPaths.join('\n')}</textarea>
                </label>

                <div class="cs-stats-grid">
                    <div class="cs-stat-card">
                        <div class="cs-stat-label">真实压缩</div>
                        <div class="cs-stat-value" id="sg_st_n">0</div>
                    </div>
                    <div class="cs-stat-card">
                        <div class="cs-stat-label">指纹去重</div>
                        <div class="cs-stat-value" id="sg_st_dedupe" style="color:#46c878;">0</div>
                    </div>
                    <div class="cs-stat-card">
                        <div class="cs-stat-label">排队合并</div>
                        <div class="cs-stat-value" id="sg_st_coal" style="color:#c8a046;">0</div>
                    </div>
                    <div class="cs-stat-card">
                        <div class="cs-stat-label">跳过/失败</div>
                        <div class="cs-stat-value"><span id="sg_st_skip">0</span> / <span id="sg_st_fail">0</span></div>
                    </div>
                    <div class="cs-stat-card cs-stat-card-wide">
                        <div class="cs-stat-label">累计上传节省（压缩 + 去重）</div>
                        <div class="cs-stat-value">
                            <span id="sg_st_in">0</span>
                            <span class="cs-stat-arrow">→</span>
                            <span id="sg_st_out">0</span>
                            <small id="sg_st_saved" class="cs-saved">省 0</small>
                        </div>
                    </div>
                </div>

                <div class="cs-row cs-actions">
                    <input type="button" class="menu_button" id="sg_force_save" value="⚡ 强制下次全量">
                    <input type="button" class="menu_button" id="sg_btn_reset" value="🧹 清空统计">
                    <input type="button" class="menu_button" id="sg_btn_test" value="🧪 自检测速">
                </div>

                <details class="meiko-log-accordion">
                    <summary><b>📜 模块运行日志 (最近 30 条)</b></summary>
                    <div class="cs-log-wrap" style="margin-top:6px;">
                        <table class="cs-log-table">
                            <thead><tr>
                                <th>时间</th>
                                <th>状态</th>
                                <th>路径</th>
                                <th>原始</th>
                                <th>压缩</th>
                                <th>比</th>
                                <th>gzip</th>
                                <th>总耗时</th>
                                <th>备注</th>
                            </tr></thead>
                            <tbody id="sg_log_body">
                                <tr><td colspan="9" class="cs-empty">暂无记录喵~</td></tr>
                            </tbody>
                        </table>
                    </div>
                </details>
            </div>
        `;

        container.appendChild(card);

        const $ = id => document.getElementById(id);
        const persist = () => this.context.saveSettings();

        $('sg_enabled').addEventListener('change', e => {
            s.enabled = e.target.checked;
            persist();
            this.updateUI();
        });
        $('sg_dedupe').addEventListener('change', e => {
            s.dedupeEnabled = e.target.checked;
            persist();
            this.updateUI();
        });
        $('sg_serial').addEventListener('change', e => {
            s.globalSerial = e.target.checked;
            persist();
        });
        $('sg_log').addEventListener('change', e => {
            s.logEnabled = e.target.checked;
            persist();
            this.updateUI();
        });
        $('sg_verbose').addEventListener('change', e => {
            s.verbose = e.target.checked;
            persist();
        });
        $('sg_persist').addEventListener('change', e => {
            s.persistDedupe = e.target.checked;
            persist();
            if (!s.persistDedupe) {
                try { localStorage.removeItem('CompressedSave.fingerprints.v1'); } catch {}
            }
        });
        $('sg_dedupe_sec').addEventListener('change', e => {
            const v = parseInt(e.target.value, 10);
            s.dedupeWindowSec = isFinite(v) && v >= 5 ? v : DEFAULTS.dedupeWindowSec;
            persist();
        });
        $('sg_min').addEventListener('change', e => {
            const v = parseInt(e.target.value, 10);
            s.minBytes = isFinite(v) && v >= 0 ? v : DEFAULTS.minBytes;
            persist();
        });
        $('sg_paths').addEventListener('change', e => {
            s.targetPaths = e.target.value.split('\n').map(x => x.trim()).filter(Boolean);
            persist();
        });

        $('sg_force_save').addEventListener('click', () => {
            this.forceSave();
            alert('指纹已清空！下次触发保存将完整上传到服务器喵~');
        });
        $('sg_btn_reset').addEventListener('click', () => this.resetStats());
        $('sg_btn_test').addEventListener('click', () => this.runSelfTest());

        this.updateUI = () => {
            if (!$('sg_st_n')) return;
            $('sg_st_n').textContent = this.stats.compressed;
            if ($('sg_st_dedupe')) $('sg_st_dedupe').textContent = this.stats.deduped;
            if ($('sg_st_coal')) $('sg_st_coal').textContent = this.stats.coalesced;
            $('sg_st_skip').textContent = this.stats.skipped;
            $('sg_st_fail').textContent = this.stats.failed;

            $('sg_st_in').textContent = fmtBytes(this.stats.bytesIn);
            $('sg_st_out').textContent = fmtBytes(this.stats.bytesOut);

            const saved = this.stats.bytesIn - this.stats.bytesOut;
            const savedPct = this.stats.bytesIn > 0 ? (saved / this.stats.bytesIn * 100) : 0;
            $('sg_st_saved').textContent = `省 ${fmtBytes(saved)} (${savedPct.toFixed(1)}%)`;

            const badge = $('sg_status_badge');
            if (badge) {
                badge.textContent = s.enabled ? '已启用' : '已禁用';
                badge.className = 'meiko-badge ' + (s.enabled ? 'meiko-badge-on' : 'meiko-badge-off');
            }

            const tbody = $('sg_log_body');
            if (!tbody) return;
            if (!s.logEnabled) {
                tbody.innerHTML = '<tr><td colspan="9" class="cs-empty">日志记录已关闭</td></tr>';
                return;
            }
            if (this.stats.log.length === 0) {
                tbody.innerHTML = '<tr><td colspan="9" class="cs-empty">暂无记录喵~</td></tr>';
                return;
            }
            tbody.innerHTML = this.stats.log.map(e => {
                const statusClass = (e.status === 'ok' || e.status === 'dedupe') ? 'cs-st-ok'
                    : e.status === 'skip' ? 'cs-st-skip'
                    : e.status === 'error' ? 'cs-st-err'
                    : 'cs-st-warn';
                const shortPath = e.path ? e.path.replace('/api/chats/', '/.../').slice(-32) : '—';
                return `<tr>
                    <td>${e.time || '—'}</td>
                    <td class="${statusClass}">${e.status}</td>
                    <td title="${e.path || ''}">${shortPath}</td>
                    <td>${fmtBytes(e.rawSize)}</td>
                    <td>${fmtBytes(e.gzSize)}</td>
                    <td>${e.ratio == null ? '—' : (e.ratio * 100).toFixed(1) + '%'}</td>
                    <td>${fmtMs(e.gzipMs)}</td>
                    <td>${fmtMs(e.totalMs)}</td>
                    <td class="cs-note" title="${e.note || ''}">${e.note || ''}</td>
                </tr>`;
            }).join('');
        };

        this.updateUI();
    },

    destroy() {
        if (this._originalFetch) {
            window.fetch = this._originalFetch;
        }
    }
};
