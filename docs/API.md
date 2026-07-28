# Referência da API

## Importação

Processo pai, ESM:

```ts
import { createProcessExecutor, createProcessPool, ProcessAbortedError, ProcessExecutorError, ProcessHandlerError, ProcessQueueFullError, ProcessTimeoutError } from "cerne-isolate";
```

Processo pai, CommonJS:

```js
const { createProcessExecutor, createProcessPool, ProcessExecutorError } = require("cerne-isolate");
```

Worker, ESM:

```ts
import { defineProcessHandler } from "cerne-isolate/worker";
import type { ProcessHandler } from "cerne-isolate/worker";
```

Worker, CommonJS:

```js
const { defineProcessHandler } = require("cerne-isolate/worker");
```

A superfície pública do pai é definida em `src/index.ts`. O registro do handler vive no export separado `src/worker.ts`. Esses caminhos pertencem ao checkout e não ao tarball publicado. Runtime, processo gerenciado e protocolo são detalhes internos e não devem ser importados por caminhos de `dist`.

## Modelo de execução

O Cerne Isolate separa a aplicação em dois papéis:

1. o processo pai cria um executor ou pool com um caminho de worker escolhido pela aplicação;
2. o processo filho importa `cerne-isolate/worker` e registra exatamente um handler;
3. cada `run(payload)` envia uma cópia serializada do payload;
4. o handler resolve um resultado ou lança uma falha;
5. o runtime entrega o primeiro desfecho, aplica a política de reúso/encerramento e mantém os limites de capacidade.

Existem dois contratos de ciclo de vida:

| Modo         | Criação                              | Reúso                    | Resolução de sucesso                      |
| ------------ | ------------------------------------ | ------------------------ | ----------------------------------------- |
| `disposable` | Um filho por tarefa                  | Nunca                    | Depois que o filho e o IPC emitem `close` |
| `reusable`   | Filhos sob demanda até `concurrency` | Após tarefa bem-sucedida | Assim que o resultado válido chega        |

Em ambos os modos, uma falha pertencente a um processo ativo só é rejeitada para o chamador depois que o encerramento desse filho foi confirmado por `close`. Um processo ainda fechando continua ocupando sua vaga de concorrência.

## `createProcessExecutor`

```ts
function createProcessExecutor<Payload = unknown, Result = unknown>(options: ProcessExecutorOptions): ProcessExecutor<Payload, Result>;
```

Cria um executor limitado que usa um processo descartável por tarefa:

```ts
const executor = createProcessExecutor<Input, Output>({
  worker: new URL("./workers/task.js", import.meta.url),
  concurrency: 2,
  maxQueue: 100,
  timeoutMs: 30_000,
});
```

O processo é criado somente quando uma tarefa pode ser despachada. Depois do primeiro resultado, erro ou encerramento, ele nunca recebe outra tarefa.

## `createProcessPool`

```ts
function createProcessPool<Payload = unknown, Result = unknown>(options: ProcessPoolOptions): ProcessPool<Payload, Result>;
```

Cria um pool limitado de processos reutilizáveis:

```ts
const pool = createProcessPool<Input, Output>({
  worker: new URL("./workers/task.js", import.meta.url),
  concurrency: 4,
  maxQueue: 500,
  timeoutMs: 20_000,
  idleTimeoutMs: 30_000,
  maxJobsPerProcess: 50,
  maxLifetimeMs: 10 * 60_000,
});
```

Os filhos são criados sob demanda. Cada filho executa somente uma tarefa por vez, e processos ociosos são reutilizados antes da criação de outro. Qualquer falha retira o processo da rotação. Estado global, caches e módulos carregados podem persistir entre sucessos, mas nunca devem ser tratados como armazenamento durável porque a reciclagem pode acontecer a qualquer momento permitido pela política.

## Opções comuns

`ProcessExecutorOptions` configura os dois modos:

| Opção         | Tipo                   |      Padrão | Faixa/contrato                                      | Significado                                         |
| ------------- | ---------------------- | ----------: | --------------------------------------------------- | --------------------------------------------------- |
| `worker`      | `string \| URL`        | obrigatória | Caminho absoluto ou `file: URL` sem query/fragmento | Arquivo JavaScript selecionado por código confiável |
| `concurrency` | `number`               |           1 | inteiro de 1 a 1.024                                | Máximo de filhos que ainda não emitiram `close`     |
| `maxQueue`    | `number`               |         100 | inteiro de 0 a 1.000.000                            | Máximo de tarefas aguardando; não inclui ativas     |
| `timeoutMs`   | `number`               |      60.000 | inteiro de 0 a 2.147.483.647                        | Prazo de cada tarefa despachada; zero desativa      |
| `killGraceMs` | `number`               |         250 | inteiro de 0 a 60.000                               | Intervalo entre etapas de encerramento              |
| `onEvent`     | `ProcessEventListener` |     ausente | função                                              | Observação de ciclo de vida sem dados da tarefa     |

