// Kleines Fragefenster des Zeige-Modus (eigenes Fenster, damit Windows ihm den Fokus gibt)
const q = document.getElementById('q');
let sent = false;
function done(text) {
  if (sent) return;
  sent = true;
  window.harnes.send('ask-done', text);
}
q.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && q.value.trim()) done(q.value.trim());
  else if (e.key === 'Escape') done('');
});
window.harnes.on('ask-reset', () => {
  sent = false;
  q.value = '';
  q.focus();
});
window.addEventListener('blur', () => {
  // Klick daneben: Frage verwerfen, wenn noch nichts getippt ist
  if (!q.value.trim()) done('');
});
q.focus();
