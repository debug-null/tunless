// Minimal YAML subset: enough to read and write the `dns:` section of a
// mihomo config without pulling in a dependency.

export function parseScalar(raw) {
  const value = raw.trim();
  if (value === "") return "";
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null" || value === "~") return null;
  if (/^-?\d+$/.test(value)) return Number(value);
  if (/^-?\d*\.\d+$/.test(value)) return Number(value);
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
    (value.startsWith("'") && value.endsWith("'") && value.length > 1)
  ) {
    return value.slice(1, -1);
  }
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((part) => parseScalar(part));
  }
  return value;
}

export function unquote(value) {
  const v = String(value).trim();
  if (v.length > 1 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

export function parseBlock(lines, startIndex = 0, baseIndent = 0) {
  const result = {};
  let i = startIndex;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) {
      i += 1;
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (indent < baseIndent) break;

    const m = /^([^:#]+):\s*(.*)$/.exec(line.trim());
    if (!m) {
      i += 1;
      continue;
    }
    const key = unquote(m[1].trim());
    const inline = m[2].trim();

    if (inline === "") {
      // Collect the nested block: every following line indented deeper than
      // this key, up to the next line at this level or shallower.
      const childLines = [];
      let j = i + 1;
      let hasContent = false;
      while (j < lines.length) {
        const l = lines[j];
        if (!l.trim() || l.trim().startsWith("#")) {
          childLines.push(l);
          j += 1;
          continue;
        }
        const li = l.length - l.trimStart().length;
        if (li <= indent) break;
        childLines.push(l);
        hasContent = true;
        j += 1;
      }
      const firstChild = childLines.find((l) => l.trim() && !l.trim().startsWith("#"));
      if (!hasContent) {
        result[key] = {};
      } else if (firstChild && firstChild.trim().startsWith("-")) {
        // Block sequence: "key:" followed by "- item" lines.
        result[key] = childLines
          .filter((l) => l.trim().startsWith("-"))
          .map((l) => parseScalar(l.trim().slice(1)));
      } else {
        result[key] = parseBlock(childLines, 0, indent + 2);
      }
      i = j;
    } else if (inline.startsWith("-")) {
      const items = [];
      let j = i;
      while (j < lines.length) {
        const l = lines[j];
        if (!l.trim()) {
          j += 1;
          continue;
        }
        const li = l.length - l.trimStart().length;
        if (li < baseIndent || !l.trim().startsWith("-")) break;
        items.push(parseScalar(l.trim().slice(1)));
        j += 1;
      }
      result[key] = items;
      i = j;
    } else {
      result[key] = parseScalar(inline);
      i += 1;
    }
  }
  return result;
}

export function parseYaml(text) {
  const lines = text.split("\n");
  return parseBlock(lines, 0, 0);
}

export function formatScalar(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  const str = String(value);
  if (str === "" || /[:#\-{}[\]&*!|>'"%@`,+]/.test(str) || /^\s|\s$/.test(str)) {
    return `"${str.replace(/"/g, '\\"')}"`;
  }
  return str;
}

export function dumpYaml(obj, indent = 0) {
  const pad = " ".repeat(indent);
  const out = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) {
        out.push(`${pad}${key}: []`);
        continue;
      }
      out.push(`${pad}${key}:`);
      for (const item of value) out.push(`${pad}  - ${formatScalar(item)}`);
    } else if (value && typeof value === "object") {
      const entries = Object.entries(value).filter(([, v]) => v !== undefined);
      if (entries.length === 0) {
        out.push(`${pad}${key}: {}`);
        continue;
      }
      out.push(`${pad}${key}:`);
      out.push(dumpYaml(Object.fromEntries(entries), indent + 2));
    } else {
      out.push(`${pad}${key}: ${formatScalar(value)}`);
    }
  }
  return out.join("\n");
}

// Extract the top-level `dns:` block from a YAML document as raw text.
export function extractTopLevelBlock(text, key) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^${key}:`).test(l));
  if (start === -1) return null;
  const out = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      out.push(line);
      continue;
    }
    if (/^\S/.test(line)) break;
    out.push(line);
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.join("\n");
}

export function replaceTopLevelBlock(text, key, replacement) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^${key}:`).test(l));
  if (start === -1) {
    const suffix = text.endsWith("\n") ? "" : "\n";
    return `${text}${suffix}${replacement}\n`;
  }
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() && /^\S/.test(line)) break;
    end += 1;
  }
  const before = lines.slice(0, start);
  const after = lines.slice(end);
  const head = before.join("\n");
  const tail = after.join("\n");
  const parts = [head, replacement];
  if (tail.trim()) parts.push(tail);
  return parts.join("\n").replace(/\n{3,}/g, "\n\n");
}
