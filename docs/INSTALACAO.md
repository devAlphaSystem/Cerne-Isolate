# Instalação e desenvolvimento

## Requisitos

- Node.js 20 ou superior.
- Um worker JavaScript acessível por caminho absoluto ou URL `file:`.

O pacote não possui dependências de runtime nem bibliotecas nativas próprias.

## Instalação no consumidor

```bash
npm install cerne-isolate
```

Em ESM, use os imports mostrados no README. Em CommonJS, os dois subpaths também estão disponíveis:

```js
const { createProcessExecutor } = require("cerne-isolate");
const { defineProcessHandler } = require("cerne-isolate/worker");
```

O arquivo executado por `fork()` precisa ser JavaScript que o Node instalado consiga carregar. Se o projeto consumidor escreve workers em TypeScript, compile-os junto com o restante da aplicação e aponte o executor para o arquivo gerado.

## Desenvolvimento do pacote

Depois de instalar as dependências de desenvolvimento, os scripts declarados são:

| Script                 | Finalidade                                         |
| ---------------------- | -------------------------------------------------- |
| `npm run typecheck`    | Verifica TypeScript sem emitir arquivos.           |
| `npm run lint`         | Verifica os arquivos-fonte.                        |
| `npm run format:check` | Confere formatação.                                |
| `npm run build`        | Gera ESM, CommonJS, tipos e source maps em `dist`. |
| `npm run bench`        | Mede os casos do benchmark com GC exposto.         |
| `npm run check`        | Executa o fluxo completo na ordem correta.         |

O benchmark roda sobre `dist`, então exige `npm run build` antes. Ele mede o
custo de cada caminho terminal do executor e compara o resultado com uma execução
salva, o que o torna a verificação de regressão disponível no repositório.
Consulte [bench/README.md](../bench/README.md).

## Distribuição

O pacote publica:

- `dist/index.js`, `dist/index.cjs` e declarações para `cerne-isolate`;
- `dist/worker.js`, `dist/worker.cjs` e declarações para `cerne-isolate/worker`;
- README, documentação e licença.

Não publique fontes de handlers da aplicação consumidora dentro deste pacote.
