// Pure formatting and redaction shared by CLI tools and hosted runtimes.

export function redactUrl(value) {
  if (!URL.canParse(value)) return "[unparseable url]";
  const url = new URL(value);
  const hidden = url.username || url.password || url.search || url.hash || url.pathname !== "/";
  return `${url.protocol}//${url.host}${hidden ? "/[redacted]" : ""}`;
}

export function scrubUrls(text) {
  return String(text).replace(/https?:\/\/[^\s"'<>]+/g, (match) => redactUrl(match));
}

export function errorMessage(error) {
  const message = error && typeof error === "object" ? error.shortMessage || error.message || error.details : error;
  return scrubUrls(message || "unknown error");
}

export function stableStringify(value) {
  return JSON.stringify(sortKeys(value), null, 2);
}

function sortKeys(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
  }
  return value;
}

export function sameJson(a, b) {
  return stableStringify(a) === stableStringify(b);
}
