# Benchmark

Mede o custo de criação, IPC, execução, encerramento e reúso de processos e verifica que uma mudança não alterou os desfechos observáveis dos cenários. Os payloads e workers são sintéticos e determinísticos; nenhum dado de produção é necessário.

O benchmark não é uma suíte de testes unitários nem integra o workflow de CI atual. Ele serve para investigar regressões comportamentais e de desempenho do runtime.

## Uso

O runner importa `dist/index.js` e os workers importam `dist/worker.js`. Gere o build antes:

```bash
npm run build
npm run bench
```

O script `bench` executa `node --expose-gc bench/run.mjs`. Também é possível chamar o runner diretamente:

```bash
node --expose-gc bench/run.mjs
```

Não há gerador de fixtures. Todos os workers necessários estão versionados em `bench/workers/`.

## Opções

| Opção            | Exemplo                 | Função                                                                  |
| ---------------- | ----------------------- | ----------------------------------------------------------------------- |
| `--repeats N`    | `--repeats 3`           | Executa cada caso N vezes e guarda o melhor tempo e o menor pico medido |
| `--filter TEXTO` | `--filter "digest.mjs"` | Seleciona casos cujo `worker [rótulo]` contém o texto                   |
| `--save NOME`    | `--save antes`          | Grava linhas e snapshots em `bench/results/NOME.json`                   |
| `--compare NOME` | `--compare antes`       | Compara a execução com um resultado salvo                               |

Ao usar um script npm, separe os argumentos com `--`:

```bash
npm run bench -- --repeats 3 --filter "pool"
```

## Verificar uma mudança

Grave uma referência com o código de origem e o build correspondentes:

```bash
npm run build
npm run bench -- --repeats 3 --save antes
```

Depois da alteração, gere novamente o build e compare:

```bash
npm run build
npm run bench -- --repeats 3 --compare antes
```

`bench/results/` é um diretório gerado e ignorado pelo repositório. Escolha nomes próprios para a máquina e o cenário. O arquivo `v0.1.0.json` existente é uma referência histórica e não representa automaticamente o comportamento ou o desempenho da versão atual.

## O que a comparação verifica

Cada caso produz um snapshot estável de:

- resultado resolvido ou classe, código e propriedades estruturadas da rejeição;
- sequência de eventos por tarefa;
- outcome terminal;
- forma de encerramento reduzida a limpa ou encerrada;
- estágio de terminação solicitado;
- quantidade agregada de processos e tarefas do pool;
- motivos de reciclagem;
- conteúdo estruturado, com SHA-256 para buffers e views binárias.

Dados instáveis ficam fora do snapshot ou são normalizados:

- PID;
- duração de tarefa e de processo;
- stack de erros;
- caminhos absolutos;
- ordem global entre tarefas concorrentes;
- código/sinal exatos quando basta distinguir saída limpa de encerrada.

Uma diferença de snapshot em caso presente nas duas execuções é marcada como `DIFERENTE` e define código de saída 1. Diferenças apenas de tempo ou memória são mostradas como percentuais, mas não falham o processo. Um caso novo é informado separadamente.

O comparador percorre os casos da execução atual. Um caso existente somente no baseline — por ter sido removido ou renomeado — não é reportado; confira também a lista de casos ao revisar a comparação.

## Interpretar tempo

O tempo de um caso inclui:

- criação do executor ou pool;
- `fork` e handshake dos filhos necessários;
- cópias e IPC;
- execução do handler;
- resposta;
- `close()` e confirmação do encerramento.

No executor descartável, esse é o custo real completo de cada tarefa isolada. No pool, o número mostra quanto do startup é amortizado pelo reúso.

Antes dos casos medidos, o runner aquece a importação e uma execução pequena com `digest.mjs`. Com `--repeats`, a coluna usa o melhor tempo, reduzindo ruído de escalonamento e cold paths ocasionais. Compare na mesma máquina, versão de Node.js e condição de carga; casos curtos podem variar significativamente entre execuções.

