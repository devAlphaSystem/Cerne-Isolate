# Instalação e desenvolvimento

## Requisitos

- Node.js 20 ou superior, conforme `engines` do pacote.
- Um runtime Node.js tradicional com suporte e permissão para `child_process.fork`.
- Um arquivo JavaScript executável para cada worker da aplicação.

O CI atual verifica Node.js 20, 22 e 24 sobre Ubuntu. O pacote não é compatível com navegador, Web Worker ou runtimes edge/serverless que proíbam subprocessos.

O Cerne Isolate não exige banco de dados, serviço externo, porta, binário nativo ou variável de ambiente. A biblioteca usa apenas módulos internos do Node.js e não possui dependências externas de runtime. O processo filho, entretanto, herda o ambiente, o diretório de trabalho e as permissões do processo pai; dependências importadas pelo worker pertencem à aplicação consumidora.

## Como dependência

A forma prevista de instalação em outro projeto é:

```bash
npm install cerne-isolate
```

> O lifecycle do tarball atual ainda precisa de validação antes da publicação: `postinstall` chama uma ferramenta presente somente no ambiente de desenvolvimento. Consulte [Validação antes de publicar](#validação-antes-de-publicar).

ESM, no processo pai:

```js
import { createProcessExecutor, createProcessPool } from "cerne-isolate";
```

ESM, no worker:

```js
import { defineProcessHandler } from "cerne-isolate/worker";
```

CommonJS, no processo pai:

```js
const { createProcessExecutor, createProcessPool } = require("cerne-isolate");
```

CommonJS, no worker:

```js
const { defineProcessHandler } = require("cerne-isolate/worker");
```

O manifesto direciona cada export para um artefato próprio:

| Export                 | Consumidor       | JavaScript        | Tipos               |
| ---------------------- | ---------------- | ----------------- | ------------------- |
| `cerne-isolate`        | ESM/import       | `dist/index.js`   | `dist/index.d.ts`   |
| `cerne-isolate`        | CommonJS/require | `dist/index.cjs`  | `dist/index.d.cts`  |
| `cerne-isolate/worker` | ESM/import       | `dist/worker.js`  | `dist/worker.d.ts`  |
| `cerne-isolate/worker` | CommonJS/require | `dist/worker.cjs` | `dist/worker.d.cts` |

Não importe caminhos internos de `dist`. O ponto de entrada raiz é usado pela aplicação; o subpath `/worker` é usado pelo arquivo executado no filho.

O pacote é marcado com `sideEffects: false`. Importar `cerne-isolate` não cria processos; filhos só surgem quando uma tarefa admitida por `run` precisa ser despachada.

## Preparar o arquivo do worker

O valor de `worker` aceita:

- uma string com caminho absoluto; ou
- um objeto `URL` com protocolo `file:`, sem query e sem fragmento.

Em ESM, prefira resolver o arquivo em relação ao módulo compilado:

```js
const executor = createProcessExecutor({
  worker: new URL("./workers/digest.js", import.meta.url),
});
```

Em CommonJS:

```js
const path = require("node:path");

const executor = createProcessExecutor({
  worker: path.resolve(__dirname, "workers", "digest.cjs"),
});
```

O worker precisa ser JavaScript diretamente executável. O filho é criado com `execArgv: []`, portanto os argumentos de `process.execArgv` do pai — inclusive loaders passados na linha de comando — não são propagados. O ambiente continua herdado, inclusive um eventual `NODE_OPTIONS`; não dependa disso para executar TypeScript. Compile o worker e aponte para o `.js` ou `.cjs` gerado.

O arquivo registra um handler exatamente uma vez:

```js
import { defineProcessHandler } from "cerne-isolate/worker";

defineProcessHandler(async (payload) => {
  return processar(payload);
});
```

`defineProcessHandler` exige um processo filho conectado por IPC. Executar o worker diretamente com `node worker.js`, importá-lo no processo pai ou chamá-lo duas vezes termina em erro de configuração.

## Bundlers, contêineres e deploy

`child_process.fork` precisa de um arquivo físico. Um bundler que inclua apenas o código do processo pai não descobre nem embute automaticamente o worker da aplicação.

Na saída de produção:

1. compile o worker para JavaScript;
2. copie o arquivo e suas dependências para o artefato;
3. preserve a relação de caminho usada por `new URL(..., import.meta.url)` ou atualize o caminho absoluto;
4. confirme que o usuário do processo pode ler o arquivo e criar subprocessos;
5. chame `close()` durante o shutdown da aplicação.

Em contêineres, o worker usa o mesmo filesystem, rede, usuário e ambiente do pai. Em plataformas serverless ou edge, confirme que subprocessos são permitidos e que continuam vivos durante toda a invocação. O pacote não substitui limites de CPU/memória, namespaces, seccomp ou isolamento do contêiner.

## Checkout de desenvolvimento

O repositório mantém `package-lock.json`. O fluxo usado pelo CI atual começa com:

```bash
npm install
```

Scripts declarados em `package.json`:

| Script                   | Função                                                                           |
| ------------------------ | -------------------------------------------------------------------------------- |
| `npm run build`          | Gera ESM, CommonJS, tipos e source maps para os pontos de entrada raiz e worker. |
| `npm run typecheck`      | Executa TypeScript em modo estrito sem emitir arquivos.                          |
| `npm run lint`           | Executa ESLint sobre TypeScript e benchmark.                                     |
| `npm run format`         | Reescreve os arquivos com Prettier.                                              |
| `npm run format:check`   | Confere a formatação sem reescrever.                                             |
| `npm run bench`          | Executa o benchmark com GC exposto; exige `dist` atualizado.                     |
| `npm run security:audit` | Audita dependências com severidade mínima `low`.                                 |
| `npm run check`          | Executa typecheck, lint, formatação e build.                                     |
| `npm run prepack`        | Executa `check` antes do empacotamento.                                          |
| `postinstall`            | Reaplica o patch local do Prettier com `patch-package`.                          |

Não há script de teste unitário, servidor, watcher, CLI ou gerador de fixtures. O benchmark é a verificação comportamental e de desempenho disponível no repositório, mas não faz parte do workflow de CI.

## Patch do Prettier

`patches/prettier+3.9.4.patch` altera somente o formatador usado no desenvolvimento. A versão do Prettier permanece fixada em `3.9.4` e o `postinstall` executa `patch-package` depois da instalação do checkout.

O patch não participa do runtime do Cerne Isolate nem muda os artefatos de `dist`. Ao atualizar o Prettier, revise as instruções no cabeçalho do patch e regenere-o; não edite arquivos minificados de `node_modules` como solução permanente.

### Validação antes de publicar

O manifesto atual declara `postinstall: patch-package`, mas `patch-package` está em `devDependencies` e `patches/` não integra a lista `files` do pacote. Portanto, antes de publicar, valide uma instalação limpa do tarball e ajuste o lifecycle de desenvolvimento se necessário. A presença do comando de instalação neste guia descreve a interface pretendida do pacote, não confirma que o tarball atual já passou por essa verificação.

## Artefatos de build e publicação

O build esperado gera:

```text
dist/
  index.js
  index.cjs
  index.d.ts
  index.d.cts
  index.js.map
  index.cjs.map
  worker.js
  worker.cjs
  worker.d.ts
  worker.d.cts
  worker.js.map
  worker.cjs.map
```

`dist/` é ignorado pelo Git, mas entra no pacote publicado. A lista `files` do manifesto inclui:

- `dist`;
- `docs`;
- `README.md`;
- `LICENSE`.

Os guias detalhados são publicados com o pacote. O benchmark, seus workers e o patch do formatador permanecem no repositório. Compile sempre a partir de `src`; não mantenha correções paralelas diretamente nos artefatos gerados.

## CI

`.github/workflows/ci.yml` possui dois jobs:

1. `verify`, em Node.js 20, 22 e 24: instalação, typecheck, lint, conferência de formatação e build;
2. `security`, em Node.js 22: instalação e auditoria de dependências.

O workflow usa permissão `contents: read` e roda em `push` e `pull_request`.

## Problemas comuns

### Versão do Node.js rejeitada

Confirme `node --version` e use Node.js 20 ou superior. O build também tem alvo `node20`.

### Caminho do worker rejeitado

Uma string relativa, string vazia ou URL não `file:` é inválida. Use um caminho absoluto ou `new URL("./worker.js", import.meta.url)`. Query e fragmento não são aceitos.

### `PROCESS_EXIT` na fase `startup`

O arquivo pode estar ausente, não ser JavaScript executável, falhar ao importar uma dependência ou encerrar antes de registrar o handler. Confira `error.phase`, `error.exitCode`, `error.signal` e os logs herdados em `stderr`.

### `dist/` ausente em um checkout

O repositório não versiona os artefatos gerados. Execute o build antes de consumir o checkout ou rodar o benchmark.

### Worker ausente no bundle

Configure o build/deploy da aplicação para copiar o worker compilado e suas dependências. O pacote não transforma uma função do processo pai em worker nem cria arquivo temporário.

### `defineProcessHandler` falha imediatamente

Importe-o de `cerne-isolate/worker` e chame-o somente no processo criado pelo executor ou pool. O processo precisa ter canal IPC ativo, e apenas um handler pode ser registrado.

### Plataforma proíbe subprocessos

O pacote não possui fallback para worker thread, execução inline ou serviço remoto. Use um ambiente Node.js que permita `fork` ou escolha outra arquitetura de execução.

## Referências no checkout

Os caminhos abaixo pertencem ao repositório e não integram o tarball publicado:

- superfície publicada: `src/index.ts` e `src/worker.ts`;
- opções e limites: `src/options.ts`;
- criação do processo: `src/child.ts`;
- build e conteúdo publicado: `package.json`;
- integração contínua: `.github/workflows/ci.yml`.
