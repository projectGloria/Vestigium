<div align="center">

<img src="build/icon.png" alt="Vestigium Logo" width="128" height="128" />

# Vestigium

**Learn once. Automate everywhere.**

*An intelligent desktop workflow browser that masters browsing and batch-downloading tasks from a single human demonstration.*

<p>
  <img src="https://img.shields.io/badge/Platform-Windows%20x64-0078D4.svg?style=flat-square&logo=windows" alt="Platform: Windows x64" />
  <img src="https://img.shields.io/badge/Electron-45-47848F.svg?style=flat-square&logo=electron" alt="Electron 45" />
  <img src="https://img.shields.io/badge/React-19-61DAFB.svg?style=flat-square&logo=react" alt="React 19" />
  <img src="https://img.shields.io/badge/TypeScript-7-3178C6.svg?style=flat-square&logo=typescript" alt="TypeScript 7" />
  <img src="https://img.shields.io/badge/Database-SQLite%20WAL-003B57.svg?style=flat-square&logo=sqlite" alt="SQLite WAL" />
  <img src="https://img.shields.io/badge/AdBlock-Built--in-E22D2D.svg?style=flat-square" alt="Built-in AdBlock" />
</p>

---

<p>
  <a href="#-about-vestigium">About</a> •
  <a href="#-key-features">Key Features</a> •
  <a href="#-visual-tour">Visual Tour</a> •
  <a href="#-installation--desktop-app">Installation</a> •
  <a href="#-command-line-cli">Command Line</a> •
  <a href="#-building-from-source">Building</a> •
  <a href="#-demo-suite--scenarios">Scenarios</a> •
  <a href="#-architecture--storage">Architecture</a> •
  <a href="#-icon--design-philosophy">Design</a> •
  <a href="#-license--credits">License</a>
</p>

<img
  width="920"
  src="artifacts/milestone-2-dev-recorded.png"
  alt="Vestigium Workflow Browser Interface Preview"
/>

</div>

---

## 👣 About Vestigium

**Vestigium** (*Latin: "footprint", "trace", or "track"*) is an intelligent desktop workflow browser engineered to eliminate the brittle, time-consuming nature of web scrapers and download automation.

Traditionally, web automation requires manually crafting fragile CSS selectors or XPath queries that break whenever target sites change layouts, obfuscate class names, or introduce dynamic JavaScript frameworks. 

With **Vestigium**, you don't write scripts. You simply browse:
1. **Teach by Doing**: Press **● Teach**, perform your actions on a single item, and click **■ Stop recording**.
2. **Instant Generalization**: Vestigium infers the list pattern, recognizes individual collection items, and compiles your demonstration into a generalized pipeline: *"for every page → for every item → download"*.
3. **Resilient Replay**: Powered by a 6-tier locator ranking engine, OS-level trusted input, and automated self-healing, Vestigium executes your routine across hundreds of items with minimal supervision.
4. **Human-in-the-Loop ("Needs You")**: When encountering captchas, server countdowns, or logins, Vestigium politely pauses, brings itself forward, and waits for your touch — then automatically resumes its run.

---

## ✨ Key Features

