/**
 * Sai antes do handshake, sem registrar handler nenhum. Exercita PROCESS_EXIT na fase de
 * startup, o caminho de um worker que quebra ao carregar suas próprias dependências.
 */
process.exit(3);
