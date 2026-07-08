// eve 服务 auth 配置的 API 层工具:校验(POST/PATCH 输入)+ 解析(eveagent/编辑回显共用)
// auth 形态与 eveagent.ts buildClientOptions 对齐:none / bearer / headers
// token 明文存 db(schema.ts auth_config 列);本地应用,GET 原样返回明文供编辑回显

export type AuthType = 'none' | 'bearer' | 'headers';

// 解析 authConfig(JSON 字符串或对象)→ 结构化形态(token/headers);空/损坏 → null
// validateAuth/eveagent.buildClientOptions/编辑回显共用,消除 JSON.parse + authType 分支重复
// 空字符串 token 归 undefined(统一"空 token 视为无效"语义)
export function parseAuthConfig(authConfig: string | object | null | undefined): { token?: string; headers?: Record<string, string> } | null {
  if (authConfig === null || authConfig === undefined) return null;
  let cfg: any;
  if (typeof authConfig === 'string') {
    try { cfg = JSON.parse(authConfig); } catch { return null; }
  } else {
    cfg = authConfig;
  }
  return {
    token: typeof cfg?.token === 'string' && cfg.token.length > 0 ? cfg.token : undefined,
    headers: cfg?.headers && typeof cfg.headers === 'object' ? cfg.headers as Record<string, string> : undefined,
  };
}

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
  const parsed = parseAuthConfig(authConfig);
  if (t === 'bearer') {
    if (!parsed?.token) {
      return { ok: false, error: 'bearer authConfig 需为 {token: string}' };
    }
    return { ok: true, authType: 'bearer', authConfig: JSON.stringify({ token: parsed.token }) };
  }
  // headers
  if (!parsed?.headers) {
    return { ok: false, error: 'headers authConfig 需为 {headers: Record<string,string>}' };
  }
  return { ok: true, authType: 'headers', authConfig: JSON.stringify({ headers: parsed.headers }) };
}