<table>
  <tr>
    <td width="50%">
      <h3>🎓 One-Shot Learning &amp; Generalization</h3>
      <p>Demonstrate an action on just <i>one</i> item in a list. Vestigium recognizes the list pattern, highlights candidate items with exclusion checkboxes, and loops seamlessly across multiple pages.</p>
    </td>
    <td width="50%">
      <h3>🛡️ Self-Healing Locator Engine</h3>
      <p>Locators are ranked across six fallback tiers (test IDs, accessible roles, text, CSS, XPath, and structural JSON fingerprints). Healed elements are flagged with one-click review controls.</p>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <h3>🔄 Smart Pagination Detection</h3>
      <p>Automatically discovers pagination controls across varied layouts: classic <code>Next</code> buttons, numbered page bars, "Load More" triggers, or continuous infinite scrolling.</p>
    </td>
    <td width="50%">
      <h3>👤 "Needs You" Human-in-the-Loop</h3>
      <p>Vestigium never tries to bypass captchas or crack bot guards. Instead, it pauses, highlights the challenge for human completion, and immediately continues on its own once satisfied.</p>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <h3>📥 Persistent Resumable Queue</h3>
      <p>File downloads route through authenticated browser sessions with HTTP Range chunk resume across pauses, drops, or restarts. Features hash integrity checks and automatic duplicate detection.</p>
    </td>
    <td width="50%">
      <h3>🏷️ Metadata &amp; Archive Extraction</h3>
      <p>Captures page metadata (titles, tags, author, date, and archive passwords) into <code>_info.txt</code> sidecars. Automatically unpacks ZipCrypto/AES ZIP archives and 7z/RAR files via 7-Zip.</p>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <h3>🚫 Network-Level Ad &amp; Tracker Blocking</h3>
      <p>Ships with built-in EasyList, EasyPrivacy, and uBlock Origin filter list enforcement at the network layer. Blocks popunders, ads, and telemetry without injecting foreign scripts into pages.</p>
    </td>
    <td width="50%">
      <h3>⚡ Headless Command-Line Runner</h3>
      <p>Execute saved site profiles directly from Windows Terminal, PowerShell, or automated scripts using the <code>vestigium run</code> CLI shim without graphical overhead.</p>
    </td>
  </tr>
</table>

---

## 📸 Visual Tour

### 1. Interactive Demonstration &amp; Workflow Recording
Perform your regular browsing tasks in the integrated tabbed browser. Vestigium compiles interactions into clean, readable, editable workflow steps with configurable parameters.

<p align="center">
  <img src="artifacts/milestone-2-dev-recorded.png" alt="Demonstration Recording in Vestigium" width="860" />
</p>

### 2. Self-Healing Locator Review &amp; Inspection
When a website mutates its DOM or renames classes, Vestigium's structural fingerprinting resolves the intended element, applies a self-heal, and gives you transparent review options (`Keep new locators` / `Undo heal`).

<p align="center">
  <img src="artifacts/milestone-3-heal-review.png" alt="Self-Healing Review Interface" width="860" />
</p>

### 3. Native Ad &amp; Tracker Suppression
Enjoy high-speed, distraction-free navigation. Invasive banners, third-party trackers, and rogue popunders are rejected at the network protocol layer without tampering with document scripts.

<p align="center">
  <img src="artifacts/adblock/misskon-blocking-on.png" alt="Ad-blocking verification in Vestigium" width="860" />
</p>

### 4. Dual Light &amp; Dark Theme Support
Seamlessly switch between dark and light themes. Application chrome, layout proportions, and workflow sidebars automatically adapt with persistent preference storage.

<p align="center">
  <img src="artifacts/milestone-2-dev-replayed-light.png" alt="Light Mode Replay" width="860" />
</p>

---

## 🚀 Installation &amp; Desktop App

### Windows Installer

Generate or run the Windows per-user installer:

```powershell
npm run dist
# Output package: release/Vestigium Setup 0.1.0.exe
```

Upon installation, Vestigium provisions:
- **Start Menu & Desktop Shortcuts** with the high-resolution Vestigium green mark icon.
- **Isolated User Profile**: Stored in `%APPDATA%\Vestigium` (database, settings, rotating logs, filter lists, and session cookies).
- **Global Command-Line Tool**: Adds `vestigium.cmd` to your installation directory for terminal runs.

> [!NOTE]
> Because release builds are self-packaged and not code-signed with a commercial certificate, Windows SmartScreen may present a prompt on first launch. Click **More info** → **Run anyway** to proceed.

---

## ⚡ Command-Line (CLI)

Vestigium includes a headless execution engine powered by the same underlying scheduler, SQLite database, and authenticated browser profile.

