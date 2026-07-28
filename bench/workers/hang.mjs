import { defineProcessHandler } from "../../dist/worker.js";

/**
 * Nunca resolve. O canal IPC mantém o processo vivo, e o `disconnect` disparado pelo executor
 * é o que o encerra, então este worker exercita timeout, cancelamento, fila e shutdown sem
 * depender de nenhum prazo interno.
 */
defineProcessHandler(() => new Promise(() => {}));
