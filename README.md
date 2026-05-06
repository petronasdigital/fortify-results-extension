# Fortify FPR Results Viewer — Azure DevOps Extension

Displays Fortify DAST/SAST FPR scan results directly in the Azure DevOps **Build Summary** tab. When multiple FPR artifacts are detected, each is shown in a separate sub-tab.

---

## Features

- **Auto-detects** FPR artifacts from the build (matches artifact names containing `fpr`, `dast`, `sast`, or `scanresult`)
- **Parses** `.fpr` files (ZIP → `audit.fvdl` XML) in the browser — no server needed
- **Severity summary** with Critical / High / Medium / Low / Info counts
- **Sortable vulnerability table** with category, kingdom, URL, method, and parameter
- **Multi-tab view** when multiple FPR artifacts exist (e.g., separate DAST + SAST scans)

---

## Project Structure

```
fortify-results-extension/
├── src/
│   ├── tab.ts          # Main entry — SDK init, artifact fetch, render
│   ├── tab.html        # HTML shell + CSS
│   └── fprParser.ts    # FPR (ZIP/FVDL) parser
├── img/
│   └── icon.png        # Extension icon (replace with 128x128 PNG)
├── dist/               # Build output (webpack)
├── package.json
├── tsconfig.json
├── webpack.config.js
└── vss-extension.json  # Extension manifest
```

---

## Prerequisites

- Node.js 18+
- `tfx-cli` (installed as dev dependency, or globally: `npm i -g tfx-cli`)
- An Azure DevOps organization with permission to install custom extensions
- A **publisher** registered at https://marketplace.visualstudio.com/manage/publishers

---

## Build

```bash
cd fortify-results-extension
npm install
npm run build
```

---

## Package (VSIX)

```bash
npm run package
```

This produces `dist/MyPetronas.fortify-fpr-viewer-1.0.0.vsix`.

---

## Publish

### Option 1: Publish to your private organization (recommended)

1. **Create a publisher** at https://marketplace.visualstudio.com/manage/publishers (if not done already).

2. **Update** `vss-extension.json`:
   ```json
   "publisher": "YOUR_PUBLISHER_ID"
   ```

3. **Create a PAT** in Azure DevOps with scope `Marketplace > Publish`:
   - Go to https://dev.azure.com → User Settings → Personal Access Tokens
   - Scope: `Marketplace (Publish)`

4. **Login and publish**:
   ```bash
   npx tfx extension login --service-url https://marketplace.visualstudio.com
   # Enter your PAT when prompted

   npx tfx extension publish --manifest-globs vss-extension.json --share-with YOUR_ORG_NAME
   ```

5. **Install in your org**:
   - Go to https://marketplace.visualstudio.com/manage/publishers/YOUR_PUBLISHER_ID
   - Click the extension → Share → Enter your org name
   - Or navigate to: `https://dev.azure.com/YOUR_ORG/_settings/extensions` → Shared → Install

### Option 2: Install from VSIX file directly

```bash
npx tfx extension publish --vsix dist/MyPetronas.fortify-fpr-viewer-1.0.0.vsix \
  --token YOUR_PAT \
  --share-with Digital-Delivery
```

### Option 3: Upload via the UI

1. Go to https://marketplace.visualstudio.com/manage/publishers/YOUR_PUBLISHER_ID
2. Click **+ New Extension** → **Azure DevOps**
3. Upload the `.vsix` file
4. Share with your organization

---

## Usage in Pipeline

The extension automatically appears as a **"Fortify Results"** tab in any build that publishes FPR artifacts. Your existing pipeline already publishes the FPR:

```yaml
- task: PublishBuildArtifacts@1
  displayName: 'Publish FPR Report'
  inputs:
    PathtoPublish: '$(System.DefaultWorkingDirectory)/$(dast-result-name-be)'
    ArtifactName: 'dastScanResult'    # <-- detected by the extension
  continueOnError: true
```

No pipeline changes needed — just install the extension in your organization.

---

## Configuration

### Manifest Settings (`vss-extension.json`)

| Field | Description |
|-------|-------------|
| `publisher` | Your marketplace publisher ID |
| `id` | Unique extension ID |
| `version` | Semver version (bump before each publish) |
| `contributions[0].properties.name` | Tab display name in build results |

### Artifact Detection

The extension looks for build artifacts with names matching (case-insensitive):
- `*fpr*`
- `*dast*`
- `*sast*`
- `*scanresult*`

---

## Update/Redeploy

```bash
# Bump version in both files
npm version patch
# Re-publish
npm run publish
```

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Tab doesn't appear | Ensure the extension is installed in the org and the build has matching artifacts |
| "No FPR Results Found" | Check artifact names match the detection patterns above |
| Permission error | The extension needs `vso.build` scope — check extension permissions in org settings |
| VSIX too large | Ensure `node_modules` is not included — only `dist/tab/` and `img/` are packaged |

---

## Development (local testing)

For local development without publishing:

```bash
# 1. Build in dev mode with source maps
npm run dev

# 2. Use the Azure DevOps Extension Test Tool:
#    https://github.com/nicknow/azure-devops-extension-test-harness
#    Or use `webpack serve` with a mock SDK
```

---

## License

Internal use — PETRONAS Digital Delivery
