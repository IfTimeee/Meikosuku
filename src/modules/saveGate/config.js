// D:\Projects\SillyTavern-CompressedSave\src\modules\saveGate\config.js
export const DEFAULTS = {
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
