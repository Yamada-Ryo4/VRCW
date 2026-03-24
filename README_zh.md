# VRCAM — VRChat 资产管理器 (Workers 版)

*[English](README.md) | 简体中文*

这是一个高性能、无服务器（Serverless）架构的 VRChat 模型/资产管理 Web 应用。VRCAM 将 Cloudflare Workers 作为轻量级代理，让你的浏览器能够突破跨域限制，将 `.vrca` 文件直接全速上传至 VRChat 的 S3 存储桶。

## 核心特性

- 🚀 **浏览器直传 S3**：告别中转服务器带来的带宽瓶颈。你的文件通过你的浏览器直接发送到 VRChat 官方存储库。
- 🔄 **高级更新模式**：无缝热更新已有模型。VRCAM 会在浏览器内自动修改及对齐 `.vrca` 二进制文件中的 `Blueprint ID`，并重新计算 MD5 和 Rsync（BLAKE2b）签名。
- 🗂️ **动态收藏夹管理**：完全兼容 VRC+。动态获取你的实际收藏分组，支持查看、搜索与一键"移除收藏"。
- 🔍 **avtrDB 公开模型搜索**：无需离开应用，直接在内置的「搜索」标签页中检索 [avtrdb.com](https://avtrdb.com) 上的海量公开模型。支持按平台筛选（PC / Quest / Apple / 组合），查看详情（性能评级、模型 ID、上传日期），一键收藏到指定收藏夹，或通过 VRCX 深链接切换模型。
- 🌐 **跨收藏夹全局搜索**：在收藏夹标签页输入关键词时，会同时搜索你 **所有** 收藏分组的内容，而非仅限当前显示的分组。
- 💾 **原生文件系统 API**：利用现代浏览器的 File System Access API，下载文件能直接以满速存入你选择的本地文件夹，绕过浏览器缓慢的临时缓存机制。
- ⚡ **本地急速缓存**：模型列表与元数据通过 IndexedDB 存储在本地，带来极其迅捷的二次加载体验。
- 🌍 **多语言 UI**：拥有完整的英语、简体中文（中文）和日语（日本語）界面支持。
- 🛡️ **安全架构保障**：所有 VRChat 凭据和身份验证 Cookie 都只保存在你自己的浏览器中。Cloudflare Worker 仅作为无状态的头部转发器存在，你无需将账号安全托付给任何第三方中心服务器。

## 技术架构

- **前端 (`/public`)**：纯 HTML/JS/CSS 打造。负责处理所有的核心业务逻辑，包括：UI 渲染、IndexedDB 缓存、文件系统 API 交互、`.vrca` 二进制包热修补、BLAKE2b/MD5 哈希计算、S3 分片上传，以及 avtrDB API 集成。
- **后端 (`worker.js`)**：一个最简化的 Cloudflare Worker。主要用于代理标准的 VRChat API 调用（绕过浏览器 CORS 跨域限制），并在 S3 `PUT` 请求中注入受限的私有头部。avtrDB 搜索直接从浏览器调用其公开 API（无需修改 Worker）。

## 部署指南

VRCAM 专为 Cloudflare Workers 与 Cloudflare Pages 体系设计（通过 `wrangler` 部署）。

### 环境要求
- 安装 [Node.js](https://nodejs.org/) 和 npm
- 拥有一可用的 Cloudflare 账号

### 部署步骤

1. **安装 Wrangler 命令行工具并登录**
   ```bash
   npm install -g wrangler
   wrangler login
   ```

2. **本地开发调试**
   ```bash
   wrangler dev
   ```
   随后在浏览器中打开 `http://localhost:8787` 即可体验。

3. **发布到 Cloudflare**
   ```bash
   wrangler deploy
   ```
   只需这一行命令，即可将 API 代理脚本（`worker.js`）部署为 Worker，并将 `./public` 目录下的所有前端静态文件部署为 Pages 服务。

## 技术细节（致开发者）

- **签名生成机制**：我们利用纯 JavaScript 实现了一套底层哈希逻辑，能够在浏览器端准确生成与 VRChat 官方 Python 端规范完全一致的 Rsync（BLAKE2b）签名。
- **大文件支持**：所有的 MD5 哈希校验与 S3 文件传输均采用流式分片上传机制，512MB 以上的超大包体依然稳如泰山。
- **S3 Proxy 方案**：由于现代浏览器在访问 S3 存储桶前发送的 CORS Preflight 请求会拦截部分自定义头部，我们将这部分 `PUT` 请求安全路由至 Worker 的 `/api/s3proxy` 端点进行了转发。
- **avtrDB 集成**：使用 avtrDB 公开的 `https://api.avtrdb.com/v2/avatar/search` 端点（原生支持 CORS），无需后端改动。平台筛选采用两阶段策略：先通过 `&compatibility=` 参数在服务端预过滤，再在客户端验证每条结果包含所有所需平台。
- **平台筛选逻辑**：下载页的平台筛选采用**包含式**模型——选择「含 PC + Quest」意味着该模型**至少**支持这两个平台（可以同时支持 Apple）。平台检测优先依赖 `unityPackages[].assetVersion > 0` 字段，以排除 VRChat API 可能返回的空壳占位包。

## 开源协议

本项目采用 [MIT 协议](LICENSE) 开源。
