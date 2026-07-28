# Exemplos de integração

Os exemplos usam somente a superfície pública de `cerne-isolate` e `cerne-isolate/worker`. Consulte [API.md](API.md) para defaults, faixas e contratos completos.

O caminho do worker deve ser definido por código confiável. Os exemplos apontam sempre para JavaScript compilado, porque o filho não herda o `process.execArgv` usado para carregar TypeScript no pai. Use `close()` em `finally` para confirmar o encerramento dos processos.

## Criar um worker tipado

`src/workers/sum.ts`:

```ts
import { defineProcessHandler } from "cerne-isolate/worker";

interface SumPayload {
  values: number[];
}

interface SumResult {
  total: number;
}

defineProcessHandler<SumPayload, SumResult>(({ values }) => ({
  total: values.reduce((sum, value) => sum + value, 0),
}));
```

O build da aplicação precisa produzir, por exemplo, `dist/workers/sum.js`. O handler é registrado uma vez quando o filho carrega o módulo.

Não execute esse arquivo diretamente e não o importe no processo pai. `defineProcessHandler` exige o canal IPC criado pelo executor ou pool.

## Executar uma tarefa em processo descartável

`src/app.ts`:

```ts
import { createProcessExecutor } from "cerne-isolate";

interface SumPayload {
  values: number[];
}

interface SumResult {
  total: number;
}

const executor = createProcessExecutor<SumPayload, SumResult>({
  worker: new URL("./workers/sum.js", import.meta.url),
  concurrency: 2,
  maxQueue: 20,
  timeoutMs: 10_000,
});

try {
  const result = await executor.run({ values: [10, 20, 30] });
  console.log(result.total);
} finally {
  await executor.close();
}
```

Cada chamada cria um filho novo. A Promise de sucesso resolve somente depois que esse processo e seu canal IPC fecham, garantindo que a tarefa descartável não continue rodando depois da entrega.

## Reutilizar processos com pool

O mesmo worker pode operar em modo reutilizável:

```ts
import { createProcessPool } from "cerne-isolate";

const pool = createProcessPool<SumPayload, SumResult>({
  worker: new URL("./workers/sum.js", import.meta.url),
  concurrency: 4,
  maxQueue: 100,
  timeoutMs: 5_000,
  idleTimeoutMs: 30_000,
  maxJobsPerProcess: 50,
  maxLifetimeMs: 5 * 60_000,
});

try {
  const results = await Promise.all([pool.run({ values: [1, 2, 3] }), pool.run({ values: [4, 5, 6] }), pool.run({ values: [7, 8, 9] })]);

  console.log(results);
} finally {
  await pool.close();
}
```

Os filhos surgem sob demanda e cada um executa uma tarefa por vez. Estado global do módulo pode sobreviver entre tarefas no mesmo processo. Use-o somente como cache descartável: falha, inatividade, limite de jobs, lifetime ou shutdown reciclam o filho.

## Processar lote sem ultrapassar a fila

`maxQueue` é um limite de admissão, não um mecanismo que bloqueia o produtor. Se todas as vagas e a fila estiverem ocupadas, novas chamadas rejeitam imediatamente.

Uma forma simples de manter o número de Promises submetidas sob controle é processar blocos:

```ts
async function runInChunks<Input, Output>(items: Input[], chunkSize: number, run: (item: Input) => Promise<Output>): Promise<Output[]> {
  const output: Output[] = [];

  for (let offset = 0; offset < items.length; offset += chunkSize) {
    const chunk = items.slice(offset, offset + chunkSize);
    output.push(...(await Promise.all(chunk.map(run))));
  }

  return output;
}

const pool = createProcessPool<SumPayload, SumResult>({
  worker: new URL("./workers/sum.js", import.meta.url),
  concurrency: 4,
  maxQueue: 12,
  idleTimeoutMs: 30_000,
});

try {
  const inputs = Array.from({ length: 1_000 }, (_, index) => ({
    values: [index, index + 1],
  }));

  const results = await runInChunks(inputs, 16, (payload) => pool.run(payload));

  console.log(results.length);
} finally {
  await pool.close();
}
```

O bloco de 16 corresponde, neste exemplo, às quatro vagas ativas mais 12 posições de fila. Ajuste os limites com base em CPU, memória, latência e tamanho dos payloads reais.

## Cancelar uma tarefa

```ts
import { createProcessExecutor, ProcessAbortedError } from "cerne-isolate";

interface TaskPayload {
  id: string;
}

interface TaskResult {
  accepted: boolean;
}

const request: TaskPayload = { id: "task-123" };
const executor = createProcessExecutor<TaskPayload, TaskResult>({
  worker: new URL("./workers/task.js", import.meta.url),
  timeoutMs: 60_000,
});

const controller = new AbortController();

try {
  const pending = executor.run(request, { signal: controller.signal });
  controller.abort(new Error("A requisição do cliente terminou."));
  await pending;
} catch (error) {
  if (error instanceof ProcessAbortedError) {
    console.log(error.source);
    console.log(error.cause);
  } else {
    throw error;
  }
} finally {
  await executor.close();
}
```

