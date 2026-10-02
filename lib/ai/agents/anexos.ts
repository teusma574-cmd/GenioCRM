/**
 * OS ARQUIVOS QUE O AGENTE PODE ENVIAR — as regras que a rota, a tela e o motor
 * compartilham (migration 0500).
 *
 * Cada agente tem uma lista de arquivos prontos (PDF, imagem, áudio). O dono dá
 * um NOME, diz QUANDO enviar e quantas vezes o arquivo pode sair na mesma
 * conversa. O modelo escolhe pelo nome (`send_message` com `anexo`).
 *
 * CLIENT-SAFE: zero import de zod, supabase ou next/headers. A tela importa daqui.
 */

export const BUCKET_DOS_ANEXOS = "agent-attachments";

/** 16 MB: o `file_size_limit` do bucket, e o teto de mídia do WhatsApp. */
export const TAMANHO_MAXIMO_DO_ANEXO = 16 * 1024 * 1024;

/** Lista curta de propósito: cada arquivo entra no prompt de TODO turno. */
export const MAXIMO_DE_ANEXOS_POR_AGENTE = 30;

export const NOME_MAXIMO = 80;
export const QUANDO_ENVIAR_MAXIMO = 600;
export const ENVIOS_POR_CONVERSA_PADRAO = 1;
export const ENVIOS_POR_CONVERSA_MAXIMO = 20;

export type TipoDeAnexo = "image" | "audio" | "document";

export interface FormatoDoAnexo {
  kind: TipoDeAnexo;
  mime: string;
  ext: string;
}

function comeca(bytes: Uint8Array, assinatura: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + assinatura.length) return false;
  return assinatura.every((b, i) => bytes[offset + i] === b);
}

/**
 * O formato é decidido pela ASSINATURA dos bytes, não pelo `content-type` que o
 * navegador declarou — o arquivo vai ser servido ao WhatsApp de outra pessoa.
 * `null` = formato que esta lista não aceita.
 *
 * Aceita o que os canais de WhatsApp entregam: JPEG/PNG, PDF, e áudio MP3,
 * OGG (opus) e M4A/AAC.
 */
export function farejarAnexo(bytes: Uint8Array): FormatoDoAnexo | null {
  if (comeca(bytes, [0xff, 0xd8, 0xff])) return { kind: "image", mime: "image/jpeg", ext: "jpg" };
  if (comeca(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { kind: "image", mime: "image/png", ext: "png" };
  }
  // %PDF
  if (comeca(bytes, [0x25, 0x50, 0x44, 0x46])) {
    return { kind: "document", mime: "application/pdf", ext: "pdf" };
  }
  // OggS — o `codecs=opus` não é enfeite: ver `lib/messaging/media/voice-transcode.ts`.
  if (comeca(bytes, [0x4f, 0x67, 0x67, 0x53])) {
    return { kind: "audio", mime: "audio/ogg;codecs=opus", ext: "ogg" };
  }
  // MP3: tag ID3 ou frame sync (0xFFEx / 0xFFFx, exceto 0xFFFF).
  if (comeca(bytes, [0x49, 0x44, 0x33])) return { kind: "audio", mime: "audio/mpeg", ext: "mp3" };
  if (bytes.length > 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0 && bytes[1] !== 0xff) {
    return { kind: "audio", mime: "audio/mpeg", ext: "mp3" };
  }
  // M4A/AAC em container MP4: `ftyp` no offset 4 com marca de ÁUDIO. Vídeo MP4
  // tem o mesmo `ftyp` com outra marca — e vídeo não entra nesta lista.
  if (comeca(bytes, [0x66, 0x74, 0x79, 0x70], 4) && bytes.length >= 12) {
    const marca = String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!);
    if (marca === "M4A " || marca === "M4B ") return { kind: "audio", mime: "audio/mp4", ext: "m4a" };
  }
  return null;
}

const FORMA_DO_ARQUIVO =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|pdf|ogg|mp3|m4a)$/;

/**
 * O caminho É desta organização e deste agente, na forma exata que a rota gera?
 *
 * Quem LÊ o caminho confere, não só quem escreve: a cópia para a conversa é por
 * service role, que não tem RLS para barrar o arquivo de outra organização.
 */
export function anexoPertenceAoAgente(caminho: string, orgId: string, agentId: string): boolean {
  const prefixo = `${orgId}/${agentId}/`;
  return caminho.startsWith(prefixo) && FORMA_DO_ARQUIVO.test(caminho.slice(prefixo.length));
}

/** Comparação de nome que perdoa caixa, acento e espaço — o modelo erra os três. */
export function normalizarNomeDoAnexo(nome: string): string {
  return nome
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * O nome do arquivo que o CLIENTE vê no WhatsApp (documento): o nome que o dono
 * deu, em forma de arquivo. O sufixo do id deixa o destino determinístico e sem
 * colisão entre dois arquivos de nome parecido.
 */
export function nomeDeArquivoDoAnexo(nome: string, id: string, ext: string): string {
  const slug = normalizarNomeDoAnexo(nome).replace(/ /g, "-").slice(0, 60) || "arquivo";
  return `${slug}-${id.slice(0, 8)}.${ext}`;
}

export function rotuloDoTipo(kind: TipoDeAnexo): string {
  return kind === "image" ? "imagem" : kind === "audio" ? "áudio" : "PDF";
}
