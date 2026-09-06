// Parse a PLS playlist file into a list of { url, title } entries.

export function parsePls(text) {
  const files = new Map();
  const titles = new Map();
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    let m;
    if ((m = /^File(\d+)$/i.exec(key))) files.set(Number(m[1]), value);
    else if ((m = /^Title(\d+)$/i.exec(key))) titles.set(Number(m[1]), value);
  }
  return [...files.keys()]
    .sort((a, b) => a - b)
    .filter((n) => files.get(n))
    .map((n) => ({ url: files.get(n), title: titles.get(n) || '' }));
}
