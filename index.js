/**
 * SillyTavern Compressed Save
 * ---------------------------------------------------------------
 *  纯前端扩展：拦截大体积 POST 请求，自动 gzip 压缩请求体。
 *  专治跨境云酒馆「保存 18MB 卡 50 秒」。
 *
 *  原理：
 *   1. monkey-patch window.fetch
 *   2. 对匹配路径的 POST 请求，把 body 用浏览器原生 CompressionStream 压成 gzip
 *   3. 附加 Content-Encoding: gzip 头
 *   4. Express 的 body-parser 默认 inflate=true，自动解压，后端无感知
 *   5. 【v1.2.0 新增】SaveGate 智能防抖滞留闸门：
 *      - 指纹去重（SHA-256）：相同内容在窗口期内直接吞掉，假装已保存
 *      - 同路径排队合并：前一个还没飞完，新的来了自动覆盖排队，只发最新一份
 *      - 全局串行上传：同一时间全网只准飞一个请求，彻底根治并发互踩丢包雪崩
 *
 *  【v1.2.2 修复】
 *      - 修复主干流程 `response is not defined`（块级作用域 bug），
 *        该 bug 会让每次成功保存后都被误判为失败
 *      - 新增 dispatched 标记：请求一旦真实发出，就绝不回退重发，
 *        杜绝「压缩上传成功 + 又全量重传一次」的双重写入灾难
 *      - 去重日志的原始体积不再显示 0
 *      - 上传超时现在会真正 AbortController.abort() 掐断连接
 *      - 主干异常时残留的排队任务会被正确 reject，避免 Promise 悬空
 *
 *  作者：莓可莉丝（meikorisu）for iftime
 *  License: MIT
 * ---------------------------------------------------------------
 */

