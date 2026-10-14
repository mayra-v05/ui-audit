# UI Audit — design & bug checker for VS Code

Scan your website or local dev server for UI bugs, dead buttons/links and backend errors. You see everything per project in one dashboard and can export it to Claude, Claude Code or a developer.

## What does it check?

| Category | Examples |
|---|---|
| **Layout & alignment** | An element sitting 1–8px off from the rest of its column, a button 3px lower than the rest of its row, overlapping elements |
| **Spacing & consistency** | Irregular gaps in lists and rows, buttons of the same variant with different padding/height/radius, near-identical sizes (42px vs 44px), spacing outside your 4px grid, near-identical colors (#333 vs #343434), headings with a deviating style |
| **Responsive / mobile** | Horizontal scrolling (including the element causing it), missing viewport meta, tap targets that are too small (WCAG 2.5.8), text that is too small, truncated text, fixed headers covering the screen |
| **Buttons & links** | Buttons without a handler (also works with React, Vue, Alpine, htmx), empty or `href="#"` links, anchors pointing to sections that don't exist, links returning 404/500, forms without an action |
| **Backend & console** | JavaScript errors and exceptions, API calls returning 4xx/5xx, failed requests, slow endpoints, `undefined`, `NaN` or `[object Object]` in the UI |
| **Content & accessibility** | Broken, distorted or low-resolution images, missing alt text, contrast (WCAG AA), inputs without a label, duplicate IDs, lorem ipsum |

Every page is scanned at **Desktop (1440px)**, **Tablet (768px)** and **Mobile (390px, with touch and an iPhone user agent)**. If the same issue appears at multiple sizes, you see it once, with a badge per size.

## Usage

1. Click the **UI Audit** icon in the activity bar and choose **New project**. The extension automatically looks for running dev servers (ports 3000, 5173, 4321, 8080, 5500 …). You can also enter a URL or a local HTML file.
2. The **dashboard** opens with:
   - counts per severity and per category, plus what is new or fixed since the previous scan;
   - a list of issues with selector, measurement, suggested fix, cropped screenshot and **the source file + line number** (click to open it);
   - the full screenshot per viewport with numbered markers. Click a marker to jump to the issue;
   - "Ignore (false positive)", so an issue no longer counts.
3. **📱 Device preview**: view the site directly on iPhone SE/15/Pro Max, Pixel, Galaxy, iPad or desktop, rotate it or pick a custom width. No need for Inspect.
4. **Live**: turn on Live and the project is rescanned and the preview reloaded after every save.
5. Issues also show up in the **Problems panel**, on the matching line in your source code.

## Exporting

Export all visible issues, or tick a few:

- **✦ Copy for Claude**: copies a complete prompt with the task, selectors, source files, measurements and suggested fixes. Paste it into claude.ai.
- **⌘ Fix with Claude Code**: writes `.ui-audit/issues.md` and cropped screenshots into your project (listed in `.gitignore`) and starts `claude` in the terminal with the instruction to fix everything.
- **✉ Mail developer**: opens your mail app with a summary and shows the HTML report with screenshots, so you can attach it.
- **Export**: Markdown, HTML report, CSV (Excel/Sheets/Jira) or JSON.

## Settings

| Setting | Default | |
|---|---|---|
| `uiAudit.viewports` | Desktop/Tablet/Mobile | Custom screen sizes |
| `uiAudit.spacingBase` | `4` | Your spacing grid in px |
| `uiAudit.clickTest` | `false` | Actually clicks questionable buttons to see if anything happens. Only use this on dev/test; buttons like *delete/pay/send* are skipped |
| `uiAudit.checkLinks` / `checkExternalLinks` | `true` / `false` | Check links for 404/500 |
| `uiAudit.developerEmail` | – | Default recipient for the mail |
| `uiAudit.chromePath` | automatic | Chrome/Edge/Brave/Chromium |
| `uiAudit.showInProblems` | `true` | Show issues in the Problems panel |

## Requirements

You need Google Chrome, Edge, Brave or Chromium. The extension runs your existing browser headless and doesn't download anything itself.
