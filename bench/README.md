# Benchmark

Mede o custo de executar tarefas em processos descartáveis e verifica que uma
mudança não alterou o resultado observável do executor. Os workers são
determinísticos e não dependem de rede, disco ou de qualquer entrada privada.

## Uso

```bash
npm run build
npm run bench
```

Diferente dos outros pacotes do Cerne, aqui não há gerador de fixtures: as
fixtures deste benchmark são workers, e código-fonte fica versionado em
`bench/workers/`. O que o benchmark precisa é do `dist/`, porque os workers
importam `dist/worker.js` e o runner importa `dist/index.js` — é a biblioteca
compilada que está sendo medida, não `src/`.

## Verificando uma otimização

Grave a execução de referência antes de mexer em `src/`, e confronte depois:

```bash
git stash && npm run build && npm run bench -- --repeats 3 --save antes
git stash pop && npm run build && npm run bench -- --repeats 3 --compare antes
```

A comparação confronta, para cada caso, o resultado de cada `run()` na ordem de
submissão — status, classe, `code`, mensagem, `source`, `phase`, `direction`,
`exitCode`, `signal`, `timeoutMs`, `maxQueue`, `remoteError` e o digest SHA-256
do valor devolvido — e o ciclo de vida de cada tarefa: quais eventos ela emitiu,
o `outcome` do `end`, o estágio de encerramento e se o filho saiu limpo. Qualquer
divergência em um caso presente nas duas execuções é listada e o processo sai com
código 1, então a comparação serve em CI.

Ficam de fora do snapshot, por variarem entre execuções sem que o comportamento
mude: as durações (`queuedMs`, `durationMs`, `totalDurationMs`), o PID, o stack
das exceções e o código de saída numérico do filho — este último entra apenas
como `limpo` ou `encerrado`.

A ordem entre tarefas concorrentes também fica de fora: os eventos são agrupados
por tarefa antes da comparação, já que qual dos quatro filhos fica pronto
primeiro é decisão do escalonador do sistema. A sequência dentro de uma tarefa,
essa sim, é confrontada.

## Interpretando os números

O tempo de cada caso é o melhor de `--repeats`, medido do `createProcessExecutor`
até o `close()` confirmado. Ele é dominado pelo `fork` e pelo startup do Node no
filho: uma tarefa trivial custa dezenas de milissegundos, e quase tudo isso é
processo, não biblioteca. É por isso que os casos de CPU existem — eles mostram
quanto do tempo total some quando o handler tem trabalho de verdade.

A variação entre execuções é baixa para um benchmark, porque o custo medido é de
processo e não de cálculo: duas execuções seguidas ficam dentro de 5% em quase
todos os casos. Ainda assim, use `--repeats 3` e leve a sério só diferenças acima
de ~15%, ou o total da suíte. A saída, ao contrário do tempo, é determinística —
uma divergência ali é sempre real.

A coluna de memória é o pico de RSS **do processo pai**, medido por amostragem a
cada 10 ms sobre uma linha de base tirada depois de um GC. Os filhos são
processos separados e o sistema operacional os contabiliza à parte: eles não
aparecem aqui. O número é alto exatamente onde a documentação avisa que seria —
no payload de 16 MiB, onde o pai mantém o buffer original, o snapshot de admissão
e a cópia serializada do IPC ao mesmo tempo.

Nessa coluna, só os casos de megabytes têm sinal. Os demais movimentam frações de
MiB, onde o alocador devolve páginas quando quer e a variação percentual entre
duas execuções idênticas chega a 100% sem que nada tenha mudado. Trate como
confiável o pico do caso de 16 MiB e o pico máximo da suíte.

`npm run bench` já passa `--expose-gc`; rodando `node bench/run.mjs` direto, sem
essa flag, as linhas de base ficam sujas e os picos saem inflados.

Nenhum caso saudável passa de um segundo. Um caso que não assenta em 4 segundos
vira a linha `*** não assentou ***`, com o ciclo de vida parcial gravado no
snapshot, em vez de travar a suíte inteira. A última seção deste arquivo explica
por que esse limite existe.

## Workers

