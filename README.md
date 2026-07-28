# Cerne Isolate

Biblioteca para executar tarefas Node.js em processos filhos com concorrência e fila limitadas, IPC estruturado, timeout, cancelamento e encerramento confirmado. O pacote oferece um executor descartável, que cria um processo por tarefa, e um pool, que reutiliza processos saudáveis sob políticas explícitas de reciclagem.

A aplicação define o caminho fixo de um worker e troca payloads e resultados tipados com ele. O Cerne Isolate cuida da admissão, do handshake, da serialização, do ciclo de vida do processo e da escalada de encerramento; não há servidor, daemon, CLI ou serviço externo.

> Isolamento de processo não é sandbox de segurança. O worker roda com o mesmo usuário e as mesmas permissões de filesystem e rede do processo pai, herda o ambiente, o diretório de trabalho, `stdout` e `stderr` e deve ser escolhido por código confiável. Não use o pacote para executar código arbitrário de terceiros sem uma camada externa de contenção.

## Recursos principais

- Processo descartável por tarefa para separar estado, falhas e vazamentos entre execuções.
- Pool criado sob demanda para reduzir o custo de startup quando o reúso é aceitável.
- Um handler tipado por worker por meio do subpath `cerne-isolate/worker`.
- IPC avançado do Node.js, com suporte a valores estruturados como `Buffer`, `BigInt`, `Date`, `RegExp`, typed arrays, `Map` e `Set`.
- Snapshot do payload antes da admissão, sem compartilhar referências mutáveis com o processo filho.
- Concorrência e fila limitadas, com rejeição estável quando a capacidade se esgota.
- Timeout a partir do despacho, cancelamento com `AbortSignal` e shutdown idempotente.
- Escalada de encerramento até `SIGTERM` e `SIGKILL`, aguardando a confirmação de `close`.
- Reciclagem do pool por falha, inatividade, quantidade de tarefas, tempo de vida ou shutdown.
- Erros públicos com códigos estáveis e eventos de ciclo de vida sem payloads ou resultados.
- Distribuição ESM, CommonJS e tipos TypeScript, sem dependências externas de runtime.

## Requisitos e instalação

- Node.js 20 ou superior.
- Runtime Node.js com permissão para criar processos filhos.
- Um arquivo JavaScript executável para o worker; o `process.execArgv` do pai é esvaziado no filho, portanto a aplicação não deve depender de loader TypeScript.

```bash
npm install cerne-isolate
```