Configuração inválida lança `TypeError` de forma síncrona na criação. Para `worker`:

- uma string precisa ser absoluta;
- uma string `file:///...` não substitui um objeto `URL`;
- um objeto `URL` precisa usar `file:`;
- query e fragmento são rejeitados;
- a biblioteca não testa a existência do arquivo durante a validação; falhas de criação/carregamento aparecem como `PROCESS_EXIT`.

### Timeout

O timer começa no despacho para um processo novo ou reutilizado. Ele inclui startup, handshake, envio, handler e retorno, mas exclui a espera na fila.

Quando o prazo vence:

1. a tarefa recebe desfecho `PROCESS_TIMEOUT`;
2. o filho é retirado de uso;
3. o runtime solicita encerramento imediato;
4. a Promise rejeita somente depois do `close` confirmado.

Timeout encerra o processo; não existe cancelamento cooperativo dentro do handler.

### Escalada de encerramento

Encerramentos naturais ou cooperativos recebem até `killGraceMs` antes de `SIGTERM` e mais um intervalo antes de `SIGKILL`. Timeout, aborto ativo e falhas que exigem interrupção começam em `SIGTERM` e escalam para `SIGKILL` depois do intervalo.

O evento `close` informa a ação mais forte solicitada em `termination`. A biblioteca continua aguardando o evento real do processo em vez de considerar o retorno de `kill()` como confirmação.

## Opções exclusivas do pool

`ProcessPoolOptions` estende as opções comuns:

| Opção               | Tipo     |      Padrão | Faixa/contrato               | Significado                                             |
| ------------------- | -------- | ----------: | ---------------------------- | ------------------------------------------------------- |
| `idleTimeoutMs`     | `number` | obrigatória | inteiro de 1 a 2.147.483.647 | Recicla um filho após esse tempo sem trabalho           |
| `maxJobsPerProcess` | `number` |          10 | inteiro de 0 a 1.000.000     | Recicla após esta quantidade de sucessos; zero desativa |
| `maxLifetimeMs`     | `number` |     600.000 | inteiro de 0 a 2.147.483.647 | Recicla após este tempo de vida; zero desativa          |

`idleTimeoutMs` é obrigatório para impedir que um pool sem trabalho mantenha filhos indefinidamente.

`maxLifetimeMs` nunca interrompe uma tarefa saudável. Se o prazo for alcançado durante a execução, o processo conclui a tarefa e é reciclado antes de voltar à rotação. O limite de jobs também é conferido depois de cada sucesso.

## Interface do executor

Executor e pool expõem a mesma interface:

```ts
interface ProcessExecutor<Payload, Result> {
  run(payload: Payload, options?: ProcessRunOptions): Promise<Result>;
  close(): Promise<void>;
}
```

`ProcessPool<Payload, Result>` é um alias dessa superfície, permitindo trocar o modo sem mudar o código que chama `run` e `close`.

## `run(payload, options)`

Admite uma tarefa ou devolve uma Promise rejeitada:

```ts
interface ProcessRunOptions {
  signal?: AbortSignal;
}

const result = await executor.run(payload, { signal });
```

O fluxo de admissão é:

1. confirmar que o runtime está aberto;
2. validar as opções e o `AbortSignal`;
3. rejeitar sinal já abortado;
4. conferir capacidade imediata ou espaço na fila;
5. criar um snapshot serializável do payload;
6. despachar ou adicionar a tarefa ao fim da fila FIFO.

Mutações no objeto original depois de `run` não alteram o snapshot. Tipos TypeScript descrevem o contrato, mas não validam o schema do payload em runtime.

### Capacidade e fila

Se houver um processo ocioso ou uma vaga abaixo de `concurrency`, a tarefa começa imediatamente. Caso contrário:

- ela aguarda se `queue.length < maxQueue`;
- rejeita com `ProcessQueueFullError` se a fila já estiver no limite;
- pode ser removida da fila por seu sinal;
- não consome `timeoutMs` enquanto espera.

