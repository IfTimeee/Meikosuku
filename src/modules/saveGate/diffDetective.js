// D:\Projects\Meikosuku\src\modules\saveGate\diffDetective.js
//
// 【Debug 工具】去重未命中 Diff 侦探
// 职责：当同一保存路径的新 body 指纹未能命中缓存时，
//      与上一次的 body 做递归 JSON diff，找出到底哪些字段在变。
// 仅做诊断输出，不修改任何数据、不参与任何拦截逻辑。喵！

/**
 * 递归收集 JSON 值的所有叶子路径与值
 * @param {any} node 当前节点
 * @param {string} prefix 路径前缀
 * @param {Map<string, any>} out 输出 map：路径 -> 叶子值
 */
function collectLeaves(node, prefix, out) {
    if (node === null || typeof node !== 'object') {
        out.set(prefix, node);
        return;
    }
    if (Array.isArray(node)) {
        // 数组以 [i] 索引作为路径段
        for (let i = 0; i < node.length; i++) {
            collectLeaves(node[i], `${prefix}[${i}]`, out);
        }
        // 记录数组长度，用于检测元素增删
        out.set(`${prefix}.__length`, node.length);
        return;
    }
    for (const key of Object.keys(node)) {
        collectLeaves(node[key], prefix ? `${prefix}.${key}` : key, out);
    }
}

/**
 * 对比两次叶子表，生成差异描述列表
 * @param {Map<string, any>} oldLeaves 旧 body 叶子
 * @param {Map<string, any>} newLeaves 新 body 叶子
 * @returns {string[]} 差异行列表
 */
function diffLeaves(oldLeaves, newLeaves) {
    const diffs = [];
    const limit = 40; // 最多输出 40 条，防止刷屏

    for (const [path, val] of newLeaves) {
        if (limit && diffs.length >= limit) {
            diffs.push(`…（还有更多差异未展示喵）`);
            break;
        }
        if (!oldLeaves.has(path)) {
            diffs.push(`+ 新增 ${path} = ${preview(val)}`);
            continue;
        }
        const oldVal = oldLeaves.get(path);
        if (oldVal !== val) {
            diffs.push(`~ 变更 ${path}: ${preview(oldVal)} → ${preview(val)}`);
        }
    }
    for (const [path, val] of oldLeaves) {
        if (limit && diffs.length >= limit) {
            diffs.push(`…（还有更多差异未展示喵）`);
            break;
        }
        if (!newLeaves.has(path)) {
            diffs.push(`- 删除 ${path} (原值 ${preview(val)})`);
        }
    }
    return diffs;
}

function preview(v) {
    if (v === undefined) return 'undefined';
    if (typeof v === 'string') {
        const s = v.length > 60 ? v.slice(0, 60) + `…(${v.length} chars)` : v;
        return `"${s}"`;
    }
    return String(v);
}

/**
 * 侦探主入口：对比新旧 body 并输出差异报告
 * @param {string} path 请求路径
 * @param {string} oldBody 上一次的 body 字符串
 * @param {string} newBody 这一次的 body 字符串
 * @returns {string[]|null} 差异列表；无法解析时返回 null
 */
export function diffBodies(path, oldBody, newBody) {
    try {
        const oldObj = JSON.parse(oldBody);
        const newObj = JSON.parse(newBody);
        const oldLeaves = new Map();
        const newLeaves = new Map();
        collectLeaves(oldObj, '', oldLeaves);
        collectLeaves(newObj, '', newLeaves);
        return diffLeaves(oldLeaves, newLeaves);
    } catch (e) {
        console.warn(`[MeikoDiffDetective] ${path} body JSON 解析失败，无法 diff：`, e);
        return null;
    }
}
