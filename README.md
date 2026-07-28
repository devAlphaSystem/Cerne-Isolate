# Cerne Isolate

`cerne-isolate` executa tarefas Node.js em processos filhos descartáveis. O pacote concentra o protocolo IPC, a disputa entre resposta, timeout e cancelamento, a fila limitada e a confirmação de encerramento que normalmente ficam espalhados ao redor de `node:child_process`.

O pacote requer Node.js 20 ou superior, não possui dependências de runtime e publica interfaces ESM, CommonJS e TypeScript.

## Garantias

Cada chamada aceita pelo executor:

- usa `fork()` sem shell e com `serialization: "advanced"`;
- executa no máximo um trabalho por processo;
- suporta `Buffer`, `Map`, `Set`, `BigInt`, `Date`, `RegExp`, `ArrayBuffer` e typed arrays estruturáveis;
- aplica o timeout a partir da saída da fila, incluindo startup, handshake, execução e resposta;
- deixa a primeira condição terminal vencer entre resultado, erro, timeout, aborto, saída e shutdown;
- encerra o filho após sucesso ou falha e só assenta a Promise depois do evento `close`;
- mantém a vaga de concorrência ocupada até esse `close`;
- escala o encerramento de saída natural para `SIGTERM` e depois `SIGKILL`;
- remove timers e listeners de aborto ao finalizar.

A fila é FIFO e limitada. `maxQueue` conta somente tarefas aguardando; filhos ativos são limitados separadamente por `concurrency`.

O payload recebe um snapshot V8 estruturável durante a admissão. Alterações posteriores no objeto original não mudam uma tarefa enfileirada, e getters são avaliados uma única vez antes da fila. Como o IPC também copia os dados, buffers grandes podem aumentar temporariamente o uso de memória; para esses casos, prefira enviar um caminho ou uma chave.

## Instalação

```bash
npm install cerne-isolate
```

## Uso

No processo principal:

```ts
import { createProcessExecutor } from "cerne-isolate";

interface HeavyPayload {
  filePath: string;
  options: Record<string, unknown>;
}

interface HeavyResult {
  pages: number;
}

const executor = createProcessExecutor<HeavyPayload, HeavyResult>({
  worker: new URL("./heavy-worker.js", import.meta.url),
  concurrency: 2,
  maxQueue: 10,
  timeoutMs: 60_000,
});

try {
  const result = await executor.run(
    {
      filePath: "/tmp/documento.pdf",
      options: {},
    },
    { signal },
  );
  console.log(result.pages);
} finally {
  await executor.close();
}
```

No arquivo escolhido pela aplicação como worker:

```ts
import { defineProcessHandler } from "cerne-isolate/worker";

import type { HeavyPayload, HeavyResult } from "./heavy-contract";
import { executarTrabalhoPesado } from "./heavy-service";

defineProcessHandler<HeavyPayload, HeavyResult>(async (payload) => {
  return executarTrabalhoPesado(payload.filePath, payload.options);
});
```

Main e worker devem importar os tipos do mesmo contrato compartilhado. Os genéricos verificam cada lado em compilação, mas o TypeScript não vincula automaticamente dois arquivos independentes.

## Cancelamento, timeout e shutdown

Um `AbortSignal` já abortado nunca entra na fila. Se o aborto ocorrer durante a espera, a tarefa é removida e libera sua vaga na fila. Se ocorrer durante a execução, o filho é encerrado e a Promise rejeita somente após `close`.

O timeout não inclui o tempo aguardando na fila. `timeoutMs: 0` desabilita o prazo; o padrão é 60 segundos.

`close()` é idempotente. A primeira chamada fecha a admissão, rejeita tarefas aguardando, aborta filhos ativos e aguarda a confirmação de fechamento de todos eles. Chamadas posteriores a `run()` rejeitam com `ProcessExecutorClosedError`.

## Erros

Todos os erros operacionais herdam de `ProcessExecutorError` e expõem um `code` estável:

| Classe                       | Código                    | Situação                                                |
| ---------------------------- | ------------------------- | ------------------------------------------------------- |
| `ProcessTimeoutError`        | `PROCESS_TIMEOUT`         | O prazo da execução venceu.                             |
| `ProcessAbortedError`        | `PROCESS_ABORTED`         | O sinal ou o shutdown cancelou a tarefa.                |
| `ProcessExitError`           | `PROCESS_EXIT`            | O filho fechou antes de responder.                      |
| `ProcessQueueFullError`      | `PROCESS_QUEUE_FULL`      | A fila limitada já estava cheia.                        |
| `ProcessSerializationError`  | `PROCESS_SERIALIZATION`   | O request, resultado ou erro não pôde atravessar o IPC. |
| `ProcessHandlerError`        | `PROCESS_HANDLER`         | O handler rejeitou ou lançou um erro.                   |
| `ProcessProtocolError`       | `PROCESS_PROTOCOL`        | O worker violou o protocolo versionado.                 |
| `ProcessExecutorClosedError` | `PROCESS_EXECUTOR_CLOSED` | O executor já está fechando ou fechado.                 |

`ProcessHandlerError.remoteError` contém somente nome, mensagem, stack, código e causas serializados como dados simples. O objeto arbitrário lançado pelo worker não é transportado.

## Eventos opcionais

`onEvent` recebe eventos `start`, `end` e `close`. Eles expõem identificador interno, PID, duração, outcome, código de saída, sinal e estágio de encerramento. Payload, resultado, caminho do worker, mensagem e stack nunca fazem parte dos eventos.

```ts
const executor = createProcessExecutor({
  worker: new URL("./heavy-worker.js", import.meta.url),
  onEvent(event) {
    metrics.observe(event);
  },
});
```

Exceções síncronas e rejeições de listeners assíncronos são isoladas e não alteram a execução.

## Limites deliberados

O `cerne-isolate` não:

- conhece Scanner, Fiscal, Boletos ou qualquer regra do handler;
- escolhe módulos a partir do payload: o worker é um caminho absoluto ou uma URL `file:` fixa na criação do executor;
- serializa funções, símbolos, `Readable` ou outros valores incompatíveis com structured clone;
- usa `eval`, shell ou comandos arbitrários;
- mantém fila ilimitada, persistente ou distribuída;
- escolhe entre `Buffer`, arquivo, armazenamento de objetos ou outra estratégia da aplicação.

Streams não atravessam esse IPC. A aplicação deve consumi-los e enviar um caminho, uma chave ou bytes estruturáveis.

O pacote confirma o encerramento do filho direto criado por ele. Node.js não fornece, de forma portátil, uma garantia de morte junto ao pai quando o processo principal é encerrado à força, nem encerra automaticamente processos netos criados pelo próprio handler. O worker reduz o primeiro risco encerrando quando o canal IPC é desconectado; código síncrono ou nativo travado ainda pode impedir que esse evento seja processado até o sinal forçado.

Isolamento de processo não é sandbox de segurança. O filho herda diretório de trabalho, ambiente, usuário e permissões do processo principal; código não confiável exige uma fronteira de segurança externa adequada.

## Documentação

- [Referência da API](docs/API.md)
- [Exemplos](docs/EXEMPLOS.md)
- [Instalação e desenvolvimento](docs/INSTALACAO.md)
- [Benchmark e regressão](bench/README.md)

## Licença

MIT. Consulte [LICENSE](LICENSE).
