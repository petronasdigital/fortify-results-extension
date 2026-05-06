import * as SDK from "azure-devops-extension-sdk";
import { CommonServiceIds, IProjectPageService } from "azure-devops-extension-api";
import { parseFpr, FprSummary } from "./fprParser";

function log(msg: string): void {
  const el = document.getElementById("debug");
  if (el) el.textContent += msg + "\n";
  console.log("[FPR]", msg);
}

interface BuildInfo {
  buildId: number;
  project: string;
}

async function getBuildInfo(): Promise<BuildInfo> {
  const projectService = await SDK.getService<IProjectPageService>(
    CommonServiceIds.ProjectPageService
  );
  const project = await projectService.getProject();
  const projectName = project?.name ?? "";

  // Try to get buildId from URL hash (ADO appends it as fragment)
  const hash = window.location.hash; // e.g. #buildId=160849
  const hashMatch = hash.match(/buildId[=:](\d+)/i);
  if (hashMatch) {
    return { buildId: parseInt(hashMatch[1], 10), project: projectName };
  }

  // Try query params
  const params = new URLSearchParams(window.location.search);
  const qBuildId = params.get("buildId");
  if (qBuildId) {
    return { buildId: parseInt(qBuildId, 10), project: projectName };
  }

  // Fallback: try SDK config
  const config = SDK.getConfiguration();
  const configBuildId = parseInt(String(config.buildId ?? config.id ?? "0"), 10);
  if (configBuildId) {
    return { buildId: configBuildId, project: projectName };
  }

  throw new Error(
    `Could not determine build ID. ` +
    `hash: ${hash}, search: ${window.location.search}, ` +
    `config keys: ${Object.keys(config).join(", ") || "(empty)"}`
  );
}

async function fetchFprArtifacts(
  buildId: number,
  project: string
): Promise<FprSummary[]> {
  // Use direct REST API calls instead of the typed BuildRestClient
  // because the SDK's XDM proxy hangs when the host pre-loads the SDK.
  const token = await SDK.getAccessToken();
  log(`fetchFprArtifacts: got access token (${token.length} chars)`);

  // Get the org base URL from the SDK host info
  const host = await SDK.getHost();
  log(`fetchFprArtifacts: host=${JSON.stringify({id: host.id, name: host.name})}`);

  // Build the org URL — use the host name (organization name)
  // For Azure DevOps Services: https://dev.azure.com/{org}
  const orgName = host.name || "Digital-Delivery";
  const orgUrl = `https://dev.azure.com/${orgName}`;

  // 1. Get artifacts list
  log(`fetchFprArtifacts: fetching artifacts list...`);
  const listUrl = `${orgUrl}/${encodeURIComponent(project)}/_apis/build/builds/${buildId}/artifacts?api-version=7.1`;
  const listResp = await fetch(listUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!listResp.ok) {
    throw new Error(`Get artifacts failed: ${listResp.status} ${listResp.statusText}`);
  }
  const listData = await listResp.json();
  const artifacts: any[] = listData.value || [];
  log(`fetchFprArtifacts: got ${artifacts.length} artifacts`);

  // 2. Filter relevant artifacts
  const fprArtifacts = artifacts.filter(
    (a: any) =>
      a.name.toLowerCase().includes("fpr") ||
      a.name.toLowerCase().includes("dast") ||
      a.name.toLowerCase().includes("sast") ||
      a.name.toLowerCase().includes("scanresult")
  );
  log(`fetchFprArtifacts: ${fprArtifacts.length} matching: ${fprArtifacts.map((a: any) => a.name).join(", ")}`);

  const results: FprSummary[] = [];

  for (const artifact of fprArtifacts) {
    try {
      // 3. Download artifact ZIP
      const downloadUrl = `${orgUrl}/${encodeURIComponent(project)}/_apis/build/builds/${buildId}/artifacts?artifactName=${encodeURIComponent(artifact.name)}&api-version=7.1&%24format=zip`;
      log(`fetchFprArtifacts: downloading ${artifact.name}...`);
      const dlResp = await fetch(downloadUrl, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!dlResp.ok) {
        log(`fetchFprArtifacts: download failed ${dlResp.status}`);
        continue;
      }
      const content = await dlResp.arrayBuffer();
      log(`fetchFprArtifacts: got ${content.byteLength} bytes`);

      // 4. Open outer container ZIP
      const JSZip = (await import("jszip")).default;
      const outerZip = await JSZip.loadAsync(content);
      const allFiles = Object.keys(outerZip.files).filter(
        (f) => !outerZip.files[f].dir
      );
      log(`fetchFprArtifacts: outer ZIP files: ${allFiles.join(", ")}`);

      // First pass: look for files explicitly named *.fpr
      const namedFprFiles = allFiles.filter((f) =>
        f.toLowerCase().endsWith(".fpr")
      );

      if (namedFprFiles.length > 0) {
        for (const fprFile of namedFprFiles) {
          try {
            const fprData = await outerZip.files[fprFile].async("arraybuffer");
            const summary = await parseFpr(fprData, fprFile.split("/").pop()!);
            results.push(summary);
            log(`fetchFprArtifacts: parsed ${fprFile} -> ${summary.totalCount} findings`);
          } catch (e: any) {
            log(`fetchFprArtifacts: failed to parse ${fprFile}: ${e.message}`);
          }
        }
      } else {
        // Second pass: try every non-directory file as a potential FPR
        for (const candidate of allFiles) {
          try {
            const data = await outerZip.files[candidate].async("arraybuffer");
            const name = candidate.split("/").pop() ?? candidate;
            const summary = await parseFpr(data, name);
            results.push(summary);
            log(`fetchFprArtifacts: parsed ${name} -> ${summary.totalCount} findings`);
          } catch {
            log(`fetchFprArtifacts: ${candidate} is not a valid FPR, skipping`);
          }
        }
      }
    } catch (err: any) {
      log(`fetchFprArtifacts: ERROR processing ${artifact.name}: ${err.message}`);
    }
  }

  return results;
}

