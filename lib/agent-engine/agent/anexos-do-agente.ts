/**
 * OS ARQUIVOS QUE O AGENTE PODE ENVIAR (migration 0500).
 *
 * O dono cadastra, na tela do agente, arquivos prontos — PDF, imagem, áudio —
 * com um NOME, uma instrução de QUANDO enviar e um teto de envios por conversa.
 * O modelo vê a lista no prompt e escolhe pelo nome, no `anexo` do `send_message`.
 *
 * O caminho do envio é o da foto do catálogo (`fotos-do-produto.ts`): o arquivo é
 * COPIADO de `agent-attachments` para a pasta da conversa em `whatsapp-media`, e
 * sai pelo handler de mensagens, com URL assinada curta — atrás da MESMA cadeia
 * runBeforeSend de todo envio. A cópia é da conversa: a inbox a mostra e a LGPD
 * a apaga junto com ela.
 *
 * O TETO DE ENVIOS É DO SERVIDOR, não do prompt. Cada mensagem que leva um
 * arquivo é marcada com `metadata.agent_attachment_id`; antes de enviar, conta-se
 * quantas a conversa já tem. O modelo que insistir recebe recusa, em texto.
 */
import {
  anexoPertenceAoAgente,
  BUCKET_DOS_ANEXOS,
  nomeDeArquivoDoAnexo,
  normalizarNomeDoAnexo,
  rotuloDoTipo,
  type TipoDeAnexo,
} from '@/lib/ai/agents/anexos';
import { createAdminClient } from '@/lib/supabase/admin';

import type { Queryable } from '../queue/queue';
import { LIMITE_DA_LEGENDA, type FotoParaEnvio } from './fotos-do-produto';
import { OK_KINDS, type BubbleOutcome } from './split-message';

const BUCKET_DA_CONVERSA = 'whatsapp-media';

export interface AnexoDoAgente {
  id: string;
  nome: string;
  quandoEnviar: string;
  kind: TipoDeAnexo;
  mime: string;
  storagePath: string;
  maxEnviosPorConversa: number;
}

interface Log {
  warn(msg: string, fields?: Record<string, unknown>): void;
}

interface LinhaDoAnexo {
  id: string;
  name: string;
  send_when: string | null;
  kind: string;
  mime: string;
  storage_path: string;
  max_sends_per_conversation: number;
}

/**
 * Os arquivos LIGADOS deste agente. Falha de leitura devolve lista vazia: o
 * worker que subiu antes da migration 0500 (tabela ausente) atende normalmente,
 * só sem arquivos — a direção segura é enviar de menos.
 */
export async function carregarAnexosDoAgente(
  db: Queryable,
  log: Log,
  input: { tenantId: string; agentId: string },
): Promise<AnexoDoAgente[]> {
  try {
    const { rows } = await db.query<LinhaDoAnexo>(
      `select id, name, send_when, kind, mime, storage_path, max_sends_per_conversation
         from ai_agent_attachments
        where organization_id = $1 and agent_id = $2 and is_active
        order by created_at`,
      [input.tenantId, input.agentId],
    );
    return rows
      // Só caminho que É deste agente: a cópia é por service role, sem RLS.
      .filter((r) => anexoPertenceAoAgente(r.storage_path, input.tenantId, input.agentId))
      .filter((r) => r.kind === 'image' || r.kind === 'audio' || r.kind === 'document')
      .map((r) => ({
        id: r.id,
        nome: r.name,
        quandoEnviar: (r.send_when ?? '').trim(),
        kind: r.kind as TipoDeAnexo,
        mime: r.mime,
        storagePath: r.storage_path,
        maxEnviosPorConversa: r.max_sends_per_conversation,
      }));
  } catch (err) {
    log.warn('arquivos do agente não carregados — turno segue sem eles', {
      detalhe: (err instanceof Error ? err.message : String(err)).slice(0, 120),
    });
    return [];
  }
}

/**
 * O bloco do prompt. `null` quando não há arquivo: nomear um recurso ausente faz
 * o modelo tentar usá-lo.
 */
