// Antes da primeira pintura: o tema salvo por shared/appearance.ts, para a janela não piscar.
// O material (vidro) só entra depois que o efeito da janela está ligado (docs/ipc.md, Janela).
try {
  if (localStorage.getItem('theme') === 'light') document.documentElement.dataset.theme = 'light';
} catch {
  // Sem localStorage, vale o tema escuro.
}