O total soma os melhores tempos por caso, não representa uma única execução contínua real.

## Interpretar memória

A coluna de memória mede, por amostragem a cada 10 ms, o aumento do RSS do processo pai sobre uma linha de base coletada depois de tentativas de GC.

Ela não soma diretamente a memória dos processos filhos, que o sistema operacional contabiliza separadamente. Portanto:

- use a coluna para detectar mudanças no custo do pai, da fila, dos snapshots e do IPC;
- não a interprete como memória total do conjunto pai + filhos;
- use medição externa do sistema ou contêiner para capacidade total;
- prefira `--repeats 3` e tendências amplas em vez de pequenas diferenças por caso.

Sem `--expose-gc`, o runner continua funcionando, mas informa que as linhas de base podem ficar menos estáveis. `npm run bench` já inclui a flag.

## Casos

| Grupo              | Workers/cenários                          | Caminho exercitado                                                          |
| ------------------ | ----------------------------------------- | --------------------------------------------------------------------------- |
| Base               | `digest.mjs`, 1 e 8 tarefas               | Fork, handshake, payload pequeno, fila e concorrência 1/2/4                 |
| Fila               | 32 tarefas, concorrência 4                | Ordem FIFO e enfileiramento sustentado                                      |
| IPC grande         | request de 1 MiB e 16 MiB                 | Cópia e envio de payload binário                                            |
| Resultado grande   | `produce.mjs`, 16 MiB                     | Criação, cópia e retorno de Buffer                                          |
| Tipos estruturados | `echo.mjs`                                | `BigInt`, `Date`, `RegExp`, Buffer, typed array, `Map`, `Set` e aninhamento |
| CPU                | `cpu.mjs` com concorrência 1 e 4          | Trabalho síncrono intensivo e paralelismo entre processos                   |
| Timeout            | `hang.mjs`                                | Handler que nunca resolve e encerramento por prazo                          |
| Escalada           | `stubborn.mjs`                            | Handler bloqueante que ignora `SIGTERM` até `SIGKILL`                       |
| Cancelamento       | aborto ativo e na fila                    | Remoção de fila e encerramento de filho                                     |
| Capacidade         | fila cheia                                | `PROCESS_QUEUE_FULL`                                                        |
| Shutdown           | quatro ativos e executor fechado          | Aborto por `close()` e recusa após fechamento                               |
| Handler            | `boom.mjs`                                | `PROCESS_HANDLER`, código e causa remotos                                   |
| Serialização       | `unserializable.mjs` e payload com função | Falha no resultado e no request                                             |
| Startup            | `crash.mjs`                               | Saída antes do handshake                                                    |
| Protocolo          | `rogue.mjs`                               | Mensagem incompatível e `PROCESS_PROTOCOL`                                  |
| Pool               | 8/32 tarefas, concorrência 1/4            | Criação sob demanda, reúso e fila                                           |
| Reciclagem         | máximo de dois jobs                       | `max-jobs` e substituição de processos                                      |

`stubborn.mjs` e `rogue.mjs` possuem limites internos de segurança; `hang.mjs` deliberadamente não resolve. Cada cenário é corrido contra um prazo de observação de quatro segundos e, se não assentar, o snapshot mostra `não assentou`. Esse prazo não cancela a Promise nem os processos subjacentes: uma regressão no encerramento ainda pode manter o runner vivo e exige inspeção/limpeza externa.

## Limitações

- Os tempos dependem do custo de `fork`, do escalonador, do antivírus, do filesystem e da versão do Node.js.
- O benchmark não mede contenção de rede ou disco dentro de handlers de aplicação.
- RSS do pai não representa memória total dos filhos.
- Payloads sintéticos ajudam na repetibilidade, mas não substituem medições com tamanhos e trabalho reais.
- A comparação protege snapshots dos casos existentes; ela não prova ausência de falhas fora dos cenários cobertos.
- Casos presentes somente no baseline são ignorados pelo comparador e precisam de revisão manual.