Se a tarefa ainda estiver na fila, ela é removida sem criar processo. Se estiver ativa, o filho é encerrado e a rejeição só chega depois do `close`. O handler não recebe o `AbortSignal`, e efeitos externos anteriores ao aborto não são desfeitos.

## Aplicar timeout

O timeout é configurado no executor ou pool e vale para cada tarefa depois do despacho:

```ts
import { createProcessExecutor, ProcessTimeoutError } from "cerne-isolate";

interface TaskPayload {
  id: string;
}

interface TaskResult {
  accepted: boolean;
}

const request: TaskPayload = { id: "task-123" };
const executor = createProcessExecutor<TaskPayload, TaskResult>({
  worker: new URL("./workers/task.js", import.meta.url),
  timeoutMs: 2_000,
  killGraceMs: 250,
});

try {
  await executor.run(request);
} catch (error) {
  if (error instanceof ProcessTimeoutError) {
    console.error("Prazo excedido", error.timeoutMs);
  } else {
    throw error;
  }
} finally {
  await executor.close();
}
```

O prazo inclui startup, handshake e handler, mas não a espera na fila. Zero desativa o timeout interno; faça isso somente quando outra camada controla prazo e capacidade.

## Propagar erro do handler

Worker:

```ts
import { defineProcessHandler } from "cerne-isolate/worker";

defineProcessHandler<{ documentId: string }, never>(({ documentId }) => {
  const error = new Error("Documento não pôde ser processado.") as Error & {
    code: string;
  };
  error.code = "INVALID_DOCUMENT";
  error.cause = new RangeError("Conteúdo fora do formato esperado.");
  throw error;
});
```

Processo pai:

```ts
import { createProcessExecutor, ProcessHandlerError } from "cerne-isolate";

const executor = createProcessExecutor<{ documentId: string }, never>({
  worker: new URL("./workers/document.js", import.meta.url),
});

try {
  await executor.run({ documentId: "doc-123" });
} catch (error) {
  if (error instanceof ProcessHandlerError) {
    console.error({
      name: error.remoteError.name,
      code: error.remoteError.code,
      message: error.remoteError.message,
      cause: error.remoteError.cause,
    });
  } else {
    throw error;
  }
} finally {
  await executor.close();
}
```

O erro original não atravessa o IPC como instância. O pai recebe `ProcessHandlerError` e uma descrição serializável, truncada e limitada em profundidade em `remoteError`. Todos os campos preservados podem conter dados sensíveis; revise-os antes de registrar ou expor.

## Tratar falhas por código

```ts
import { ProcessExecutorError } from "cerne-isolate";

function classify(error: unknown): string {
  if (!(error instanceof ProcessExecutorError)) {
    return "Falha de configuração ou da aplicação";
  }

  switch (error.code) {
    case "PROCESS_QUEUE_FULL":
      return "Capacidade temporariamente esgotada";
    case "PROCESS_TIMEOUT":
    case "PROCESS_ABORTED":
      return "Execução interrompida";
    case "PROCESS_EXIT":
      return "Worker encerrou sem resultado";
    case "PROCESS_SERIALIZATION":
      return "Payload, resultado ou erro incompatível com IPC";
    case "PROCESS_HANDLER":
      return "Handler rejeitou a tarefa";
    case "PROCESS_PROTOCOL":
      return "Worker incompatível ou canal IPC violado";
    case "PROCESS_EXECUTOR_CLOSED":
      return "Runtime já está fechando";
  }
}
```

Use `code` e as propriedades estruturadas. Mensagens podem mudar e não devem controlar retry, status HTTP ou alertas.

Erros de opções são `TypeError`, fora da hierarquia de `ProcessExecutorError`.

## Observar o ciclo de vida

```ts
import type { ProcessExecutorEvent } from "cerne-isolate";
import { createProcessPool } from "cerne-isolate";

interface TaskPayload {
  value: string;
}

interface TaskResult {
  value: string;
}

function observe(event: ProcessExecutorEvent): void {
  if (event.type === "start") {
    console.log({
      type: event.type,
      processId: event.processId,
      taskId: event.taskId,
      queuedMs: event.queuedMs,
      reused: event.reused,
    });
  }

  if (event.type === "end") {
    console.log({
      type: event.type,
      taskId: event.taskId,
      outcome: event.outcome,
      durationMs: event.durationMs,
    });
  }

  if (event.type === "recycle") {
    console.log({
      type: event.type,
      processId: event.processId,
      reason: event.reason,
      jobs: event.jobs,
    });
  }
}

const pool = createProcessPool<TaskPayload, TaskResult>({
  worker: new URL("./workers/task.js", import.meta.url),
  concurrency: 2,
  idleTimeoutMs: 30_000,
  onEvent: observe,
});

try {
  await pool.run({ value: "observar" });
} finally {
  await pool.close();
}
```

