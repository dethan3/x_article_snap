# X Article Snap

将 X / Twitter 帖子整理成更适合阅读与分享的 Chrome 扩展。

[English](./README.md)

## 项目定位

X Article Snap 当前主要覆盖三条使用链路：

- 将 `status` 页面切到更干净的 `/article/` 阅读模式
- 生成带分享 footer 的高清截图
- 提取正文并导出 Markdown

项目基于 Chrome Manifest V3，当前无需构建步骤即可直接加载使用。

## 已实现功能

### 阅读模式

- 将普通 `x.com/.../status/...` 页面切换到 `/article/`
- 尽量隐藏侧栏和干扰元素，形成更适合阅读的布局
- `status` 页面与 `article` 页面都能继续使用截图导出

### 分享型截图

- 自动滚动截图，并在离屏页面完成拼接
- 支持 `2x` 高清导出
- `article` 页面截图会尽量贴合真实文章内容宽度
- 最终图片底部会附带分享 footer，包含：
  - 原帖链接
  - 占位品牌名 `x_share`
  - 扩展 logo
  - 可选二维码
- 支持可选水印

### 长内容分享截断

- 当内容超过大约两屏时，截图会自动切换为分享截断模式
- 不再继续生成过长图片
- 正文底部会做白色渐隐蒙版
- 渐隐之后继续衔接 footer，保留原帖链接与可选二维码

### Markdown 导出

- 使用 Readability 提取正文
- 使用 Turndown 转成 Markdown
- 下载 `.md` 文件
- 在页面允许的情况下尝试写入剪贴板

### 交互与便捷入口

- 弹窗支持阅读模式、截图、Markdown、水印、二维码、分辨率等设置
- 右键菜单支持截图、转 Markdown、切换阅读模式
- 设置会持久化保存

## 安装方式

1. 打开 `chrome://extensions/`
2. 开启右上角 `开发者模式`
3. 点击 `加载已解压的扩展程序`
4. 选择当前项目目录
5. 如有需要，将扩展固定到工具栏

## 使用方式

1. 打开 `x.com` 或 `twitter.com` 的帖子页面
2. 点击扩展图标
3. 选择主要操作：
   - `Article Mode`
   - `High-Res Screenshot`
   - `Markdown`
4. 截图前可按需切换水印、二维码和 `2x` 导出

## 截图行为说明

- 在普通 `status` 页面，截图会尽量聚焦主帖，而不是把回复流整段带进去
- 在 `article` 页面，截图宽度会贴近实际文章内容区域，而不是整列留白
- 即使当前浏览的是 `/article/` 页面，footer 中仍然使用原始帖子链接

## 目录结构

```text
x_article_snap/
├── manifest.json
├── background/
│   └── service-worker.js
├── content/
│   ├── article-mode.css
│   └── content.js
├── icons/
│   └── xas_logo.png
├── libs/
│   ├── qrcodegen.js
│   ├── readability.js
│   └── turndown.js
├── offscreen/
│   ├── offscreen.html
│   └── offscreen.js
└── popup/
    ├── popup.css
    ├── popup.html
    └── popup.js
```

## 权限说明

| 权限 | 用途 |
| --- | --- |
| `activeTab` | 在用户触发扩展时访问当前标签页 |
| `scripting` | 在需要时注入或补注入内容脚本 |
| `downloads` | 保存截图与 Markdown 文件 |
| `tabs` | 截图时调用可见标签页捕获能力 |
| `offscreen` | 在离屏文档中完成拼图 |
| `storage` | 保存用户偏好设置 |
| `contextMenus` | 为 X / Twitter 页面增加右键菜单 |

## 说明

- 本文档只描述当前已经实现的功能
- footer 中的 `x_share` 仍然是分享产品方向下的临时品牌占位
