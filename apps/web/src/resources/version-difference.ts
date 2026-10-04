/** Linear comparison: a single changed region, not a minimal edit script. */
export function compareTextVersions(before: string, after: string) {
  const lines = (value: string) => value.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const left = lines(before);
  const right = lines(after);
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < left.length - prefix &&
    suffix < right.length - prefix &&
    left[left.length - suffix - 1] === right[right.length - suffix - 1]
  )
    suffix++;
  const changedLeft = [...left.slice(prefix, left.length - suffix).join('')];
  const changedRight = [...right.slice(prefix, right.length - suffix).join('')];
  const format = (value: string) => {
    const crlf = (value.match(/\r\n/g) ?? []).length;
    const lf = (value.match(/\n/g) ?? []).length - crlf;
    const cr = (value.match(/\r/g) ?? []).length - crlf;
    return `换行：LF ${lf}，CRLF ${crlf}，CR ${cr}；结尾${/[\r\n]$/.test(value) ? '有' : '无'}换行；${value.startsWith('\uFEFF') ? '有' : '无'} BOM。`;
  };
  return {
    beforeFormat: format(before),
    afterFormat: format(after),
    equal: before === after,
    prefixLines: prefix,
    suffixLines: suffix,
    before: changedLeft.slice(0, 12000).join(''),
    after: changedRight.slice(0, 12000).join(''),
    truncated: changedLeft.length > 12000 || changedRight.length > 12000,
  };
}