function renderSeverityBadge(severity: string): string {
  const colors: Record<string, string> = {
    Critical: "#d32f2f",
    High: "#f57c00",
    Medium: "#fbc02d",
    Low: "#388e3c",
    Info: "#1976d2",
  };
  const color = colors[severity] || "#757575";
  return `<span class="severity-badge" style="background:${color}">${severity}</span>`;
}

function renderSummaryCard(summary: FprSummary): string {
  const meta = [summary.engineType, summary.appVersion, summary.scanDate].filter(Boolean).join(" | ");
  return `
    <div class="summary-card">
      <div class="summary-header">
        <h3>${escapeHtml(summary.fileName)}</h3>
        <span class="scan-meta">${escapeHtml(meta)}</span>
      </div>
      <div class="summary-counts">
        <div class="count critical"><span class="count-value">${summary.criticalCount}</span><span class="count-label">Critical</span></div>
        <div class="count high"><span class="count-value">${summary.highCount}</span><span class="count-label">High</span></div>
        <div class="count medium"><span class="count-value">${summary.mediumCount}</span><span class="count-label">Medium</span></div>
        <div class="count low"><span class="count-value">${summary.lowCount}</span><span class="count-label">Low</span></div>
        <div class="count info"><span class="count-value">${summary.infoCount}</span><span class="count-label">Info</span></div>
        <div class="count total"><span class="count-value">${summary.totalCount}</span><span class="count-label">Total</span></div>
      </div>
    </div>`;
}