export function blocoDeAnexos(anexos: readonly AnexoDoAgente[]): string | null {
  if (anexos.length === 0) return null;
  const linhas = anexos.map((a) => {
    const quando = a.quandoEnviar !== '' ? a.quandoEnviar : 'quando o cliente pedir este material';
    const vezes = a.maxEnviosPorConversa === 1 ? '1 vez' : `${a.maxEnviosPorConversa} vezes`;
    return `- "${a.nome}" (${rotuloDoTipo(a.kind)}) — quando enviar: ${quando} — no máximo ${vezes} por conversa`;
  });
  return [
    'ARQUIVOS QUE VOCÊ PODE ENVIAR',
    'Você tem arquivos prontos para mandar ao cliente. Para enviar um, chame send_message com `anexo` igual ao NOME exato do arquivo (entre aspas na lista abaixo); o `body` é o texto que acompanha o arquivo.',
    'Envie quando a situação descrita em "quando enviar" acontecer, ou quando o cliente pedir aquele material. Um arquivo por mensagem. Não envie fora de contexto e não repita um arquivo que você já mandou nesta conversa: cada um tem um limite de envios, e a ferramenta recusa acima dele — se recusar, não insista; diga ao cliente que o arquivo já foi enviado acima.',
    'Só diga que enviou um arquivo depois que send_message confirmar o envio dele. Nunca prometa arquivo que não está nesta lista.',
    ...linhas,
  ].join('\n');
}

/** Acha pelo nome, perdoando caixa/acento/pontuação. Ambíguo ou ausente = `null`. */
export function acharAnexoPeloNome(
  anexos: readonly AnexoDoAgente[],
  nome: string,
): AnexoDoAgente | null {
  const alvo = normalizarNomeDoAnexo(nome);
  if (alvo === '') return null;
  const exatos = anexos.filter((a) => normalizarNomeDoAnexo(a.nome) === alvo);
  return exatos.length === 1 ? exatos[0]! : null;
}

/** Quantas mensagens desta conversa já levaram este arquivo (falha não conta). */
export async function enviosDoAnexoNaConversa(
  db: Queryable,
  input: { tenantId: string; conversationId: string; anexoId: string },
): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `select count(*)::int as n
       from messages
      where organization_id = $1
        and conversation_id = $2
        and metadata ? 'agent_attachment_id'
        and metadata ->> 'agent_attachment_id' = $3
        and status <> 'failed'`,
    [input.tenantId, input.conversationId, input.anexoId],
  );
  return rows[0]?.n ?? 0;
}

/** Marca a mensagem enviada com o arquivo que ela levou — é o que a contagem lê. */
export async function marcarEnvioDoAnexo(
  db: Queryable,
  input: { tenantId: string; messageId: string; anexoId: string; nome: string },
): Promise<void> {
  await db.query(
    `update messages
        set metadata = coalesce(metadata, '{}'::jsonb)
          || jsonb_build_object('agent_attachment_id', $3::text, 'agent_attachment_name', $4::text)
      where organization_id = $1 and id = $2`,
    [input.tenantId, input.messageId, input.anexoId, input.nome],
  );
}

/** Copia do bucket do agente para a conversa. `true` = o arquivo está no destino. */
export type CopiarAnexo = (origem: string, destino: string) => Promise<boolean>;

export function copiarAnexoNoStorage(log: Log): CopiarAnexo {
  return async (origem, destino) => {
    const { error } = await createAdminClient()
      .storage.from(BUCKET_DOS_ANEXOS)
      .copy(origem, destino, { destinationBucket: BUCKET_DA_CONVERSA });
    if (!error) return true;
    // Já copiado antes para esta conversa: o arquivo que precisamos está lá.
    if (/already exists/i.test(error.message) || (error as { statusCode?: string }).statusCode === '409') {
      return true;
    }
    log.warn('arquivo do agente não copiado para a conversa', { detalhe: error.message.slice(0, 120) });
    return false;
  };
}

export type AnexoPreparado =
  | { ok: true; anexo: AnexoDoAgente; media: FotoParaEnvio }
  | {
      ok: false;
      code: 'anexo_nao_encontrado' | 'anexo_limite_de_envios' | 'anexo_indisponivel';
      message: string;
    };

/**
 * Confere nome e teto, e deixa o arquivo pronto na pasta da conversa.
 *
 * Todo erro aqui é de ENSINO e acontece ANTES de enviar qualquer coisa: o modelo
 * corrige o nome, ou segue só com texto. `enviadosNoTurno` cobre o envio que este
 * MESMO turno já fez e cuja marca ainda não chegou ao banco (canal em fila).
 */
