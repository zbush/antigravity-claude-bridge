import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isFullyAbsolute } from "../workspace-policy.mjs";

function parseSemver(versionStr) {
  const match = String(versionStr || "").match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemverDesc(a, b) {
  const va = parseSemver(a);
  const vb = parseSemver(b);
  if (va && vb) {
    for (let i = 0; i < 3; i += 1) {
      if (va[i] !== vb[i]) return vb[i] - va[i];
    }
    return b.localeCompare(a);
  }
  if (va) return -1;
  if (vb) return 1;
  return b.localeCompare(a);
}

function findClaudeInVersionedDir(baseDir, binaryName) {
  if (!baseDir || !fs.existsSync(baseDir)) return null;
  let versionEntries;
  try {
    versionEntries = fs
      .readdirSync(baseDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort(compareSemverDesc);
  } catch {
    return null;
  }

  for (const ver of versionEntries) {
    const verDir = path.join(baseDir, ver);
    const direct = path.join(verDir, binaryName);
    if (fs.existsSync(direct)) return direct;
    try {
      const subDirs = fs
        .readdirSync(verDir, { withFileTypes: true })
        .filter((d) => d.isDirectory());
      for (const sub of subDirs) {
        const nested = path.join(verDir, sub.name, binaryName);
        if (fs.existsSync(nested)) return nested;
      }
    } catch {
      // ignore unreadable subdirectories
    }
  }
  return null;
}

function findClaudeInExtensionsDir(extDir, binaryName) {
  if (!extDir || !fs.existsSync(extDir)) return null;
  try {
    const dirs = fs
      .readdirSync(extDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith("anthropic.claude-code-"))
      .map((d) => d.name)
      .sort((a, b) => {
        const va = a.replace(/^anthropic\.claude-code-/, "");
        const vb = b.replace(/^anthropic\.claude-code-/, "");
        return compareSemverDesc(va, vb);
      });
    for (const dir of dirs) {
      const candidate = path.join(extDir, dir, "resources", "native-binary", binaryName);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    // ignore unreadable extension directories
  }
  return null;
}

function findOnPath(binaryNames) {
  const pathEnv = process.env.PATH || "";
  const dirs = pathEnv.split(path.delimiter).map(dir => dir.replace(/^"|"$/g, "")).filter(isFullyAbsolute);
  for (const dir of dirs) {
    for (const name of binaryNames) {
      const full = path.join(dir, name);
      try {
        if (fs.existsSync(full) && fs.statSync(full).isFile()) {
          return full;
        }
      } catch {
        // ignore permission errors on PATH entries
      }
    }
  }
  return null;
}

function discoverClaudeBinary() {
  const isWin = process.platform === "win32";
  const exeName = isWin ? "claude.exe" : "claude";
  const home = os.homedir();

  // 1. Explicit env override
  const source = process.env.CLAUDE_BIN ? "CLAUDE_BIN" : "CLAUDE_CLI_BIN";
  const configured = process.env[source];
  if (configured) {
    if (!isFullyAbsolute(configured) || !fs.statSync(configured, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(source + " must point to an existing absolute file.");
    }
    if (isWin && !/\.(exe|[cm]?js)$/i.test(configured)) {
      throw new Error(source + " must point to a Windows .exe or JavaScript CLI entry point.");
    }
    fs.accessSync(configured, /\.[cm]?js$/i.test(configured) ? fs.constants.R_OK : fs.constants.X_OK);
    return { path: configured, source };
  }

  // 2. Standalone CLI on standard native install paths or PATH
  const standaloneCandidates = [
    path.join(home, ".local", "bin", exeName),
    path.join(home, ".claude", "local", exeName),
  ];
  for (const candidate of standaloneCandidates) {
    if (fs.existsSync(candidate)) {
      return { path: candidate, source: "standalone" };
    }
  }

  const fromPath = findOnPath(isWin ? ["claude.exe", path.join("node_modules", "@anthropic-ai", "claude-code", "cli.js")] : ["claude"]);
  if (fromPath) {
    return { path: fromPath, source: "PATH" };
  }

  // 3. Claude Desktop bundled Claude Code CLI (auto-updates to latest semver)
  if (isWin) {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    const desktopBin = findClaudeInVersionedDir(
      path.join(appData, "Claude", "claude-code"),
      exeName
    );
    if (desktopBin) {
      return { path: desktopBin, source: "claude-desktop" };
    }

    // MSIX virtualized Roaming path fallback
    const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    const packagesDir = path.join(localAppData, "Packages");
    if (fs.existsSync(packagesDir)) {
      try {
        const claudePkgs = fs
          .readdirSync(packagesDir, { withFileTypes: true })
          .filter((d) => d.isDirectory() && d.name.startsWith("Claude_"))
          .map((d) => d.name);
        for (const pkg of claudePkgs) {
          const msixBin = findClaudeInVersionedDir(
            path.join(packagesDir, pkg, "LocalCache", "Roaming", "Claude", "claude-code"),
            exeName
          );
          if (msixBin) {
            return { path: msixBin, source: "claude-desktop-msix" };
          }
        }
      } catch {
        // ignore
      }
    }
  } else if (process.platform === "darwin") {
    const desktopBin = findClaudeInVersionedDir(
      path.join(home, "Library", "Application Support", "Claude", "claude-code"),
      exeName
    );
    if (desktopBin) {
      return { path: desktopBin, source: "claude-desktop" };
    }
  } else {
    const desktopBin = findClaudeInVersionedDir(
      path.join(home, ".config", "Claude", "claude-code"),
      exeName
    );
    if (desktopBin) {
      return { path: desktopBin, source: "claude-desktop" };
    }
  }

  // 4. IDE extension bundled native binary (VS Code / Cursor)
  const ideDirs = [
    path.join(home, ".vscode", "extensions"),
    path.join(home, ".cursor", "extensions"),
  ];
  for (const extDir of ideDirs) {
    const extBin = findClaudeInExtensionsDir(extDir, exeName);
    if (extBin) {
      return { path: extBin, source: "ide-extension" };
    }
  }

  throw new Error("Cannot find Claude Code. Set CLAUDE_BIN to its absolute executable path.");
}

function resolveClaudeInvocation(claudeArgs, discovered = discoverClaudeBinary()) {
  const useNode = /\.[cm]?js$/i.test(discovered.path);
  return {
    command: useNode ? process.execPath : discovered.path,
    args: useNode ? [discovered.path, ...claudeArgs] : claudeArgs,
    shell: false,
    binary: discovered.path,
    source: discovered.source,
  };
}

export { findOnPath, discoverClaudeBinary, resolveClaudeInvocation };
