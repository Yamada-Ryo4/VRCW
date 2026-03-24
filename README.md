# VRCW — VRChat Web Companion

> 一个运行在 Cloudflare Workers 上的 VRChat 网页伴侣工具

🌐 **在线访问**: [vrcw.yamadaryo.workers.dev](https://vrcw.yamadaryo.workers.dev)

## 功能

| 模块 | 功能 |
|------|------|
| 🎭 **模型** | 浏览、收藏、下载自己和收藏夹里的 Avatar |
| 👥 **好友** | 按实例聚合显示在线好友、共同好友、右键操作菜单 |
| 🌍 **世界** | VRC+ 世界收藏夹、最近访问、热门世界 |
| 👥 **群组** | 浏览加入的群组与群组实例 |
| 📤 **上传** | 上传 Avatar (.vrca) |
| 💎 **资产** | VRC+ 相册、拍立得照片、表情/贴纸 |
| 🔍 **搜索** | 公开 Avatar 搜索 |

## 技术栈

- **前端**: 原生 HTML + CSS + JavaScript（无框架）
- **后端**: Cloudflare Worker（代理 VRChat API，处理认证）
- **部署**: Cloudflare Workers + Static Assets

## 本地开发

```bash
# 安装依赖
npm install

# 本地运行（需要 Cloudflare 账号）
npx wrangler dev --port 8787

# 访问
open http://localhost:8787
```

## 部署

```bash
npx wrangler deploy
```

## 注意事项

- 需要 VRChat 账号登录（支持邮箱 OTP 2FA）
- VRC+ 功能（相册、拍立得上传）需要有效的 VRC+ 订阅
- 本工具仅供个人学习使用，请勿滥用 VRChat API
- VRChat API 为社区逆向，可能随时变更

## License

MIT