> [!IMPORTANT]
> Ensure the desktop application window is closed before initiating a CLI run, as SQLite and Chromium profiles enforce single-instance locking.

```powershell
# Run a batch workflow from a saved profile
vestigium run --profile example.com --url "https://example.com/gallery" --output D:\Downloads\example --max-pages 5 --force

# List all available site profiles
vestigium profiles

# Show command help and options
vestigium --help
```

### CLI Parameters

| Flag | Description |
| --- | --- |
| `--profile <domain>` | The saved site profile identifier to execute |
| `--url <address>` | Initial starting list URL |
| `--output <folder>` | Target directory for completed downloads |
| `--max-pages <num>` | Maximum pagination depth before stopping |
| `--force` | Re-download items even if already present in history |
| `--dry-run` | Inspect and highlight targets without invoking downloads |

**Exit Codes:**
- `0` — Workflow completed successfully.
- `1` — Encountered an unrecoverable step or network error.
- `2` — Invalid arguments supplied.
- `3` — Could not initialize process or load profile.

---

## 🛠️ Building from Source

### Prerequisites

Ensure your environment includes:
- **Node.js**: `26.8.1` (pinned via `.nvmrc`)
- **npm**: `11.19.0`
- **Visual Studio C++ Build Tools** & **Python** (required for `better-sqlite3` native ABI compilation)

### Development Setup

1. **Clone the repository:**
   ```powershell
   git clone https://github.com/projectGloria/Vestigium.git
   cd Vestigium
   ```

2. **Install dependencies and native modules:**
   ```powershell
   npm ci
   npx playwright install chromium
   ```
   > [!TIP]
   > The `npm ci` script triggers a `postinstall` hook that executes `electron-rebuild -f -w better-sqlite3`. Never execute `npm rebuild better-sqlite3` directly with host Node, as this overwrites the Electron ABI binary with a Node ABI binary. Use `npm run native:rebuild` if rebuilding is needed.

3. **Start the development environment:**
   ```powershell
   npm run dev
   ```

4. **Production Build & Preview:**
   ```powershell
   npm run build
   npm start
   ```

---

## 🧪 Demo Suite &amp; Scenarios

Vestigium includes an adversarial dual-origin test server (`tests/demo-site`) providing reproducible scenarios for pagination edge cases, anti-bot countdowns, captchas, and dynamic DOM mutations.

Start the test server:
```powershell
npm run demo
```
- **Primary Origin**: `http://127.0.0.1:4173`
- **Secondary File Host**: `http://127.0.0.1:4174`

### Test Scenario Matrix

| Scenario | Route / Query | Verified Behavior |
| --- | --- | --- |
| **Paginated Cards & Tables** | `/list`, `/list?layout=table` | 47 items over 5 pages; detects end of pagination |
| **Infinite Scroll & Load More** | `/list?mode=infinite`, `/list?mode=more` | Dynamic DOM insertion and continuous scrolling |
| **SPA Route Pagination** | `/list?mode=spa`, `/list?wrap=1` | In-place view replacement and loop-wrap prevention |
| **Human Captcha Gate** | `/item/N?variant=captcha` | Enters "Needs you" state; pauses for human click |
| **Countdown & Ticket Gate** | `/item/1?variant=countdown` | Enforces 5s server wait; prompts manual continuation |
| **Shortlink Popups** | `/item/N?variant=shortlink` | Traverses intermediary shortlink redirects safely |
| **DOM Class & Tag Mutation** | `/item/N?mutate=all` | Validates self-healing multi-locator resolution |
| **Encrypted Archives** | `/files/encrypted`, `/files/aes` | Unpacks ZipCrypto, AES-256 ZIP, and encrypted 7z |
| **Metadata Password Labels** | `/item/1` through `/item/5` | Extracts `Password:`, `Pass:`, `Unzip:`, and `Şifre:` |
| **Network Ad Suppression** | `/ads` | Neutralizes external banner scripts and popunders |
| **Broken & Dead Downloads** | `/list?broken=3`, `/list?dead=3` | Skips failed items cleanly without aborting run |
| **Dynamic Item Set** | `/list?dataset=changing` | Detects removals, reordering, and newly appended items |

