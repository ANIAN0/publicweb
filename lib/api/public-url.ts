// APP-012：从请求/环境推导 webtool 对外 URL（register 命令等共用）

/**
 * 命令与回显中的 webtool URL 必须反映真实部署形态：
 * 1. 优先 WEBTOOL_PUBLIC_URL（部署显式配置）
 * 2. 其次 Origin 头（浏览器/反向代理）
 * 3. 最后从 Request URL 解析 origin（兜底，兼容单测 plain Request）
 */
export function derivePublicUrl(req: Request): string {
  const envUrl = process.env.WEBTOOL_PUBLIC_URL;
  if (envUrl) return envUrl;
  const origin = req.headers.get('origin');
  if (origin) return origin;
  try {
    return new URL(req.url).origin;
  } catch {
    return 'http://localhost:3000';
  }
}
