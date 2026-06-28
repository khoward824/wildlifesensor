const btn = document.getElementById('btn');
let count = 0;

btn.addEventListener('click', () => {
  count++;
  btn.textContent = `Clicked ${count} time${count !== 1 ? 's' : ''}`;
});