| Worker               | Papel                                                      |
| -------------------- | ---------------------------------------------------------- |
| `digest.mjs`         | Reduz o payload a um resumo: mede o IPC de ida             |
| `produce.mjs`        | Devolve um Buffer do tamanho pedido: mede o IPC de volta   |
| `echo.mjs`           | Devolve o payload intacto: verifica o structured clone     |
| `cpu.mjs`            | Trabalho de CPU determinístico: a carga real de um handler |
| `hang.mjs`           | Nunca resolve: timeout, cancelamento, fila e shutdown      |
| `stubborn.mjs`       | Ignora SIGTERM e trava o event loop: escalada até SIGKILL  |
| `boom.mjs`           | Lança erro com código e causa: serialização do erro        |
| `unserializable.mjs` | Devolve uma função: falha de serialização no resultado     |
| `crash.mjs`          | Sai antes do handshake: `PROCESS_EXIT` na fase de startup  |
| `rogue.mjs`          | Fala fora do protocolo versionado: `PROCESS_PROTOCOL`      |

`hang.mjs` e `stubborn.mjs` têm um prazo de segurança interno para não deixarem
processos órfãos se a suíte for interrompida no meio de um caso.

## Casos

Os primeiros cinco casos isolam o preço do isolamento: uma tarefa sozinha, oito
tarefas em série e as mesmas oito com `concurrency` 2 e 4, mais uma fila de 32
tarefas para quatro vagas. A comparação entre eles mostra o ganho real de
paralelizar processos nesta máquina.

Os três seguintes medem o IPC em cada sentido separadamente — payload de 1 MiB e
de 16 MiB com resultado minúsculo, e resultado de 16 MiB com payload minúsculo —
e `eco estruturado` manda `Buffer`, `Map`, `Set`, `BigInt`, `Date`, `RegExp` e
typed array em uma volta completa, conferindo o digest do que voltou.

Os dois casos de `cpu.mjs` rodam o mesmo trabalho em série e com quatro vagas.

O resto cobre um caminho terminal cada: timeout, timeout com escalada até
SIGKILL, aborto durante a execução, aborto ainda na fila, fila cheia, `close()`
com quatro filhos ativos, erro do handler, resultado não serializável, payload
não serializável (que rejeita sem sequer criar processo), saída do filho durante
o startup, violação de protocolo e `run()` depois de `close()`.

## Diferenças entre sistemas

O caso `timeout até sigkill` é o único que muda de forma visível de um sistema
para outro. No Linux o worker recebe o SIGTERM, ignora, e só morre no SIGKILL
disparado depois de `killGraceMs` — o caso custa o timeout mais a carência. No
Windows não há entrega de sinal: o `kill` termina o processo direto, e o caso
custa só o timeout. O snapshot acompanha essa diferença no campo `termination`,
que sai `sigkill` no Linux e `sigterm` no Windows.

Pela mesma razão, o campo `exit` guarda apenas `limpo` ou `encerrado`: um filho
morto reporta sinal `SIGTERM` sem código no Linux e código 1 sem sinal no
Windows. Compare execuções da mesma máquina.

## Por que existe o prazo de 4 segundos

Um benchmark que trava não reporta nada, e o modo de falha mais provável deste
pacote é justamente uma tarefa que nunca assenta: o executor só entrega o
resultado depois de confirmar o `close` do filho, então qualquer filho cujo
`close` não chegue prende a Promise, prende `executor.close()` e prenderia a
suíte inteira.

Isso não é hipotético. A primeira execução desta suíte encontrou exatamente esse
bug: `#beginTermination` chamava `child.disconnect()` antes do `SIGTERM`, e um
`disconnect()` feito pelo pai suprime o `close` daquele filho — o `exit` chega, o
`close` não. Todos os sete caminhos de encerramento imediato ficavam pendentes
para sempre, no Windows com Node 24.11 e no Linux com Node 20.19. Reprodução
mínima, sem envolver o pacote:

```js
import { fork } from "node:child_process";

const child = fork(worker, [], { serialization: "advanced", stdio: ["ignore", "inherit", "inherit", "ipc"] });
child.on("exit", () => console.log("exit"));
child.on("close", () => console.log("close"));
setTimeout(() => {
  child.disconnect();
  child.kill("SIGTERM");
}, 200);
```

Isso imprime apenas `exit`. Sem o `disconnect()`, ou trocando-o por
`child.channel?.unref()`, os dois eventos chegam — que é o que o executor faz
hoje. O prazo fica como rede de proteção para a próxima regressão dessa família.
