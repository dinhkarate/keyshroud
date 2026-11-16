// A copy button on every code block.
document.querySelectorAll('pre').forEach((pre) => {
  const button = document.createElement('button');
  button.className = 'copy';
  button.type = 'button';
  button.textContent = 'Copy';
  button.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(pre.querySelector('code').textContent); button.textContent = 'Copied'; }
    catch { button.textContent = 'Select & copy'; }
    setTimeout(() => { button.textContent = 'Copy'; }, 1600);
  });
  pre.append(button);
});
