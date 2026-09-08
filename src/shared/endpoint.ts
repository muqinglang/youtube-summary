export function validateBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('请输入有效的 API 地址。');
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('API 地址必须使用 HTTPS；本机 localhost / 127.0.0.1 可使用 HTTP。');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('API 地址不能包含用户名、密码、查询参数或片段。');
  }
  return url.href.replace(/\/+$/, '');
}

/** Chrome match patterns intentionally omit ports. */
export function getOriginPattern(baseUrl: string): string {
  const url = new URL(validateBaseUrl(baseUrl));
  return `${url.protocol}//${url.hostname}/*`;
}
