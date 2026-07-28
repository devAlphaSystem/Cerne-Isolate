import { defineProcessHandler } from "../../dist/worker.js";

/**
 * Devolve um valor que o structured clone não aceita. A falha é detectada no worker, antes do
 * IPC, e chega ao chamador como PROCESS_SERIALIZATION no sentido do resultado.
 */
defineProcessHandler(() => ({ callback: () => undefined }));