export async function prepararAnexo(
  db: Queryable,
  copiar: CopiarAnexo,
  input: {
    tenantId: string;
    conversationId: string;
    anexos: readonly AnexoDoAgente[];
    nome: string;
    enviadosNoTurno?: number;
  },
): Promise<AnexoPreparado> {
  const anexo = acharAnexoPeloNome(input.anexos, input.nome);
  if (!anexo) {
    const nomes = input.anexos.map((a) => `"${a.nome}"`).join(', ');
    return {
      ok: false,
      code: 'anexo_nao_encontrado',
      message:
        `não há arquivo com o nome ${JSON.stringify(input.nome)}. ` +
        (nomes !== ''
          ? `Os arquivos disponíveis são: ${nomes}. Use o nome exato, ou envie sem \`anexo\`.`
          : 'Este agente não tem arquivos para enviar. Envie sem `anexo` e não prometa arquivo ao cliente.'),
    };
  }
  const jaEnviados =
    (await enviosDoAnexoNaConversa(db, {
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      anexoId: anexo.id,
    })) + (input.enviadosNoTurno ?? 0);
  if (jaEnviados >= anexo.maxEnviosPorConversa) {
    return {
      ok: false,
      code: 'anexo_limite_de_envios',
      message:
        `o arquivo "${anexo.nome}" já foi enviado ${jaEnviados} vez(es) nesta conversa ` +
        `(limite: ${anexo.maxEnviosPorConversa}). NÃO envie de novo. Responda só com texto, ` +
        'sem `anexo` — se fizer sentido, diga ao cliente que o arquivo já está logo acima na conversa.',
    };
  }
  const ext = anexo.storagePath.split('.').pop() ?? 'bin';
  const destino = `${input.tenantId}/${input.conversationId}/${nomeDeArquivoDoAnexo(anexo.nome, anexo.id, ext)}`;
  if (!(await copiar(anexo.storagePath, destino))) {
    return {
      ok: false,
      code: 'anexo_indisponivel',
      message:
        `o arquivo "${anexo.nome}" não pôde ser preparado agora. Envie só o texto, sem \`anexo\`, ` +
        'e NÃO diga ao cliente que mandou o arquivo.',
    };
  }
  return { ok: true, anexo, media: { storagePath: destino, mime: anexo.mime } };
}

/**
 * Manda o texto com o arquivo.
 *
 * Imagem e PDF: o texto vira a LEGENDA (uma mensagem só); acima do teto de
 * legenda o texto sai antes, como texto, e o arquivo depois sem legenda. Áudio
 * não tem legenda no WhatsApp: o texto sai antes e o áudio depois.
 *
 * `restantes` é quantas mensagens físicas o turno ainda pode mandar, consultado
 * antes do arquivo. `aoEnviarArquivo` recebe o desfecho da mensagem que LEVOU o
 * arquivo — é ela que a contagem de envios marca.
 */
export async function enviarComAnexo<T extends BubbleOutcome>(
  body: string,
  anexo: { kind: TipoDeAnexo; media: FotoParaEnvio },
  opts: {
    enviarTexto: (body: string) => Promise<T>;
    enviarArquivo: (media: FotoParaEnvio, legenda: string) => Promise<T>;
    sleep: (ms: number) => Promise<void>;
    jitter: () => number;
    restantes?: () => number;
    aoEnviarArquivo?: (desfecho: T) => void;
  },
): Promise<T> {
  const cabeMaisUma = () => (opts.restantes?.() ?? Number.POSITIVE_INFINITY) > 0;
  const arquivo = async (legenda: string): Promise<T> => {
    const desfecho = await opts.enviarArquivo(anexo.media, legenda);
    opts.aoEnviarArquivo?.(desfecho);
    return desfecho;
  };
  if (!cabeMaisUma()) return opts.enviarTexto(body);
  const comLegenda = anexo.kind !== 'audio' && body.length <= LIMITE_DA_LEGENDA;
  if (comLegenda) return arquivo(body);
  const texto = await opts.enviarTexto(body);
  if (!OK_KINDS.has(texto.kind)) return texto;
  if (!cabeMaisUma()) return texto;
  await opts.sleep(opts.jitter());
  return arquivo('');
}
