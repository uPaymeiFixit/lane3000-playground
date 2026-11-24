/** Python-style repr() of a str, for log lines that match the Python programs' output. */
export function pyRepr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (ch === "\\") out += "\\\\";
    else if (ch === quote) out += "\\" + quote;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (c < 0x20 || (c >= 0x7f && c <= 0xa0) || c === 0xad) out += "\\x" + c.toString(16).padStart(2, "0");
    else out += ch;
  }
  return out + quote;
}

/** The characters (UTF-16 code units) of a string; our strings are latin-1 only. */
export function chars(s: string): string[] {
  return Array.from({ length: s.length }, (_, i) => s.charAt(i));
}

/** Python-style repr() of a list of str. */
export function pyReprList(items: readonly string[]): string {
  return "[" + items.map(pyRepr).join(", ") + "]";
}
