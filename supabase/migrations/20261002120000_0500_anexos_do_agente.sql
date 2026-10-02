-- ============================================================================
-- 0500 — ARQUIVOS QUE O AGENTE PODE ENVIAR (fork desta instalação, 2026-10-02)
--
-- Cada agente ganha uma lista de arquivos prontos (PDF, imagem, áudio). Cada
-- arquivo tem um NOME, uma instrução de QUANDO enviar e um teto de envios por
-- conversa. O agente os envia pelo `send_message` (argumento `anexo`), pelo
-- mesmo caminho seguro de todo envio (opt-out, anti-ban, janela).
--
-- ─── Por que tabela própria, e não coluna na versão do agente
--
-- A versão publicada é imutável (0051). Arquivo é material vivo: o dono troca o
-- cardápio sem querer republicar o prompt. A lista é lida a cada turno, como a
-- config publicada — trocar o arquivo vale no próximo turno.
--
-- ─── Por que bucket próprio, privado
--
-- Mesmo motivo do `catalog-photos` (0390): o arquivo não é de contato nenhum,
-- então não mora em `whatsapp-media`, que a LGPD limpa por conversa. No envio o
-- app COPIA o arquivo para a pasta da conversa — é essa cópia que a conversa
-- possui. Nenhuma policy em `storage.objects`: só o service role lê e grava,
-- depois de a rota conferir o papel.
--
-- ─── O teto de envios
--
-- `max_sends_per_conversation` é conferido no SERVIDOR, contando as mensagens
-- da conversa marcadas com `metadata.agent_attachment_id`. Não é só instrução
-- de prompt: o modelo que insistir recebe recusa da ferramenta.
--
-- Idempotente e aditiva.
-- ============================================================================

create table if not exists public.ai_agent_attachments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  agent_id uuid not null references public.ai_agents(id) on delete cascade,
  name text not null,
  send_when text not null default '',
  kind text not null,
  mime text not null,
  storage_path text not null,
  size_bytes integer not null,
  max_sends_per_conversation integer not null default 1,
  is_active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_agent_attachments_name_check check (btrim(name) <> '' and char_length(name) <= 80),
  constraint ai_agent_attachments_send_when_check check (char_length(send_when) <= 600),
  constraint ai_agent_attachments_kind_check check (kind in ('image', 'audio', 'document')),
  constraint ai_agent_attachments_max_sends_check
    check (max_sends_per_conversation between 1 and 20),
  constraint ai_agent_attachments_size_check check (size_bytes > 0)
);

comment on table public.ai_agent_attachments is
  'Arquivos (PDF, imagem, áudio) que um agente de IA pode enviar na conversa. storage_path aponta para storage/agent-attachments, sempre <organization_id>/<agent_id>/<uuid>.<ext>. Escrito só por app/api/v1/ai/agents/[id]/attachments.';

-- O modelo escolhe o arquivo pelo NOME: dois com o mesmo nome no mesmo agente
-- é a receita para mandar o errado.
create unique index if not exists ai_agent_attachments_nome_unico
  on public.ai_agent_attachments (agent_id, lower(name));

create index if not exists idx_ai_agent_attachments_agente
  on public.ai_agent_attachments (organization_id, agent_id, created_at);

drop trigger if exists trg_ai_agent_attachments_updated_at on public.ai_agent_attachments;
create trigger trg_ai_agent_attachments_updated_at
  before update on public.ai_agent_attachments
  for each row execute function public.fn_set_updated_at();

alter table public.ai_agent_attachments enable row level security;

drop policy if exists ai_agent_attachments_select on public.ai_agent_attachments;
create policy ai_agent_attachments_select on public.ai_agent_attachments
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

-- Escrita só pelo service role (a rota confere `admin`): nenhuma policy de
-- escrita, e nenhum grant de escrita para os papéis do PostgREST.
revoke all on public.ai_agent_attachments from anon, authenticated;
grant select on public.ai_agent_attachments to authenticated;
grant all on public.ai_agent_attachments to service_role;

-- A contagem de envios por conversa lê `messages.metadata->>'agent_attachment_id'`.
-- Índice parcial: só as (poucas) mensagens que carregam um arquivo do agente.
create index if not exists idx_messages_agent_attachment
  on public.messages (conversation_id, ((metadata ->> 'agent_attachment_id')))
  where (metadata ? 'agent_attachment_id');

-- 16 MB: o teto de mídia do WhatsApp para imagem e áudio. Sem lista de mime no
-- bucket — quem decide o formato é a rota, pela assinatura dos bytes.
insert into storage.buckets (id, name, public, file_size_limit)
values ('agent-attachments', 'agent-attachments', false, 16777216)
on conflict (id) do update
  set public          = excluded.public,
      file_size_limit = excluded.file_size_limit;