(function () {
    'use strict';
    if (window.__CompressedSavePatched) {
        console.warn('[CompressedSave] 已经加载过一次，跳过重复挂载喵~');
        return;
    }
    window.__CompressedSavePatched = true;

    const MODULE_NAME = 'CompressedSave';
    const STORAGE_KEY = 'CompressedSave.settings.v1';
    const MAX_LOG_ROWS = 30;

    // ---------- 默认配置 ----------
    const DEFAULTS = {
        enabled: true,
        targetPaths: [
            '/api/chats/save',
            '/api/chats/group/save',
            '/api/settings/save',
        ],
        minBytes: 4096,
        verbose: false,
        logEnabled: true,
        // v1.2.0 滞留去重机制
        dedupeEnabled: true,
        dedupeWindowSec: 300,        // 去重有效期（秒），默认 5 分钟
        persistDedupe: false,        // 跨刷新保留去重指纹（默认关：刷新保证安全）
        globalSerial: true,          // 全局串行锁：防止多请求并发互踩
        sendTimeoutSec: 180,         // 上传超时熔断（秒）
    };

    // ---------- 设置持久化 ----------
    function loadSettings() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return { ...DEFAULTS };
            const parsed = JSON.parse(raw);
            return { ...DEFAULTS, ...parsed };
        } catch {
            return { ...DEFAULTS };
        }
    }
    function saveSettings(s) {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch {}
    }
    let settings = loadSettings();

    // ---------- 运行时统计 ----------
    const stats = {
        intercepted: 0,
        compressed: 0,
        deduped: 0,
        coalesced: 0,
        skipped: 0,
        failed: 0,
        bytesIn: 0,
        bytesOut: 0,
        lastRatio: null,
        log: [], // 最近 N 条记录 {time, path, status, rawSize, gzSize, ratio, gzipMs, totalMs, note}
    };

    function pushLog(entry) {
        if (!settings.logEnabled) return;
        stats.log.unshift(entry);
        if (stats.log.length > MAX_LOG_ROWS) stats.log.length = MAX_LOG_ROWS;
        scheduleUIRefresh();
    }

    function incStat(key) {
        if (!settings.logEnabled) return;
        stats[key]++;
    }
    function addStat(key, val) {
        if (!settings.logEnabled) return;
        stats[key] += val;
    }
    function setStat(key, val) {
        if (!settings.logEnabled) return;
        stats[key] = val;
    }

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

    // ---------- 工具函数 ----------
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

    // 计算内容指纹（支持 string / ArrayBuffer / TypedDataView，v1.2.1 修复字符串入参崩溃）
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
        // 极冷备用 FNV 变体 hash（防极旧或特殊环境，碰撞率高但仅影响去重命中率）
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

    function shouldIntercept(url, init) {
        if (!settings.enabled) return false;
        const method = (init?.method || 'GET').toUpperCase();
        if (method !== 'POST' && method !== 'PUT' && method !== 'PATCH') return false;
        let pathname = '';
        try {
            const u = typeof url === 'string' ? url : url?.url || '';
            pathname = u.startsWith('http') ? new URL(u).pathname : (u.split('?')[0] || u);
        } catch { return false; }
        return settings.targetPaths.some(p => pathname.includes(p));
    }

    function extractPath(input) {
        try {
            const u = typeof input === 'string' ? input : input?.url || '';
            return u.startsWith('http') ? new URL(u).pathname : (u.split('?')[0] || u);
        } catch { return '?'; }
    }

    // =================================================================
    //                     SaveGate 智能防抖滞留闸门
    // =================================================================
    class SaveGateManager {
        constructor() {
            // path -> { hash: string, at: number } (只记录真正成功的指纹)
            this.fingerprints = new Map();
            // path -> { running: boolean, queued: { task, resolve, reject } | null }
            this.slots = new Map();
            // 全局串行上传 Promise 链
            this.globalSerialLock = Promise.resolve();

            if (settings.persistDedupe) {
                this.loadFromStorage();
            }

            // 监听窗口卸载/刷新警告
            window.addEventListener('beforeunload', () => {
                let pendingCount = 0;
                for (const slot of this.slots.values()) {
                    if (slot.running) pendingCount++;
                    if (slot.queued) pendingCount++;
                }
                if (pendingCount > 0) {
                    console.warn(`[${MODULE_NAME}] 页面刷新/离开：尚有 ${pendingCount} 个保存任务在排队或执行中喵！`);
                }
            });
        }

        loadFromStorage() {
            try {
                const raw = localStorage.getItem('CompressedSave.fingerprints.v1');
                if (!raw) return;
                const obj = JSON.parse(raw);
                const now = Date.now();
                const maxAge = (settings.dedupeWindowSec || 300) * 1000;
                for (const [p, item] of Object.entries(obj)) {
                    if (item && item.hash && (now - item.at) < maxAge) {
                        this.fingerprints.set(p, item);
                    }
                }
            } catch {}
        }

        saveToStorage() {
            if (!settings.persistDedupe) return;
            try {
                const obj = Object.fromEntries(this.fingerprints);
                localStorage.setItem('CompressedSave.fingerprints.v1', JSON.stringify(obj));
            } catch {}
        }

        clear(path) {
            if (path) {
                this.fingerprints.delete(path);
            } else {
                this.fingerprints.clear();
            }
            try { localStorage.removeItem('CompressedSave.fingerprints.v1'); } catch {}
        }

        // 带超时的底层发送执行（v1.2.2：超时真正 abort 底层连接，不再干等）
        async _execSendWithTimeout(sendFn) {
            const timeoutMs = (settings.sendTimeoutSec || 180) * 1000;
            const controller = new AbortController();
            let timerId = null;
            const timeoutPromise = new Promise((_, reject) => {
                timerId = setTimeout(() => {
                    try { controller.abort(); } catch {}
                    reject(new Error(`上传超时 (${settings.sendTimeoutSec}s)，已中止连接`));
                }, timeoutMs);
            });

            try {
                return await Promise.race([sendFn(controller.signal), timeoutPromise]);
            } finally {
                if (timerId) clearTimeout(timerId);
            }
        }

        // 全局串行调度
        _scheduleGlobalSerial(taskFn) {
            if (!settings.globalSerial) {
                return taskFn();
            }
            const run = () => taskFn();
            const next = this.globalSerialLock.then(run, run);
            this.globalSerialLock = next.catch(() => {});
            return next;
        }

        /**
         * 提交一个保存任务
         * @param {string} path 请求路径
         * @param {string} rawHash 原始数据指纹 (用于去重比对)
         * @param {number} rawSize 原始体积（仅用于日志展示）
         * @param {Function} executeFn 真正执行网络发送的闭包，接收 AbortSignal，必须返回 Response
         * @returns {Promise<Response>}
         */
        async submit(path, rawHash, rawSize, executeFn) {
                    // v1.2.1：指纹为 null（哈希失败降级）时跳过去重，直接上传
                    if (settings.dedupeEnabled && rawHash) {
                const cached = this.fingerprints.get(path);
                const now = Date.now();
                const windowMs = (settings.dedupeWindowSec || 300) * 1000;
                if (cached && cached.hash === rawHash && (now - cached.at) < windowMs) {
                    incStat('deduped');
                    if (settings.verbose) {
                        console.log(`%c[${MODULE_NAME}]%c 🎯 内容指纹一致，命中去重跳过网络请求喵：${path}`, 'color:#46c878;font-weight:bold', '');
                    }
                    pushLog({
                        time: nowHMS(),
                        path: path,
                        status: 'dedupe',
                        rawSize: cached.rawSize,
                        gzSize: 0,
                        ratio: 0,
                        gzipMs: 0,
                        totalMs: 0,
                        note: `指纹命中(剩 ${Math.round((windowMs - (now - cached.at)) / 1000)}s)，直接响应200`,
                    });
                    // 返回酒馆期望的标准 JSON 成功响应
                    return new Response(JSON.stringify({ ok: true, deduped: true }), {
                        status: 200,
                        statusText: 'OK',
                        headers: new Headers({ 'Content-Type': 'application/json' }),
                    });
                }
            }

            // ── 阀门 2：同路径任务合并（覆盖排队，只留最新）──
            let slot = this.slots.get(path);
            if (!slot) {
                slot = { running: false, queued: null };
                this.slots.set(path, slot);
            }

            if (slot.running) {
                incStat('coalesced');
                if (settings.verbose) {
                    console.log(`%c[${MODULE_NAME}]%c ⏳ 前一任务传输中，合并排队最新保存喵：${path}`, 'color:#c8a046;font-weight:bold', '');
                }
                return new Promise((resolve, reject) => {
                    // 如果之前已经有排队中的，覆盖它并让被覆盖者直接返回假成功（因为最新数据会包含其状态）
                    if (slot.queued) {
                        try {
                            slot.queued.resolve(new Response(JSON.stringify({ ok: true, superseded: true }), {
                                status: 200,
                                headers: new Headers({ 'Content-Type': 'application/json' }),
                            }));
                        } catch {}
                    }
                    slot.queued = { rawHash, rawSize, executeFn, resolve, reject };
                });
            }

            // 本路径主干执行流
            slot.running = true;
            try {
                // ★ v1.2.2 修复：response 必须声明在 while 循环之外！
                // 之前声明在循环体内，导致 `return response` 触发 ReferenceError，
                // 进而被上层 catch 误判为失败、并回退重发一次未压缩的全量数据。
                let response = null;
                let primaryResponse = null;
                let cur = { rawHash, rawSize, executeFn, resolve: null, reject: null, isPrimary: true };
                while (cur) {
                    let curErr = null;
                    try {
                        // ── 阀门 3：全局串行锁 + 超时熔断保护 ──
                        response = await this._execSendWithTimeout((signal) => {
                            return this._scheduleGlobalSerial(() => cur.executeFn(signal));
                        });
                    } catch (err) {
                        curErr = err;
                    }

                    if (curErr) {
                        // 排队任务失败 → 只 reject 它自己，不拖垮主干
                        if (cur.reject) { try { cur.reject(curErr); } catch {} }
                        // 主干自己失败 → 向上抛，由 patchedFetch 决定是否回退
                        if (cur.isPrimary) throw curErr;
                    } else {
                        if (cur.isPrimary && !primaryResponse) primaryResponse = response;
                        // 极其重要：只有收到真实服务器 ok 响应，才记录指纹
                        if (response && response.ok && cur.rawHash) {
                            this.fingerprints.set(path, {
                                hash: cur.rawHash,
                                at: Date.now(),
                                rawSize: cur.rawSize || 0,
                            });
                            this.saveToStorage();
                        }
                        if (cur.resolve) { try { cur.resolve(response); } catch {} }
                    }

                    // 检查在传输过程中是否有新的保存请求排队
                    const next = slot.queued;
                    slot.queued = null;
                    cur = next;
                }
                return primaryResponse || response;
            } finally {
                slot.running = false;
                this.slots.delete(path);
                // ★ v1.2.2 兜底：异常路径下残留的排队任务必须被 reject，否则 Promise 永远悬空、UI 假死
                if (slot.queued) {
                    const leftover = slot.queued;
                    slot.queued = null;
                    try { leftover.reject(new Error('主干保存任务异常，排队任务已取消')); } catch {}
                }
            }
        }
    }

    const saveGate = new SaveGateManager();

    // ---------- 核心：fetch hook ----------
    const originalFetch = window.fetch.bind(window);

    async function patchedFetch(input, init) {
        const t0 = performance.now();
        let pathname = extractPath(input);
        let dispatched = false;   // ★ v1.2.2：一旦为 true，就绝不回退重发（防止双重写入）
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

            if (!shouldIntercept(input, init)) {
                return originalFetch(input, init);
            }

            // 防止重复压缩：如果已经有 Content-Encoding，就不要再处理
            const existingHeaders = new Headers(init.headers || {});
            if (existingHeaders.has('content-encoding')) {
                incStat('skipped');
                pushLog({
                    time: nowHMS(),
                    path: pathname,
                    status: 'skip',
                    note: `已有 Content-Encoding: ${existingHeaders.get('content-encoding')}`,
                });
                return originalFetch(input, init);
            }

            if (typeof CompressionStream === 'undefined') {
                incStat('skipped');
                pushLog({
                    time: nowHMS(), path: pathname,
                    status: 'skip', note: 'CompressionStream 不可用',
                });
                return originalFetch(input, init);
            }

            const body = getBodyString(init.body);
            if (body == null) {
                incStat('skipped');
                pushLog({
                    time: nowHMS(), path: pathname,
                    status: 'skip', note: 'body 类型不支持',
                });
                return originalFetch(input, init);
            }

            const byteSize = typeof body === 'string' ? new Blob([body]).size : body.byteLength;
            if (byteSize < settings.minBytes) {
                incStat('skipped');
                pushLog({
                    time: nowHMS(), path: pathname,
                    status: 'skip', note: `< ${fmtBytes(settings.minBytes)} 阈值`,
                    rawSize: byteSize,
                });
                return originalFetch(input, init);
            }

            incStat('intercepted');

            // 1. 先计算原始未压缩内容的 SHA-256 指纹（v1.2.1：哈希失败只降级去重，不影响压缩上传）
            let rawHash = null;
            try {
                rawHash = await sha256Hex(body);
            } catch (hashErr) {
                console.warn(`[${MODULE_NAME}] 指纹计算失败，本次跳过去重（压缩上传不受影响喵）：`, hashErr);
            }

            // 2. 扔进 SaveGate 进行防抖、去重与串行调度
            return await saveGate.submit(pathname, rawHash, byteSize, async (signal) => {
                // ★ 进入此闭包 = 请求即将真实发出，标记 dispatched
                dispatched = true;

                // 进入此闭包才真正进行 gzip 压缩和发送
                const tGzipStart = performance.now();
                const { input: rawBytes, output: gzBytes } = await gzip(body);
                const tGzipEnd = performance.now();

                incStat('compressed');
                addStat('bytesIn', rawBytes.byteLength);
                addStat('bytesOut', gzBytes.byteLength);
                const currentRatio = gzBytes.byteLength / rawBytes.byteLength;
                setStat('lastRatio', currentRatio);

                const newHeaders = new Headers(init.headers || {});
                newHeaders.delete('content-length');
                newHeaders.set('content-encoding', 'gzip');
                if (!newHeaders.has('content-type')) {
                    newHeaders.set('content-type', 'application/json');
                }

                // 一次性发送 ArrayBuffer body，彻底避免 chunked 流式劣质回源
                const newInit = { ...init, headers: newHeaders, body: gzBytes, signal };

                if (settings.verbose) {
                    console.log(
                        `%c[${MODULE_NAME}]%c gzip ${fmtBytes(rawBytes.byteLength)} -> ${fmtBytes(gzBytes.byteLength)} ` +
                        `(${(currentRatio * 100).toFixed(1)}%, ${(tGzipEnd - tGzipStart).toFixed(0)}ms)  ${pathname}`,
                        'color:#b46aff;font-weight:bold', '',
                    );
                }

                const response = await originalFetch(input, newInit);
                const t1 = performance.now();

                pushLog({
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
            });

        } catch (err) {
            incStat('failed');
            console.error(`[${MODULE_NAME}] hook 或发送过程错误：`, err);
            pushLog({
                time: nowHMS(), path: pathname,
                status: 'error', note: String(err?.message || err),
            });
            // ★ v1.2.2 关键修复：一旦请求真实发出过，绝不回退重发！
            // 否则会出现「压缩上传成功 + 又全量重传一次」的双重写入灾难（既丢时间又烧流量）。
            if (dispatched) {
                throw err;
            }
            // 仅当「从未发出」（压缩/调度阶段就出错）时，才安全回退原生 fetch
            try {
                return originalFetch(input, init);
            } catch (e2) { throw err; }
        }
    }

    window.fetch = patchedFetch;

    // 控制台调试入口
    window.CompressedSave = {
        get settings() { return settings; },
        get stats() { return stats; },
        gate: saveGate,
        forceSave() {
            saveGate.clear();
            console.log(`[${MODULE_NAME}] 已清空保存指纹，下一次任何保存将强制完整上传喵！`);
            scheduleUIRefresh();
        },
        reset() {
            stats.intercepted = stats.compressed = stats.deduped = stats.coalesced = stats.skipped = stats.failed = 0;
            stats.bytesIn = stats.bytesOut = 0;
            stats.lastRatio = null;
            stats.log.length = 0;
            saveGate.clear();
            scheduleUIRefresh();
        },
    };

    console.log(`%c[${MODULE_NAME}]%c v1.2.2 已激活，SaveGate 滞留闸门 + gzip 已就绪喵~`, 'color:#b46aff;font-weight:bold', '');

    // =================================================================
    //                              UI 面板
    // =================================================================

    let uiRefreshTimer = null;
    function scheduleUIRefresh() {
        if (uiRefreshTimer) return;
        uiRefreshTimer = requestAnimationFrame(() => {
            uiRefreshTimer = null;
            refreshUI();
        });
    }

    function buildUI() {
        const container = document.getElementById('extensions_settings2')
            || document.getElementById('extensions_settings');
        if (!container) { setTimeout(buildUI, 500); return; }
        if (document.getElementById('CompressedSave_panel')) return;

        const panel = document.createElement('div');
        panel.id = 'CompressedSave_panel';
        panel.classList.add('CompressedSave-panel');

        panel.innerHTML = `
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>🐈 Compressed Save (猫猫加速喵~ v1.2.2)</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <small>为跨境酒馆提供 gzip 压缩与 SaveGate 智能滞留闸门。<b id="cs_status_badge" class="cs-badge cs-badge-on">已启用</b></small>

                    <div class="cs-row">
                        <label class="checkbox_label" for="cs_enabled" style="flex:1;">
                            <input id="cs_enabled" type="checkbox" ${settings.enabled ? 'checked' : ''}>
                            <span>启用压缩</span>
                        </label>
                        <label class="checkbox_label" for="cs_dedupe_enabled" style="flex:1;">
                            <input id="cs_dedupe_enabled" type="checkbox" ${settings.dedupeEnabled ? 'checked' : ''}>
                            <span>指纹去重</span>
                        </label>
                        <label class="checkbox_label" for="cs_serial" style="flex:1;">
                            <input id="cs_serial" type="checkbox" ${settings.globalSerial ? 'checked' : ''}>
                            <span>全局串行</span>
                        </label>
                        <label class="checkbox_label" for="cs_log_enabled" style="flex:1;">
                            <input id="cs_log_enabled" type="checkbox" ${settings.logEnabled ? 'checked' : ''}>
                            <span>实时日志</span>
                        </label>
                    </div>

                    <div class="cs-row">
                        <label for="cs_dedupe_sec" class="cs-field" style="flex:1;">
                            <small>指纹有效期（秒）：</small>
                            <input id="cs_dedupe_sec" type="number" class="text_pole" value="${settings.dedupeWindowSec}" min="10" step="30">
                        </label>
                        <label for="cs_min" class="cs-field" style="flex:1;">
                            <small>压缩阈值（字节）：</small>
                            <input id="cs_min" type="number" class="text_pole" value="${settings.minBytes}" min="0" step="1024">
                        </label>
                    </div>

                    <div class="cs-row">
                        <label class="checkbox_label" for="cs_persist" style="flex:1;">
                            <input id="cs_persist" type="checkbox" ${settings.persistDedupe ? 'checked' : ''}>
                            <span>跨刷新保留指纹（刷新不重复上传）</span>
                        </label>
                        <label class="checkbox_label" for="cs_verbose" style="flex:1;">
                            <input id="cs_verbose" type="checkbox" ${settings.verbose ? 'checked' : ''}>
                            <span>控制台详细日志</span>
                        </label>
                    </div>

                    <label for="cs_paths" class="cs-field">
                        <small>拦截路径（每行一个，匹配 includes）：</small>
                        <textarea id="cs_paths" class="text_pole cs-paths" rows="3">${settings.targetPaths.join('\n')}</textarea>
                    </label>

                    <hr>
                    <div class="cs-stats-grid">
                        <div class="cs-stat-card">
                            <div class="cs-stat-label">真实压缩</div>
                            <div class="cs-stat-value" id="cs_st_n">0</div>
                        </div>
                        <div class="cs-stat-card">
                            <div class="cs-stat-label">指纹去重</div>
                            <div class="cs-stat-value" id="cs_st_dedupe" style="color:#46c878;">0</div>
                        </div>
                        <div class="cs-stat-card">
                            <div class="cs-stat-label">排队合并</div>
                            <div class="cs-stat-value" id="cs_st_coal" style="color:#c8a046;">0</div>
                        </div>
                        <div class="cs-stat-card">
                            <div class="cs-stat-label">跳过/失败</div>
                            <div class="cs-stat-value"><span id="cs_st_skip">0</span> / <span id="cs_st_fail">0</span></div>
                        </div>
                        <div class="cs-stat-card cs-stat-card-wide">
                            <div class="cs-stat-label">累计上传节省（压缩 + 去重）</div>
                            <div class="cs-stat-value">
                                <span id="cs_st_in">0</span>
                                <span class="cs-stat-arrow">→</span>
                                <span id="cs_st_out">0</span>
                                <small id="cs_st_saved" class="cs-saved">省 0</small>
                            </div>
                        </div>
                    </div>

                    <div class="cs-row cs-actions">
                        <input type="button" class="menu_button" id="cs_force_save" value="⚡ 强制下次全量" title="清空指纹缓存，下次操作一定会发送网络上传">
                        <input type="button" class="menu_button" id="cs_reset" value="🧹 清空统计">
                        <input type="button" class="menu_button" id="cs_test" value="🧪 自检测速">
                        <input type="button" class="menu_button" id="cs_copy" value="📋 复制诊断">
                    </div>

                    <hr>
                    <div class="cs-log-header">
                        <b>📜 实时日志</b>
                        <small>最近 ${MAX_LOG_ROWS} 条</small>
                    </div>
                    <div class="cs-log-wrap">
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
                            <tbody id="cs_log_body">
                                <tr><td colspan="9" class="cs-empty">暂无记录，发条消息试试喵~</td></tr>
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        `;

        container.appendChild(panel);

        const $ = id => document.getElementById(id);
        $('cs_enabled').addEventListener('change', e => {
            settings.enabled = e.target.checked;
            saveSettings(settings);
            refreshUI();
        });
        $('cs_dedupe_enabled').addEventListener('change', e => {
            settings.dedupeEnabled = e.target.checked;
            saveSettings(settings);
            refreshUI();
        });
        $('cs_serial').addEventListener('change', e => {
            settings.globalSerial = e.target.checked;
            saveSettings(settings);
        });
        $('cs_log_enabled').addEventListener('change', e => {
            settings.logEnabled = e.target.checked;
            saveSettings(settings);
            refreshUI();
        });
        $('cs_verbose').addEventListener('change', e => {
            settings.verbose = e.target.checked;
            saveSettings(settings);
        });
        $('cs_persist').addEventListener('change', e => {
            settings.persistDedupe = e.target.checked;
            saveSettings(settings);
            if (!settings.persistDedupe) {
                try { localStorage.removeItem('CompressedSave.fingerprints.v1'); } catch {}
            }
        });
        $('cs_dedupe_sec').addEventListener('change', e => {
            const v = parseInt(e.target.value, 10);
            settings.dedupeWindowSec = isFinite(v) && v >= 5 ? v : DEFAULTS.dedupeWindowSec;
            saveSettings(settings);
        });
        $('cs_min').addEventListener('change', e => {
            const v = parseInt(e.target.value, 10);
            settings.minBytes = isFinite(v) && v >= 0 ? v : DEFAULTS.minBytes;
            saveSettings(settings);
        });
        $('cs_paths').addEventListener('change', e => {
            settings.targetPaths = e.target.value
                .split('\n').map(s => s.trim()).filter(Boolean);
            saveSettings(settings);
        });

        $('cs_force_save').addEventListener('click', () => {
            window.CompressedSave.forceSave();
            alert('指纹已清空！下次触发保存将完整上传到服务器喵~');
        });
        $('cs_reset').addEventListener('click', () => window.CompressedSave.reset());
        $('cs_test').addEventListener('click', runSelfTest);
        $('cs_copy').addEventListener('click', copyDiagnostics);

        refreshUI();
    }

    function refreshUI() {
        const $ = id => document.getElementById(id);
        if (!$('cs_st_n')) return;

        $('cs_st_n').textContent = stats.compressed;
        if ($('cs_st_dedupe')) $('cs_st_dedupe').textContent = stats.deduped;
        if ($('cs_st_coal')) $('cs_st_coal').textContent = stats.coalesced;
        $('cs_st_skip').textContent = stats.skipped;
        $('cs_st_fail').textContent = stats.failed;

        $('cs_st_in').textContent = fmtBytes(stats.bytesIn);
        $('cs_st_out').textContent = fmtBytes(stats.bytesOut);

        const saved = stats.bytesIn - stats.bytesOut;
        const savedPct = stats.bytesIn > 0 ? (saved / stats.bytesIn * 100) : 0;
        $('cs_st_saved').textContent = `省 ${fmtBytes(saved)} (${savedPct.toFixed(1)}%)`;

        const badge = $('cs_status_badge');
        if (badge) {
            badge.textContent = settings.enabled ? '已启用' : '已禁用';
            badge.className = 'cs-badge ' + (settings.enabled ? 'cs-badge-on' : 'cs-badge-off');
        }

        // 日志表格
        const tbody = $('cs_log_body');
        if (!tbody) return;
        if (!settings.logEnabled) {
            tbody.innerHTML = '<tr><td colspan="9" class="cs-empty">日志记录已关闭</td></tr>';
            return;
        }
        if (stats.log.length === 0) {
            tbody.innerHTML = '<tr><td colspan="9" class="cs-empty">暂无记录，发条消息试试喵~</td></tr>';
            return;
        }
        tbody.innerHTML = stats.log.map(e => {
            const statusClass = (e.status === 'ok' || e.status === 'dedupe') ? 'cs-st-ok'
                : e.status === 'skip' ? 'cs-st-skip'
                : e.status === 'error' ? 'cs-st-err'
                : 'cs-st-warn';
            const shortPath = e.path
                ? e.path.replace('/api/chats/', '/.../').slice(-32)
                : '—';
            return `<tr>
                <td>${e.time || '—'}</td>
                <td class="${statusClass}">${e.status}</td>
                <td title="${escapeHtml(e.path || '')}">${escapeHtml(shortPath)}</td>
                <td>${fmtBytes(e.rawSize)}</td>
                <td>${fmtBytes(e.gzSize)}</td>
                <td>${e.ratio == null ? '—' : (e.ratio * 100).toFixed(1) + '%'}</td>
                <td>${fmtMs(e.gzipMs)}</td>
                <td>${fmtMs(e.totalMs)}</td>
                <td class="cs-note" title="${escapeHtml(e.note || '')}">${escapeHtml(e.note || '')}</td>
            </tr>`;
        }).join('');
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        }[c]));
    }

    // ---------- 自检功能：本地压缩一段 1MB 数据测试 ----------
    async function runSelfTest() {
        const btn = document.getElementById('cs_test');
        if (!btn) return;
        const orig = btn.value;
        btn.value = '测试中...';
        btn.disabled = true;
        try {
            if (typeof CompressionStream === 'undefined') {
                alert('当前浏览器不支持 CompressionStream，无法启用压缩喵 QAQ');
                return;
            }
            const sample = JSON.stringify({
                msg: '猫猫思故猫猫在'.repeat(50),
                role: 'assistant',
                meta: { tags: ['test', 'cat', 'savegate'] },
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
        } finally {
            btn.value = orig;
            btn.disabled = false;
        }
    }

    // ---------- 一键复制诊断信息 ----------
    function copyDiagnostics() {
        const info = {
            module: MODULE_NAME,
            version: '1.2.2',
            ua: navigator.userAgent,
            compressionStreamSupported: typeof CompressionStream !== 'undefined',
            settings,
            stats: {
                intercepted: stats.intercepted,
                compressed: stats.compressed,
                deduped: stats.deduped,
                coalesced: stats.coalesced,
                skipped: stats.skipped,
                failed: stats.failed,
                bytesIn: stats.bytesIn,
                bytesOut: stats.bytesOut,
                lastRatio: stats.lastRatio,
                recentLog: stats.log.slice(0, 15),
            },
            time: new Date().toISOString(),
        };
        const text = JSON.stringify(info, null, 2);
        navigator.clipboard.writeText(text).then(
            () => alert('诊断信息已复制到剪贴板喵～粘给莓可看吧！'),
            () => {
                const win = window.open('', '_blank');
                win.document.body.innerText = text;
            },
        );
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', buildUI);
    } else {
        buildUI();
    }
})();
