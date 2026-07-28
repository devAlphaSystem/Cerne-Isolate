import { defineProcessHandler } from "../../dist/worker.js";

/**
 * Lança um erro com código e causa. Exercita a serialização do erro no worker, a validação da
 * mensagem no pai e o `remoteError` entregue ao chamador.
 */
defineProcessHandler(() => {
  const cause = new RangeError("A página 7 está fora do intervalo do documento.");
  const error = new Error("O handler falhou ao processar a tarefa.", { cause });
  error.code = "HANDLER_FALHOU";
  throw error;
});
