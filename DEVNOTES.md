# Meikosuku (猫速) · 开发笔记本

> 本文档由莓可莉丝（meikorisu）维护，记录 Meikosuku 项目的开发进度与关键决策。
> 最后更新：2026-10-01

---

## 项目概况

- **项目名**：Meikosuku（猫速 ฅ^•ﻌ•^ฅ）
- **命名由来**：Meiko（莓可）+ Suku（速 / すくすく）= 猫速。寓意给酒馆注入猫娘推背感。
- **前身**：SillyTavern-CompressedSave（单功能扩展，v1.2.2）
- **现状**：已重构为模块化微内核架构的 SillyTavern 前端扩展
- **项目路径**：已更改为`D:\Projects\Meikosuku`
- **版本**：v2.0.0
- **许可证**：MIT

---

## 架构设计

```
D:\Projects\Meikosuku/
├── manifest.json              # 扩展清单 v2.0.0
├── index.js                   # 百宝箱入口：加载 Core、注册模块、统一 UI 面板
├── style.css                  # 统一主题样式（卡片式模块 + 折叠菜单 + 移动端适配）
├── README.md                  # 项目主页文档
└── src/
    ├── core/
    │   ├── registry.js        # 模块注册中心（生命周期管控、上下文注入）
    │   └── storage.js         # 统一持久化存储管理器（LocalStorage 沙箱）
    └── modules/
        ├── saveGate/          # 【模块 1】史山保存加速（原 CompressedSave 平移）
        │   ├── index.js       # Fetch Hook + gzip 压缩 + 统计 + 模块 UI
        │   ├── saveGateManager.js  # 指纹去重 + 排队合并 + 全局串行锁
        │   └── config.js      # 默认配置
        └── tokenGate/         # 【模块 2】token计算优化（插槽已就绪，算法待接入）
            └── index.js       # 模块定义 + 预览 UI
```

### 微内核模块协议

每个模块实现统一接口，由 `registry.js` 管理生命周期：

```javascript
export default {
    id: 'xxx',                  // 唯一标识
    name: '显示名称',
    icon: '⚡',
    version: 'x.x.x',
    description: '模块描述',
    defaultSettings: { ... },   // 默认配置（自动合并持久化）

    init(context) {},           // context = { core, settings, saveSettings, logger }
    renderUI(container) {},     // 注入模块专属 UI 卡片
    destroy() {}                // 卸载还原
};
```

### 全局调试对象

- `window.Meikosuku`（主对象）
- `window.Meiko` / `window.CompressedSave`（向下兼容别名）
- 方法：`Meikosuku.forceSave()`、`Meikosuku.resetStats()`

---

## 已完成工作

### ✅ 1. 项目起源（v1.0 ~ v1.2.2，CompressedSave 时期）

- **痛点**：跨境云酒馆保存 18MB 聊天卡 50 秒，短时间 5~10 次全量重复上传互相挤占带宽。
- **第一层：gzip 压缩**
  - Hook `window.fetch`，匹配 `/api/chats/save`、`/api/chats/group/save`、`/api/settings/save`
  - 浏览器原生 `CompressionStream('gzip')` 流式压缩，压缩比 8~12 倍
  - 附加 `Content-Encoding: gzip`，Express body-parser 默认 `inflate:true` 后端零改动
- **第二层：SaveGate 智能滞留闸门（v1.2.0+）**
  - ① SHA-256 指纹去重：窗口期（默认 300s）内相同内容 0ms 本地伪造 200 拦截
  - ② 同路径排队合并：覆盖式排队，只发最新一份，被覆盖者收到合成成功响应
  - ③ 全局串行互斥锁：同一时刻只允许一个上传在飞，杜绝 TCP 并发互踩
- **安全性设计**：
  - 只有服务器真实返回 200 才登记指纹（绝不因去重丢数据）
  - dispatched 标记：请求一旦真实发出绝不回退重发（防双重写入灾难）
  - 超时熔断 `AbortController` 真正掐断连接
  - 异常路径残留排队任务正确 reject（防 Promise 悬空 UI 假死）
- **UI 面板**：统计卡片、实时日志表、强制全量按钮、自检测速、一键复制诊断
- **实测效果**：13MB 聊天单次上传 4~11 秒；16 次保存操作 10 次真传 + 6 次指纹秒杀，failed: 0