> Antes de publicar o tarball atual, revise o lifecycle de instalação: o manifesto executa `patch-package` em `postinstall`, mas essa ferramenta e `patches/` não integram o conteúdo publicado. A [ressalva de empacotamento](docs/INSTALACAO.md#validação-antes-de-publicar) descreve o ponto que ainda precisa de validação.

A forma de instalação prevista, os artefatos publicados e as orientações para bundlers e deploy estão em [docs/INSTALACAO.md](docs/INSTALACAO.md).

## Uso rápido

O worker registra exatamente um handler. Em um projeto TypeScript, compile este arquivo para JavaScript antes de apontar o executor para ele.

`src/workers/digest.ts`:

```ts
import { createHash } from "node:crypto";
import { defineProcessHandler } from "cerne-isolate/worker";

interface DigestPayload {
  content: string;
}

interface DigestResult {
  sha256: string;
}

defineProcessHandler<DigestPayload, DigestResult>(({ content }) => ({
  sha256: createHash("sha256").update(content, "utf8").digest("hex"),
}));
```

`src/app.ts`:

```ts
import { createProcessExecutor } from "cerne-isolate";

interface DigestPayload {
  content: string;
}

interface DigestResult {
  sha256: string;
}

const executor = createProcessExecutor<DigestPayload, DigestResult>({
  worker: new URL("./workers/digest.js", import.meta.url),
  concurrency: 2,
  maxQueue: 50,
  timeoutMs: 15_000,
});

try {
  const result = await executor.run({ content: "cerne-isolate" });
  console.log(result.sha256);
} finally {
  await executor.close();
}
```

`worker` precisa resolver para o arquivo JavaScript gerado ao lado da aplicação compilada. A URL deve usar o protocolo `file:`, sem query ou fragmento; uma string precisa ser um caminho absoluto.

## Executor descartável e pool reutilizável

| Aspecto                   | `createProcessExecutor`              | `createProcessPool`                       |
| ------------------------- | ------------------------------------ | ----------------------------------------- |
| Processo                  | Um filho novo por tarefa             | Filhos criados sob demanda e reutilizados |
| Estado entre tarefas      | Não persiste                         | Pode persistir até a reciclagem           |
| Custo de startup          | Pago em cada tarefa                  | Amortizado entre tarefas bem-sucedidas    |
| Falha do handler/processo | Encerra o único filho                | Retira o filho da rotação                 |
| Encerramento do sucesso   | A Promise aguarda o `close` do filho | A Promise resolve ao receber o resultado  |
| Uso indicado              | Maior separação entre tarefas        | Cargas frequentes e workers confiáveis    |

O pool exige `idleTimeoutMs`:

```ts
import { createProcessPool } from "cerne-isolate";

const pool = createProcessPool<DigestPayload, DigestResult>({
  worker: new URL("./workers/digest.js", import.meta.url),
  concurrency: 4,
  maxQueue: 200,
  timeoutMs: 10_000,
  idleTimeoutMs: 30_000,
  maxJobsPerProcess: 25,
  maxLifetimeMs: 5 * 60_000,
});

try {
  const results = await Promise.all(["a", "b", "c"].map((content) => pool.run({ content })));
  console.log(results);
} finally {
  await pool.close();
}
```

Cada processo do pool executa uma tarefa por vez. Somente sucessos permitem reúso; timeout, aborto, erro do handler, saída inesperada, falha de serialização ou violação de protocolo descartam o processo.

## Concorrência, fila e encerramento

`concurrency` limita filhos que ainda não emitiram `close`; o padrão é 1. Quando todas as vagas estão ocupadas, até `maxQueue` tarefas aguardam em FIFO. O padrão é 100, e tarefas ativas não entram nessa contagem. Com `maxQueue: 0`, uma chamada sem capacidade imediata rejeita com `PROCESS_QUEUE_FULL`.

`close()`:

1. impede novas admissões;
2. rejeita tarefas em espera e tarefas ativas ainda sem desfecho com `PROCESS_ABORTED` e origem `shutdown`, preservando qualquer desfecho já reivindicado;
3. encerra todos os filhos;
4. aguarda a confirmação de `close` de cada processo.

A chamada é idempotente. Use-a em `finally`, principalmente com pools, porque processos ociosos permanecem disponíveis até a política de inatividade ou o shutdown.

## Cancelamento e timeout

Cada `run` aceita um `AbortSignal`. Com um executor ainda aberto:

```ts
const controller = new AbortController();
const pending = executor.run({ content: "entrada" }, { signal: controller.signal });

controller.abort(new Error("A requisição foi encerrada."));
await pending.catch((error) => {
  console.error(error.code, error.source);
});
```

Uma tarefa cancelada na fila é removida sem criar processo. Se já estiver ativa, o processo inteiro é encerrado; o handler não recebe o sinal e efeitos externos já realizados não são revertidos.

`timeoutMs` tem padrão de 60 segundos e pode ser desativado com zero. O prazo começa quando a tarefa recebe um processo, inclui startup, handshake e execução, mas não inclui o tempo de espera na fila.

## Erros e observabilidade

As Promises de `run` rejeitam com subclasses de `ProcessExecutorError` para falhas operacionais:

- `PROCESS_TIMEOUT`;
- `PROCESS_ABORTED`;
- `PROCESS_EXIT`;
- `PROCESS_QUEUE_FULL`;
- `PROCESS_SERIALIZATION`;
- `PROCESS_HANDLER`;
- `PROCESS_PROTOCOL`;
- `PROCESS_EXECUTOR_CLOSED`.

Use `error.code` para automação. Um erro lançado pelo handler chega como `ProcessHandlerError`, com a representação remota em `remoteError`; a instância original não atravessa o IPC.

`onEvent` recebe eventos `spawn`, `start`, `end`, `idle`, `recycle` e `close`, conforme o modo. Eles não carregam payload, resultado, caminho do worker ou detalhes do erro. Falhas do listener são isoladas da execução. Consulte [docs/API.md](docs/API.md#eventos-de-ciclo-de-vida).

## API pública

O ponto de entrada `cerne-isolate` exporta:

- `createProcessExecutor`;
- `createProcessPool`;
- `ProcessExecutorError` e suas subclasses;
- tipos TypeScript de opções, runtime, eventos, erros, serialização e ciclo de vida.

O subpath `cerne-isolate/worker` exporta:

- `defineProcessHandler`;
- o tipo `ProcessHandler`.

A referência completa está em [docs/API.md](docs/API.md).

## Documentação

- [Instalação e desenvolvimento](docs/INSTALACAO.md)
- [Referência da API](docs/API.md)
- [Exemplos de integração](docs/EXEMPLOS.md)
- Benchmark e regressão: `bench/README.md` no checkout do repositório

## Estrutura do repositório

```text
src/
  child.ts       processo filho, IPC e escalada de encerramento
  errors.ts      erros públicos e códigos estáveis
  executor.ts    criação do executor descartável
  pool.ts        criação do pool reutilizável
  protocol.ts    protocolo interno e serialização
  runtime.ts     admissão, fila, despacho, reciclagem e shutdown
  types.ts       contratos públicos
  worker.ts      entrada pública usada pelo processo filho
bench/
  workers/       workers determinísticos para cenários de regressão
  run.mjs        medição e comparação de snapshots
docs/            instalação, API e exemplos
```

O projeto não possui rotas HTTP, controllers, views, banco de dados, CLI ou variáveis de ambiente obrigatórias.

## Desenvolvimento

Os scripts declarados cobrem tipos, lint, formatação, build, benchmark e auditoria:

```bash
npm run typecheck
npm run lint
npm run format:check
npm run build
```

O fluxo consolidado é `npm run check`. O CI executa instalação, typecheck, lint, conferência de formatação e build em Node.js 20, 22 e 24, além de uma auditoria separada. O benchmark exige o build e cobre sucesso, concorrência, fila, serialização, timeout, aborto, encerramento, falhas de processo e reúso.

## Licença

[MIT](LICENSE), copyright 2026 devAlphaSystem.