Submeter muitas Promises de uma vez não expande a capacidade: chamadas acima de `concurrency + maxQueue` podem rejeitar imediatamente. A vaga só volta a existir quando o processo anterior emite `close` ou, no pool, quando um sucesso libera um filho saudável.

### Cancelamento

Um `AbortSignal` nativo pode cancelar a tarefa:

| Momento           | Efeito                                                 |
| ----------------- | ------------------------------------------------------ |
| Antes da admissão | Rejeita com `PROCESS_ABORTED` sem clonar ou enfileirar |
| Enquanto aguarda  | Remove da fila e rejeita sem criar processo            |
| Enquanto executa  | Encerra o filho e rejeita depois do `close`            |

`ProcessAbortedError.source` é `signal`. Se `signal.reason` existe, ele é preservado como `cause` do erro local.

O sinal não é enviado ao handler. Operações externas concluídas pelo worker — gravações, requisições ou alterações em outros sistemas — não são revertidas pelo encerramento do processo.

### Resultado

O handler pode devolver um valor ou `PromiseLike<Result>`. O resultado resolvido precisa ser serializável.

- No executor descartável, o resultado só resolve para o chamador depois que o filho encerra e o IPC fecha.
- No pool, o resultado resolve assim que a mensagem válida chega; o filho é então reutilizado ou reciclado.

Uma mensagem atrasada depois de um timeout/aborto não substitui o primeiro desfecho já registrado.

## `close()`

```ts
await executor.close();
```

Na primeira chamada, `close`:

1. muda o runtime para `closing` e impede novas admissões;
2. rejeita toda a fila com `ProcessAbortedError("shutdown")`;
3. reivindica o mesmo desfecho para tarefas ativas ainda sem desfecho e preserva qualquer primeiro desfecho já registrado;
4. remove processos do pool da rotação;
5. solicita encerramento e aguarda todos os eventos `close`;
6. resolve quando não restam filhos nem tarefas ativas.

Chamadas seguintes devolvem a mesma Promise. Uma chamada posterior de `run` rejeita com `ProcessExecutorClosedError`.

Use `close` em `finally`:

```ts
const pool = createProcessPool<Payload, Result>(options);

try {
  await processar(pool);
} finally {
  await pool.close();
}
```

## `defineProcessHandler`

```ts
function defineProcessHandler<Payload = unknown, Result = unknown>(handler: ProcessHandler<Payload, Result>): void;

type ProcessHandler<Payload, Result> = (payload: Payload) => Result | PromiseLike<Result>;
```

O handler deve ser registrado uma única vez no arquivo do worker:

```ts
import { defineProcessHandler } from "cerne-isolate/worker";

defineProcessHandler<{ value: string }, { value: string }>(async ({ value }) => ({ value: value.trim() }));
```

Durante o registro, o worker:

- exige um canal IPC conectado;
- instala o listener do protocolo;
- anuncia suporte aos modos descartável e reutilizável;
- recusa mensagens inválidas, tarefas simultâneas, IDs regressivos e mudança de modo;
- executa no máximo um handler por vez;
- encerra após a resposta no modo descartável;
- permanece disponível após sucesso no modo reutilizável;
- encerra em qualquer falha, desconexão ou pedido de shutdown.

Não use `process.send` para trocar mensagens próprias no mesmo canal e não instale outro protocolo concorrente. `stdout` e `stderr` são herdados e podem ser usados para logs, desde que a aplicação trate conteúdo sensível de forma adequada.

## IPC e serialização

O processo é criado com `serialization: "advanced"`. Antes do IPC, a biblioteca também usa `node:v8` para validar e clonar o request no pai e o resultado no worker.

O serializador V8 usado pela biblioteca aceita, entre outros:

- primitivos, inclusive `BigInt` e `undefined`;
- objetos e arrays;
- `Buffer`, `ArrayBuffer` e typed arrays;
- `Date` e `RegExp`;
- `Map` e `Set`.

O suporte efetivo segue a serialização V8 do Node.js usado pela aplicação. O benchmark atual exercita explicitamente `BigInt`, `Date`, `RegExp`, `Buffer`, `Float64Array`, `Map`, `Set`, objetos e arrays; `undefined` e `ArrayBuffer` pertencem ao contrato do serializador, mas não possuem caso dedicado no cenário estruturado atual. Funções, símbolos como valores e outras estruturas não serializáveis falham. A API não oferece transfer list, referência compartilhada ou execução por ponteiro; payload e resultado atravessam cópias.

