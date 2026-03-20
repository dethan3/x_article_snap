# X Article Snap — 推特文章高清截图 & 剪藏神器

Chrome 扩展（Manifest V3），适用于 **x.com / twitter.com**。

## 功能

| 功能 | 说明 |
|------|------|
| 📖 纯阅读模式 | 一键跳转 `/article/` 并注入 CSS 隐藏侧栏/广告/回复 |
| 📷 高清全页截图 | 滚动拼接，支持 2x Retina，输出含日期的 PNG |
| 📄 导出 PDF | 调用浏览器打印 API，最小边距 |
| 🖼 长图模式 | 同截图，适合微信/小红书分享 |
| 📝 转 Markdown | Readability.js 提取 + Turndown 转换，复制剪贴板 + 下载 .md |
| 🔴 悬浮球 | article 页面显示可拖动相机图标（可关闭） |
| 💧 水印 | 可自定义水印文字 |
| 🌙 深色/浅色 | 截图时可切换背景主题 |

## 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Alt+Shift+A` | 高清截图 |
| `Alt+Shift+R` | 切换阅读模式 |

## 安装步骤

1. 打开 Chrome，访问 `chrome://extensions/`
2. 右上角开启 **开发者模式**
3. 点击 **加载已解压的扩展程序**
4. 选择本目录（`ArticleSnap/`）
5. 扩展图标出现在工具栏中

## 文件结构

```
ArticleSnap/
├── manifest.json           # Manifest V3
├── background/
│   └── service-worker.js   # 截图调度、右键菜单、快捷键
├── content/
│   ├── content.js          # 注入脚本：阅读模式、滚动截图、MD提取
│   └── article-mode.css    # 阅读模式 CSS
├── offscreen/
│   ├── offscreen.html      # 离屏文档
│   └── offscreen.js        # Canvas 拼接 + 水印
├── popup/
│   ├── popup.html          # 弹窗 UI
│   ├── popup.css           # 深色主题样式
│   └── popup.js            # 弹窗逻辑
├── libs/
│   ├── readability.js      # Mozilla Readability
│   └── turndown.js         # HTML → Markdown
└── icons/
    ├── icon16.png
    ├── icon48.png
    ├── icon128.png
    └── icon512.png
```

## 使用说明

### 阅读模式
- 在 `x.com/用户名/status/ID` 页面点击「切换纯阅读模式」
- 自动跳转到 `/article/` 版本并隐藏所有干扰元素

### 截图
- 点击「高清截图」→ 扩展自动滚动全页并拼接
- 可在设置中开启水印、深色主题

### Markdown
- 点击「转 Markdown」→ 内容自动复制到剪贴板 + 下载 `.md` 文件

## 权限说明

| 权限 | 用途 |
|------|------|
| `activeTab` | 获取当前页面信息 |
| `scripting` | 注入内容脚本 |
| `downloads` | 保存截图/MD文件 |
| `tabs` | 截图时访问标签页 |
| `offscreen` | 离屏 Canvas 拼接 |
| `storage` | 保存用户设置 |
| `contextMenus` | 右键菜单 |