### ✅ 2. 模块化重构（v2.0.0，Meikosuku 纪元）

- 单文件 42KB 史山拆解为微内核架构
- `registry.js`：模块注册中心，自动合并持久化设置，异常隔离（单模块崩溃不拖垮全局）
- `storage.js`：统一 LocalStorage 管理器（key: `Meikosuku.settings.v1`）
- SaveGate 无损平移至 `src/modules/saveGate/`，功能 100% 保留
- tokenGate 插槽预留 `src/modules/tokenGate/`
- 统一 UI：百宝箱主面板 + 各模块独立卡片

### ✅ 3. 命名定档

- 讨论过候选：Meikotoba（言葉）、Meikokoro（心）、Meikore、Meikombat、Meikosmos
- **最终定名：Meikosuku（猫速）** —— 老大钦定喵！
- manifest、控制台对象、README 全部同步

### ✅ 4. UI 改造：双层折叠菜单

- 主面板 `🐈 Meikosuku (猫速 v2.0.0)` 下，每个子模块一个独立 `inline-drawer` 下拉菜单
- SaveGate 面板、tokenGate 面板均改为酒馆原生 `inline-drawer` 结构
- 「预设 Token 极速缓存」更名为 **「token计算优化」**（老大要求：为后续更多 token 相关功能留空间）
- 紫色猫娘主题卡片、悬停动效、徽章状态灯

### 🐛 5. 修复：菜单展开又瞬间收回（Double Toggle Bug）

- **病因**：酒馆原生对 `.inline-drawer-toggle` 有 document 级事件委托监听；莓可又在 `buildUI()` 里手动绑了一次 click 切换 → 一次点击触发两次 toggle，互相抵消
- **修复**：删除手动绑定，折叠/展开完全交还酒馆原生委托机制
- 代码中留有注释防止未来重复踩坑

### ✅ 6. UI 优化：限高滚动 + 安卓适配

- PC 端：`.meiko-drawer-content` 限高 480px，超出内部滚动，纤细紫色滚动条
- 安卓/移动端（≤768px）：
  - 限高改为 `60vh`（不顶穿屏幕）
  - `-webkit-overflow-scrolling: touch` 原生滚动阻尼
  - `overscroll-behavior: contain` 锁滚动链（内滚到底不带动整页）
  - 抽屉标题 44px 最小触控热区
  - 操作按钮 2x2 网格铺满、复选框触控保护、日志区限高 180px

---

## 待办事项（Roadmap）

### 🔜 下一阶段：token计算优化（TokenGate）正式开发

**背景痛点**：酒馆前端预设开关条目时全量重算 token（无脑全量拼接 + tokenizer 跑在主线程 + 无局部缓存），几十万字预设点一下卡几百毫秒，连点直接冻住。

**技术方案（已讨论定型）**：
1. **条目级哈希分块缓存**：对每个独立条目计算快速指纹（murmurhash3/FNV-1a），token 数缓存进 Map，开关条目时未变更条目 O(1) 命中，只重算被修改项
2. **高频操作防抖**：150~300ms debounce，狂点只在停下后计算一次
3. **Web Worker 异步卸载（可选）**：超长文本分词扔后台线程，主线程 60 帧丝滑

**待执行步骤**：
- [ ] 探查酒馆源码：定位 tokenizers / countTokens / Prompt Manager 渲染链路与事件挂载点
- [ ] 实现条目哈希缓存核心算法
- [ ] 接入防抖与空闲调度
- [ ] UI 开放开关与命中率统计
- [ ] 实测验证

### 📋 远期规划

- 更多模块插槽（老大有其他功能待加入）
- tokenGate 模块下挂多个子功能（token计算优化是系列功能集合）

---

## 关键技术备忘

- **酒馆原生折叠机制**：`.inline-drawer-toggle` 是 document 级事件委托，**不要**再手动绑 click（Double Toggle 教训）
- **指纹存储 key**：`CompressedSave.fingerprints.v1`（保留旧 key 保证跨版本兼容）
- **设置存储 key**：`Meikosuku.settings.v1`
- **旧用户升级注意**：老版本 CompressedSave 的 settings 存在 `CompressedSave.settings.v1`，新架构 key 已变，用户设置会重置为默认值（功能无影响，指纹缓存继续通用）