Os eventos não contêm payload, resultado, caminho do worker ou detalhes do erro. O listener não é aguardado; se precisar persistir telemetria, controle sua própria fila e flush durante o shutdown. Uma exceção ou Promise rejeitada no listener não altera a tarefa.

## Transportar valores estruturados

Worker de eco:

```ts
import { defineProcessHandler } from "cerne-isolate/worker";

defineProcessHandler((payload) => payload);
```

Processo pai:

```ts
import { createProcessExecutor, ProcessSerializationError } from "cerne-isolate";

const payload = {
  id: 9007199254740993n,
  createdAt: new Date("2026-07-28T12:00:00.000Z"),
  pattern: /cerne-(\d+)/gu,
  bytes: Buffer.from([1, 2, 3, 4]),
  samples: new Float64Array([1.5, 2.25]),
  labels: new Set(["a", "b"]),
  values: new Map([["answer", 42]]),
};

const executor = createProcessExecutor<unknown, unknown>({
  worker: new URL("./workers/echo.js", import.meta.url),
});

try {
  const result = await executor.run(payload);
  console.log(result);

  await executor.run({
    callback: () => undefined,
  });
} catch (error) {
  if (error instanceof ProcessSerializationError) {
    console.error(error.code, error.direction);
  } else {
    throw error;
  }
} finally {
  await executor.close();
}
```

O payload é clonado antes de a tarefa entrar no fluxo assíncrono. Alterar `payload` depois de `run` não altera o valor recebido pelo worker. Resultado e request não compartilham referências ou buffers com o pai. A segunda chamada rejeita com `PROCESS_SERIALIZATION` e `direction: "request"` antes do despacho porque funções não são serializáveis.

## Garantir shutdown da aplicação

Mantenha uma única rotina de fechamento e reutilize a Promise idempotente:

```ts
import { createProcessPool } from "cerne-isolate";

interface TaskPayload {
  value: string;
}

interface TaskResult {
  value: string;
}

const pool = createProcessPool<TaskPayload, TaskResult>({
  worker: new URL("./workers/task.js", import.meta.url),
  concurrency: 4,
  idleTimeoutMs: 30_000,
});

async function shutdown(): Promise<void> {
  await pool.close();
}

process.once("SIGTERM", () => {
  void shutdown().then(
    () => {
      process.exitCode = 0;
    },
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
});
```

Esse bloco é a integração de shutdown de uma aplicação mantida viva por outras operações. Ele não força `process.exit()`: o runtime precisa observar o `close` de cada filho. Integre a Promise ao ciclo de vida real da aplicação e pare de submeter trabalho antes ou ao mesmo tempo que inicia o shutdown.

## CommonJS

Worker `dist/workers/sum.cjs`:

```js
const { defineProcessHandler } = require("cerne-isolate/worker");

defineProcessHandler(({ values }) => ({
  total: values.reduce((sum, value) => sum + value, 0),
}));
```

Processo pai:

```js
const path = require("node:path");
const { createProcessExecutor } = require("cerne-isolate");

async function main() {
  const executor = createProcessExecutor({
    worker: path.resolve(__dirname, "workers", "sum.cjs"),
    concurrency: 2,
  });

  try {
    const result = await executor.run({ values: [2, 3, 5] });
    console.log(result.total);
  } finally {
    await executor.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

O exemplo usa `.cjs` para tornar CommonJS explícito; um `.js` também funciona quando o contexto do pacote o resolve como CommonJS. Em ambos os casos, use arquivo físico e caminho absoluto. Não faça deep import de `dist/worker.cjs`; o subpath publicado seleciona o artefato correto.

## Escolher entre executor e pool

Prefira `createProcessExecutor` quando:

- cada tarefa precisa começar com heap e estado de módulo novos;
- dados de tarefas diferentes não devem coexistir no mesmo processo;
- falhas, vazamentos ou mutações globais precisam morrer com a tarefa;
- o custo de startup é aceitável diante do trabalho executado.

Prefira `createProcessPool` quando:

- tarefas são frequentes e o startup do worker é relevante;
- estado residual entre tarefas é aceitável;
- o handler limpa recursos por tarefa;
- `idleTimeoutMs` e as políticas de reciclagem estão definidos para a carga.

Nenhum dos modos executa código hostil com segurança. Se o worker não for confiável, use contenção externa com limites e permissões próprios.
