---
impacto: nada_mudou
secao: alterado
titulo: Cada requisição deixa de fazer duas viagens ao Supabase Auth só para saber quem é o usuário
---

A assinatura do token de sessão passa a ser conferida no próprio servidor do CRM, com a chave pública do projeto (JWKS, buscada uma vez e guardada em memória), em vez de perguntar ao Supabase Auth duas vezes por requisição — uma no proxy e outra ao carregar o usuário. O contexto de acompanhamento administrativo passa a ser lido na mesma rodada que as permissões, não depois delas. Numa instalação medida com o Supabase respondendo lento (compute Nano), uma rota trivial caiu de 1,5–3,5 s para o tempo de uma única consulta ao banco.

Projetos ainda em chave simétrica (HS256) continuam no caminho antigo, sem mudança. Em chave assimétrica, um token encerrado noutro aparelho segue válido até vencer (1 h por padrão) — a revogação de papel, vínculo e acompanhamento continua imediata, porque vem do banco a cada requisição.

Não é preciso fazer nada na instalação.
