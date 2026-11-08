// Shared classification only. Never expose upstream diagnostic text to callers.
export function isLogRangeLimit(error) {
  const seen = new Set();
  let rangeLimit = false;
  for (let current = error, depth = 0; current && depth < 8 && !seen.has(current); current = current.cause, depth++) {
    seen.add(current);
    const detail = [current.shortMessage, current.details, current.message].filter((value) => typeof value === "string").join(" ");
    if (/rate limit|quota|too many requests|requests? per|\b429\b/i.test(detail)) return false;
    if (/block range.{0,80}(?:too (?:large|wide)|exceed|limit|maximum)|requested range too large|ranges? over \d+ blocks (?:are |is )?not supported|(?:maximum|max|limited to).{0,40}block range|query returned more than.{0,40}(?:results|logs)|(?:log )?response size.{0,40}(?:exceed|limit|too large)|too many (?:logs|results)/i.test(detail)) rangeLimit = true;
  }
  return rangeLimit;
}