### Test Commands

```powershell
# Type verification
npm run typecheck

# Full test pipeline (unit, demo suite, and Electron e2e)
npm test

# Granular suites
npm run test:unit      # Core engine, migrations, and download queue unit tests
npm run test:demo      # Playwright browser integration suite
npm run test:http      # HTTP Range and network streaming tests
npm run test:e2e       # Electron application e2e tests
npm run test:package   # Post-dist NSIS installer verification
```

---

## 🏗️ Architecture &amp; Storage

```
┌────────────────────────────────────────────────────────┐
│                   Electron Main                        │
│  ┌───────────────────────┐   ┌──────────────────────┐  │
│  │   WebContentsView     │   │   SQLite Database    │  │
│  │   Tab Manager         │   │   (WAL / Synchronous)│  │
│  └───────────┬───────────┘   └──────────┬───────────┘  │
│              │                          │              │
│              ▼                          ▼              │
│  ┌───────────────────────┐   ┌──────────────────────┐  │
│  │   Network Monitor     │   │   Download Manager   │  │
│  │   (AdBlock Filters)   │   │   (HTTP Range Queue) │  │
│  └───────────────────────┘   └──────────────────────┘  │
└──────────────────────────┬─────────────────────────────┘
                           │ Typed IPC (Zod Schema)
┌──────────────────────────▼─────────────────────────────┐
│                 React Shell Chrome                     │
│  ┌──────────────────────────────────────────────────┐  │
│  │   Tabs • Address Bar • Workflow Panel • Queue    │  │
│  └──────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────┘
```

- **Strict Sandbox Boundary**: React chrome contains no Node.js or Electron access. Communication flows entirely through typed IPC schemas (`src/shared/ipc.ts`) validated at runtime by Zod.
- **Embedded SQLite (WAL Mode)**: High-speed relational storage at `%APPDATA%\Vestigium\vestigium.sqlite` managing workflows, site profiles, item caches, and run histories.
- **Encrypted Session Continuity**: Session cookies are encrypted via Windows DPAPI (`safeStorage`) into `session-cookies.enc` on clean exit and restored on launch, ensuring logged-in sites remain active without risking stale crash restores.
- **Multi-Source Filter Engine**: Filter lists are parsed into memory buffers directly from EasyList and uBlock Origin rule sets, checking each request before network dispatch.

---

## 🎨 Icon &amp; Design Philosophy

<p align="center">
  <img src="build/icon.png" alt="Vestigium App Icon" width="100" height="100" />
</p>

> *"A dark forest square anchored by a clean, resilient sage-green 'V' glyph — representing the lasting trace and dependable trail left behind by purposeful navigation."*

The visual identity of Vestigium is engineered around clarity, balance, and precision:
- **Obsidian Forest (`#111916`)**: An ultra-dark, grounding slate background that provides seamless contrast in both Windows taskbar and system tray contexts.
- **Muted Sage Accent (`#A7CF8A`)**: A calm, organic green representing successful traces, verified paths, and natural adaptation.
- **Zero-Dependency Vector Generation**: The icon is drawn purely in code using a mathematical 32-unit grid and minimal PNG chunk generation (`src/main/tray-icon.ts`), guaranteeing razor-sharp rasterization across all display scales (16px to 256px).

---

## 📜 License &amp; Credits

Vestigium is designed and maintained by **Nihil** as part of the **Gloria Repoz** suite.

- **Architecture Documentation**: See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for full subsystem specifications and design decisions.
- **Milestone Verifications**: Complete testing logs and artifacts for milestones 0 through 9 are cataloged under [docs/](docs/).
- **Copyright**: &copy; 2026 Nihil. All rights reserved.