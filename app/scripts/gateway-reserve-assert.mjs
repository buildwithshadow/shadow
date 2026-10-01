// Browser-safe checks shared by the operator and browser Gateway paths.
// Only plain protocol objects, arrays and scalar values are accepted.
function plain(value) {
  return value !== null && typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function equal(a, b) {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
      Object.keys(a).length === Object.keys(b).length &&
      Object.keys(a).every(k => Object.hasOwn(b, k) && equal(a[k], b[k]));
  }
  if (!plain(a) || !plain(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(k => Object.hasOwn(b, k) && equal(a[k], b[k]));
}
export function gatewayAssert(condition, message = 'Gateway validation failed') {
  if (!condition) throw new Error(message);
}
gatewayAssert.equal = (a, b, message) => gatewayAssert(Object.is(a, b), message);
gatewayAssert.notEqual = (a, b, message) => gatewayAssert(!Object.is(a, b), message);
gatewayAssert.deepEqual = (a, b, message) => gatewayAssert(equal(a, b), message);
gatewayAssert.match = (value, pattern, message) => gatewayAssert(typeof value === 'string' && pattern.test(value), message);
