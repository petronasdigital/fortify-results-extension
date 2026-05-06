import JSZip from "jszip";

export interface FprVulnerability {
  id: string;
  category: string;
  kingdom: string;
  severity: string;
  url: string;
  method: string;
  checkType: string;
  cwe: string;
  summary: string;
}

export interface FprSummary {
  fileName: string;
  engineType: string;
  scanDate: string;
  appVersion: string;
  totalCount: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  infoCount: number;
  vulnerabilities: FprVulnerability[];
}

/** Fortify DAST severity integers → labels
 *  4 = Critical, 3 = High, 2 = Medium, 1 = Low, 0 = Info/BestPractice
 *  CheckTypeID drives the final bucket when Severity is 0 */
function mapWebInspectSeverity(severityInt: string, checkType: string): string {
  switch (severityInt) {
    case "4": return "Critical";
    case "3": return "High";
    case "2": return "Medium";
    case "1": return "Low";
    default:
      // Severity 0: distinguish Info vs Best Practices
      if (checkType === "Vulnerability") return "Low";
      return "Info";
  }
}

function firstText(el: Element | null | undefined, tag: string): string {
  if (!el) return "";
  const child = el.getElementsByTagName(tag)[0];
  return child?.textContent?.trim() ?? "";
}

/** Parse webinspect.xml — the format used by Fortify DAST FPR files */
function parseWebInspectXml(doc: Document, fileName: string): FprSummary {
  const root = doc.documentElement; // <Sessions>
  const appVersion = root.getAttribute("appVersion") ?? "";

  const vulnerabilities: FprVulnerability[] = [];

  const sessions = root.getElementsByTagName("Session");
  for (let i = 0; i < sessions.length; i++) {
    const session = sessions[i];
    const url = firstText(session, "URL");
    const method = firstText(session, "Method") ||
      firstText(session.getElementsByTagName("Request")[0], "Method");

    const issues = session.getElementsByTagName("Issue");
    for (let j = 0; j < issues.length; j++) {
      const issue = issues[j];
      const name = firstText(issue, "Name");
      const severityRaw = firstText(issue, "Severity");
      const checkType = firstText(issue, "CheckTypeID");

      // Collect CWE identifiers from <Classifications>
      const classifications = issue.getElementsByTagName("Classification");
      const cwes: string[] = [];
      for (let k = 0; k < classifications.length; k++) {
        const kind = classifications[k].getAttribute("kind") ?? "";
        const identifier = classifications[k].getAttribute("identifier") ?? "";
        if (kind === "CWE") cwes.push(identifier);
      }

      // Summary text (first 200 chars of ReportSection SectionText, strip HTML)
      let summary = "";
      const sectionText = issue.getElementsByTagName("SectionText")[0];
      if (sectionText) {
        const raw = sectionText.textContent ?? "";
        summary = raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
      }

      vulnerabilities.push({
        id: issue.getAttribute("id") ?? `${i}-${j}`,
        category: name,
        kingdom: cwes.length > 0 ? cwes[0] : checkType,
        severity: mapWebInspectSeverity(severityRaw, checkType),
        url: url || "(unknown)",
        method,
        checkType,
        cwe: cwes.join(", "),
        summary,
      });
    }
  }

  const counts = { Critical: 0, High: 0, Medium: 0, Low: 0, Info: 0 };
  vulnerabilities.forEach((v) => {
    if (v.severity in counts) counts[v.severity as keyof typeof counts]++;
  });

  return {
    fileName,
    engineType: "WebInspect (DAST)",
    scanDate: "",
    appVersion,
    totalCount: vulnerabilities.length,
    criticalCount: counts.Critical,
    highCount: counts.High,
    mediumCount: counts.Medium,
    lowCount: counts.Low,
    infoCount: counts.Info,
    vulnerabilities,
  };
}

/** Parse audit.fvdl — the format used by Fortify SAST FPR files */
function parseFvdl(doc: Document, fileName: string): FprSummary {
  const buildEl = doc.getElementsByTagName("Build")[0];
  const scanDate = buildEl ? firstText(buildEl, "ScanDate") : "";
  const appVersion = buildEl ? firstText(buildEl, "SourceBasePath") : "";
  const engineEl = doc.getElementsByTagName("EngineData")[0];
  const engineType = engineEl ? firstText(engineEl, "EngineVersion") : "SCA";

  const vulnElements = doc.getElementsByTagName("Vulnerability");
  const vulnerabilities: FprVulnerability[] = [];

  for (let i = 0; i < vulnElements.length; i++) {
    const vuln = vulnElements[i];
    const classInfo = vuln.getElementsByTagName("ClassInfo")[0];
    const instanceInfo = vuln.getElementsByTagName("InstanceInfo")[0];

    const category = classInfo ? firstText(classInfo, "Type") : "";
    const kingdom = classInfo ? firstText(classInfo, "Kingdom") : "";
    const confidence = instanceInfo ? parseFloat(firstText(instanceInfo, "Confidence")) || 1 : 1;
    const impact = classInfo ? parseFloat(firstText(classInfo, "DefaultSeverity")) || 1 : 1;
    const score = impact * confidence / 25;

    let severity: string;
    if (score >= 4) severity = "Critical";
    else if (score >= 3) severity = "High";
    else if (score >= 2) severity = "Medium";
    else if (score >= 1) severity = "Low";
    else severity = "Info";

    let url = "";
    const primaryLoc = vuln.getElementsByTagName("SourceLocation")[0];
    if (primaryLoc) url = primaryLoc.getAttribute("path") ?? "";

    vulnerabilities.push({
      id: `${i + 1}`,
      category,
      kingdom,
      severity,
      url: url || "(source code)",
      method: "",
      checkType: "SCA",
      cwe: "",
      summary: "",
    });
  }

  const counts = { Critical: 0, High: 0, Medium: 0, Low: 0, Info: 0 };
  vulnerabilities.forEach((v) => {
    if (v.severity in counts) counts[v.severity as keyof typeof counts]++;
  });

  return {
    fileName,
    engineType: `Fortify SCA ${engineType}`,
    scanDate,
    appVersion,
    totalCount: vulnerabilities.length,
    criticalCount: counts.Critical,
    highCount: counts.High,
    mediumCount: counts.Medium,
    lowCount: counts.Low,
    infoCount: counts.Info,
    vulnerabilities,
  };
}

export async function parseFpr(data: ArrayBuffer, fileName: string): Promise<FprSummary> {
  const zip = await JSZip.loadAsync(data);
  const files = Object.keys(zip.files);
  const xmlParser = new DOMParser();

  // Fortify DAST FPR: contains webinspect.xml
  const wiFile = zip.file("webinspect.xml");
  if (wiFile) {
    const xml = await wiFile.async("text");
    const doc = xmlParser.parseFromString(xml, "text/xml");
    return parseWebInspectXml(doc, fileName);
  }

  // Fortify SAST FPR: contains audit.fvdl
  const fvdlFile = zip.file("audit.fvdl") ?? zip.file(files.find(f => f.endsWith(".fvdl")) ?? "");
  if (fvdlFile) {
    const xml = await fvdlFile.async("text");
    const doc = xmlParser.parseFromString(xml, "text/xml");
    return parseFvdl(doc, fileName);
  }

  throw new Error(`Unrecognised FPR format in ${fileName}. Expected webinspect.xml or audit.fvdl.`);
}