| Direção   | Momento da validação                            | Falha pública                                      |
| --------- | ----------------------------------------------- | -------------------------------------------------- |
| `request` | Antes da fila e também no envio IPC             | `PROCESS_SERIALIZATION` com `direction: "request"` |
| `result`  | No worker, antes da resposta                    | `PROCESS_SERIALIZATION` com `direction: "result"`  |
| `error`   | Ao preparar a representação de uma falha remota | `PROCESS_SERIALIZATION` com `direction: "error"`   |

O custo cresce com o tamanho do valor e com o número de cópias. Para payloads grandes, meça latência e memória com dados representativos; o benchmark inclui request e response de 16 MiB.

### Erros do handler

Erros lançados pelo handler são convertidos para:

```ts
interface SerializedProcessError {
  name: string;
  message: string;
  stack?: string;
  code?: string | number;
  cause?: SerializedProcessError;
}
```

Campos são copiados defensivamente, truncados e limitados em profundidade. Valores lançados que não são instâncias de `Error` também viram uma descrição serializável.

O pai rejeita com `ProcessHandlerError`:

```ts
try {
  await executor.run(payload);
} catch (error) {
  if (error instanceof ProcessHandlerError) {
    console.error(error.remoteError.name);
    console.error(error.remoteError.code);
  }
}
```

A classe, o prototype e propriedades arbitrárias do erro original não atravessam o processo. Os campos preservados — inclusive `message`, `stack`, `code` e `cause` — ainda podem conter caminhos, identificadores ou dados sensíveis; avalie privacidade antes de registrá-los ou expô-los.

## Erros públicos

Todas as falhas operacionais abaixo herdam de `ProcessExecutorError` e expõem um `code` estável:

| Classe                       | Código                    | Propriedades adicionais       | Origem típica                               |
| ---------------------------- | ------------------------- | ----------------------------- | ------------------------------------------- |
| `ProcessTimeoutError`        | `PROCESS_TIMEOUT`         | `timeoutMs`                   | Tarefa despachada excedeu o prazo           |
| `ProcessAbortedError`        | `PROCESS_ABORTED`         | `source`                      | Sinal do chamador ou shutdown               |
| `ProcessExitError`           | `PROCESS_EXIT`            | `exitCode`, `signal`, `phase` | Filho encerrou sem resultado                |
| `ProcessQueueFullError`      | `PROCESS_QUEUE_FULL`      | `maxQueue`                    | Capacidade e fila esgotadas                 |
| `ProcessSerializationError`  | `PROCESS_SERIALIZATION`   | `direction`                   | Request, resultado ou erro não serializável |
| `ProcessHandlerError`        | `PROCESS_HANDLER`         | `remoteError`                 | Handler lançou/rejeitou                     |
| `ProcessProtocolError`       | `PROCESS_PROTOCOL`        | —                             | Worker violou o protocolo                   |
| `ProcessExecutorClosedError` | `PROCESS_EXECUTOR_CLOSED` | —                             | Nova tarefa depois do início do fechamento  |

Tipos auxiliares:

```ts
type ProcessAbortSource = "signal" | "shutdown";
type ProcessExitPhase = "startup" | "execution";
type ProcessSerializationDirection = "request" | "result" | "error";
```

Erros de configuração não usam essa hierarquia:

- opções inválidas de `createProcessExecutor` ou `createProcessPool` lançam `TypeError`;
- opções inválidas de `run` rejeitam a Promise com `TypeError`.

Automação deve depender de `error.code` e das propriedades estruturadas, não do texto da mensagem.

## Eventos de ciclo de vida

`onEvent` recebe um objeto congelado. O listener pode devolver `void` ou `PromiseLike<void>`, mas a execução não aguarda essa Promise. Exceções e rejeições do listener são ignoradas para que observabilidade nunca altere admissão, resultado ou limpeza.

| Evento    | Modos | Campos                                                                                       | Momento                                                           |
| --------- | ----- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `spawn`   | pool  | `processId`, `pid`                                                                           | Filho reutilizável criado                                         |
| `start`   | ambos | `processId`, `taskId`, `pid`, `queuedMs`, `reused`                                           | Tarefa associada a um filho, antes do handshake quando ele é novo |
| `end`     | ambos | `processId`, `taskId`, `outcome`, `durationMs`                                               | Primeiro desfecho terminal da tarefa                              |
| `idle`    | pool  | `processId`, `pid`, `jobs`                                                                   | Filho saudável ficou disponível sem fila imediata                 |
| `recycle` | pool  | `processId`, `pid`, `reason`, `jobs`                                                         | Filho saiu da rotação                                             |
| `close`   | ambos | `processId`, `taskId`, `pid`, `exitCode`, `signal`, `termination`, `totalDurationMs`, `jobs` | Processo e IPC fecharam                                           |

