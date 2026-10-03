import { describe, expect, it, vi } from "vitest";
import { identidadeDaSessao } from "./identidade-da-sessao";

/**
 * A IDENTIDADE VEM DO JWT VERIFICADO LOCALMENTE — E O GOTRUE NÃO É CHAMADO.
 *
 * O ganho desta função é NÃO viajar: `getClaims()` confere a assinatura com a
 * chave pública cacheada. Se um dia alguém "simplificar" para `getUser()`
 * sem perceber, toda requisição volta a pagar a viagem — e a tela volta a
 * travar sob um Supabase lento. O primeiro caso é o que prende isso.
 */
describe("identidadeDaSessao", () => {
  it("usa getClaims quando existe e NÃO chama getUser", async () => {
    const getUser = vi.fn();
    const auth = {
      getUser,
      getClaims: async () => ({
        data: {
          claims: {
            sub: "u-1",
            email: "ana@exemplo.com",
            user_metadata: { full_name: "Ana", locale: "pt-BR" },
          },
        },
        error: null,
      }),
    };

    const { user, error } = await identidadeDaSessao(auth);

    expect(getUser).not.toHaveBeenCalled();
    expect(error).toBeNull();
    expect(user).toEqual({
      id: "u-1",
      email: "ana@exemplo.com",
      user_metadata: { full_name: "Ana", locale: "pt-BR" },
    });
  });

  it("sem sessão: user null e o erro passa adiante, do jeito que veio", async () => {
    const erro = { name: "AuthSessionMissingError", message: "Auth session missing!", status: 400 };
    const auth = {
      getUser: vi.fn(),
      getClaims: async () => ({ data: null, error: erro }),
    };

    const r = await identidadeDaSessao(auth);
    expect(r.user).toBeNull();
    expect(r.error).toBe(erro);
  });

  it("claims sem `sub` não viram usuário", async () => {
    const auth = {
      getUser: vi.fn(),
      getClaims: async () => ({ data: { claims: { email: "x@y" } }, error: null }),
    };
    expect((await identidadeDaSessao(auth)).user).toBeNull();
  });

  it("cliente sem getClaims cai para getUser — o caminho antigo, intacto", async () => {
    const auth = {
      getUser: async () => ({
        data: { user: { id: "u-2", email: null, user_metadata: null } },
        error: null,
      }),
    };

    const { user } = await identidadeDaSessao(auth);
    expect(user).toEqual({ id: "u-2", email: null, user_metadata: {} });
  });

  it("no fallback, a falha do getUser preserva nome/código/status para o log", async () => {
    const erro = { name: "AuthRetryableFetchError", code: "x", status: 503, message: "fetch failed" };
    const auth = { getUser: async () => ({ data: { user: null }, error: erro }) };
    const r = await identidadeDaSessao(auth);
    expect(r.user).toBeNull();
    expect(r.error).toBe(erro);
  });
});
