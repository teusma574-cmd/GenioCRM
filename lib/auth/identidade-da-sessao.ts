/**
 * Quem é a pessoa desta requisição — verificando o JWT LOCALMENTE.
 *
 * ## Por que existe
 *
 * Cada requisição autenticada fazia DUAS viagens ao GoTrue só para saber quem
 * era o usuário: `getUser()` no `proxy.ts` e `getUser()` de novo em
 * `loadAuthUser`. Com o Supabase respondendo em 200–900 ms (compute Nano sob
 * carga, medido em 2026-10-03 na instalação `mentoriahunter.online`), uma
 * rota trivial como `/api/v1/system/version` levava 1,5–3,5 s — e a tela
 * "travava": cada botão e cada lista pagavam as duas viagens antes de
 * qualquer dado.
 *
 * ## O que faz
 *
 * `getClaims()` do auth-js: lê a sessão do cookie, renova o access token se
 * venceu (como `getUser()` já fazia) e **verifica a assinatura do JWT com a
 * chave pública do projeto** (JWKS, buscado uma vez e cacheado em memória).
 * Nenhuma viagem ao GoTrue para o caminho comum. É o substituto que o próprio
 * Supabase recomenda para `getUser()` em projetos com chave assimétrica
 * (ES256/RS256) — e NÃO é `getSession()`: a assinatura é conferida, o cookie
 * não é acreditado.
 *
 * ## Quando cai para `getUser()`
 *
 * - Projeto ainda em chave simétrica (HS256): o próprio auth-js cai para
 *   `getUser()` por dentro — o comportamento antigo, intacto.
 * - Cliente sem `getClaims` (SDK antigo, ou os dublês de teste que só
 *   modelam `auth.getUser`): cai para `getUser()` aqui.
 *
 * ## O que muda de verdade
 *
 * Um JWT assinado continua válido até o `exp` (1 h por padrão) mesmo que a
 * sessão tenha sido encerrada noutro aparelho ou o usuário banido no painel —
 * `getUser()` pegava isso na hora, a verificação local não. É a troca
 * documentada pelo Supabase; revogação de ACESSO (papel, vínculo, suporte)
 * não é afetada: ela continua vindo do banco a cada requisição.
 */

interface ErroDeAuth {
  name?: string;
  code?: string;
  status?: number;
  message: string;
}

/** O recorte de `User` que `loadAuthUser` e o proxy realmente leem. */
export interface IdentidadeDaSessao {
  id: string;
  email: string | null;
  user_metadata: Record<string, unknown>;
}

interface RespostaGetUser {
  data: { user: { id: string; email?: string | null; user_metadata?: Record<string, unknown> | null } | null };
  error: ErroDeAuth | null;
}

interface RespostaGetClaims {
  data: {
    claims: {
      sub?: string;
      email?: string | null;
      user_metadata?: Record<string, unknown> | null;
    };
  } | null;
  error: ErroDeAuth | null;
}

/** O mínimo de `SupabaseAuthClient` que este helper toca — tipado frouxo de
 *  propósito, para aceitar o cliente real e os dublês de teste. */
export interface AuthComClaims {
  getUser: () => Promise<RespostaGetUser>;
  getClaims?: () => Promise<RespostaGetClaims>;
}

export async function identidadeDaSessao(
  auth: AuthComClaims,
): Promise<{ user: IdentidadeDaSessao | null; error: ErroDeAuth | null }> {
  if (typeof auth.getClaims === "function") {
    const { data, error } = await auth.getClaims();
    const claims = data?.claims;
    if (!claims?.sub) return { user: null, error };
    return {
      user: {
        id: claims.sub,
        email: claims.email ?? null,
        user_metadata: claims.user_metadata ?? {},
      },
      error,
    };
  }

  const { data, error } = await auth.getUser();
  const user = data?.user;
  if (!user) return { user: null, error };
  return {
    user: { id: user.id, email: user.email ?? null, user_metadata: user.user_metadata ?? {} },
    error,
  };
}
