import { defineProcessHandler } from "../../dist/worker.js";

/**
 * Devolve o payload sem alterações. O resultado atravessa o structured clone quatro vezes
 * (snapshot de admissão, IPC de ida, snapshot do worker e IPC de volta), então o digest do
 * valor recebido de volta é a verificação de fidelidade dos tipos suportados.
 */
defineProcessHandler((payload) => payload);