Detalhes:

- `processId` e `taskId` são identificadores locais crescentes do runtime.
- `pid` pode ser `null` se o sistema não o disponibilizou.
- `queuedMs` mede da admissão até o despacho.
- `durationMs` mede do despacho até o primeiro desfecho e inclui startup.
- `outcome` é `success` ou um `ProcessErrorCode`.
- `jobs` registra sucessos reutilizáveis do pool; no evento `close` de um executor descartável, o valor permanece zero.
- `taskId` em `close` é `null` quando um processo do pool fecha ocioso ou depois de ser reciclado sem possuir tarefa.
- `totalDurationMs` mede a vida do processo desde o `fork`.

Eventos não incluem payload, resultado, caminho do worker ou detalhes da falha. Ainda assim, PID e métricas podem ser dados operacionais sensíveis em alguns ambientes.

Execuções concorrentes podem intercalar eventos; não dependa de uma ordem global entre tarefas diferentes.

### Encerramento observado

`ProcessTerminationStage` identifica a ação mais forte solicitada:

| Valor     | Significado                                                     |
| --------- | --------------------------------------------------------------- |
| `natural` | Saída natural/cooperativa, sem sinal de encerramento solicitado |
| `sigterm` | O runtime solicitou `SIGTERM`                                   |
| `sigkill` | A escalada alcançou `SIGKILL`                                   |

O campo descreve a ação do runtime, enquanto `exitCode` e `signal` descrevem o fechamento observado.

### Motivos de reciclagem

`ProcessRecycleReason`:

| Valor          | Condição                            |
| -------------- | ----------------------------------- |
| `failure`      | Tarefa ou protocolo falhou          |
| `max-jobs`     | `maxJobsPerProcess` foi alcançado   |
| `max-lifetime` | `maxLifetimeMs` foi alcançado       |
| `idle`         | `idleTimeoutMs` venceu sem trabalho |
| `shutdown`     | O chamador fechou o pool            |

## Segurança e limites de isolamento

O Cerne Isolate isola ciclo de vida e memória de heap entre processos, mas não cria uma fronteira de autorização:

- o filho usa o mesmo usuário e as mesmas permissões do pai;
- ambiente, secrets, filesystem e rede continuam acessíveis ao worker;
- `stdout` e `stderr` do filho são herdados;
- stdin é ignorado;
- não há limite interno de CPU ou memória;
- não há seccomp, namespace, contêiner, VM ou allowlist de módulos;
- timeout e cancelamento não desfazem efeitos externos;
- o caminho do worker é fixo, mas o conteúdo desse arquivo continua sendo código com todos os privilégios da aplicação.

Use workers selecionados por código confiável. Para código hostil ou multi-tenant que exige uma fronteira de segurança, aplique isolamento externo apropriado. Quando tarefas não devem compartilhar estado, prefira o executor descartável; o pool conserva memória e módulos entre sucessos até a reciclagem.

## Tipos exportados

O ponto de entrada raiz exporta:

- `ProcessAbortSource`;
- `ProcessCloseEvent`;
- `ProcessEndEvent`;
- `ProcessErrorCode`;
- `ProcessEventListener`;
- `ProcessExecutionMode`;
- `ProcessExecutor`;
- `ProcessExecutorEvent`;
- `ProcessExecutorOptions`;
- `ProcessExitPhase`;
- `ProcessIdleEvent`;
- `ProcessPool`;
- `ProcessPoolOptions`;
- `ProcessRecycleEvent`;
- `ProcessRecycleReason`;
- `ProcessRunOptions`;
- `ProcessSerializationDirection`;
- `ProcessSpawnEvent`;
- `ProcessStartEvent`;
- `ProcessTerminationStage`;
- `SerializedProcessError`.

O subpath `cerne-isolate/worker` exporta o tipo `ProcessHandler`.

## Referências no checkout

Os caminhos abaixo pertencem ao repositório e não integram o tarball publicado:

- superfície pública: `src/index.ts`;
- contratos e eventos: `src/types.ts`;
- defaults e faixas: `src/options.ts`;
- erros públicos: `src/errors.ts`;
- registro do handler: `src/worker.ts`;
- admissão e ciclo de vida: `src/runtime.ts`;
- processo e sinais: `src/child.ts`;
- protocolo e serialização: `src/protocol.ts`.
