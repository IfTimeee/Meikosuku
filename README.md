# SillyTavern Meikosuku (猫速 ฅ^•ﻌ•^ฅ)

> **Meikosuku · 猫速** —— 专为 SillyTavern 打造的猫娘级极致性能与扩展引擎。
> 注入极致推背感，专治酒馆各类史山卡顿与性能毒瘤！
>
> by 莓可莉丝（meikorisu）for iftime ฅ^•ﻌ•^ฅ
>
> v2.0.0 | MIT | 模块化微内核架构

---

## 🧰 模块矩阵 (Modules)

### ⚡ 1. SaveGate (史山保存加速)
专治跨境云酒馆「保存 18MB 卡 50 秒、发一句话卡两分钟」的顽疾。
- **浏览器原生流式 gzip 压缩**：聊天 JSON 体积瞬间暴降 8~12 倍，后端 Express 零改动原生自动解压。
- **SHA-256 内容指纹去重**：酒馆高频触发的无意义重复保存，0ms 本地伪造 200 拦截，省时省流量。
- **同路径覆盖排队合并**：并发保存收敛为只飞最新一份。
- **全局单通道串行互斥锁**：杜绝弱网环境下 TCP 并发重传雪崩。

### ⚡ 2. token计算优化 (TokenGate) [规划接入中]
专治编辑预设、频繁开关 Prompt 条目、长上下文重算时主线程卡死转菊花。
- **条目级哈希分块缓存**：针对未改动的 Prompt 条目直接命中缓存 Token 计数，拒绝几十万字无脑重算。
- **UI 空闲防抖**：将高频连续点击动作与重型 Tokenizer 解耦，确保 60 帧丝滑。
- **多维度 Token 调度与优化**：为后续更多 Token 优化与上下文处理工具预留通用矩阵。

---

## 🚀 安装方式

### 方法一：酒馆直接安装
1. 打开 SillyTavern 的 **扩展管理器 (Extensions)**
2. 点击 **「安装扩展」**
3. 输入 Git 仓库地址并点击安装
4. 刷新酒馆页面即可！

### 方法二：手动安装
把文件夹放入 SillyTavern 扩展目录：
- **全局安装**：`SillyTavern/public/scripts/extensions/third-party/Meikosuku/`
- **用户级安装**：`SillyTavern/data/<your-user-handle>/extensions/Meikosuku/`

---

## 🐾 控制台调试指令

在浏览器 F12 控制台中可直接调用：
```javascript
// 查看猫速运行状态与模块列表
Meikosuku.modules

// 强制清空 SaveGate 指纹缓存（让下一次保存必定发起网络上传）
Meikosuku.forceSave()

// 清空当前统计数据
Meikosuku.resetStats()
```
*(同时完整向下兼容 `CompressedSave` 与 `Meiko` 全局别名)*
