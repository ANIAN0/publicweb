// eve 服务 auth 配置的 API 层工具:校验(POST/PATCH 输入)+ 脱敏(GET 输出)
// auth 形态与 eveagent.ts buildClientOptions 对齐:none / bearer / headers
// token 明文存 db(schema.ts auth_config 列),GET 不回显明文(bearer→hasToken / headers→headerNames)

export type AuthType = 'none' | 'bearer' | 'headers';

// 校验并规范化 authType + authConfig。
// - none:authConfig 忽略,置 null
// - bearer/headers:authConfig 必填,bearer 需 {token:string},headers 需 {headers:Record}
// 接受 authConfig 为 JSON 字符串或对象;返回规范化的 JSON 字符串(或 null)
export function validateAuth(
  authType: unknown,
  authConfig: unknown,
): { ok: true; authType: AuthType; authConfig: string | null } | { ok: false; error: string } {
  // authType 校验:非 bearer/headers 一律归 none
  const t: AuthType = authType === 'bearer' || authType === 'headers' ? authType : 'none';
  // none:authConfig 忽略,置 null
  if (t === 'none') return { ok: true, authType: 'none', authConfig: null };
  // bearer/headers:authConfig 必填
  if (authConfig === undefined || authConfig === null) {
    return { ok: false, error: `${t} authConfig 必填` };
  }
  // 解析 authConfig(接受 JSON 字符串或对象)
  let cfg: any;
  if (typeof authConfig === 'string') {
    try { cfg = JSON.parse(authConfig); } catch { return { ok: false, error: 'authConfig 不是合法 JSON' }; }
  } else {
    cfg = authConfig;
  }
  if (t === 'bearer') {
    if (typeof cfg?.token !== 'string' || cfg.token.length === 0) {
      return { ok: false, error: 'bearer authConfig 需为 {token: string}' };
    }
    return { ok: true, authType: 'bearer', authConfig: JSON.stringify({ token: cfg.token }) };
  }
  // headers
  if (!cfg?.headers || typeof cfg.headers !== 'object') {
    return { ok: false, error: 'headers authConfig 需为 {headers: Record<string,string>}' };
  }
  return { ok: true, authType: 'headers', authConfig: JSON.stringify({ headers: cfg.headers }) };
}

// GET 脱敏:bearer 不回显 token(→ hasToken),headers 不回显 value(→ headerNames),none/损坏 → null
// 前端据此显示"已配置 token"/"已配置 N 个自定义头",编辑时若不改 auth 则 PATCH 不传 authType
export function maskAuth(authType: string | null, authConfig: string | null): { authType: string; authConfig: string | null } {
  if (!authConfig) return { authType: authType ?? 'none', authConfig: null };
  let cfg: any;
  try { cfg = JSON.parse(authConfig); } catch { return { authType: authType ?? 'none', authConfig: null }; }
  if (authType === 'bearer') {
    return { authType, authConfig: JSON.stringify({ hasToken: Boolean(cfg?.token) }) };
  }
  if (authType === 'headers') {
    const headerNames = cfg?.headers && typeof cfg.headers === 'object' ? Object.keys(cfg.headers) : [];
    return { authType, authConfig: JSON.stringify({ headerNames }) };
  }
  return { authType: authType ?? 'none', authConfig: null };
}
