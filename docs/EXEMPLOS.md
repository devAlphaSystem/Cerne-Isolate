# Exemplos

## Contrato compartilhado

```ts
// heavy-contract.ts
export interface HeavyPayload {
  filePath: string;
  options: {
    quality: number;
  };
}

export interface HeavyResult {
  outputPath: string;
  durationMs: number;
}
```

## Worker da aplicação

```ts
// heavy-worker.ts, compilado para JavaScript antes da execução
import { defineProcessHandler } from "cerne-isolate/worker";

import type { HeavyPayload, HeavyResult } from "./heavy-contract";
import { convertDocument } from "./convert-document";

defineProcessHandler<HeavyPayload, HeavyResult>((payload) => {
  return convertDocument(payload.filePath, payload.options);
});
```

O nome da operação e o caminho do módulo não vêm de uma requisição externa. O arquivo do worker é escolhido no bootstrap da aplicação; o payload contém apenas dados do trabalho.

## Executor compartilhado

```ts
// heavy-executor.ts
import { createProcessExecutor } from "cerne-isolate";

import type { HeavyPayload, HeavyResult } from "./heavy-contract";

export const heavyExecutor = createProcessExecutor<HeavyPayload, HeavyResult>({
  worker: new URL("./heavy-worker.js", import.meta.url),
  concurrency: 2,
  maxQueue: 10,
  timeoutMs: 60_000,
});
```

## Execução cancelável

```ts
const controller = new AbortController();

const resultPromise = heavyExecutor.run(
  {
    filePath: "/tmp/source.pdf",
    options: { quality: 80 },
  },
  { signal: controller.signal },
);

request.once("close", () => controller.abort());

const result = await resultPromise;
```

## Tratamento de erros

```ts
import { ProcessAbortedError, ProcessHandlerError, ProcessQueueFullError, ProcessTimeoutError } from "cerne-isolate";

try {
  await heavyExecutor.run(payload, { signal });
} catch (error) {
  if (error instanceof ProcessQueueFullError) {
    response.status(503).end();
  } else if (error instanceof ProcessTimeoutError) {
    response.status(504).end();
  } else if (error instanceof ProcessAbortedError) {
    return;
  } else if (error instanceof ProcessHandlerError) {
    logger.error({ remote: error.remoteError }, "Heavy worker failed");
  } else {
    throw error;
  }
}
```

## Buffer estruturável

```ts
interface BufferPayload {
  bytes: Buffer;
}

const executor = createProcessExecutor<BufferPayload, Buffer>({
  worker: new URL("./buffer-worker.js", import.meta.url),
  maxQueue: 4,
});

const output = await executor.run({ bytes: inputBuffer });
```

Buffers atravessam o IPC por cópia. Para arquivos grandes, a aplicação normalmente reduz memória e custo de serialização enviando um caminho ou uma chave de armazenamento. Essa decisão permanece fora do pacote.

## Shutdown

```ts
async function shutdown() {
  await heavyExecutor.close();
}

process.once("SIGTERM", () => {
  void shutdown();
});
```

A aplicação deve aguardar `close()` antes de terminar o processo principal quando tiver oportunidade de executar shutdown cooperativo.
