// D:\Projects\SillyTavern-CompressedSave\src\modules\saveGate\saveGateManager.js
export class SaveGateManager {
    constructor(getSettings, onFingerprintUpdate) {
        this.getSettings = getSettings;
        this.onFingerprintUpdate = onFingerprintUpdate;
        // path -> { hash: string, at: number, rawSize: number }
        this.fingerprints = new Map();
        // path -> { running: boolean, queued: { rawHash, rawSize, executeFn, resolve, reject } | null }
        this.slots = new Map();
        // 全局串行上传 Promise 链
        this.globalSerialLock = Promise.resolve();

        const s = this.getSettings();
        if (s.persistDedupe) {
            this.loadFromStorage();
        }

        window.addEventListener('beforeunload', () => {
            let pendingCount = 0;
            for (const slot of this.slots.values()) {
                if (slot.running) pendingCount++;
                if (slot.queued) pendingCount++;
            }
            if (pendingCount > 0) {
                console.warn(`[MeikoSaveGate] 页面刷新/离开：尚有 ${pendingCount} 个保存任务在排队或执行中喵！`);
            }
        });
    }

    loadFromStorage() {
        try {
            const raw = localStorage.getItem('CompressedSave.fingerprints.v1');
            if (!raw) return;
            const obj = JSON.parse(raw);
            const now = Date.now();
            const s = this.getSettings();
            const maxAge = (s.dedupeWindowSec || 300) * 1000;
            for (const [p, item] of Object.entries(obj)) {
                if (item && item.hash && (now - item.at) < maxAge) {
                    this.fingerprints.set(p, item);
                }
            }
        } catch {}
    }

    saveToStorage() {
        const s = this.getSettings();
        if (!s.persistDedupe) return;
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

    async _execSendWithTimeout(sendFn) {
        const s = this.getSettings();
        const timeoutMs = (s.sendTimeoutSec || 180) * 1000;
        const controller = new AbortController();
        let timerId = null;
        const timeoutPromise = new Promise((_, reject) => {
            timerId = setTimeout(() => {
                try { controller.abort(); } catch {}
                reject(new Error(`上传超时 (${s.sendTimeoutSec}s)，已中止连接`));
            }, timeoutMs);
        });

        try {
            return await Promise.race([sendFn(controller.signal), timeoutPromise]);
        } finally {
            if (timerId) clearTimeout(timerId);
        }
    }

    _scheduleGlobalSerial(taskFn) {
        const s = this.getSettings();
        if (!s.globalSerial) {
            return taskFn();
        }
        const run = () => taskFn();
        const next = this.globalSerialLock.then(run, run);
        this.globalSerialLock = next.catch(() => {});
        return next;
    }

    async submit(path, rawHash, rawSize, executeFn, hooks = {}) {
        const s = this.getSettings();
        const { incStat, pushLog, nowHMS } = hooks;

        // ── 阀门 1：指纹去重（相同哈希直接拦截）──
        if (s.dedupeEnabled && rawHash) {
            const cached = this.fingerprints.get(path);
            const now = Date.now();
            const windowMs = (s.dedupeWindowSec || 300) * 1000;
            if (cached && cached.hash === rawHash && (now - cached.at) < windowMs) {
                if (incStat) incStat('deduped');
                if (s.verbose) {
                    console.log(`%c[MeikoSaveGate]%c 🎯 内容指纹一致，命中去重跳过网络请求喵：${path}`, 'color:#46c878;font-weight:bold', '');
                }
                if (pushLog) {
                    pushLog({
                        time: nowHMS ? nowHMS() : '',
                        path: path,
                        status: 'dedupe',
                        rawSize: cached.rawSize || rawSize,
                        gzSize: 0,
                        ratio: 0,
                        gzipMs: 0,
                        totalMs: 0,
                        note: `指纹命中(剩 ${Math.round((windowMs - (now - cached.at)) / 1000)}s)，直接响应200`,
                    });
                }
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
            if (incStat) incStat('coalesced');
            if (s.verbose) {
                console.log(`%c[MeikoSaveGate]%c ⏳ 前一任务传输中，合并排队最新保存喵：${path}`, 'color:#c8a046;font-weight:bold', '');
            }
            return new Promise((resolve, reject) => {
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

        // 主干执行流
        slot.running = true;
        try {
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
                    if (cur.reject) { try { cur.reject(curErr); } catch {} }
                    if (cur.isPrimary) throw curErr;
                } else {
                    if (cur.isPrimary && !primaryResponse) primaryResponse = response;
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

                const next = slot.queued;
                slot.queued = null;
                cur = next;
            }
            return primaryResponse || response;
        } finally {
            slot.running = false;
            this.slots.delete(path);
            if (slot.queued) {
                const leftover = slot.queued;
                slot.queued = null;
                try { leftover.reject(new Error('主干保存任务异常，排队任务已取消')); } catch {}
            }
        }
    }
}
