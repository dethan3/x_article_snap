# X Article Snap

Chrome extension for turning X / Twitter posts into cleaner, share-ready captures.

[简体中文](./README.zh-CN.md)

## What It Does

X Article Snap focuses on three workflows:

- Clean reading mode for `status` pages by switching into X's `/article/` view.
- High-resolution screenshot export with a share footer.
- Markdown extraction for lightweight clipping and note-taking.

This project currently targets Chrome Manifest V3 and runs without a build step.

## Current Features

### Reading Mode

- Switch a standard `x.com/.../status/...` page into `/article/`.
- Reduce sidebars and visual noise for a tighter reading layout.
- Keep screenshot export compatible with both `status` and `article` pages.

### Share-Ready Screenshots

- Full-page capture pipeline with automatic scrolling and offscreen stitching.
- `2x` high-resolution export toggle.
- Tighter crop on article pages, aligned to the actual article content area.
- Footer appended to the bottom of the final image with:
  - original post link
  - placeholder share brand: `x_share`
  - extension logo
  - optional QR code for the original post URL
- Optional watermark overlay.

### Smart Share Truncation

- When content runs longer than roughly two screens, the export switches to a share mode.
- The capture stops early instead of generating an excessively tall image.
- The bottom of the content fades out with a white mask before the footer.
- The footer still carries the original source link and optional QR code.

### Markdown Export

- Extract article content with Readability.
- Convert HTML to Markdown with Turndown.
- Download a `.md` file.
- Attempt clipboard copy when the page context allows it.

### Convenience

- Popup controls for reading mode, screenshot, Markdown, watermark, QR code, and resolution.
- Right-click context menu entries for screenshot, Markdown export, and reading mode.
- Storage-backed settings persistence.

## Installation

1. Open `chrome://extensions/`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select this project folder.
5. Pin the extension if you want quick access from the toolbar.

## Usage

1. Open a post on `x.com` or `twitter.com`.
2. Click the extension icon.
3. Choose one of the main actions:
   - `Article Mode`
   - `High-Res Screenshot`
   - `Markdown`
4. Adjust optional settings such as watermark, QR code, and `2x` export before capturing.

## Capture Behavior

- On standard `status` pages, the capture focuses on the main post instead of including the reply feed.
- On `article` pages, the crop is aligned to the article content width rather than the entire column.
- The share footer always uses the original post URL, even when the current page is `/article/`.

## Project Structure

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

## Permissions

| Permission | Purpose |
| --- | --- |
| `activeTab` | Access the current tab when the user invokes the extension |
| `scripting` | Inject or reinject content scripts when needed |
| `downloads` | Save screenshots and Markdown files |
| `tabs` | Capture the visible tab during screenshot export |
| `offscreen` | Stitch screenshots in an offscreen document |
| `storage` | Persist user preferences |
| `contextMenus` | Add right-click actions on X / Twitter pages |

## Notes

- This README only documents features that are currently implemented.
- The footer brand is intentionally a placeholder for the upcoming share-oriented product direction.