function renderVulnTable(summary: FprSummary): string {
  if (summary.vulnerabilities.length === 0) {
    return `<p class="no-issues">No vulnerabilities found.</p>`;
  }

  const rows = summary.vulnerabilities
    .sort((a, b) => {
      const order = ["Critical", "High", "Medium", "Low", "Info"];
      return order.indexOf(a.severity) - order.indexOf(b.severity);
    })
    .map(
      (v) => `
    <tr>
      <td>${renderSeverityBadge(v.severity)}</td>
      <td>${escapeHtml(v.category)}</td>
      <td>${escapeHtml(v.checkType)}</td>
      <td class="url-cell" title="${escapeHtml(v.url)}">${escapeHtml(truncate(v.url, 70))}</td>
      <td>${escapeHtml(v.method)}</td>
      <td class="cwe-cell">${escapeHtml(v.cwe)}</td>
      <td class="summary-cell" title="${escapeHtml(v.summary)}">${escapeHtml(truncate(v.summary, 80))}</td>
    </tr>`
    )
    .join("");

  return `
    <table class="vuln-table">
      <thead>
        <tr>
          <th>Severity</th>
          <th>Finding</th>
          <th>Type</th>
          <th>URL / Location</th>
          <th>Method</th>
          <th>CWE</th>
          <th>Description</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderTabs(summaries: FprSummary[]): string {
  if (summaries.length === 0) {
    return `
      <div class="empty-state">
        <h2>No FPR Results Found</h2>
        <p>No Fortify FPR artifacts were detected for this build.<br>
        Ensure your pipeline publishes artifacts with names containing "fpr", "dast", "sast", or "scanresult".</p>
      </div>`;
  }

  if (summaries.length === 1) {
    return `
      <div class="tab-content active">
        ${renderSummaryCard(summaries[0])}
        ${renderVulnTable(summaries[0])}
      </div>`;
  }

  const tabHeaders = summaries
    .map(
      (s, i) =>
        `<button class="tab-btn ${i === 0 ? "active" : ""}" data-tab="${i}">${escapeHtml(s.fileName)} (${s.totalCount})</button>`
    )
    .join("");

  const tabContents = summaries
    .map(
      (s, i) => `
    <div class="tab-content ${i === 0 ? "active" : ""}" data-tab="${i}">
      ${renderSummaryCard(s)}
      ${renderVulnTable(s)}
    </div>`
    )
    .join("");

  return `
    <div class="tab-bar">${tabHeaders}</div>
    ${tabContents}`;
}

function escapeHtml(str: string): string {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.substring(0, max) + "..." : str;
}

function showLoading(): void {
  document.getElementById("app")!.innerHTML = `
    <div class="loading">
      <div class="spinner"></div>
      <p>Loading Fortify scan results...</p>
    </div>`;
}

function showError(msg: string): void {
  document.getElementById("app")!.innerHTML = `
    <div class="error-state">
      <h2>Error</h2>
      <p>${escapeHtml(msg)}</p>
    </div>`;
}

function attachTabListeners(): void {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tabId = btn.getAttribute("data-tab")!;
      document
        .querySelectorAll(".tab-btn")
        .forEach((b) => b.classList.remove("active"));
      document
        .querySelectorAll(".tab-content")
        .forEach((c) => c.classList.remove("active"));
      btn.classList.add("active");
      document
        .querySelector(`.tab-content[data-tab="${tabId}"]`)
        ?.classList.add("active");
    });
  });
}

async function loadResults(buildId: number, projectName: string): Promise<void> {
  log(`loadResults(${buildId}, "${projectName}") starting...`);
  showLoading();
  try {
    const summaries = await fetchFprArtifacts(buildId, projectName);
    log(`Got ${summaries.length} summaries, rendering...`);
    document.getElementById("app")!.innerHTML = renderTabs(summaries);
    attachTabListeners();
    log("Render complete!");
  } catch (err: any) {
    log(`loadResults ERROR: ${err.message}`);
    showError(err.message || "Failed to load FPR results");
  }
}

async function init(): Promise<void> {
  // Add a debug area (hidden unless issues occur)
  const app = document.getElementById("app")!;
  app.innerHTML = `
    <div class="loading"><div class="spinner"></div><p>Initializing SDK...</p></div>
    <pre id="debug" style="font-size:10px;color:#999;margin-top:20px;white-space:pre-wrap;"></pre>`;

  let buildReceived = false;

  try {
    log("SDK.init starting...");
    // loaded:false means WE control when to call notifyLoadSucceeded
    await SDK.init({ loaded: false });
    log("SDK.init done");

    const config = SDK.getConfiguration();
    const configKeys = Object.keys(config || {});
    log(`config keys: ${configKeys.join(", ")}`);

    if (config && typeof config.onBuildChanged === "function") {
      log("Registering onBuildChanged handler...");

      // Register our callback — ADO should invoke it with the build object
      config.onBuildChanged((build: any) => {
        log(`onBuildChanged fired! build.id=${build?.id}`);
        log(`build.project=${JSON.stringify(build?.project)}`);
        buildReceived = true;
        if (build?.id) {
          // Use project name from build, or fallback to "MyPetronas"
          const projectName = build.project?.name || "MyPetronas";
          log(`Using projectName="${projectName}", calling loadResults...`);
          loadResults(build.id, projectName);
        } else {
          showError("onBuildChanged called but build.id is missing");
        }
      });

      log("Handler registered, calling notifyLoadSucceeded...");
    } else {
      log("ERROR: onBuildChanged not found on config");
    }

    // Notify ADO that the frame is ready — ADO should now fire onBuildChanged
    SDK.notifyLoadSucceeded();
    log("notifyLoadSucceeded called");

    // Safety timeout: if nothing happens in 5s, show diagnostics
    setTimeout(() => {
      if (!buildReceived) {
        log("TIMEOUT: onBuildChanged never fired after 5s");
        log(`window.location: ${window.location.href}`);
        log(`Attempting URL-based fallback...`);

        // Try to extract buildId from the parent frame's URL via SDK
        // The build results URL contains buildId=XXXXX
        const parentUrl = document.referrer || "";
        log(`document.referrer: ${parentUrl}`);
        const match = parentUrl.match(/buildId[=:](\d+)/i);
        if (match) {
          const buildId = parseInt(match[1], 10);
          log(`Found buildId=${buildId} from referrer`);
          SDK.getService<IProjectPageService>(CommonServiceIds.ProjectPageService)
            .then((svc) => svc.getProject())
            .then((p) => loadResults(buildId, p?.name ?? "MyPetronas"))
            .catch((e) => showError(`Fallback failed: ${e.message}`));
        } else {
          showError(
            `Extension timed out waiting for build data.\n` +
            `Config keys: ${configKeys.join(", ")}\n` +
            `Referrer: ${parentUrl}\n` +
            `Try hard-refreshing the page (Ctrl+Shift+R).`
          );
        }
      }
    }, 5000);
  } catch (err: any) {
    showError(`Init failed: ${err.message}`);
    SDK.notifyLoadSucceeded();
  }
}

init();
