# Referência da API

## `createProcessExecutor<Payload, Result>(options)`

Cria um executor com worker fixo e fila FIFO limitada.

### Opções

| Opção         | Tipo                                   |      Padrão | Contrato                                                             |
| ------------- | -------------------------------------- | ----------: | -------------------------------------------------------------------- |
| `worker`      | `string \| URL`                        | obrigatória | Caminho absoluto ou URL `file:` sem query ou fragmento.              |
| `concurrency` | `number`                               |         `1` | Filhos simultâneos ainda sem `close`, entre 1 e 1024.                |
| `maxQueue`    | `number`                               |       `100` | Tarefas aguardando, entre 0 e 1.000.000.                             |
| `timeoutMs`   | `number`                               |     `60000` | Prazo por tarefa despachada; zero desabilita.                        |
| `killGraceMs` | `number`                               |       `250` | Janela entre saída natural, `SIGTERM` e `SIGKILL`, de 0 a 60.000 ms. |
| `onEvent`     | `(event) => void \| PromiseLike<void>` |     ausente | Listener de telemetria sem dados do trabalho.                        |

O worker não é recebido em `run()` nem no payload. `fork()` é chamado com serialização avançada, entrada padrão ignorada, saída e erro herdados, canal IPC, `detached: false` e sem herdar `process.execArgv`. O pacote não usa shell.

### `executor.run(payload, { signal? })`

Executa imediatamente quando há capacidade ou entra na fila. A Promise:

- resolve com o resultado do handler após o filho emitir `close`;
- rejeita com erro tipado após `close` quando um filho chegou a ser criado;
- pode rejeitar sem criar filho para aborto prévio, fila cheia, executor fechado, opções inválidas ou payload não serializável.

O timeout começa quando a tarefa deixa a fila. Uma tarefa aguardando pode ser cancelada pelo sinal sem consumir processo.

Antes da fila, o executor cria um snapshot estruturável do payload. A operação é síncrona, não faz parte do timeout do filho e impede mudanças posteriores ou getters repetidos entre validação e envio.

### `executor.close()`

Retorna sempre a mesma Promise. A primeira chamada muda o estado para fechamento de forma síncrona, recusa novas tarefas, rejeita a fila com `ProcessAbortedError` de source `shutdown`, encerra filhos ativos e aguarda todos os eventos `close`.

Se um resultado já venceu a corrida antes de `close()` começar, ele permanece o resultado da tarefa; o shutdown apenas acelera a terminação ainda pendente.

## `defineProcessHandler<Payload, Result>(handler)`

Disponível em `cerne-isolate/worker`. Deve ser chamado exatamente uma vez no arquivo executado pelo filho.

O subpath:

1. registra o listener antes de anunciar `ready`;
2. aceita exatamente uma mensagem `run` do protocolo atual;
3. aguarda o handler;
4. valida a serialização do resultado ou converte o erro para um DTO seguro;
5. envia uma resposta, drena o IPC e encerra o processo mesmo que o handler tenha deixado handles referenciados.

Se o processo principal desconectar o IPC, o worker solicita saída imediata. Esse mecanismo depende do event loop do filho continuar responsivo.

## Serialização

A serialização avançada do Node é baseada no mecanismo V8 de structured clone. Valores usuais suportados incluem:

- primitivos, objetos e arrays;
- `Buffer`, `ArrayBuffer`, `Uint8Array` e outras typed arrays;
- `Map`, `Set`, `Date`, `RegExp` e `BigInt`;
- referências circulares estruturáveis.

Funções, símbolos, streams e objetos nativos sem representação structured-clone não são aceitos. O pacote não cria codecs ou fallbacks JSON, pois isso mudaria silenciosamente tipos e semântica.

## Ordem terminal

Resultado, erro do handler, falha de serialização, timeout, aborto, violação do protocolo, falha de lifecycle e shutdown disputam um único outcome. O primeiro evento observado vence. Eventos posteriores não mudam a Promise e servem apenas para completar a limpeza até `close`.

## Erros

### `ProcessTimeoutError`

Propriedades adicionais: `timeoutMs`.

### `ProcessAbortedError`

Propriedade adicional: `source`, com `signal` ou `shutdown`. O motivo original do `AbortSignal`, quando existe, é preservado em `cause`, mas nunca é copiado para eventos.

### `ProcessExitError`

Propriedades adicionais: `exitCode`, `signal` e `phase` (`startup` ou `execution`). Código zero sem resposta também é falha de saída.

### `ProcessQueueFullError`

Propriedade adicional: `maxQueue`.

### `ProcessSerializationError`

Propriedade adicional: `direction` (`request`, `result` ou `error`).

### `ProcessHandlerError`

Propriedade adicional: `remoteError`, um `SerializedProcessError` recursivo e limitado. Campos customizados arbitrários não são copiados; somente `name`, `message`, `stack`, `code` string/number e `cause` são considerados.

### `ProcessProtocolError`

Indica mensagem inválida, duplicada, fora de ordem, com versão incorreta ou com task ID inesperado.

### `ProcessExecutorClosedError`

Indica admissão tentada durante ou depois de `close()`.

## Eventos

`ProcessExecutorEvent` é a união discriminada:

- `start`: `taskId`, `pid`, `queuedMs`;
- `end`: `taskId`, `outcome`, `durationMs`;
- `close`: `taskId`, `pid`, `exitCode`, `signal`, `termination`, `totalDurationMs`.

`termination` informa a ação mais forte solicitada pelo executor, não atribui causalidade ao sinal. `natural` inclui o encerramento cooperativo feito pelo subpath worker.

Em aplicações que misturam `import` e `require` no mesmo processo, compare o campo literal `code` ao atravessar a fronteira entre os dois loaders. Como em outros pacotes dual ESM/CommonJS, cada loader possui sua própria identidade de classe e um `instanceof` cruzado não é portátil.
